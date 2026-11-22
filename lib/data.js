'use strict';

const db = require('../db');
const { currentMonth, monthLabel, shiftMonth, num } = require('../utils');

async function billsForMonth(month) {
  const rows = await db.query('SELECT room_id, amount FROM room_electricity_bills WHERE month = ?', [month]);
  return new Map(rows.map((r) => [Number(r.room_id), num(r.amount)]));
}

async function listRooms(month = currentMonth()) {
  const [rooms, tenants, payments, dues, bills] = await Promise.all([
    db.query('SELECT * FROM rooms ORDER BY CAST(room_no AS INTEGER), room_no'),
    db.query('SELECT * FROM tenants WHERE active = 1'),
    db.query('SELECT * FROM payments WHERE month = ?', [month]),
    db.query('SELECT * FROM dues WHERE settled = 0'),
    billsForMonth(month),
  ]);

  return rooms.map((room) => {
    const tenant = tenants.find((t) => t.room_id === room.id) || null;
    const paid = payments.filter((p) => p.tenant_id === tenant?.id).reduce((s, p) => s + num(p.amount), 0);
    const roomDues = dues.filter((d) => d.tenant_id === tenant?.id).reduce((s, d) => s + num(d.amount), 0);
    const bill = bills.get(Number(room.id)) || 0;
    return {
      ...room,
      electricity_bill: bill,
      tenant: tenant ? { id: tenant.id, name: tenant.name, phone: tenant.phone } : null,
      collected: paid,
      pending: tenant ? Math.max(0, num(room.rent) + bill - paid) + roomDues : 0,
    };
  });
}

async function listTenants(includeInactive = false) {
  const where = includeInactive ? '' : 'WHERE t.active = 1';
  const tenants = await db.query(`
    SELECT t.*, r.room_no, r.floor, r.rent AS room_rent
    FROM tenants t LEFT JOIN rooms r ON r.id = t.room_id
    ${where}
    ORDER BY t.active DESC, CAST(r.room_no AS INTEGER), t.name
  `);
  const dues = await db.query('SELECT * FROM dues WHERE settled = 0');
  const payments = await db.query('SELECT * FROM payments ORDER BY created_at DESC');
  return tenants.map((t) => {
    const last = payments.find((p) => p.tenant_id === t.id) || null;
    return {
      ...t,
      due_total: dues.filter((d) => d.tenant_id === t.id).reduce((s, d) => s + num(d.amount), 0),
      due_count: dues.filter((d) => d.tenant_id === t.id).length,
      last_payment: last ? { amount: last.amount, month: last.month, created_at: last.created_at } : null,
    };
  });
}

async function tenantDetail(id) {
  const tenant = await db.get(`
    SELECT t.*, r.room_no, r.floor, r.rent AS room_rent
    FROM tenants t LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?
  `, [id]);
  if (!tenant) return null;
  const payments = await db.query('SELECT * FROM payments WHERE tenant_id = ? ORDER BY month DESC, id DESC', [id]);
  const dues = await db.query('SELECT * FROM dues WHERE tenant_id = ? ORDER BY settled ASC, month DESC, id DESC', [id]);
  const documents = await db.query(`
    SELECT f.id, f.filename, f.mime, f.size, f.kind, f.created_at, u.name AS uploaded_by_name
    FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
    WHERE f.tenant_id = ? ORDER BY f.created_at DESC
  `, [id]);
  return {
    tenant,
    payments,
    dues,
    documents,
    due_total: dues.filter((d) => !d.settled).reduce((s, d) => s + num(d.amount), 0),
    paid_total: payments.reduce((s, p) => s + num(p.amount), 0),
  };
}

async function listPayments(filters = {}) {
  let sql = `
    SELECT p.*, t.name AS tenant_name, t.phone AS tenant_phone, r.room_no, u.name AS received_by
    FROM payments p
    LEFT JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN rooms r ON r.id = p.room_id
    LEFT JOIN users u ON u.id = p.created_by
    WHERE 1 = 1
  `;
  const params = [];
  if (filters.month) { sql += ' AND p.month = ?'; params.push(filters.month); }
  if (filters.tenantId) { sql += ' AND p.tenant_id = ?'; params.push(filters.tenantId); }
  if (filters.from) { sql += ' AND p.month >= ?'; params.push(filters.from); }
  if (filters.to) { sql += ' AND p.month <= ?'; params.push(filters.to); }
  sql += ' ORDER BY p.month DESC, p.id DESC LIMIT 500';
  return db.query(sql, params);
}

async function listDues(filters = {}) {
  let sql = `
    SELECT d.*, t.name AS tenant_name, t.phone AS tenant_phone, r.room_no, r.rent AS room_rent
    FROM dues d
    JOIN tenants t ON t.id = d.tenant_id
    LEFT JOIN rooms r ON r.id = t.room_id
    WHERE 1 = 1
  `;
  const params = [];
  if (filters.settled === false || filters.settled === '0') sql += ' AND d.settled = 0';
  else if (filters.settled === true || filters.settled === '1') sql += ' AND d.settled = 1';
  if (filters.tenantId) { sql += ' AND d.tenant_id = ?'; params.push(filters.tenantId); }
  sql += ' ORDER BY d.settled ASC, d.month ASC, d.id DESC LIMIT 500';
  return db.query(sql, params);
}

function monthRange(from, to) {
  const out = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard++ < 60) {
    out.push(cur);
    cur = shiftMonth(cur, 1);
  }
  return out;
}

