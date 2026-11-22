'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { asyncHandler, publicUser } = require('../utils');

const router = express.Router();

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  const user = await db.get('SELECT * FROM users WHERE username = ?', [String(username).toLowerCase().trim()]);
  if (!user || !(await auth.comparePassword(password, user.password_hash))) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  if (!user.active) return res.status(403).json({ error: 'This account is deactivated. Contact the super admin.' });
  auth.setCookie(res, user);
  res.json({ user: publicUser(user) });
}));

router.post('/logout', (req, res) => {
  auth.clearCookie(res);
  res.json({ ok: true });
});

router.get('/me', auth.authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/change-password', auth.authRequired, asyncHandler(async (req, res) => {
  const { current, next } = req.body || {};
  if (!current || !next || String(next).length < 6) {
    return res.status(400).json({ error: 'Enter the current password and a new password of at least 6 characters.' });
  }
  if (!(await auth.comparePassword(current, req.user.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  await db.run('UPDATE users SET password_hash = ? WHERE id = ? RETURNING id', [
    await auth.hashPassword(next),
    req.user.id,
  ]);
  res.json({ ok: true });
}));

module.exports = router;
