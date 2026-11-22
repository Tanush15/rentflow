'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { asyncHandler, logActivity, notify, num } = require('../utils');

const router = express.Router();
router.use(auth.authRequired);

const CATEGORIES = ['maintenance', 'repairs', 'electricity', 'water', 'salary', 'supplies', 'other'];

router.get('/', asyncHandler(async (req, res) => {
  const params = [];
  let sql = `
    SELECT e.*, u.name AS created_by_name FROM expenses e
    LEFT JOIN users u ON u.id = e.created_by WHERE 1 = 1
  `;
  if (req.query.from) { sql += ' AND e.expense_date >= ?'; params.push(req.query.from); }
  if (req.query.to) { sql += ' AND e.expense_date <= ?'; params.push(req.query.to); }
  sql += ' ORDER BY e.expense_date DESC, e.id DESC LIMIT 500';
  res.json({ expenses: await db.query(sql, params), categories: CATEGORIES });
}));

router.post('/', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const { title, category, amount, expense_date, note } = req.body || {};
  if (!title || !String(title).trim() || num(amount) <= 0) {
    return res.status(400).json({ error: 'Enter a title and an amount greater than zero.' });
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(expense_date) ? expense_date : new Date().toISOString().slice(0, 10);
  const result = await db.run(
    `INSERT INTO expenses (title, category, amount, expense_date, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    [String(title).trim(), CATEGORIES.includes(category) ? category : 'other', num(amount), date, note || null, req.user.id]
  );
  await logActivity(req, 'added', 'expense', result.lastId, `${title} ${num(amount)}`);
  notify(req, 'expenses', 'created');
  res.status(201).json({ id: result.lastId });
}));

router.put('/:id', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const expense = await db.get('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
  if (!expense) return res.status(404).json({ error: 'Expense not found.' });
  const b = req.body || {};
  await db.run(
    'UPDATE expenses SET title = ?, category = ?, amount = ?, expense_date = ?, note = ? WHERE id = ? RETURNING id',
    [
      b.title || expense.title,
      CATEGORIES.includes(b.category) ? b.category : expense.category,
      b.amount !== undefined ? num(b.amount) : expense.amount,
      /^\d{4}-\d{2}-\d{2}$/.test(b.expense_date) ? b.expense_date : expense.expense_date,
      b.note !== undefined ? b.note || null : expense.note,
      expense.id,
    ]
  );
  await logActivity(req, 'updated', 'expense', expense.id, b.title || expense.title);
  notify(req, 'expenses', 'updated');
  res.json({ ok: true });
}));

router.delete('/:id', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const expense = await db.get('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
  if (!expense) return res.status(404).json({ error: 'Expense not found.' });
  await db.run('DELETE FROM expenses WHERE id = ? RETURNING id', [expense.id]);
  await logActivity(req, 'deleted', 'expense', expense.id, expense.title);
  notify(req, 'expenses', 'deleted');
  res.json({ ok: true });
}));

module.exports = router;
