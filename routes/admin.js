'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { asyncHandler, logActivity, notify } = require('../utils');

const router = express.Router();
router.use(auth.authRequired);

// Remove every business record but keep the family's user accounts.
// A marker is stored so the demo seed never repopulates an emptied database.
router.post('/clear-demo-data', auth.requireRole('super_admin'), asyncHandler(async (req, res) => {
  for (const table of [
    'electricity_readings', 'electricity_meters', 'room_electricity_bills',
    'dues', 'payments', 'files', 'tenants', 'expenses', 'rooms',
  ]) {
    await db.run(`DELETE FROM ${table}`);
  }
  const marker = await db.get("SELECT key FROM app_meta WHERE key = 'demo_cleared'");
  if (marker) {
    await db.run("UPDATE app_meta SET value = '1' WHERE key = 'demo_cleared'");
  } else {
    await db.run("INSERT INTO app_meta (key, value) VALUES ('demo_cleared', '1')");
  }
  await logActivity(req, 'cleared', 'demo-data', null, 'Rooms, tenants, payments, dues, expenses and meters removed');
  notify(req, 'demo-data', 'cleared');
  res.json({ ok: true });
}));

// Download the whole rent book as a single JSON file. Passwords and uploaded
// document contents are deliberately left out; everything else is included.
router.get('/backup', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const tables = {
    users: 'SELECT id, name, username, role, active, created_at FROM users ORDER BY id',
    rooms: 'SELECT * FROM rooms ORDER BY id',
    room_electricity_bills: 'SELECT * FROM room_electricity_bills ORDER BY month, room_id',
    tenants: 'SELECT * FROM tenants ORDER BY id',
    payments: 'SELECT * FROM payments ORDER BY id',
    dues: 'SELECT * FROM dues ORDER BY id',
    expenses: 'SELECT * FROM expenses ORDER BY id',
    electricity_meters: 'SELECT * FROM electricity_meters ORDER BY id',
    electricity_readings: 'SELECT * FROM electricity_readings ORDER BY id',
    files: 'SELECT id, filename, mime, size, tenant_id, kind, uploaded_by, created_at FROM files ORDER BY id',
    activity: 'SELECT * FROM activity ORDER BY id',
    share_links: 'SELECT * FROM share_links ORDER BY id',
    app_meta: 'SELECT * FROM app_meta ORDER BY key',
  };
  const data = {};
  for (const [name, sql] of Object.entries(tables)) {
    data[name] = await db.query(sql);
  }
  const payload = {
    app: 'RentFlow',
    version: 1,
    generated_at: new Date().toISOString(),
    note: 'User passwords and uploaded file contents are not included in this backup.',
    data,
  };
  await logActivity(req, 'downloaded', 'backup', null, 'Full JSON data backup');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="rentflow-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify(payload, null, 2));
}));

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  // BOM keeps ₹ and Hindi text readable when opened in Excel.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

const CSV_EXPORTS = {
  payments: {
    filename: 'payments',
    sql: `SELECT p.month, p.receipt_no, t.name AS tenant, r.room_no AS room, p.rent_amount,
                 p.extra_charges, p.dues_adjusted, p.amount, p.remaining, p.mode, p.reference,
                 p.note, u.name AS received_by, p.created_at
          FROM payments p
          LEFT JOIN tenants t ON t.id = p.tenant_id
          LEFT JOIN rooms r ON r.id = p.room_id
          LEFT JOIN users u ON u.id = p.created_by
          ORDER BY p.month DESC, p.id DESC`,
    headers: ['Month', 'Receipt', 'Tenant', 'Room', 'Rent', 'Extra', 'Due adjusted', 'Received',
      'Pending', 'Mode', 'Reference', 'Note', 'Received by', 'Created at'],
    map: (r) => [r.month, r.receipt_no, r.tenant, r.room, r.rent_amount, r.extra_charges,
      r.dues_adjusted, r.amount, r.remaining, r.mode, r.reference, r.note, r.received_by, r.created_at],
  },
  dues: {
    filename: 'dues',
    sql: `SELECT d.month, t.name AS tenant, r.room_no AS room, d.amount, d.reason, d.settled, d.created_at
          FROM dues d
          LEFT JOIN tenants t ON t.id = d.tenant_id
          LEFT JOIN rooms r ON r.id = t.room_id
          ORDER BY d.month DESC, d.id DESC`,
    headers: ['Month', 'Tenant', 'Room', 'Amount', 'Reason', 'Settled', 'Created at'],
    map: (r) => [r.month, r.tenant, r.room, r.amount, r.reason, r.settled ? 'Yes' : 'No', r.created_at],
  },
  tenants: {
    filename: 'tenants',
    sql: `SELECT t.name, r.room_no AS room, t.phone, t.email, t.join_date, t.active, t.notes, t.created_at
          FROM tenants t LEFT JOIN rooms r ON r.id = t.room_id ORDER BY t.active DESC, r.room_no`,
    headers: ['Name', 'Room', 'Phone', 'Email', 'Joined', 'Active', 'Notes', 'Created at'],
    map: (r) => [r.name, r.room, r.phone, r.email, r.join_date, r.active ? 'Yes' : 'No', r.notes, r.created_at],
  },
  rooms: {
    filename: 'rooms',
    sql: 'SELECT room_no, floor, address, rent, electricity_bill, notes, created_at FROM rooms ORDER BY room_no',
    headers: ['Room', 'Floor', 'Address', 'Rent', 'Electricity bill', 'Notes', 'Created at'],
    map: (r) => [r.room_no, r.floor, r.address, r.rent, r.electricity_bill, r.notes, r.created_at],
  },
  expenses: {
    filename: 'expenses',
    sql: 'SELECT expense_date, title, category, amount, note, created_at FROM expenses ORDER BY expense_date DESC',
    headers: ['Date', 'Title', 'Category', 'Amount', 'Note', 'Created at'],
    map: (r) => [r.expense_date, r.title, r.category, r.amount, r.note, r.created_at],
  },
  electricity: {
    filename: 'electricity-readings',
    sql: `SELECT e.month, r.room_no AS room, m.meter_no, m.provider, e.reading, e.previous_reading,
                 e.units, e.amount, e.status, e.bill_date, e.due_date
          FROM electricity_readings e
          LEFT JOIN electricity_meters m ON m.id = e.meter_id
          LEFT JOIN rooms r ON r.id = m.room_id
          ORDER BY e.month DESC, r.room_no`,
    headers: ['Month', 'Room', 'Meter', 'Provider', 'Reading', 'Previous', 'Units', 'Amount', 'Status', 'Bill date', 'Due date'],
    map: (r) => [r.month, r.room, r.meter_no, r.provider, r.reading, r.previous_reading,
      r.units, r.amount, r.status, r.bill_date, r.due_date],
  },
  bills: {
    filename: 'electricity-bills',
    sql: `SELECT b.month, r.room_no AS room, b.amount, b.updated_at
          FROM room_electricity_bills b LEFT JOIN rooms r ON r.id = b.room_id
          ORDER BY b.month DESC, r.room_no`,
    headers: ['Month', 'Room', 'Amount', 'Updated at'],
    map: (r) => [r.month, r.room, r.amount, r.updated_at],
  },
};

router.get('/export/:type.csv', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const spec = CSV_EXPORTS[req.params.type];
  if (!spec) return res.status(404).json({ error: 'Unknown export type.' });
  const rows = await db.query(spec.sql);
  const csv = toCsv(spec.headers, rows.map(spec.map));
  await logActivity(req, 'downloaded', 'csv', null, `${spec.filename}.csv`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="rentflow-${spec.filename}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

module.exports = router;
