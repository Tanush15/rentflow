'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const db = require('./db');
const auth = require('./auth');
const share = require('./lib/share');
const { asyncHandler } = require('./utils');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  },
});

app.set('io', io);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
const isProd = process.env.NODE_ENV === 'production';
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  maxAge: isProd ? '1h' : 0,
  etag: isProd,
  lastModified: isProd,
}));

function parseCookies(header = '') {
  return header.split(';').reduce((acc, part) => {
    const i = part.indexOf('=');
    if (i > 0) {
      acc[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return acc;
  }, {});
}

io.use(async (socket, next) => {
  try {
    const cookies = parseCookies(socket.handshake.headers.cookie || '');
    const user = await auth.userFromToken(cookies[auth.COOKIE]);
    if (!user || !user.active) return next(new Error('Unauthorized'));
    socket.data.user = auth.publicUser(user);
    next();
  } catch (err) {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.join('family');
  socket.emit('hello', { user: socket.data.user, at: Date.now() });
});

app.get('/api/health', (req, res) => {
  // Public + CORS-enabled so the mobile app shell can validate a server URL.
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, db: db.usePostgres ? 'postgres' : 'sqlite', at: Date.now() });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/tenants', require('./routes/tenants'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/dues', require('./routes/dues'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/electricity', require('./routes/electricity'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/users', require('./routes/users'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/files', require('./routes/files'));
app.use('/api/share', require('./routes/share'));

app.get('/s/:token', asyncHandler(async (req, res) => {
  res.type('html').send(await share.renderPublic(req.params.token));
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  if (status >= 500) console.error('[RentFlow]', err);
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

const PORT = Number(process.env.PORT || 3000);

db.init()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`RentFlow is running at http://localhost:${PORT}`);
      console.log(`Database: ${db.usePostgres ? 'PostgreSQL' : 'SQLite (local file in ./data)'}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start RentFlow:', err);
    process.exit(1);
  });

process.on('SIGTERM', () => server.close(() => process.exit(0)));
