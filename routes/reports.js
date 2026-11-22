'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const data = require('../lib/data');
const { asyncHandler, currentMonth } = require('../utils');

const router = express.Router();
router.use(auth.authRequired);

router.get('/dashboard', asyncHandler(async (req, res) => {
  res.json(await data.dashboard(req.query.month || currentMonth()));
}));

router.get('/summary', asyncHandler(async (req, res) => {
  res.json(await data.reports(req.query.month || currentMonth()));
}));

router.get('/activity', asyncHandler(async (req, res) => {
  const rows = await db.query(`
    SELECT a.*, u.name AS user_name FROM activity a
    LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 50
  `);
  res.json({ activity: rows });
}));

module.exports = router;
