'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { asyncHandler, logActivity, notify, num, describeChanges } = require('../utils');

const METER_FIELDS = ['meter_no', 'ca_number', 'provider', 'rate_per_unit', 'notes'];
const READING_FIELDS = ['month', 'reading', 'previous_reading', 'units', 'amount', 'bill_date', 'due_date', 'status', 'source'];

const router = express.Router();
router.use(auth.authRequired);

const PROVIDER_LINKS = {
  'BSES Rajdhani': 'https://www.bsesdelhi.com/web/brpl/know-your-bill',
  'BSES Yamuna': 'https://www.bsesdelhi.com/web/bypl/know-your-bill',
};
const DEFAULT_LINK = 'https://www.bsesdelhi.com/';
const write = auth.requireRole('admin', 'super_admin');

function providerLink(provider) {
  return PROVIDER_LINKS[provider] || DEFAULT_LINK;
}
function validMonth(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''));
}

async function recalcMeter(meterId) {
  const rows = await db.query(
    'SELECT id, reading FROM electricity_readings WHERE meter_id = ? ORDER BY month ASC', [meterId]
  );
  let previous = null;
  for (const row of rows) {
    const reading = num(row.reading);
    // The earliest reading is only a baseline — there is no earlier reading to subtract.
    const units = previous === null ? 0 : Math.max(0, Math.round((reading - previous) * 100) / 100);
    await db.run('UPDATE electricity_readings SET previous_reading = ?, units = ? WHERE id = ?',
      [previous === null ? reading : previous, units, row.id]);
    previous = reading;
  }
}

async function findMeter(roomId) {
  return db.get('SELECT * FROM electricity_meters WHERE room_id = ?', [roomId]);
}

async function saveReading(meter, input) {
  const month = String(input.month || '').slice(0, 7);
  const reading = num(input.reading);
  const rate = num(meter.rate_per_unit);
  const hasPrevious = input.previous_reading !== undefined && input.previous_reading !== null && input.previous_reading !== '';
  const units = hasPrevious ? Math.max(0, Math.round((reading - num(input.previous_reading)) * 100) / 100) : 0;
  const amount = input.amount !== undefined && input.amount !== null && input.amount !== ''
    ? Math.round(num(input.amount))
    : Math.round(units * rate);
  const existing = await db.get(
    'SELECT id FROM electricity_readings WHERE meter_id = ? AND month = ?', [meter.id, month]
  );
  const values = [
    month, reading, num(input.previous_reading), units, amount,
    input.bill_date || null, input.due_date || null,
    input.status || 'pending', input.source || 'manual',
  ];
  if (existing) {
    await db.run(`UPDATE electricity_readings SET month=?, reading=?, previous_reading=?, units=?, amount=?,
      bill_date=?, due_date=?, status=?, source=? WHERE id=? RETURNING id`, [...values, existing.id]);
  } else {
    await db.run(`INSERT INTO electricity_readings
      (month, reading, previous_reading, units, amount, bill_date, due_date, status, source, meter_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [...values, meter.id]);
  }
  await recalcMeter(meter.id);
}

// Config + one row per flat/room, with its latest and selected-month reading.
router.get('/', asyncHandler(async (req, res) => {
  const month = validMonth(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
  const meters = await db.query(`
    SELECT r.id AS room_id, r.room_no, r.floor,
      t.name AS tenant_name,
      m.id AS meter_id, m.meter_no, m.ca_number, m.provider, m.rate_per_unit, m.notes,
      last.month AS last_month, last.reading AS last_reading, last.units AS last_units,
      last.amount AS last_amount,
      cur.month AS current_month, cur.reading AS current_reading, cur.units AS current_units,
      cur.amount AS current_amount, cur.status AS current_status
    FROM rooms r
    LEFT JOIN electricity_meters m ON m.room_id = r.id
    LEFT JOIN tenants t ON t.room_id = r.id AND t.active = 1
    LEFT JOIN electricity_readings last ON last.id = (
      SELECT er.id FROM electricity_readings er WHERE er.meter_id = m.id
      ORDER BY er.month DESC LIMIT 1)
    LEFT JOIN electricity_readings cur ON cur.id = (
      SELECT er.id FROM electricity_readings er WHERE er.meter_id = m.id AND er.month = ? LIMIT 1)
    ORDER BY CAST(r.room_no AS INTEGER), r.room_no`, [month]);
  res.json({
    month,
    config: {
      apiConfigured: !!process.env.ELECTRICITY_API_URL,
      providerLinks: PROVIDER_LINKS,
      defaultLink: DEFAULT_LINK,
    },
    meters,
  });
}));

router.put('/meters/:roomId', write, asyncHandler(async (req, res) => {
  const room = await db.get('SELECT id, room_no FROM rooms WHERE id = ?', [req.params.roomId]);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  const { meter_no, ca_number, provider, rate_per_unit, notes } = req.body || {};
  if (!meter_no || !String(meter_no).trim()) return res.status(400).json({ error: 'Meter number is required.' });
  const existing = await findMeter(room.id);
  const after = {
    meter_no: String(meter_no).trim(), ca_number: ca_number ? String(ca_number).trim() : null,
    provider: provider || 'BSES Rajdhani', rate_per_unit: num(rate_per_unit), notes: notes || null,
  };
  const values = [after.meter_no, after.ca_number, after.provider, after.rate_per_unit, after.notes];
  if (existing) {
    await db.run(`UPDATE electricity_meters SET meter_no=?, ca_number=?, provider=?, rate_per_unit=?, notes=?
      WHERE id=? RETURNING id`, [...values, existing.id]);
  } else {
    await db.run(`INSERT INTO electricity_meters (room_id, meter_no, ca_number, provider, rate_per_unit, notes)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, [room.id, ...values]);
  }
  await logActivity(req, 'updated', 'electricity', room.id,
    `Room ${room.room_no} · ${describeChanges(existing || {}, after, METER_FIELDS)}`);
  notify(req, 'electricity', 'updated');
  res.json({ ok: true });
}));

