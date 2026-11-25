'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const data = require('../lib/data');
const { activityPdf, monthSummaryPdf } = require('../lib/pdf');
const { asyncHandler, currentMonth, monthLabel } = require('../utils');

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

router.get('/activity/pdf', asyncHandler(async (req, res) => {
  const rows = await db.query(`
    SELECT a.*, u.name AS user_name FROM activity a
    LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 1000
  `);
  const pdf = await activityPdf(rows);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="rentflow-activity-${new Date().toISOString().slice(0, 10)}.pdf"`);
  res.send(pdf);
}));

router.get('/month/pdf', asyncHandler(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : currentMonth();
  const report = await data.reports(month);
  const pdf = await monthSummaryPdf(report);
  const stamp = monthLabel(month).replace(/\s+/g, '-').toLowerCase();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="rentflow-summary-${stamp}.pdf"`);
  res.send(pdf);
}));

module.exports = router;
