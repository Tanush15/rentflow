'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL || '';
const usePostgres = /^postgres(ql)?:\/\//i.test(DATABASE_URL);

let pool = null;
let sqlite = null;

if (usePostgres) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSL === 'false' ? undefined : { rejectUnauthorized: false },
    max: 5,
  });
} else {
  const Database = require('better-sqlite3');
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  sqlite = new Database(path.join(dataDir, 'rentflow.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
}

const ID = usePostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const BLOB = usePostgres ? 'BYTEA' : 'BLOB';

function toPg(sql, params) {
  let i = 0;
  return {
    text: sql.replace(/\?/g, () => `$${++i}`),
    values: params,
  };
}

async function query(sql, params = []) {
  if (usePostgres) {
    const { text, values } = toPg(sql, params);
    const res = await pool.query(text, values);
    return res.rows;
  }
  return sqlite.prepare(sql).all(...params);
}

async function get(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function run(sql, params = []) {
  if (usePostgres) {
    const { text, values } = toPg(sql, params);
    const res = await pool.query(text, values);
    return {
      changes: res.rowCount || 0,
      lastId: res.rows && res.rows[0] ? Number(res.rows[0].id) : null,
    };
  }
  const info = sqlite.prepare(sql).run(...params);
  return { changes: info.changes, lastId: Number(info.lastInsertRowid) };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id ${ID},
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rooms (
  id ${ID},
  room_no TEXT NOT NULL UNIQUE,
  floor TEXT,
  address TEXT,
  rent INTEGER NOT NULL DEFAULT 0,
  electricity_bill INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS tenants (
  id ${ID},
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  join_date DATE,
  photo_file_id INTEGER,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id ${ID},
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  rent_amount INTEGER NOT NULL DEFAULT 0,
  extra_charges INTEGER NOT NULL DEFAULT 0,
  dues_adjusted INTEGER NOT NULL DEFAULT 0,
  remaining INTEGER NOT NULL DEFAULT 0,
  mode TEXT DEFAULT 'cash',
  reference TEXT,
  note TEXT,
  receipt_no TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dues (
  id ${ID},
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT 'Carry forward',
  settled INTEGER NOT NULL DEFAULT 0,
  settled_payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  source_payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS expenses (
  id ${ID},
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  amount INTEGER NOT NULL,
  expense_date DATE NOT NULL,
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS electricity_meters (
  id ${ID},
  room_id INTEGER NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
  meter_no TEXT NOT NULL,
  ca_number TEXT,
  provider TEXT NOT NULL DEFAULT 'BSES Rajdhani',
  rate_per_unit REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS electricity_readings (
  id ${ID},
  meter_id INTEGER NOT NULL REFERENCES electricity_meters(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  reading REAL NOT NULL,
  previous_reading REAL NOT NULL DEFAULT 0,
  units REAL NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,
  bill_date DATE,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'manual',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(meter_id, month)
);

CREATE TABLE IF NOT EXISTS files (
  id ${ID},
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  content ${BLOB},
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'document',
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activity (
  id ${ID},
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS share_links (
  id ${ID},
  token TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(month);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dues_tenant ON dues(tenant_id, settled);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_elec_readings_month ON electricity_readings(month);
CREATE INDEX IF NOT EXISTS idx_elec_readings_meter ON electricity_readings(meter_id, month);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
`;

async function ensureColumn(table, column, type) {
  let exists = false;
  if (usePostgres) {
    const rows = await query(
      'SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?',
      [table, column]
    );
    exists = rows.length > 0;
  } else {
    const rows = await query(`PRAGMA table_info(${table})`);
    exists = rows.some((c) => c.name === column);
  }
  if (!exists) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

async function init() {
  // Split on semicolons that end statements. Safe here: no procedural SQL bodies.
  const statements = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    if (usePostgres) await pool.query(stmt);
    else sqlite.prepare(stmt).run();
  }
  // Add newer columns to databases created before they existed.
  await ensureColumn('rooms', 'address', 'TEXT');
  await ensureColumn('rooms', 'electricity_bill', 'INTEGER NOT NULL DEFAULT 0');
  await seedIfEmpty();
}

async function seedIfEmpty() {
  const users = await query('SELECT COUNT(*) AS n FROM users');
  if (Number(users[0].n) === 0) {
    const people = [
      ['Family Admin', 'admin', 'admin123', 'super_admin'],
      ['Mom', 'mom', 'family123', 'admin'],
      ['Dad', 'dad', 'family123', 'admin'],
    ];
    for (const [name, username, password, role] of people) {
      await run(
        'INSERT INTO users (name, username, password_hash, role, active) VALUES (?, ?, ?, ?, 1) RETURNING id',
        [name, username, bcrypt.hashSync(password, 10), role]
      );
    }
  }

  // Once the family clears the demo data, never re-seed it on a later restart.
  const cleared = await get("SELECT value FROM app_meta WHERE key = 'demo_cleared'");
  if (cleared) return;
  if (process.env.SEED_DEMO === 'false') return;
  const rooms = await query('SELECT COUNT(*) AS n FROM rooms');
  const tenants = await query('SELECT COUNT(*) AS n FROM tenants');
  if (Number(rooms[0].n) > 0 && Number(tenants[0].n) > 0) return;

  // A previous seed may have failed partway (e.g. Postgres rejecting a demo DATE).
  // Clear the half-seeded demo data so this run can start clean. Users are kept.
  if (Number(rooms[0].n) > 0 || Number(tenants[0].n) > 0) {
    for (const table of ['electricity_readings', 'electricity_meters', 'dues', 'payments', 'files', 'tenants', 'expenses', 'rooms']) {
      await run(`DELETE FROM ${table}`);
    }
  }

  const roomData = [
    ['101', 'Ground', 8500, 'Main road side'],
    ['102', 'Ground', 7500, ''],
    ['103', 'First', 9000, 'Attached bathroom'],
    ['104', 'First', 6500, ''],
    ['201', 'Second', 11000, 'Two bedroom'],
    ['202', 'Second', 7000, ''],
  ];
  const roomIds = [];
  for (const [no, floor, rent, notes] of roomData) {
    const r = await run(
      'INSERT INTO rooms (room_no, floor, rent, notes) VALUES (?, ?, ?, ?) RETURNING id',
      [no, floor, rent, notes]
    );
    roomIds.push(r.lastId);
  }

  const now = new Date();
  const ym = (offset = 0) => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  // ym() returns YYYY-MM for text "month" columns. DATE columns need a full YYYY-MM-DD.
  const ds = (offset = 0) => `${ym(offset)}-01`;
  const u = await get('SELECT id FROM users WHERE username = ?', ['admin']);

  const t1 = await run(
    'INSERT INTO tenants (room_id, name, phone, join_date, notes, active) VALUES (?, ?, ?, ?, ?, 1) RETURNING id',
    [roomIds[0], 'Rahul Sharma', '9876543210', ds(-8), 'Pays by 5th every month']
  );
  const t2 = await run(
    'INSERT INTO tenants (room_id, name, phone, join_date, notes, active) VALUES (?, ?, ?, ?, ?, 1) RETURNING id',
    [roomIds[1], 'Priya Verma', '9123456780', ds(-5), '']
  );
  const t3 = await run(
    'INSERT INTO tenants (room_id, name, phone, join_date, notes, active) VALUES (?, ?, ?, ?, ?, 1) RETURNING id',
    [roomIds[2], 'Amit Kumar', '9988776655', ds(-3), '']
  );

  async function addPayment(tenantId, roomId, month, amount, rent, extra, remaining, mode) {
    const count = await query('SELECT COUNT(*) AS n FROM payments');
    const receipt = `RF/${month.replace('-', '')}/${String(Number(count[0].n) + 1).padStart(4, '0')}`;
    await run(
      `INSERT INTO payments (tenant_id, room_id, month, amount, rent_amount, extra_charges,
        dues_adjusted, remaining, mode, receipt_no, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?) RETURNING id`,
      [tenantId, roomId, month, amount, rent, extra, remaining, mode, receipt, u.id]
    );
  }

  await addPayment(t1.lastId, roomIds[0], ym(-2), 8500, 8500, 0, 0, 'upi');
  await addPayment(t1.lastId, roomIds[0], ym(-1), 8500, 8500, 0, 0, 'upi');
  await addPayment(t1.lastId, roomIds[0], ym(0), 6500, 8500, 0, 2000, 'cash');
  await run(
    `INSERT INTO dues (tenant_id, month, amount, reason, settled, created_by)
     VALUES (?, ?, 2000, ?, 0, ?) RETURNING id`,
    [t1.lastId, ym(0), 'Partial payment / आंशिक भुगतान', u.id]
  );
  await addPayment(t2.lastId, roomIds[1], ym(-1), 7500, 7500, 0, 0, 'cash');
  await addPayment(t2.lastId, roomIds[1], ym(0), 7800, 7500, 300, 0, 'upi');
  await addPayment(t3.lastId, roomIds[2], ym(-1), 9000, 9000, 0, 0, 'bank');
  await run(
    `INSERT INTO dues (tenant_id, month, amount, reason, settled, created_by)
     VALUES (?, ?, 1500, ?, 0, ?) RETURNING id`,
    [t3.lastId, ym(-1), 'Electricity / बिजली', u.id]
  );

  await run(
    `INSERT INTO expenses (title, category, amount, expense_date, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    ['Water tanker', 'maintenance', 1200, new Date().toISOString().slice(0, 10), 'Common supply', u.id]
  );
  await run(
    `INSERT INTO expenses (title, category, amount, expense_date, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    ['Street light repair', 'repairs', 850, new Date().toISOString().slice(0, 10), '', u.id]
  );
}

module.exports = {
  usePostgres,
  query,
  get,
  run,
  init,
  randomToken: (bytes = 24) => crypto.randomBytes(bytes).toString('hex'),
};
