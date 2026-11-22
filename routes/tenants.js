'use strict';

const express = require('express');
const multer = require('multer');
const db = require('../db');
const auth = require('../auth');
const data = require('../lib/data');
const { asyncHandler, logActivity, notify } = require('../utils');

const router = express.Router();

// DATE columns need YYYY-MM-DD on Postgres (SQLite is lenient, Postgres is not).
function dateValue(value) {
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  return new Date().toISOString().slice(0, 10);
}
router.use(auth.authRequired);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].includes(file.mimetype);
    if (!ok) {
      const err = new Error('Only JPG, PNG, WebP, GIF and PDF files are allowed.');
      err.status = 400;
      return cb(err, false);
    }
    cb(null, true);
  },
});

function handleUpload(req, res, kind) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (err) return reject(err);
      resolve();
    });
  }).then(async () => {
    if (!req.file) throw Object.assign(new Error('Choose a file to upload.'), { status: 400 });
    const tenantId = req.params.id;
    const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [tenantId]);
    if (!tenant) throw Object.assign(new Error('Tenant not found.'), { status: 404 });
    const result = await db.run(
      `INSERT INTO files (filename, mime, size, content, tenant_id, kind, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, tenantId, kind, req.user.id]
    );
    if (kind === 'photo') {
      if (tenant.photo_file_id && tenant.photo_file_id !== result.lastId) {
        await db.run('DELETE FROM files WHERE id = ? RETURNING id', [tenant.photo_file_id]);
      }
      await db.run('UPDATE tenants SET photo_file_id = ? WHERE id = ? RETURNING id', [result.lastId, tenantId]);
    }
    await logActivity(req, 'uploaded', kind === 'photo' ? 'photo' : 'document', result.lastId, req.file.originalname);
    notify(req, 'tenants', 'document-uploaded', { tenantId: Number(tenantId) });
    return { id: result.lastId, name: req.file.originalname, size: req.file.size, mime: req.file.mimetype };
  });
}

router.get('/', asyncHandler(async (req, res) => {
  res.json({ tenants: await data.listTenants(req.query.includeInactive === '1') });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const detail = await data.tenantDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Tenant not found.' });
  res.json(detail);
}));

router.post('/', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const { room_id, name, phone, email, join_date, notes } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Tenant name is required.' });
  if (room_id) {
    const occupied = await db.get('SELECT id FROM tenants WHERE room_id = ? AND active = 1', [room_id]);
    if (occupied) return res.status(400).json({ error: 'That room already has an active tenant.' });
  }
  const result = await db.run(
    `INSERT INTO tenants (room_id, name, phone, email, join_date, notes, active)
     VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id`,
    [room_id || null, String(name).trim(), phone || null, email || null, dateValue(join_date), notes || null]
  );
  await logActivity(req, 'created', 'tenant', result.lastId, name);
  notify(req, 'tenants', 'created');
  res.status(201).json({ id: result.lastId, tenants: await data.listTenants() });
}));

router.put('/:id', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
  const b = req.body || {};
  if (b.room_id && String(b.room_id) !== String(tenant.room_id)) {
    const occupied = await db.get('SELECT id FROM tenants WHERE room_id = ? AND active = 1 AND id != ?', [b.room_id, tenant.id]);
    if (occupied) return res.status(400).json({ error: 'That room already has an active tenant.' });
  }
  await db.run(
    `UPDATE tenants SET room_id = ?, name = ?, phone = ?, email = ?, join_date = ?, notes = ?
     WHERE id = ? RETURNING id`,
    [
      b.room_id !== undefined ? b.room_id || null : tenant.room_id,
      b.name || tenant.name,
      b.phone !== undefined ? b.phone || null : tenant.phone,
      b.email !== undefined ? b.email || null : tenant.email,
      b.join_date !== undefined ? (b.join_date ? dateValue(b.join_date) : null) : tenant.join_date,
      b.notes !== undefined ? b.notes || null : tenant.notes,
      tenant.id,
    ]
  );
  await logActivity(req, 'updated', 'tenant', tenant.id, b.name || tenant.name);
  notify(req, 'tenants', 'updated');
  res.json({ tenants: await data.listTenants() });
}));

router.post('/:id/vacate', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
  await db.run('UPDATE tenants SET active = 0 WHERE id = ? RETURNING id', [tenant.id]);
  await logActivity(req, 'vacated', 'tenant', tenant.id, tenant.name);
  notify(req, 'tenants', 'vacated');
  res.json({ ok: true });
}));

router.delete('/:id', auth.requireRole('super_admin'), asyncHandler(async (req, res) => {
  const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
  await db.run('DELETE FROM tenants WHERE id = ? RETURNING id', [tenant.id]);
  await logActivity(req, 'deleted', 'tenant', tenant.id, tenant.name);
  notify(req, 'tenants', 'deleted');
  res.json({ ok: true });
}));

router.post('/:id/photo', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const file = await handleUpload(req, res, 'photo');
  res.status(201).json({ photo: file });
}));

router.post('/:id/documents', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const file = await handleUpload(req, res, 'document');
  res.status(201).json({ document: file, documents: (await data.tenantDetail(req.params.id)).documents });
}));

module.exports = router;
