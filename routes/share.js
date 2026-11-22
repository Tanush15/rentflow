'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const share = require('../lib/share');
const { asyncHandler, currentMonth, whatsappLink } = require('../utils');

const router = express.Router();
router.use(auth.authRequired);

function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

router.post('/receipt', asyncHandler(async (req, res) => {
  const result = await share.receiptShare(req.body.paymentId, req.body.days || 30, baseUrl(req));
  res.json({
    url: result.url,
    absolute: result.absolute,
    token: result.token,
    qr: result.qr,
    text: result.text,
    waLink: whatsappLink(result.context.phone, result.text),
  });
}));

router.post('/reminder', asyncHandler(async (req, res) => {
  const result = await share.reminderShare({
    tenantId: req.body.tenantId,
    month: req.body.month || currentMonth(),
    customMessage: req.body.customMessage,
    days: req.body.days || 30,
    baseUrl: baseUrl(req),
  });
  res.json({
    url: result.url,
    absolute: result.absolute,
    token: result.token,
    qr: result.qr,
    text: result.text,
    waLink: result.waLink,
    tenant: result.tenant,
    dueTotal: result.dueTotal,
  });
}));

router.get('/links', asyncHandler(async (req, res) => {
  const links = await db.query('SELECT id, token, kind, expires_at, created_at FROM share_links ORDER BY id DESC LIMIT 30');
  res.json({ links });
}));

module.exports = router;
