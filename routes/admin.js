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
    'electricity_readings', 'electricity_meters', 'dues', 'payments',
    'files', 'tenants', 'expenses', 'rooms',
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

module.exports = router;
