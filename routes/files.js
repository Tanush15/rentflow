'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { asyncHandler, logActivity, notify } = require('../utils');

const router = express.Router();
router.use(auth.authRequired);

function safeFilename(name) {
  return String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
}

router.get('/:id', asyncHandler(async (req, res) => {
  const file = await db.get('SELECT * FROM files WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'File not found.' });
  const type = file.mime || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(file.filename)}"`);
  } else {
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename(file.filename)}"`);
  }
  res.send(file.content);
}));

router.delete('/:id', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const file = await db.get('SELECT * FROM files WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'File not found.' });
  if (file.kind === 'photo') {
    await db.run('UPDATE tenants SET photo_file_id = NULL WHERE photo_file_id = ? RETURNING id', [file.id]);
  }
  await db.run('DELETE FROM files WHERE id = ? RETURNING id', [file.id]);
  await logActivity(req, 'deleted', 'document', file.id, file.filename);
  notify(req, 'tenants', 'document-deleted');
  res.json({ ok: true });
}));

module.exports = router;
