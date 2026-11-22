'use strict';

/* Local-development helper: wipes the SQLite database so the demo seed runs again.
   Does nothing when DATABASE_URL points to PostgreSQL. */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const url = process.env.DATABASE_URL || '';
if (/^postgres(ql)?:\/\//i.test(url)) {
  console.log('PostgreSQL detected. This reset script only affects local SQLite — nothing was changed.');
  process.exit(0);
}

const file = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'rentflow.db');
if (!fs.existsSync(file)) {
  console.log('No local database to reset.');
  process.exit(0);
}

if (process.env.FORCE !== '1') {
  console.error('This deletes all local data and restores the demo seed.');
  console.error('Run again with FORCE=1 to confirm:  FORCE=1 npm run reset:demo');
  process.exit(1);
}

for (const suffix of ['', '-wal', '-shm']) {
  const target = `${file}${suffix}`;
  if (fs.existsSync(target)) fs.unlinkSync(target);
}
console.log('Local database reset. Start the app to re-seed the demo data.');