router.delete('/meters/:id', write, asyncHandler(async (req, res) => {
  const meter = await db.get('SELECT * FROM electricity_meters WHERE id = ?', [req.params.id]);
  if (!meter) return res.status(404).json({ error: 'Meter not found.' });
  await db.run('DELETE FROM electricity_meters WHERE id = ? RETURNING id', [meter.id]);
  await logActivity(req, 'deleted', 'electricity', meter.id, describeChanges(meter, {}, METER_FIELDS));
  notify(req, 'electricity', 'deleted');
  res.json({ ok: true });
}));

router.get('/readings/:roomId', asyncHandler(async (req, res) => {
  const meter = await findMeter(req.params.roomId);
  if (!meter) return res.json({ meter: null, readings: [] });
  const readings = await db.query(
    'SELECT * FROM electricity_readings WHERE meter_id = ? ORDER BY month DESC', [meter.id]
  );
  res.json({ meter, readings });
}));

router.post('/readings', write, asyncHandler(async (req, res) => {
  const input = req.body || {};
  if (!validMonth(input.month)) return res.status(400).json({ error: 'Choose a valid billing month.' });
  const meter = await findMeter(input.roomId);
  if (!meter) return res.status(400).json({ error: 'Add the meter for this flat first.' });
  if (input.reading === undefined || input.reading === '' || !Number.isFinite(Number(input.reading))) {
    return res.status(400).json({ error: 'Enter the current meter reading.' });
  }
  const previous = await db.get(
    'SELECT reading FROM electricity_readings WHERE meter_id = ? AND month < ? ORDER BY month DESC LIMIT 1',
    [meter.id, input.month]
  );
  const month = String(input.month || '').slice(0, 7);
  const before = await db.get('SELECT * FROM electricity_readings WHERE meter_id = ? AND month = ?', [meter.id, month]);
  await saveReading(meter, { ...input, previous_reading: previous ? previous.reading : null, source: 'manual' });
  const after = await db.get('SELECT * FROM electricity_readings WHERE meter_id = ? AND month = ?', [meter.id, month]);
  await logActivity(req, 'recorded', 'electricity', meter.id, describeChanges(before || {}, after || {}, READING_FIELDS));
  notify(req, 'electricity', 'reading-added');
  res.json({ ok: true });
}));

router.post('/readings/import', write, asyncHandler(async (req, res) => {
  const input = req.body || {};
  const meter = await findMeter(input.roomId);
  if (!meter) return res.status(400).json({ error: 'Add the meter for this flat first.' });
  const rows = Array.isArray(input.readings) ? input.readings : [];
  let saved = 0;
  for (const row of rows) {
    if (!validMonth(row.month) || !Number.isFinite(Number(row.reading))) continue;
    const previous = await db.get(
      'SELECT reading FROM electricity_readings WHERE meter_id = ? AND month < ? ORDER BY month DESC LIMIT 1',
      [meter.id, row.month]
    );
    await saveReading(meter, { ...row, previous_reading: previous ? previous.reading : null, source: 'online' });
    saved += 1;
  }
  const imported = rows.filter((row) => validMonth(row.month) && Number.isFinite(Number(row.reading)))
    .slice(0, 20).map((row) => `${row.month}: reading ${num(row.reading)}`).join(' · ');
  await logActivity(req, 'imported', 'electricity', meter.id,
    `${saved} online reading(s)${imported ? ` · ${imported}` : ''}`);
  notify(req, 'electricity', 'imported');
  res.json({ ok: true, saved });
}));

router.delete('/readings/:id', write, asyncHandler(async (req, res) => {
  const row = await db.get(`SELECT er.* FROM electricity_readings er
    WHERE er.id = ?`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Reading not found.' });
  await db.run('DELETE FROM electricity_readings WHERE id = ? RETURNING id', [row.id]);
  await recalcMeter(row.meter_id);
  await logActivity(req, 'deleted', 'electricity', row.meter_id, describeChanges(row, {}, READING_FIELDS));
  notify(req, 'electricity', 'reading-deleted');
  res.json({ ok: true });
}));

// Online fetch. BSES has no public API, so this uses a provider adapter when configured.
router.post('/fetch', write, asyncHandler(async (req, res) => {
  const input = req.body || {};
  const endpoint = process.env.ELECTRICITY_API_URL;
  const provider = input.provider || 'BSES Rajdhani';
  if (!endpoint) {
    return res.status(400).json({
      error: 'No electricity data provider is configured on this server.',
      code: 'NO_PROVIDER',
      providerLink: providerLink(provider),
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.ELECTRICITY_API_KEY ? { Authorization: `Bearer ${process.env.ELECTRICITY_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        meterNo: input.meter_no, caNumber: input.ca_number, provider,
        fromMonth: input.fromMonth, toMonth: input.toMonth,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return res.status(502).json({ error: `Electricity provider returned HTTP ${response.status}.` });
  const data = await response.json().catch(() => ({}));
  const raw = Array.isArray(data.readings) ? data.readings : (data.month ? [data] : []);
  const readings = raw.map((r) => ({
    month: String(r.month || '').slice(0, 7),
    reading: num(r.reading),
    amount: num(r.amount),
    bill_date: r.bill_date || r.billDate || null,
    due_date: r.due_date || r.dueDate || null,
    status: r.status || 'pending',
  })).filter((r) => validMonth(r.month));
  res.json({ readings, source: 'online', providerLink: providerLink(provider) });
}));

module.exports = router;
