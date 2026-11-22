'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { asyncHandler, logActivity, notify, publicUser } = require('../utils');

const router = express.Router();
router.use(auth.authRequired, auth.requireRole('super_admin'));

const VALID_ROLES = ['super_admin', 'admin', 'member'];

router.get('/', asyncHandler(async (req, res) => {
  const users = await db.query('SELECT * FROM users ORDER BY role, id');
  res.json({ users: users.map(publicUser) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, username, password, role } = req.body || {};
  if (!name || !username || !password || String(password).length < 6) {
    return res.status(400).json({ error: 'Name, username and a password of at least 6 characters are required.' });
  }
  const uname = String(username).toLowerCase().trim();
  if (await db.get('SELECT id FROM users WHERE username = ?', [uname])) {
    return res.status(400).json({ error: 'That username is already taken.' });
  }
  const result = await db.run(
    'INSERT INTO users (name, username, password_hash, role, active) VALUES (?, ?, ?, ?, 1) RETURNING id',
    [String(name).trim(), uname, await auth.hashPassword(password), VALID_ROLES.includes(role) ? role : 'member']
  );
  await logActivity(req, 'created', 'user', result.lastId, uname);
  notify(req, 'users', 'created');
  res.status(201).json({ id: result.lastId });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const target = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const b = req.body || {};
  if (target.role === 'super_admin' && (b.active === 0 || b.active === '0' || (b.role && b.role !== 'super_admin'))) {
    const supers = await db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND active = 1");
    if (b.active === 0 || b.active === '0') {
      return res.status(400).json({ error: 'The last active super admin cannot be deactivated.' });
    }
    if (b.role && b.role !== 'super_admin' && Number(supers[0].n) <= 1) {
      return res.status(400).json({ error: 'The last super admin cannot be demoted.' });
    }
  }
  await db.run(
    'UPDATE users SET name = ?, username = ?, role = ?, active = ? WHERE id = ? RETURNING id',
    [
      b.name || target.name,
      b.username ? String(b.username).toLowerCase().trim() : target.username,
      VALID_ROLES.includes(b.role) ? b.role : target.role,
      b.active === undefined ? target.active : (b.active ? 1 : 0),
      id,
    ]
  );
  await logActivity(req, 'updated', 'user', id, b.name || target.name);
  notify(req, 'users', 'updated');
  res.json({ ok: true });
}));

router.post('/:id/reset-password', asyncHandler(async (req, res) => {
  const target = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const password = req.body && req.body.password;
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  await db.run('UPDATE users SET password_hash = ? WHERE id = ? RETURNING id', [
    await auth.hashPassword(password),
    target.id,
  ]);
  await logActivity(req, 'reset-password', 'user', target.id, target.name);
  notify(req, 'users', 'updated');
  res.json({ ok: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  const target = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'super_admin') {
    const supers = await db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin'");
    if (Number(supers[0].n) <= 1) return res.status(400).json({ error: 'The only super admin cannot be deleted.' });
  }
  await db.run('UPDATE payments SET created_by = NULL WHERE created_by = ? RETURNING id', [id]);
  await db.run('UPDATE expenses SET created_by = NULL WHERE created_by = ? RETURNING id', [id]);
  await db.run('UPDATE dues SET created_by = NULL WHERE created_by = ? RETURNING id', [id]);
  await db.run('DELETE FROM activity WHERE user_id = ? RETURNING id', [id]);
  await db.run('DELETE FROM users WHERE id = ? RETURNING id', [id]);
  await logActivity(req, 'deleted', 'user', id, target.name);
  notify(req, 'users', 'deleted');
  res.json({ ok: true });
}));

module.exports = router;
