'use strict';

const QRCode = require('qrcode');
const db = require('../db');
const { monthLabel, inr, reminderText, whatsappLink, receiptText } = require('../utils');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function createLink(kind, payload, days = 30, baseUrl = '') {
  const token = db.randomToken(20);
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  await db.run(
    'INSERT INTO share_links (token, kind, payload, expires_at) VALUES (?, ?, ?, ?) RETURNING id',
    [token, kind, JSON.stringify(payload), expires]
  );
  const url = `/s/${token}`;
  const absolute = baseUrl ? `${String(baseUrl).replace(/\/$/, '')}${url}` : url;
  return {
    token,
    url,
    absolute,
    qr: await QRCode.toDataURL(absolute, { margin: 1, width: 320, color: { dark: '#123c30', light: '#ffffff' } }),
  };
}

async function receiptShare(paymentId, days, baseUrl = '') {
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [paymentId]);
  if (!payment) throw Object.assign(new Error('Payment not found.'), { status: 404 });
  const [tenant, room, user] = await Promise.all([
    db.get('SELECT * FROM tenants WHERE id = ?', [payment.tenant_id]),
    db.get('SELECT * FROM rooms WHERE id = ?', [payment.room_id]),
    db.get('SELECT name FROM users WHERE id = ?', [payment.created_by]),
  ]);
  const ctx = {
    tenantName: tenant ? tenant.name : '-',
    roomNo: room ? room.room_no : '-',
    receivedBy: user ? user.name : 'Family Admin',
    phone: tenant ? tenant.phone : null,
  };
  const link = await createLink('receipt', { type: 'receipt', paymentId }, days, baseUrl);
  return { ...link, text: receiptText(payment, ctx), payment, context: ctx };
}

async function reminderShare({ tenantId, month, customMessage, days, baseUrl = '' }) {
  const tenant = await db.get(`
    SELECT t.*, r.room_no FROM tenants t LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?
  `, [tenantId]);
  if (!tenant) throw Object.assign(new Error('Tenant not found.'), { status: 404 });
  const dues = await db.query('SELECT * FROM dues WHERE tenant_id = ? AND settled = 0', [tenantId]);
  const dueTotal = dues.reduce((s, d) => s + Number(d.amount || 0), 0);
  const link = await createLink('reminder', {
    type: 'reminder', tenantId, month, customMessage: customMessage || null,
  }, days, baseUrl);
  const absolute = link.absolute;
  const text = customMessage
    ? `${customMessage}\n${absolute}`
    : reminderText({
      name: tenant.name,
      month,
      roomNo: tenant.room_no,
      amountDue: dueTotal,
      link: absolute,
    });
  return { ...link, text, waLink: whatsappLink(tenant.phone, text), tenant, dueTotal };
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - RentFlow</title>
<style>
body{margin:0;background:#f2f6f3;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#17352b;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;max-width:520px;width:100%;border-radius:18px;box-shadow:0 12px 40px rgba(20,60,45,.12);overflow:hidden}
.head{background:#1f4d3d;color:#fff;padding:22px 26px}.head h1{margin:0;font-size:22px}.head p{margin:4px 0 0;opacity:.8;font-size:13px}
.body{padding:24px 26px}.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #edf1ee;font-size:14px}.row span:first-child{color:#718078}.row strong{text-align:right}
.total{font-size:22px;color:#1f4d3d;margin-top:18px;text-align:right}
.note{background:#eef7f1;color:#2f5d46;padding:14px;border-radius:10px;font-size:13px;margin-top:18px;white-space:pre-wrap}
.foot{padding:16px 26px;background:#f8faf8;color:#8a9991;font-size:12px;text-align:center}
.badge{display:inline-block;background:#e6f3ea;color:#276b48;border-radius:20px;padding:4px 12px;font-size:12px;font-weight:600}
</style></head><body><div class="card"><div class="head"><h1>RentFlow</h1><p>${esc(title)}</p></div>
<div class="body">${body}</div><div class="foot">Shared by your family via RentFlow</div></div></body></html>`;
}

async function renderPublic(token) {
  const row = await db.get('SELECT * FROM share_links WHERE token = ?', [token]);
  if (!row) return page('Link not found', '<p>This link does not exist.</p>');
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return page('Link expired', '<p>This link has expired. Ask your family for a new one.</p>');
  }
  let payload;
  try { payload = JSON.parse(row.payload); } catch (e) { return page('Invalid link', '<p>This link could not be read.</p>'); }

  if (payload.type === 'receipt') {
    const payment = await db.get('SELECT * FROM payments WHERE id = ?', [payload.paymentId]);
    if (!payment) return page('Receipt not found', '<p>This receipt is no longer available.</p>');
    const [tenant, room, user] = await Promise.all([
      db.get('SELECT name FROM tenants WHERE id = ?', [payment.tenant_id]),
      db.get('SELECT room_no FROM rooms WHERE id = ?', [payment.room_id]),
      db.get('SELECT name FROM users WHERE id = ?', [payment.created_by]),
    ]);
    const r = (label, value) => `<div class="row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
    const body = `<span class="badge">Paid ✓</span>
      ${r('Receipt no.', payment.receipt_no)}
      ${r('Tenant', tenant ? tenant.name : '-')}
      ${r('Room', room ? room.room_no : '-')}
      ${r('Month', monthLabel(payment.month))}
      ${r('Rent', inr(payment.rent_amount))}
      ${payment.extra_charges ? r('Extra charges', inr(payment.extra_charges)) : ''}
      ${payment.dues_adjusted ? r('Old dues adjusted', inr(payment.dues_adjusted)) : ''}
      <div class="total">${inr(payment.amount)}</div>
      ${payment.remaining ? r('Still pending', inr(payment.remaining)) : ''}
      ${r('Mode', String(payment.mode || 'cash').toUpperCase())}
      ${r('Received by', user ? user.name : 'Family Admin')}
      <div class="note">Thank you for your payment! - RentFlow family</div>`;
    return page('Rent receipt', body);
  }

  if (payload.type === 'reminder') {
    const tenant = await db.get(`
      SELECT t.*, r.room_no FROM tenants t LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?
    `, [payload.tenantId]);
    if (!tenant) return page('Reminder', '<p>This reminder is no longer available.</p>');
    const dues = await db.query('SELECT * FROM dues WHERE tenant_id = ? AND settled = 0', [tenant.id]);
    const dueTotal = dues.reduce((s, d) => s + Number(d.amount || 0), 0);
    const r = (label, value) => `<div class="row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
    const body = `<span class="badge">Payment reminder</span>
      ${r('Tenant', tenant.name)}
      ${r('Room', tenant.room_no || '-')}
      ${r('Month', monthLabel(payload.month))}
      <div class="total">${inr(dueTotal)} pending</div>
      ${dues.map((d) => r(`${monthLabel(d.month)} - ${d.reason}`, inr(d.amount))).join('')}
      <div class="note">${esc(payload.customMessage || `Namaste ${tenant.name} ji, please clear the pending rent at your earliest convenience. Dhanyavaad!`)}</div>`;
    return page('Rent reminder', body);
  }

  return page('Link', '<p>Unknown link type.</p>');
}

module.exports = { createLink, receiptShare, reminderShare, renderPublic };
