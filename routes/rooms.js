'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const data = require('../lib/data');
const { asyncHandler, logActivity, notify, num, currentMonth } = require('../utils');

const router = express.Router();
router.use(auth.authRequired);

router.get('/', asyncHandler(async (req, res) => {
  res.json({ rooms: await data.listRooms(req.query.month || currentMonth()) });
}));

router.post('/', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const { room_no, floor, address, rent, notes } = req.body || {};
  if (!room_no || !String(room_no).trim()) return res.status(400).json({ error: 'Room number is required.' });
  const exists = await db.get('SELECT id FROM rooms WHERE room_no = ?', [String(room_no).trim()]);
  if (exists) return res.status(400).json({ error: 'A room with that number already exists.' });
  const result = await db.run(
    'INSERT INTO rooms (room_no, floor, address, rent, notes) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [String(room_no).trim(), floor || null, address || null, num(rent), notes || null]
  );
  await logActivity(req, 'created', 'room', result.lastId, `Room ${room_no}`);
  notify(req, 'rooms', 'created');
  res.status(201).json({ id: result.lastId, rooms: await data.listRooms() });
}));

router.put('/:id', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const id = req.params.id;
  const room = await db.get('SELECT * FROM rooms WHERE id = ?', [id]);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  const { room_no, floor, address, rent, notes } = req.body || {};
  await db.run(
    'UPDATE rooms SET room_no = ?, floor = ?, address = ?, rent = ?, notes = ? WHERE id = ? RETURNING id',
    [room_no || room.room_no, floor ?? room.floor, address ?? room.address,
      rent !== undefined ? num(rent) : room.rent, notes ?? room.notes, id]
  );
  await logActivity(req, 'updated', 'room', id, `Room ${room_no || room.room_no}`);
  notify(req, 'rooms', 'updated');
  res.json({ rooms: await data.listRooms() });
}));

router.delete('/:id', auth.requireRole('admin', 'super_admin'), asyncHandler(async (req, res) => {
  const room = await db.get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  const active = await db.get('SELECT id FROM tenants WHERE room_id = ? AND active = 1', [room.id]);
  if (active) return res.status(400).json({ error: 'Vacate the tenant in this room before deleting it.' });
  await db.run('DELETE FROM rooms WHERE id = ? RETURNING id', [room.id]);
  await logActivity(req, 'deleted', 'room', room.id, `Room ${room.room_no}`);
  notify(req, 'rooms', 'deleted');
  res.json({ ok: true });
}));

module.exports = router;
