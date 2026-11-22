'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const data = require('../lib/data');
const { asyncHandler, logActivity, notify, num, currentMonth, monthLabel, describeChanges } = require('../utils');

const ROOM_FIELDS = ['room_no', 'floor', 'address', 'rent', 'electricity_bill', 'notes'];

function billMonth(value) {
  const month = String(value || '');
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : currentMonth();
}

async function saveMonthBill(roomId, month, amount) {
  const existing = await db.get(
    'SELECT id FROM room_electricity_bills WHERE room_id = ? AND month = ?', [roomId, month]
  );
  if (existing) {
    await db.run(
      'UPDATE room_electricity_bills SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id',
      [amount, existing.id]
    );
    return existing.amount;
  }
  await db.run('INSERT INTO room_electricity_bills (room_id, month, amount) VALUES (?, ?, ?) RETURNING id',
    [roomId, month, amount]);
  return 0;
}

const router = express.Router();
router.use(auth.authRequired);

router.get('/', asyncHandler(async (req, res) => {
  res.json({ rooms: await data.listRooms(req.query.month || currentMonth()) });
}));

router.post('/', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const { room_no, floor, address, rent, electricity_bill, notes, month } = req.body || {};
  if (!room_no || !String(room_no).trim()) return res.status(400).json({ error: 'Room number is required.' });
  const exists = await db.get('SELECT id FROM rooms WHERE room_no = ?', [String(room_no).trim()]);
  if (exists) return res.status(400).json({ error: 'A room with that number already exists.' });
  const billMonthValue = billMonth(month);
  const billAmount = Math.max(0, num(electricity_bill));
  const created = {
    room_no: String(room_no).trim(), floor: floor || null, address: address || null,
    rent: num(rent), electricity_bill: billAmount, notes: notes || null,
  };
  const result = await db.run(
    'INSERT INTO rooms (room_no, floor, address, rent, electricity_bill, notes) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [created.room_no, created.floor, created.address, created.rent, created.electricity_bill, created.notes]
  );
  if (billAmount) await saveMonthBill(result.lastId, billMonthValue, billAmount);
  await logActivity(req, 'created', 'room', result.lastId,
    `Room ${created.room_no} · ${monthLabel(billMonthValue)} · ${describeChanges({}, created, ROOM_FIELDS)}`);
  notify(req, 'rooms', 'created');
  res.status(201).json({ id: result.lastId, rooms: await data.listRooms(billMonthValue) });
}));

router.put('/:id', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const id = req.params.id;
  const room = await db.get('SELECT * FROM rooms WHERE id = ?', [id]);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  const { room_no, floor, address, rent, electricity_bill, notes, month } = req.body || {};
  const billMonthValue = billMonth(month);
  const billRow = await db.get(
    'SELECT amount FROM room_electricity_bills WHERE room_id = ? AND month = ?', [room.id, billMonthValue]
  );
  const oldBill = billRow ? num(billRow.amount) : 0;
  const newBill = electricity_bill !== undefined ? Math.max(0, num(electricity_bill)) : oldBill;
  const updated = {
    room_no: room_no || room.room_no,
    floor: floor ?? room.floor,
    address: address ?? room.address,
    rent: rent !== undefined ? num(rent) : room.rent,
    electricity_bill: newBill,
    notes: notes ?? room.notes,
  };
  await db.run(
    `UPDATE rooms SET room_no = ?, floor = ?, address = ?, rent = ?, electricity_bill = ?, notes = ?
     WHERE id = ? RETURNING id`,
    [updated.room_no, updated.floor, updated.address, updated.rent, newBill, updated.notes, id]
  );
  if (electricity_bill !== undefined) await saveMonthBill(room.id, billMonthValue, newBill);
  const diff = describeChanges({ ...room, electricity_bill: oldBill }, updated, ROOM_FIELDS);
  await logActivity(req, 'updated', 'room', id,
    `Room ${updated.room_no} · ${monthLabel(billMonthValue)} · ${diff || 'no values changed'}`);
  notify(req, 'rooms', 'updated');
  res.json({ rooms: await data.listRooms(billMonthValue) });
}));

router.delete('/:id', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const room = await db.get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  const active = await db.get('SELECT id FROM tenants WHERE room_id = ? AND active = 1', [room.id]);
  if (active) return res.status(400).json({ error: 'Vacate the tenant in this room before deleting it.' });
  await db.run('DELETE FROM rooms WHERE id = ? RETURNING id', [room.id]);
  await logActivity(req, 'deleted', 'room', room.id,
    `Room ${room.room_no} · ${describeChanges(room, {}, ROOM_FIELDS)}`);
  notify(req, 'rooms', 'deleted');
  res.json({ ok: true });
}));

module.exports = router;
