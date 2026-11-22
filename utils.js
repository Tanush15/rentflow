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

const CHANGE_LABELS = {
  room_no: 'Room no', floor: 'Floor', address: 'Address', rent: 'Rent',
  electricity_bill: 'Electricity bill', notes: 'Notes', name: 'Name', phone: 'Phone',
  meter_no: 'Meter no', ca_number: 'CA number', provider: 'Provider', rate_per_unit: 'Rate/unit',
  month: 'Month', reading: 'Reading', previous_reading: 'Previous reading', units: 'Units',
  amount: 'Amount', bill_date: 'Bill date', due_date: 'Due date', status: 'Status',
  tenant_id: 'Tenant', mode: 'Mode', reference: 'Reference', rent_amount: 'Rent',
  extra_charges: 'Extra charges', dues_adjusted: 'Dues adjusted', remaining: 'Pending',
  receipt_no: 'Receipt', source: 'Source', reason: 'Reason',
};
const MONEY_KEYS = new Set([
  'rent', 'electricity_bill', 'amount', 'rent_amount', 'extra_charges',
  'dues_adjusted', 'remaining', 'rate_per_unit',
]);

function changeValue(key, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (MONEY_KEYS.has(key)) return inr(value);
  return String(value);
}

// Build a readable "Field: old → new" summary for the activity log.
function describeChanges(before, after, keys) {
  const b = before || {};
  const a = after || {};
  const list = keys || Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));
  const parts = [];
  for (const key of list) {
    const oldValue = b[key];
    const newValue = a[key];
    if (String(oldValue ?? '') === String(newValue ?? '')) continue;
    const label = CHANGE_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    parts.push(`${label}: ${changeValue(key, oldValue)} → ${changeValue(key, newValue)}`);
  }
  return parts.join(' · ');
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
  describeChanges,
  notify,
  nextReceiptNo,
  normalizePhone,
  whatsappLink,
  reminderText,
  receiptText,
};
