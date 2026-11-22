'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const data = require('../lib/data');
const {
  asyncHandler, logActivity, notify, num, currentMonth, shiftMonth, nextReceiptNo, monthLabel,
} = require('../utils');

const router = express.Router();
router.use(auth.authRequired);

router.get('/', asyncHandler(async (req, res) => {
  const settled = req.query.settled;
  const dues = await data.listDues({
    settled: settled === undefined ? false : settled,
    tenantId: req.query.tenantId,
  });
  res.json({ dues });
}));

router.post('/', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const { tenant_id, month, amount, reason } = req.body || {};
  if (!tenant_id || num(amount) <= 0) return res.status(400).json({ error: 'Choose a tenant and enter an amount.' });
  const tenant = await db.get('SELECT id FROM tenants WHERE id = ?', [tenant_id]);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
  const dueMonth = /^\d{4}-\d{2}$/.test(month) ? month : currentMonth();
  const result = await db.run(
    `INSERT INTO dues (tenant_id, month, amount, reason, settled, created_by)
     VALUES (?, ?, ?, ?, 0, ?) RETURNING id`,
    [tenant_id, dueMonth, num(amount), reason || 'Extra due / अतिरिक्त बकाया', req.user.id]
  );
  await logActivity(req, 'created', 'due', result.lastId, `${monthLabel(dueMonth)} ${num(amount)}`);
  notify(req, 'dues', 'created');
  res.status(201).json({ id: result.lastId, dues: await data.listDues({ settled: false }) });
}));

router.put('/:id', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const due = await db.get('SELECT * FROM dues WHERE id = ?', [req.params.id]);
  if (!due) return res.status(404).json({ error: 'Due not found.' });
  const b = req.body || {};
  await db.run(
    'UPDATE dues SET month = ?, amount = ?, reason = ? WHERE id = ? RETURNING id',
    [
      /^\d{4}-\d{2}$/.test(b.month) ? b.month : due.month,
      b.amount !== undefined ? num(b.amount) : due.amount,
      b.reason || due.reason,
      due.id,
    ]
  );
  await logActivity(req, 'updated', 'due', due.id, b.reason || due.reason);
  notify(req, 'dues', 'updated');
  res.json({ dues: await data.listDues({ settled: false }) });
}));

router.post('/:id/settle', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const due = await db.get('SELECT * FROM dues WHERE id = ?', [req.params.id]);
  if (!due) return res.status(404).json({ error: 'Due not found.' });
  if (due.settled) return res.status(400).json({ error: 'This due is already settled.' });
  const amount = num(due.amount);
  const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [due.tenant_id]);
  const receiptNo = await nextReceiptNo(due.month);
  const result = await db.run(
    `INSERT INTO payments (tenant_id, room_id, month, amount, rent_amount, extra_charges,
      dues_adjusted, remaining, mode, reference, note, receipt_no, created_by)
     VALUES (?, ?, ?, ?, 0, 0, ?, 0, 'adjustment', ?, ?, ?, ?) RETURNING id`,
    [due.tenant_id, tenant ? tenant.room_id : null, due.month, amount, amount,
      req.body.reference || null, `Settlement of due: ${due.reason}`, receiptNo, req.user.id]
  );
  await db.run('UPDATE dues SET settled = 1, settled_payment_id = ? WHERE id = ? RETURNING id', [result.lastId, due.id]);
  await logActivity(req, 'settled', 'due', due.id, `${tenant ? tenant.name : ''} ${amount}`);
  notify(req, 'dues', 'settled');
  res.json({ ok: true, paymentId: result.lastId });
}));

router.post('/:id/carry-forward', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const due = await db.get('SELECT * FROM dues WHERE id = ?', [req.params.id]);
  if (!due) return res.status(404).json({ error: 'Due not found.' });
  if (due.settled) return res.status(400).json({ error: 'Settled dues cannot be carried forward.' });
  const next = shiftMonth(/^\d{4}-\d{2}$/.test(due.month) ? due.month : currentMonth(), 1);
  const reason = `Carried from ${monthLabel(due.month)}: ${due.reason}`.slice(0, 240);
  await db.run('UPDATE dues SET month = ?, reason = ? WHERE id = ? RETURNING id', [next, reason, due.id]);
  await logActivity(req, 'carried-forward', 'due', due.id, `${monthLabel(due.month)} → ${monthLabel(next)}`);
  notify(req, 'dues', 'carried-forward');
  res.json({ dues: await data.listDues({ settled: false }) });
}));

router.delete('/:id', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const due = await db.get('SELECT * FROM dues WHERE id = ?', [req.params.id]);
  if (!due) return res.status(404).json({ error: 'Due not found.' });
  await db.run('DELETE FROM dues WHERE id = ? RETURNING id', [due.id]);
  await logActivity(req, 'deleted', 'due', due.id, due.reason);
  notify(req, 'dues', 'deleted');
  res.json({ ok: true });
}));

module.exports = router;
