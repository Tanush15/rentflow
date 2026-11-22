'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { publicUser } = require('./utils');

const COOKIE = 'rf_token';
const SECRET = process.env.JWT_SECRET || 'rentflow-dev-secret-change-me-in-production';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('[RentFlow] WARNING: JWT_SECRET is not set. Set it before deploying.');
}

function tokenFor(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET, {
    expiresIn: '7d',
  });
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE,
    path: '/',
  };
}

function setCookie(res, user) {
  res.cookie(COOKIE, tokenFor(user), cookieOptions());
}

function clearCookie(res) {
  res.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'lax' });
}

async function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SECRET);
    return await db.get('SELECT * FROM users WHERE id = ?', [payload.id]);
  } catch (e) {
    return null;
  }
}

async function authRequired(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  const user = await userFromToken(token);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  if (!user.active) return res.status(403).json({ error: 'This account has been deactivated.' });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please log in.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission for this action.' });
    next();
  };
}

function isAdmin(user) {
  return user && (user.role === 'admin' || user.role === 'super_admin');
}

module.exports = {
  COOKIE,
  SECRET,
  setCookie,
  clearCookie,
  userFromToken,
  authRequired,
  requireRole,
  isAdmin,
  comparePassword: (plain, hash) => bcrypt.compare(plain, hash),
  hashPassword: (plain) => bcrypt.hash(plain, 10),
  publicUser,
};
