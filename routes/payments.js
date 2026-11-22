'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const data = require('../lib/data');
const { receiptPdf, paymentsPdf } = require('../lib/pdf');
const {
  asyncHandler, logActivity, notify, num, currentMonth, nextReceiptNo, receiptText, inr, monthLabel,
  describeChanges,
} = require('../utils');

const router = express.Router();
router.use(auth.authRequired);

async function paymentContext(payment) {
  const [tenant, room, user] = await Promise.all([
    db.get('SELECT name FROM tenants WHERE id = ?', [payment.tenant_id]),
    db.get('SELECT room_no FROM rooms WHERE id = ?', [payment.room_id]),
    db.get('SELECT name FROM users WHERE id = ?', [payment.created_by]),
  ]);
  return {
    tenantName: tenant ? tenant.name : '-',
    roomNo: room ? room.room_no : '-',
    receivedBy: user ? user.name : 'Family Admin',
    phone: tenant ? tenant.phone : null,
  };
}

router.get('/', asyncHandler(async (req, res) => {
  res.json({ payments: await data.listPayments({
    month: req.query.month,
    tenantId: req.query.tenantId,
    from: req.query.from,
    to: req.query.to,
  }) });
}));

router.get('/export/pdf', asyncHandler(async (req, res) => {
  const payments = await data.listPayments({
    month: req.query.all === '1' ? undefined : (req.query.month || undefined),
    tenantId: req.query.tenantId,
    from: req.query.from,
    to: req.query.to,
  });
  const pdf = await paymentsPdf(payments);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="rentflow-payments-${new Date().toISOString().slice(0, 10)}.pdf"`);
  res.send(pdf);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const payment = await db.get(`
    SELECT p.*, t.name AS tenant_name, t.phone AS tenant_phone, r.room_no, u.name AS received_by
    FROM payments p LEFT JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN rooms r ON r.id = p.room_id LEFT JOIN users u ON u.id = p.created_by
    WHERE p.id = ?`, [req.params.id]);
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  res.json({ payment });
}));

router.post('/', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.tenant_id) return res.status(400).json({ error: 'Select a tenant.' });
  const tenant = await db.get(`
    SELECT t.*, r.rent AS room_rent FROM tenants t LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?
  `, [b.tenant_id]);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

  const month = /^\d{4}-\d{2}$/.test(b.month) ? b.month : currentMonth();
  const rent = b.rent_amount !== undefined && b.rent_amount !== '' ? num(b.rent_amount) : num(tenant.room_rent);
  const extra = num(b.extra_charges);
  const amount = num(b.amount);
  if (amount <= 0) return res.status(400).json({ error: 'Enter an amount greater than zero.' });

  const payable = rent + extra;
  const allDues = await db.query('SELECT * FROM dues WHERE tenant_id = ? AND settled = 0 ORDER BY month ASC, id ASC', [tenant.id]);
  const selectedIds = Array.isArray(b.adjust_due_ids)
    ? b.adjust_due_ids.map(Number)
    : [];
  const selected = allDues.filter((d) => selectedIds.includes(Number(d.id)));
  const oldTotal = selected.reduce((s, d) => s + num(d.amount), 0);

  const receiptNo = await nextReceiptNo(month);
  const insert = await db.run(
    `INSERT INTO payments (tenant_id, room_id, month, amount, rent_amount, extra_charges,
      dues_adjusted, remaining, mode, reference, note, receipt_no, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?) RETURNING id`,
    [tenant.id, tenant.room_id, month, amount, rent, extra, b.mode || 'cash', b.reference || null,
      b.note || null, receiptNo, req.user.id]
  );
  const paymentId = insert.lastId;

  let cashForDues = amount;
  let duesAdjusted = 0;
  for (const due of selected) {
    if (cashForDues <= 0) break;
    const dueAmount = num(due.amount);
    const paidToward = Math.min(cashForDues, dueAmount);
    cashForDues -= paidToward;
    duesAdjusted += paidToward;
    if (paidToward >= dueAmount) {
      await db.run('UPDATE dues SET settled = 1, settled_payment_id = ? WHERE id = ? RETURNING id', [paymentId, due.id]);
    } else {
      await db.run('UPDATE dues SET amount = ? WHERE id = ? RETURNING id', [dueAmount - paidToward, due.id]);
    }
  }

  const cashForMonth = Math.max(0, amount - duesAdjusted);
  let currentShort = Math.max(0, payable - cashForMonth);
  if (currentShort > 0 && b.create_due_if_partial !== false) {
    await db.run(
      `INSERT INTO dues (tenant_id, month, amount, reason, settled, source_payment_id, created_by)
       VALUES (?, ?, ?, ?, 0, ?, ?) RETURNING id`,
      [tenant.id, month, currentShort, 'Partial payment / आंशिक भुगतान', paymentId, req.user.id]
    );
  }

  const outstanding = await db.query('SELECT amount FROM dues WHERE tenant_id = ? AND settled = 0', [tenant.id]);
  const remaining = outstanding.reduce((s, d) => s + num(d.amount), 0);
  await db.run('UPDATE payments SET dues_adjusted = ?, remaining = ? WHERE id = ? RETURNING id', [duesAdjusted, remaining, paymentId]);

  await logActivity(req, 'recorded', 'payment', paymentId, describeChanges({}, {
    receipt_no: receiptNo,
    tenant_id: tenant.name,
    room_no: tenant.room_no,
    month: monthLabel(month),
    rent_amount: rent,
    extra_charges: extra,
    dues_adjusted: duesAdjusted,
    remaining,
    amount,
    mode: b.mode || 'cash',
    reference: b.reference,
    note: b.note,
  }));
  notify(req, 'payments', 'created', { tenantId: tenant.id });
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [paymentId]);
  res.status(201).json({ payment, oldTotal, payable });
}));

router.delete('/:id', auth.requireRole('super_admin'), asyncHandler(async (req, res) => {
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [req.params.id]);
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  await db.run('DELETE FROM dues WHERE source_payment_id = ? RETURNING id', [payment.id]);
  await db.run('UPDATE dues SET settled = 0, settled_payment_id = NULL WHERE settled_payment_id = ? RETURNING id', [payment.id]);
  await db.run('DELETE FROM payments WHERE id = ? RETURNING id', [payment.id]);
  const ctx = await paymentContext(payment);
  await logActivity(req, 'deleted', 'payment', payment.id, describeChanges({
    receipt_no: payment.receipt_no,
    tenant_id: ctx.tenantName,
    room_no: ctx.roomNo,
    month: monthLabel(payment.month),
    rent_amount: payment.rent_amount,
    extra_charges: payment.extra_charges,
    dues_adjusted: payment.dues_adjusted,
    amount: payment.amount,
    mode: payment.mode,
  }, {}));
  notify(req, 'payments', 'deleted');
  res.json({ ok: true });
}));

router.get('/:id/receipt/text', asyncHandler(async (req, res) => {
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [req.params.id]);
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  const ctx = await paymentContext(payment);
  res.json({ text: receiptText(payment, ctx), payment, context: ctx });
}));

router.get('/:id/receipt/pdf', asyncHandler(async (req, res) => {
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [req.params.id]);
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  const ctx = await paymentContext(payment);
  const pdf = await receiptPdf(payment, ctx);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${payment.receipt_no || payment.id}.pdf"`);
  res.send(pdf);
}));

module.exports = router;
