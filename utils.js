'use strict';

const db = require('./db');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return month || '';
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function inr(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN')}`;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    active: !!u.active,
    created_at: u.created_at,
  };
}

async function logActivity(req, action, entity, entityId, details) {
  try {
    await db.run(
      'INSERT INTO activity (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [req.user ? req.user.id : null, action, entity, entityId || null, details ? String(details) : null]
    );
  } catch (e) {
    console.error('activity log failed', e.message);
  }
}

function notify(req, entity, action, extra = {}) {
  const io = req.app.get('io');
  if (!io) return;
  io.emit('sync', {
    entity,
    action,
    at: Date.now(),
    by: req.user ? req.user.name : 'System',
    ...extra,
  });
}

async function nextReceiptNo(month) {
  const stamp = (month || currentMonth()).replace('-', '');
  const rows = await db.query('SELECT receipt_no FROM payments WHERE receipt_no LIKE ?', [`RF/${stamp}/%`]);
  const highest = rows.reduce((max, row) => {
    const suffix = Number(String(row.receipt_no || '').split('/').pop());
    return Number.isFinite(suffix) && suffix > max ? suffix : max;
  }, 0);
  return `RF/${stamp}/${String(highest + 1).padStart(4, '0')}`;
}

function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return digits;
}

function whatsappLink(phone, message) {
  const digits = normalizePhone(phone);
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

function reminderText({ name, month, roomNo, amountDue, amountPaid, link }) {
  const m = monthLabel(month);
  const namePart = name ? `${name} ji` : 'Namaste';
  let msg = `Namaste ${namePart}! 👋\n`;
  msg += `RentFlow reminder from your family.\n`;
  msg += `Room: ${roomNo || '-'} | Month: ${m}\n`;
  if (amountPaid) msg += `Received: ${inr(amountPaid)}\n`;
  if (amountDue) msg += `Pending: ${inr(amountDue)} 🙏\n`;
  if (link) msg += `Receipt / details: ${link}\n`;
  msg += `Please pay at your earliest convenience. Dhanyavaad!`;
  return msg;
}

function receiptText(payment, ctx = {}) {
  const lines = [];
  lines.push('*RENTFLOW - RENT RECEIPT*');
  lines.push('----------------------------');
  lines.push(`Receipt No : ${payment.receipt_no || '-'}`);
  lines.push(`Date       : ${payment.paid_on || new Date(payment.created_at).toLocaleDateString('en-IN')}`);
  lines.push(`Tenant     : ${ctx.tenantName || '-'}`);
  lines.push(`Room       : ${ctx.roomNo || '-'}`);
  lines.push(`Month      : ${monthLabel(payment.month)}`);
  lines.push('----------------------------');
  lines.push(`Rent       : ${inr(payment.rent_amount)}`);
  if (payment.extra_charges) lines.push(`Extra      : ${inr(payment.extra_charges)}`);
  if (payment.dues_adjusted) lines.push(`Old dues   : ${inr(payment.dues_adjusted)}`);
  lines.push(`Received   : ${inr(payment.amount)}`);
  if (payment.remaining) lines.push(`Remaining  : ${inr(payment.remaining)}`);
  lines.push(`Mode       : ${String(payment.mode || 'cash').toUpperCase()}`);
  if (payment.reference) lines.push(`Reference  : ${payment.reference}`);
  lines.push('----------------------------');
  lines.push(`Received by: ${ctx.receivedBy || 'Family Admin'}`);
  lines.push('Thank you! - RentFlow');
  return lines.join('\n');
}

module.exports = {
  currentMonth,
  shiftMonth,
  monthLabel,
  inr,
  num,
  asyncHandler,
  publicUser,
  logActivity,
  notify,
  nextReceiptNo,
  normalizePhone,
  whatsappLink,
  reminderText,
  receiptText,
};