async function dashboard(month = currentMonth()) {
  const [payments, dues, expenses, rooms, tenants, activity, bills] = await Promise.all([
    db.query('SELECT * FROM payments'),
    db.query('SELECT * FROM dues WHERE settled = 0'),
    db.query('SELECT * FROM expenses'),
    db.query('SELECT * FROM rooms'),
    db.query('SELECT * FROM tenants WHERE active = 1'),
    db.query(`
      SELECT a.*, u.name AS user_name FROM activity a
      LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 12
    `),
    billsForMonth(month),
  ]);

  const sum = (arr, key) => arr.reduce((s, x) => s + num(x[key]), 0);
  const year = String(new Date().getFullYear());
  const thisMonthPayments = payments.filter((p) => p.month === month);
  const thisMonthExpenses = expenses.filter((e) => String(e.expense_date).slice(0, 7) === month);

  const tenantPending = tenants.map((t) => {
    const room = rooms.find((r) => r.id === t.room_id);
    const paid = sum(thisMonthPayments.filter((p) => p.tenant_id === t.id), 'amount');
    const d = sum(dues.filter((x) => x.tenant_id === t.id), 'amount');
    return {
      tenant_id: t.id,
      name: t.name,
      room_no: room ? room.room_no : '-',
      rent: room ? num(room.rent) : 0,
      electricity_bill: room ? bills.get(Number(room.id)) || 0 : 0,
      paid,
      dues: d,
      pending: Math.max(0, (room ? num(room.rent) : 0)
        + (room ? bills.get(Number(room.id)) || 0 : 0) - paid) + d,
    };
  }).filter((x) => x.pending > 0).sort((a, b) => b.pending - a.pending);

  const months = monthRange(shiftMonth(month, -5), month).map((m) => ({
    month: m,
    label: monthLabel(m),
    collection: sum(payments.filter((p) => p.month === m), 'amount'),
    expense: sum(expenses.filter((e) => String(e.expense_date).slice(0, 7) === m), 'amount'),
  }));

  return {
    month,
    month_label: monthLabel(month),
    collection_this_month: sum(thisMonthPayments, 'amount'),
    expense_this_month: sum(thisMonthExpenses, 'amount'),
    income_this_year: sum(payments.filter((p) => String(p.month).slice(0, 4) === year), 'amount'),
    expense_this_year: sum(expenses.filter((e) => String(e.expense_date).slice(0, 4) === year), 'amount'),
    pending_total: tenantPending.reduce((s, x) => s + x.pending, 0),
    dues_total: sum(dues, 'amount'),
    occupied_rooms: tenants.length,
    total_rooms: rooms.length,
    recent_payments: await listPayments({ month }),
    pending_tenants: tenantPending.slice(0, 6),
    months,
    activity,
  };
}

async function reports(month = currentMonth()) {
  const [payments, expenses, dues, tenants, rooms, bills] = await Promise.all([
    db.query('SELECT * FROM payments'),
    db.query('SELECT * FROM expenses'),
    db.query('SELECT * FROM dues WHERE settled = 0'),
    db.query('SELECT * FROM tenants WHERE active = 1'),
    db.query('SELECT * FROM rooms'),
    billsForMonth(month),
  ]);
  const sum = (arr, key) => arr.reduce((s, x) => s + num(x[key]), 0);
  const year = String(new Date().getFullYear());
  const last12 = monthRange(shiftMonth(month, -11), month);
  const monthly = last12.map((m) => ({
    month: m,
    label: monthLabel(m),
    collection: sum(payments.filter((p) => p.month === m), 'amount'),
    expense: sum(expenses.filter((e) => String(e.expense_date).slice(0, 7) === m), 'amount'),
  }));
  const categoryMap = {};
  for (const e of expenses.filter((x) => String(x.expense_date).slice(0, 4) === year)) {
    categoryMap[e.category] = (categoryMap[e.category] || 0) + num(e.amount);
  }
  const pending = tenants.map((t) => {
    const room = rooms.find((r) => r.id === t.room_id);
    const paid = sum(payments.filter((p) => p.tenant_id === t.id && p.month === month), 'amount');
    const d = sum(dues.filter((x) => x.tenant_id === t.id), 'amount');
    return {
      tenant_id: t.id,
      name: t.name,
      room_no: room ? room.room_no : '-',
      rent: room ? num(room.rent) : 0,
      electricity_bill: room ? bills.get(Number(room.id)) || 0 : 0,
      paid,
      dues: d,
      pending: Math.max(0, (room ? num(room.rent) : 0)
        + (room ? bills.get(Number(room.id)) || 0 : 0) - paid) + d,
    };
  }).filter((x) => x.pending > 0).sort((a, b) => b.pending - a.pending);

  const byRoom = rooms.map((r) => {
    const t = tenants.find((x) => x.room_id === r.id);
    return {
      room_no: r.room_no,
      tenant: t ? t.name : '-',
      collected: sum(payments.filter((p) => p.room_id === r.id && String(p.month).slice(0, 4) === year), 'amount'),
    };
  }).sort((a, b) => b.collected - a.collected);

  return {
    month,
    monthly,
    year,
    yearly_collection: sum(payments.filter((p) => String(p.month).slice(0, 4) === year), 'amount'),
    yearly_expense: sum(expenses.filter((e) => String(e.expense_date).slice(0, 4) === year), 'amount'),
    pending,
    pending_total: pending.reduce((s, x) => s + x.pending, 0),
    categories: Object.entries(categoryMap).map(([name, total]) => ({ name, total })),
    by_room: byRoom,
    expense_list: expenses.slice().sort((a, b) => String(b.expense_date).localeCompare(String(a.expense_date))).slice(0, 20),
  };
}

module.exports = {
  listRooms,
  listTenants,
  tenantDetail,
  listPayments,
  listDues,
  dashboard,
  reports,
};
