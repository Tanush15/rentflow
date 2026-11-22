'use strict';

/* RentFlow - single-file browser app (no build step) */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Native phone features are provided by public/js/native.js (Capacitor bridge).
const N = window.RFNative || null;
const IS_NATIVE = !!(N && N.isNative);
function openExternal(url) {
  if (N) N.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

// When the APK has no baked-in server URL it starts from a local app shell.
// Ask for the deployed URL once, save it, then open the real app from there.
const SERVER_KEY = 'rentflow_server_url';
const LOCAL_ORIGINS = ['http://localhost', 'https://localhost', 'capacitor://localhost', 'file://', 'http://127.0.0.1'];
function isLocalAppShell() {
  return IS_NATIVE && LOCAL_ORIGINS.some((o) => location.origin.startsWith(o));
}
function savedServerUrl() {
  return String(localStorage.getItem(SERVER_KEY) || '').trim().replace(/\/+$/, '');
}
function normalizeServerUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(n) { return `₹${Number(n || 0).toLocaleString('en-IN')}`; }
function dstr(v) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
const MNAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function mlabel(m) {
  if (!/^\d{4}-\d{2}$/.test(String(m || ''))) return m || '-';
  const [y, mo] = m.split('-').map(Number);
  return `${MNAMES[mo - 1]} ${y}`;
}
function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthList() {
  const out = [];
  const now = new Date();
  for (let i = -17; i <= 2; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
function initials(name) {
  return String(name || '?').split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
}
function v(form, name) {
  const el = form.elements[name];
  return el ? (el.value || '').trim() : '';
}
function checked(form, name) {
  const el = form.elements[name];
  return !!(el && el.checked);
}

const S = {
  me: null,
  view: 'dashboard',
  param: null,
  month: thisMonth(),
  paymentsAll: false,
  duesTab: 'pending',
  rooms: [], tenants: [], payments: [], dues: [], settledDues: [], expenses: [], users: [],
  electricity: null,
  dash: null, reports: null, detail: null,
  socket: null, reloadTimer: null, receiptId: null, voiceOpen: false,
};

/* ---------------- API ---------------- */
async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const method = opts.method || (opts.body ? 'POST' : 'GET');
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: isForm ? {} : { 'Content-Type': 'application/json' },
      body: opts.body ? (isForm ? opts.body : JSON.stringify(opts.body)) : undefined,
    });
  } catch (e) {
    throw new Error('Cannot reach the server. Check your connection.');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong.');
  return data;
}

/* ---------------- Toast / modal ---------------- */
function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = message;
  $('#toast-root').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 3200);
}

function openModal({ title, body, foot = '', wide = false }) {
  $('#modal-root').innerHTML = `<div class="modal-backdrop" data-act="modal-backdrop">
    <div class="modal${wide ? ' wide' : ''}">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="x" data-act="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div></div>`;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function confirmAction(title, message, onYes, label = 'Delete') {
  openModal({
    title,
    body: `<p style="line-height:1.6">${esc(message)}</p>`,
    foot: `<button class="btn ghost" data-act="close-modal">Cancel</button>
           <button class="btn danger" id="confirm-yes">${esc(label)}</button>`,
  });
  $('#confirm-yes').onclick = async () => {
    closeModal();
    try { await onYes(); } catch (e) { toast(e.message, true); }
  };
}

/* ---------------- Auth / shell ---------------- */
async function boot() {
  if (isLocalAppShell()) {
    const saved = savedServerUrl();
    if (saved) {
      location.href = `${saved}/`;
      return;
    }
    renderServerSetup();
    return;
  }
  try {
    const r = await api('/auth/me');
    S.me = r.user;
    await loadData();
    renderShell();
    connectSocket();
    setupNative();
    handleRoute();
  } catch (e) {
    renderLogin();
  }
}

function setupNative() {
  if (!N || !IS_NATIVE) return;
  N.setupStatusBar();
  N.onBackButton(({ canGoBack }) => {
    if ($('#modal-root').innerHTML.trim()) { closeModal(); return; }
    if (S.voiceOpen) { S.voiceOpen = false; renderVoice(); return; }
    if (location.hash && location.hash !== '#/' && location.hash !== '#/dashboard') {
      go('dashboard');
      return;
    }
    if (canGoBack) window.history.back();
    else N.exitApp();
  });
  const applyNetwork = ({ connected }) => {
    const banner = $('#offline-banner');
    if (banner) banner.style.display = connected ? 'none' : 'block';
  };
  N.networkStatus().then(applyNetwork).catch(() => {});
  N.onNetworkChange(applyNetwork);
}

function renderServerSetup() {
  $('#app').innerHTML = `<div class="login-page">
    <div class="login-hero">
      <div class="brand-logo">₹</div>
      <h1>RentFlow</h1>
      <p>One shared rent book for the whole family. Connect once, then everyone stays in sync.</p>
      <div class="login-features">
        <div>🏠 Room-wise rent collection &amp; partial payments</div>
        <div>⚡ Live sync on every family phone</div>
        <div>🧾 PDF receipts &amp; WhatsApp reminders</div>
      </div>
    </div>
    <div class="login-form-wrap"><div class="login-card">
      <h2>Connect your family server</h2>
      <p class="lead">Enter the web address where RentFlow is hosted. Use the same link everyone opens in their browser.</p>
      <form id="server-form">
        <div class="field"><label>Server URL</label><input name="serverUrl" inputmode="url" autocomplete="url" placeholder="https://rentflow.onrender.com" required></div>
        <button class="btn block" type="submit">Connect</button>
      </form>
      <div class="login-note">Example: <b>https://rentflow.onrender.com</b><br>Ask the person who set up RentFlow if you are unsure.</div>
    </div></div></div>`;
  const form = $('#server-form');
  form.elements.serverUrl.value = savedServerUrl();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    const url = normalizeServerUrl(v(form, 'serverUrl'));
    if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      toast('Enter a valid address, e.g. https://rentflow.onrender.com', true);
      btn.disabled = false;
      return;
    }
    try {
      const res = await fetch(`${url}/api/health`, { cache: 'no-store' });
      if (!res.ok) throw new Error('offline');
      const health = await res.json();
      if (!health.ok) throw new Error('offline');
      localStorage.setItem(SERVER_KEY, url);
      location.href = `${url}/`;
    } catch (e) {
      toast('Could not reach that server. Check the address and your internet connection.', true);
      btn.disabled = false;
    }
  });
}

function renderLogin() {
  $('#app').innerHTML = `<div class="login-page">
    <div class="login-hero">
      <div class="brand-logo">₹</div>
      <h1>RentFlow</h1>
      <p>One shared rent book for the whole family. Record a payment once — everyone sees it instantly.</p>
      <div class="login-features">
        <div>🏠 Room-wise rent collection &amp; partial payments</div>
        <div>⚡ Live sync on every family phone</div>
        <div>🧾 PDF receipts &amp; WhatsApp reminders</div>
        <div>📊 Monthly, pending &amp; yearly reports</div>
      </div>
    </div>
    <div class="login-form-wrap"><div class="login-card">
      <h2>Welcome back</h2>
      <p class="lead">Sign in with your family account.</p>
      <form id="login-form">
        <div class="field"><label>Username</label><input name="username" autocomplete="username" required autofocus></div>
        <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn block" type="submit">Sign in</button>
      </form>
      <div class="login-note">Demo accounts: <b>admin / admin123</b> (super admin), <b>mom</b> or <b>dad / family123</b><br>Change these passwords after your first login.</div>
    </div></div></div>`;
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget;
    const btn = $('button[type=submit]', f);
    btn.disabled = true;
    try {
      const r = await api('/auth/login', { body: { username: v(f, 'username'), password: v(f, 'password') } });
      S.me = r.user;
      await loadData();
      renderShell();
      connectSocket();
      handleRoute();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
}

const NAV = [
  { view: 'dashboard', ico: '📊', label: 'Dashboard', title: 'Family dashboard', sub: 'Everything at a glance' },
  { view: 'rooms', ico: '🏠', label: 'Rooms', title: 'Rooms', sub: 'Occupancy, rent &amp; collection' },
  { view: 'tenants', ico: '👥', label: 'Tenants', title: 'Tenants', sub: 'Profiles, documents &amp; history' },
  { view: 'payments', ico: '💰', label: 'Payments', title: 'Rent payments', sub: 'Record rent, extras &amp; partial payments' },
  { view: 'dues', ico: '⏳', label: 'Dues', title: 'Pending dues', sub: 'Carry forward, settle or remind' },
  { view: 'expenses', ico: '🧾', label: 'Expenses', title: 'Expenses', sub: 'Track every outflow' },
  { view: 'electricity', ico: '⚡', label: 'Electricity', title: 'Electricity', sub: 'Meter numbers, units, bills &amp; reading history' },
  { view: 'reports', ico: '📈', label: 'Reports', title: 'Reports', sub: 'Collections, dues &amp; yearly summaries' },
  { view: 'admin', ico: '⚙️', label: 'Admin', title: 'Family access', sub: 'Manage who can use RentFlow', adminOnly: true },
  { view: 'account', ico: '🔐', label: 'Account', title: 'My account', sub: 'Change your password' },
];

function renderShell() {
  const links = NAV.filter((n) => !n.adminOnly || S.me.role === 'super_admin').map((n) => `
    <button class="nav-item" data-act="nav" data-view="${n.view}"><span class="ico">${n.ico}</span>${n.label}</button>`).join('');
  $('#app').innerHTML = `<div class="layout">
    <aside class="sidebar">
      <div class="brand"><div class="brand-logo">₹</div><div><div class="brand-name">RentFlow</div><div class="brand-sub">Family rent manager</div></div></div>
      <nav class="nav"><div class="nav-label">Workspace</div>${links}</nav>
      <div class="sidebar-foot">Shared family database · Live sync on</div>
    </aside>
    <div class="main">
      <div id="offline-banner" style="display:none;background:#b9770e;color:#fff;text-align:center;padding:8px;font-size:12px;font-weight:600">You are offline. Reconnect to sync with your family.</div>
      <header class="topbar">
        <div><h2 id="page-title">Dashboard</h2><div class="sub" id="page-sub">Everything at a glance</div></div>
        <div class="top-actions">
          <select class="month-picker" data-change="month" title="Reporting month">
            ${monthList().map((m) => `<option value="${m}"${m === S.month ? ' selected' : ''}>${mlabel(m)}</option>`).join('')}
          </select>
          <div class="user-chip"><div class="avatar">${initials(S.me.name)}</div><div class="who"><b>${esc(S.me.name)}</b><small>${S.me.role.replace('_', ' ')}</small></div></div>
          <button class="btn ghost sm" data-act="logout">Logout</button>
        </div>
      </header>
      <div class="content" id="content"></div>
    </div>
  </div>`;
  renderVoice();
}

function handleRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [view, param] = raw.split('/');
  S.view = view || 'dashboard';
  S.param = param || null;
  if (S.view === 'tenants' && S.param) S.view = 'tenant';
  renderView();
}
function go(view, param) {
  location.hash = `#/${view}${param ? `/${encodeURIComponent(param)}` : ''}`;
  if (S.view === view && S.param === (param || null)) renderView();
}
window.addEventListener('hashchange', handleRoute);

async function loadData() {
  const calls = [
    api(`/rooms?month=${S.month}`), api('/tenants'), api('/payments'), api('/dues'),
    api('/dues?settled=1'), api('/expenses'),
    api(`/reports/dashboard?month=${S.month}`), api(`/reports/summary?month=${S.month}`),
    api(`/electricity?month=${S.month}`),
  ];
  if (S.me && S.me.role === 'super_admin') calls.push(api('/users'));
  const [rooms, tenants, payments, dues, settled, expenses, dash, reports, electricity, users] = await Promise.all(calls);
  S.rooms = rooms.rooms; S.tenants = tenants.tenants; S.payments = payments.payments;
  S.dues = dues.dues; S.settledDues = settled.dues; S.expenses = expenses.expenses;
  S.dash = dash; S.reports = reports; S.electricity = electricity;
  S.users = users ? users.users : [];
}

function scheduleReload() {
  clearTimeout(S.reloadTimer);
  S.reloadTimer = setTimeout(async () => {
    try { await loadData(); await renderView(); } catch (e) { /* next sync will retry */ }
  }, 250);
}

function connectSocket() {
  if (S.socket) return;
  S.socket = io({ transports: ['websocket', 'polling'] });
  S.socket.on('sync', (payload) => {
    toast(`${payload.by || 'Someone'} updated ${payload.entity}`);
    scheduleReload();
  });
  S.socket.on('connect_error', () => { /* silently fall back to polling/manual refresh */ });
}

/* ---------------- View router ---------------- */
async function renderView() {
  const content = $('#content');
  if (!content) return;
  const activeNav = S.view === 'tenant' ? 'tenants' : S.view;
  const meta = NAV.find((n) => n.view === activeNav) || NAV[0];
  $('#page-title').innerHTML = meta.title;
  $('#page-sub').innerHTML = meta.sub;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === activeNav));

  const views = {
    dashboard: viewDashboard, rooms: viewRooms, tenants: viewTenants, tenant: viewTenantDetail,
    payments: viewPayments, dues: viewDues, expenses: viewExpenses,
    electricity: viewElectricity,
    reports: viewReports, admin: viewAdmin, account: viewAccount,
  };
  const fn = views[S.view] || viewDashboard;
  content.innerHTML = await fn();
}

/* ---------------- Views ---------------- */
function statCard(label, value, hint, icon, tone) {
  return `<div class="card stat ${tone || ''}"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div><div class="icon">${icon}</div></div>`;
}
function barsHtml(rows, keyA, keyB, labelA, labelB) {
  const max = Math.max(1, ...rows.flatMap((r) => [Number(r[keyA] || 0), Number(r[keyB] || 0)]));
  return `<div class="legend"><span><i style="background:var(--green-600)"></i>${labelA}</span><span><i style="background:#e3a34a"></i>${labelB}</span></div>
  <div class="bars">${rows.map((r) => {
    const a = Math.round((Number(r[keyA] || 0) / max) * 100);
    const b = Math.round((Number(r[keyB] || 0) / max) * 100);
    return `<div class="bar-group" title="${esc(r.label)}: ${money(r[keyA])} / ${money(r[keyB])}">
      <div class="bar-pair"><div class="bar collect" style="height:${a}%"></div><div class="bar spend" style="height:${b}%"></div></div>
      <div class="bar-label">${esc(r.label.split(' ')[0])}</div></div>`;
  }).join('')}</div>`;
}

function viewDashboard() {
  const d = S.dash;
  const paid = d.occupied_rooms ? Math.round((d.occupied_rooms / d.total_rooms) * 100) : 0;
  return `
  <div class="page-head"><div><h1>Namaste, ${esc(S.me.name.split(' ')[0])} 👋</h1><p>Collection and pending summary for ${mlabel(S.month)}.</p></div>
    <button class="btn" data-act="open-payment">＋ Record payment</button></div>
  <div class="grid stats">
    ${statCard('Collected this month', money(d.collection_this_month), `${d.recent_payments.length} payment(s) recorded`, '💰', 'green')}
    ${statCard('Pending right now', money(d.pending_total), `${d.pending_tenants.length} tenant(s) with dues`, '⏳', 'red')}
    ${statCard('Income this year', money(d.income_this_year), `${new Date().getFullYear()} total collection`, '📈', 'blue')}
    ${statCard('Expense this month', money(d.expense_this_month), `${money(d.expense_this_year)} this year`, '🧾', 'amber')}
  </div>
  <div class="grid split" style="margin-top:16px">
    <div class="card"><h3>Last 6 months <small>Collection vs expense</small></h3>${barsHtml(d.months, 'collection', 'expense', 'Collection', 'Expense')}</div>
    <div class="card"><h3>Occupancy</h3>
      <div style="display:flex;align-items:center;gap:20px">
        <div class="donut" style="background:conic-gradient(var(--green-600) ${paid}%, #e6ece8 ${paid}% 100%)"></div>
        <div><div style="font-size:26px;font-weight:800;color:var(--green-700)">${paid}%</div>
        <div class="muted small">${d.occupied_rooms} of ${d.total_rooms} rooms occupied</div>
        <button class="btn soft sm" style="margin-top:12px" data-act="nav" data-view="rooms">View rooms</button></div>
      </div>
      <div style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px">
        <div class="strong">Total outstanding dues: ${money(d.dues_total)}</div>
        <div class="muted small" style="margin-top:4px">Includes carried-forward and partial-payment balances.</div>
      </div>
    </div>
  </div>
  <div class="grid split" style="margin-top:16px">
    <div class="card"><h3>Recent payments <small>${mlabel(S.month)}</small></h3>
      ${d.recent_payments.length ? `<div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Room</th><th>Date</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${d.recent_payments.slice(0, 7).map((p) => `<tr><td class="strong">${esc(p.tenant_name || '-')}</td><td>${esc(p.room_no || '-')}</td><td class="muted">${dstr(p.created_at)}</td>
      <td class="num strong">${money(p.amount)}</td><td><button class="btn ghost sm" data-act="receipt" data-id="${p.id}">Receipt</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty"><span class="big">💸</span>No payments this month yet.</div>`}
    </div>
    <div class="card"><h3>Needs attention <small>Top pending</small></h3>
      ${d.pending_tenants.length ? d.pending_tenants.map((t) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid #f0f4f1">
        <div><div class="strong">${esc(t.name)} <span class="muted small">· Room ${esc(t.room_no)}</span></div><div class="small" style="color:var(--red);font-weight:600">${money(t.pending)} pending</div></div>
        <button class="btn soft sm" data-act="open-payment" data-id="${t.tenant_id}">Collect</button></div>`).join('')
      : `<div class="empty"><span class="big">✅</span>Everyone is clear. Nice work!</div>`}
    </div>
  </div>
  <div class="card"><h3>Family activity</h3>
    ${d.activity.length ? `<div class="table-wrap"><table><thead><tr><th>Who</th><th>What</th><th>When</th></tr></thead><tbody>
    ${d.activity.slice(0, 8).map((a) => `<tr><td class="strong">${esc(a.user_name || 'System')}</td><td>${esc(a.action)} · ${esc(a.entity)} ${a.details ? `· <span class="muted">${esc(a.details)}</span>` : ''}</td><td class="muted">${dstr(a.created_at)}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="empty">No activity yet.</div>`}
  </div>`;
}

function viewRooms() {
  const elecFor = (id) => (S.electricity?.meters || []).find((m) => String(m.room_id) === String(id)) || {};
  const canEdit = S.me && (S.me.role === 'admin' || S.me.role === 'super_admin');
  return `<div class="page-head"><div><h1>Rooms</h1><p>${S.rooms.length} rooms · ${S.rooms.filter((r) => r.tenant).length} occupied · address, rent &amp; electricity in one place</p></div>
    ${canEdit ? '<button class="btn" data-act="add-room">＋ Add room</button>' : ''}</div>
  <div class="card"><div class="table-wrap"><table><thead><tr><th>Room</th><th>Complete address</th><th>Floor</th><th>Tenant</th>
    <th class="num">Rent</th><th class="num">Electricity bill (₹)</th>
    <th class="num">Collected</th><th class="num">Pending</th><th></th></tr></thead><tbody>
  ${S.rooms.map((r) => {
    const e = elecFor(r.id);
    return `<tr>
      <td class="strong">${esc(r.room_no)}</td>
      <td class="small muted" style="max-width:230px;white-space:normal">${r.address ? esc(r.address) : '<span class="badge">Not set · click Edit</span>'}</td>
      <td class="muted">${esc(r.floor || '-')}</td>
      <td>${r.tenant ? `<a href="#/tenants/${r.tenant.id}">${esc(r.tenant.name)}</a>` : '<span class="badge info">Vacant</span>'}</td>
      <td class="num">${money(r.rent)}</td>
      <td class="num">
        ${canEdit
          ? `<span class="bill-wrap"><span>₹</span><input type="number" class="bill-input" min="0" step="1" value="${esc(r.electricity_bill || 0)}" data-change="room-electricity-bill" data-id="${r.id}" aria-label="Electricity bill for room ${esc(r.room_no)}" title="Type the electricity bill in rupees, then press Tab or Enter"></span>`
          : money(r.electricity_bill || 0)}
        ${e.current_units !== null && e.current_units !== undefined
          ? `<br><span class="muted small">reading ${fmtN(e.current_units)} units</span>` : ''}
      </td>
      <td class="num">${r.tenant ? money(r.collected) : '-'}</td>
      <td class="num" style="color:${r.pending > 0 ? 'var(--red)' : 'inherit'};font-weight:600">${r.tenant ? money(r.pending) : '-'}</td>
      <td><div class="btn-row">${r.tenant ? `<button class="btn soft sm" data-act="open-payment" data-id="${r.tenant.id}">Collect</button>` : ''}
        ${e.meter_no ? `<button class="btn ghost sm" data-act="elec-history" data-id="${r.id}">Bill history</button>` : ''}
        ${canEdit ? `<button class="btn ghost sm" data-act="edit-room" data-id="${r.id}">Edit</button>
        <button class="btn danger sm" data-act="del-room" data-id="${r.id}">Delete</button>` : ''}</div></td></tr>`;
  }).join('')}
  </tbody></table></div>
  <div class="muted small" style="padding:0 16px 14px">Admins can type each flat's electricity bill in rupees directly in the table — it saves automatically on Enter or when you click away. Monthly meter readings are tracked separately on the <b>Electricity</b> page.</div>
  </div>`;
}

function viewTenants() {
  return `<div class="page-head"><div><h1>Tenants</h1><p>Active family tenants and their balances.</p></div>
    <button class="btn" data-act="add-tenant">＋ Add tenant</button></div>
  <div class="card"><div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Room</th><th>Phone</th><th>Joined</th><th class="num">Dues</th><th>Last payment</th><th></th></tr></thead><tbody>
  ${S.tenants.map((t) => `<tr>
    <td class="strong"><a href="#/tenants/${t.id}">${esc(t.name)}</a></td><td>${esc(t.room_no || '-')}</td><td>${esc(t.phone || '-')}</td>
    <td class="muted">${dstr(t.join_date)}</td>
    <td class="num" style="color:${t.due_total > 0 ? 'var(--red)' : 'inherit'};font-weight:600">${t.due_total ? money(t.due_total) : 'Clear'}</td>
    <td class="small muted">${t.last_payment ? `${money(t.last_payment.amount)} · ${mlabel(t.last_payment.month)}` : '-'}</td>
    <td><div class="btn-row"><button class="btn soft sm" data-act="open-payment" data-id="${t.id}">Collect</button>
    <button class="btn ghost sm" data-act="view-tenant" data-id="${t.id}">Profile</button>
    ${S.me.role === 'super_admin' ? `<button class="btn danger sm" data-act="del-tenant" data-id="${t.id}">Delete</button>` : ''}</div></td></tr>`).join('')}
  ${S.tenants.length ? '' : '<tr><td colspan="7" class="empty">No active tenants yet.</td></tr>'}
  </tbody></table></div></div>`;
}

async function viewTenantDetail() {
  let detail;
  try { detail = await api(`/tenants/${S.param}`); }
  catch (e) { return `<div class="card"><div class="empty">${esc(e.message)}</div></div>`; }
  const t = detail.tenant;
  const photo = t.photo_file_id ? `/api/files/${t.photo_file_id}` : '';
  return `<div class="page-head"><div><h1>${esc(t.name)}</h1><p>Room ${esc(t.room_no || '-')} · Joined ${dstr(t.join_date)} · ${t.active ? 'Active' : 'Vacated'}</p></div>
    <div class="btn-row"><button class="btn" data-act="open-payment" data-id="${t.id}">💰 Record payment</button>
    <button class="btn ghost" data-act="nav" data-view="tenants">← Back</button></div></div>
  <div class="grid split">
    <div class="card"><h3>Payment history</h3>
      ${detail.payments.length ? `<div class="table-wrap"><table><thead><tr><th>Month</th><th>Receipt</th><th>Mode</th><th class="num">Amount</th><th class="num">Pending</th><th></th></tr></thead><tbody>
      ${detail.payments.map((p) => `<tr><td>${mlabel(p.month)}</td><td class="small">${esc(p.receipt_no || '-')}</td><td class="small muted">${esc(p.mode)}</td>
      <td class="num strong">${money(p.amount)}</td><td class="num">${p.remaining ? `<span style="color:var(--red)">${money(p.remaining)}</span>` : '-'}</td>
      <td><button class="btn ghost sm" data-act="receipt" data-id="${p.id}">Receipt</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">No payments recorded.</div>`}
    </div>
    <div>
      <div class="card"><h3>Profile</h3>
        <div style="display:flex;gap:16px;align-items:center">
          ${photo ? `<img src="${photo}" alt="Tenant photo" style="width:78px;height:78px;border-radius:12px;object-fit:cover;border:1px solid var(--line)">`
            : `<div class="avatar" style="width:78px;height:78px;font-size:24px">${initials(t.name)}</div>`}
          <div><div class="strong" style="font-size:16px">${esc(t.name)}</div><div class="muted small">${esc(t.phone || 'No phone')}</div>
          <div class="muted small">Rent ${money(t.room_rent)}/month</div></div>
        </div>
        <div style="margin-top:14px;display:grid;gap:6px" class="small">
          <div><span class="muted">Email:</span> ${esc(t.email || '-')}</div>
          <div><span class="muted">Notes:</span> ${esc(t.notes || '-')}</div>
          <div><span class="muted">Total paid:</span> <b>${money(detail.paid_total)}</b></div>
          <div><span class="muted">Outstanding:</span> <b style="color:var(--red)">${money(detail.due_total)}</b></div>
        </div>
        <div class="btn-row" style="margin-top:14px">
          <button class="btn soft sm" data-act="upload-photo" data-id="${t.id}">📷 ${photo ? 'Change photo' : 'Add photo'}</button>
          <button class="btn ghost sm" data-act="edit-tenant" data-id="${t.id}">Edit</button>
          <button class="btn amber sm" data-act="vacate-tenant" data-id="${t.id}">Mark vacated</button>
        </div>
      </div>
      <div class="card"><h3>Documents <small>${detail.documents.length} file(s)</small></h3>
        <form data-form="upload-doc" data-id="${t.id}" class="field" style="margin-bottom:12px">
          <input type="file" name="file" accept="image/*,application/pdf" required>
          <div class="btn-row" style="margin-top:8px">
            <button class="btn soft sm" type="submit">⬆ Upload file</button>
            ${IS_NATIVE ? `<button class="btn ghost sm" type="button" data-act="camera-doc" data-id="${t.id}" data-source="camera">📷 Take photo</button>
            <button class="btn ghost sm" type="button" data-act="camera-doc" data-id="${t.id}" data-source="gallery">🖼 Gallery</button>` : ''}
          </div>
        </form>
        ${detail.documents.length ? detail.documents.map((f) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid #f0f4f1">
          <div class="small"><b>${esc(f.filename)}</b><div class="muted">${(f.size / 1024).toFixed(0)} KB · ${dstr(f.created_at)}</div></div>
          <div class="btn-row"><a class="btn ghost sm" href="/api/files/${f.id}" target="_blank">View</a>
          <a class="btn ghost sm" href="/api/files/${f.id}?download=1">Download</a>
          <button class="btn danger sm" data-act="del-file" data-id="${f.id}">×</button></div></div>`).join('')
        : `<div class="empty small">No documents uploaded.</div>`}
      </div>
      <div class="card"><h3>Dues</h3>
        ${detail.dues.filter((x) => !x.settled).length ? detail.dues.filter((x) => !x.settled).map((x) => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f0f4f1">
          <div class="small">${mlabel(x.month)} · ${esc(x.reason)}</div><b style="color:var(--red)">${money(x.amount)}</b></div>`).join('')
        : '<div class="empty small">No outstanding dues. 🎉</div>'}
      </div>
    </div>
  </div>`;
}

function viewPayments() {
  const list = S.payments.filter((p) => S.paymentsAll || p.month === S.month);
  const total = list.reduce((s, p) => s + Number(p.amount || 0), 0);
  return `<div class="page-head"><div><h1>Rent payments</h1><p>${list.length} payment(s) · ${money(total)} total</p></div>
    <div class="btn-row"><button class="btn ghost" data-act="toggle-all-payments">${S.paymentsAll ? 'Show selected month' : 'Show all months'}</button>
    <button class="btn" data-act="open-payment">＋ Record payment</button></div></div>
  <div class="card"><h3>Room-aware collection <small>Partial payments keep the balance visible as a due</small></h3>
    <div class="table-wrap"><table><thead><tr><th>Receipt</th><th>Tenant</th><th>Room</th><th>Month</th><th>Mode</th><th class="num">Rent</th><th class="num">Extra</th><th class="num">Due adj.</th><th class="num">Received</th><th class="num">Pending</th><th></th></tr></thead><tbody>
  ${list.map((p) => `<tr><td class="small">${esc(p.receipt_no || '-')}</td><td class="strong">${esc(p.tenant_name || '-')}</td><td>${esc(p.room_no || '-')}</td>
    <td>${mlabel(p.month)}</td><td class="small muted">${esc(p.mode)}</td><td class="num">${money(p.rent_amount)}</td>
    <td class="num">${p.extra_charges ? money(p.extra_charges) : '-'}</td><td class="num">${p.dues_adjusted ? money(p.dues_adjusted) : '-'}</td>
    <td class="num strong">${money(p.amount)}</td><td class="num">${p.remaining ? `<span style="color:var(--red)">${money(p.remaining)}</span>` : '<span class="badge ok">Clear</span>'}</td>
    <td><div class="btn-row"><button class="btn ghost sm" data-act="receipt" data-id="${p.id}">🧾</button>
    <button class="btn amber sm" data-act="receipt-wa" data-id="${p.id}">WhatsApp</button>
    ${S.me.role === 'super_admin' ? `<button class="btn danger sm" data-act="del-payment" data-id="${p.id}">×</button>` : ''}</div></td></tr>`).join('')}
  ${list.length ? '' : '<tr><td colspan="11" class="empty">No payments in this view.</td></tr>'}
  </tbody></table></div></div>`;
}

function viewDues() {
  const list = S.duesTab === 'pending' ? S.dues : S.settledDues;
  const total = S.dues.reduce((s, d) => s + Number(d.amount || 0), 0);
  return `<div class="page-head"><div><h1>Pending dues</h1><p>Carry forward, settle later, remind or receipt — all in one place.</p></div>
    <div class="btn-row"><button class="btn ghost" data-act="dues-tab" data-tab="${S.duesTab === 'pending' ? 'settled' : 'pending'}">${S.duesTab === 'pending' ? 'Show settled' : 'Show pending'}</button>
    <button class="btn" data-act="add-due">＋ Add extra due</button></div></div>
  <div class="grid stats">
    ${statCard('Total outstanding', money(total), `${S.dues.length} open dues`, '⏳', 'red')}
    ${statCard('Settled dues', money(S.settledDues.reduce((s, d) => s + Number(d.amount || 0), 0)), `${S.settledDues.length} settled`, '✅', 'green')}
    ${statCard('Tenants with dues', new Set(S.dues.map((d) => d.tenant_id)).size, 'Across all rooms', '👥', 'amber')}
    ${statCard('Oldest due month', S.dues.length ? mlabel(S.dues.map((d) => d.month).sort()[0]) : '-', 'Settle the oldest first', '📅', 'blue')}
  </div>
  <div class="card" style="margin-top:16px"><div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Room</th><th>Month</th><th>Reason</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead><tbody>
  ${list.map((d) => `<tr><td class="strong">${esc(d.tenant_name || '-')}</td><td>${esc(d.room_no || '-')}</td><td>${mlabel(d.month)}</td>
    <td class="small">${esc(d.reason)}</td><td class="num strong" style="color:${d.settled ? 'inherit' : 'var(--red)'}">${money(d.amount)}</td>
    <td>${d.settled ? '<span class="badge ok">Settled</span>' : '<span class="badge warn">Pending</span>'}</td>
    <td><div class="btn-row">${!d.settled ? `
      <button class="btn soft sm" data-act="settle-due" data-id="${d.id}">Settle</button>
      <button class="btn amber sm" data-act="remind-due" data-id="${d.id}" data-tenant="${d.tenant_id}" data-month="${d.month}">Remind</button>
      <button class="btn ghost sm" data-act="carry-due" data-id="${d.id}">Carry →</button>
      <button class="btn ghost sm" data-act="edit-due" data-id="${d.id}">Edit</button>` : ''}
      <button class="btn danger sm" data-act="del-due" data-id="${d.id}">×</button></div></td></tr>`).join('')}
  ${list.length ? '' : `<tr><td colspan="7" class="empty"><span class="big">${S.duesTab === 'pending' ? '✅' : '📭'}</span>${S.duesTab === 'pending' ? 'No pending dues. Everyone is clear!' : 'No settled dues yet.'}</td></tr>`}
  </tbody></table></div></div>`;
}

function viewExpenses() {
  const total = S.expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  return `<div class="page-head"><div><h1>Expenses</h1><p>${S.expenses.length} entries · ${money(total)} recorded</p></div>
    <button class="btn" data-act="add-expense">＋ Add expense</button></div>
  <div class="card"><div class="table-wrap"><table><thead><tr><th>Title</th><th>Category</th><th>Date</th><th>Note</th><th class="num">Amount</th><th></th></tr></thead><tbody>
  ${S.expenses.map((e) => `<tr><td class="strong">${esc(e.title)}</td><td><span class="badge info">${esc(e.category)}</span></td>
    <td>${dstr(e.expense_date)}</td><td class="muted small">${esc(e.note || '-')}</td><td class="num strong">${money(e.amount)}</td>
    <td><div class="btn-row"><button class="btn ghost sm" data-act="edit-expense" data-id="${e.id}">Edit</button>
    <button class="btn danger sm" data-act="del-expense" data-id="${e.id}">×</button></div></td></tr>`).join('')}
  ${S.expenses.length ? '' : '<tr><td colspan="6" class="empty">No expenses recorded.</td></tr>'}
  </tbody></table></div></div>`;
}

function viewElectricity() {
  const e = S.electricity || { config: { providerLinks: {}, defaultLink: '#' }, meters: [], month: S.month };
  const rows = e.meters || [];
  const withMeter = rows.filter((m) => m.meter_no);
  const current = rows.filter((m) => m.current_reading !== null && m.current_reading !== undefined);
  const totalUnits = current.reduce((s, m) => s + Number(m.current_units || 0), 0);
  const totalAmount = current.reduce((s, m) => s + Number(m.current_amount || 0), 0);
  const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
  return `<div class="page-head"><div><h1>Electricity · BSES Delhi</h1><p>Meter numbers, units and bills for every flat · ${mlabel(e.month || S.month)}</p></div>
    <div class="btn-row"><button class="btn" data-act="add-elec-meter">＋ Set meter</button></div></div>
  <div class="grid stats">
    ${statCard('Flats with meter', `${withMeter.length} / ${rows.length}`, 'Meter numbers saved', '⚡', 'green')}
    ${statCard('Units this month', fmt(totalUnits), mlabel(e.month || S.month), '🔌', 'blue')}
    ${statCard('Bill this month', money(totalAmount), 'Based on saved readings', '🧾', 'amber')}
    ${statCard('Data source', e.config.apiConfigured ? 'API connected' : 'Manual + BSES link', e.config.apiConfigured ? 'Online fetch enabled' : 'No provider API configured', '🌐', '')}
  </div>
  <div class="card" style="margin-top:16px"><div class="table-wrap"><table>
    <thead><tr><th>Flat</th><th>Tenant</th><th>Meter no.</th><th>CA no.</th><th>Provider</th>
      <th class="num">Last reading</th><th class="num">Units · ${esc(String(e.month || S.month).slice(5))}</th>
      <th class="num">Amount</th><th></th></tr></thead><tbody>
    ${rows.map((m) => {
      const link = (e.config.providerLinks || {})[m.provider] || e.config.defaultLink || '#';
      return `<tr>
        <td class="strong">${esc(m.room_no)}</td><td class="muted">${esc(m.tenant_name || 'Vacant')}</td>
        <td>${m.meter_no ? `<b>${esc(m.meter_no)}</b>` : '<span class="badge">Not set</span>'}</td>
        <td class="small muted">${esc(m.ca_number || '-')}</td>
        <td class="small">${esc(m.provider || 'BSES Rajdhani')}</td>
        <td class="num small">${m.last_reading !== null && m.last_reading !== undefined ? `${fmt(m.last_reading)}<br><span class="muted">${mlabel(m.last_month)}</span>` : '-'}</td>
        <td class="num strong">${m.current_units !== null && m.current_units !== undefined ? fmt(m.current_units) : '-'}</td>
        <td class="num">${m.current_amount !== null && m.current_amount !== undefined ? money(m.current_amount) : '-'}</td>
        <td><div class="btn-row">
          ${m.meter_no ? `<button class="btn soft sm" data-act="add-elec-reading" data-id="${m.room_id}" data-room="${esc(m.room_no)}">＋ Reading</button>
          <button class="btn ghost sm" data-act="elec-fetch" data-id="${m.room_id}">🌐 Fetch</button>
          <button class="btn ghost sm" data-act="elec-history" data-id="${m.room_id}">History</button>
          <a class="btn ghost sm" href="${esc(link)}" target="_blank" rel="noopener" title="Check on BSES website">BSES ↗</a>
          <button class="btn ghost sm" data-act="add-elec-meter" data-id="${m.room_id}">Edit</button>
          <button class="btn danger sm" data-act="del-elec-meter" data-id="${m.meter_id}">×</button>` :
          `<button class="btn soft sm" data-act="add-elec-meter" data-id="${m.room_id}">Set meter</button>`}
        </div></td></tr>`;
    }).join('')}
    ${rows.length ? '' : '<tr><td colspan="9" class="empty">Add a room first, then set its meter number.</td></tr>'}
  </tbody></table></div></div>
  <div class="card" style="margin-top:16px"><h3>How online electricity details work</h3>
    <p class="muted small" style="line-height:1.7">
      BSES Delhi does not offer a free public API for meter lookup — its "Know Your Bill" page is a login/OTP protected form.
      So RentFlow stores the meter number, CA number, monthly reading, calculated units and bill for each flat, and the <b>BSES ↗</b> button opens the official
      Rajdhani/Yamuna bill page in a new tab where you can verify the units. Enter that reading once and RentFlow keeps the full history.
      If you have a data provider or your own API, set <code>ELECTRICITY_API_URL</code> (and optionally <code>ELECTRICITY_API_KEY</code>) on the server —
      the <b>Fetch</b> button will then pull readings online automatically and let you import them.
    </p>
  </div>`;
}

function viewReports() {
  const r = S.reports;
  const catColors = ['#1f5c45', '#2b7a56', '#e3a34a', '#2563a8', '#9b59b6', '#c0392b', '#7f8c8d'];
  const catTotal = r.categories.reduce((s, c) => s + c.total, 0) || 1;
  let acc = 0;
  const slices = r.categories.map((c, i) => {
    const start = acc;
    const end = acc + (c.total / catTotal) * 100;
    acc = end;
    return `${catColors[i % catColors.length]} ${start}% ${end}%`;
  }).join(', ');
  return `<div class="page-head"><div><h1>Reports</h1><p>Collection, pending dues and yearly summaries for ${r.year}.</p></div></div>
  <div class="grid stats">
    ${statCard('Yearly collection', money(r.yearly_collection), r.year, '💰', 'green')}
    ${statCard('Yearly expenses', money(r.yearly_expense), r.year, '🧾', 'amber')}
    ${statCard('Net this year', money(r.yearly_collection - r.yearly_expense), 'Collection minus expenses', '📈', 'blue')}
    ${statCard('Pending dues', money(r.pending_total), `${r.pending.length} tenant(s)`, '⏳', 'red')}
  </div>
  <div class="card" style="margin-top:16px"><h3>Monthly collection &amp; expenses <small>Last 12 months</small></h3>${barsHtml(r.monthly, 'collection', 'expense', 'Collection', 'Expense')}</div>
  <div class="grid two" style="margin-top:16px">
    <div class="card"><h3>Expense by category <small>${r.year}</small></h3>
      <div class="donut-wrap"><div class="donut" style="background:${r.categories.length ? `conic-gradient(${slices})` : '#e6ece8'}"></div>
      <div class="donut-key">${r.categories.length ? r.categories.map((c, i) => `<span><i style="background:${catColors[i % catColors.length]}"></i>${esc(c.name)} · ${money(c.total)}</span>`).join('') : '<span class="muted">No expenses yet</span>'}</div></div>
    </div>
    <div class="card"><h3>Collection by room <small>${r.year}</small></h3>
      <div class="table-wrap"><table><thead><tr><th>Room</th><th>Tenant</th><th class="num">Collected</th></tr></thead><tbody>
      ${r.by_room.map((x) => `<tr><td class="strong">${esc(x.room_no)}</td><td class="muted">${esc(x.tenant)}</td><td class="num">${money(x.collected)}</td></tr>`).join('')}
      </tbody></table></div>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Pending dues detail</h3>
    ${r.pending.length ? `<div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Room</th><th class="num">Rent</th><th class="num">Paid</th><th class="num">Old dues</th><th class="num">Pending</th></tr></thead><tbody>
    ${r.pending.map((p) => `<tr><td class="strong">${esc(p.name)}</td><td>${esc(p.room_no)}</td><td class="num">${money(p.rent)}</td><td class="num">${money(p.paid)}</td>
    <td class="num">${money(p.dues)}</td><td class="num strong" style="color:var(--red)">${money(p.pending)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No pending dues. 🎉</div>'}
  </div>`;
}

function viewAdmin() {
  return `<div class="page-head"><div><h1>Family access</h1><p>Only the super admin can manage accounts.</p></div>
    <button class="btn" data-act="add-user">＋ Add family user</button></div>
  <div class="card"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>
  ${S.users.map((u) => `<tr><td class="strong">${esc(u.name)}</td><td>${esc(u.username)}</td><td><span class="badge ${u.role === 'super_admin' ? 'warn' : 'info'}">${esc(u.role.replace('_', ' '))}</span></td>
    <td>${u.active ? '<span class="badge ok">Active</span>' : '<span class="badge bad">Deactivated</span>'}</td><td class="muted">${dstr(u.created_at)}</td>
    <td><div class="btn-row"><button class="btn ghost sm" data-act="edit-user" data-id="${u.id}">Edit</button>
    <button class="btn ghost sm" data-act="reset-password" data-id="${u.id}">Reset password</button>
    <button class="btn amber sm" data-act="toggle-user" data-id="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? 'Deactivate' : 'Activate'}</button>
    <button class="btn danger sm" data-act="del-user" data-id="${u.id}">Delete</button></div></td></tr>`).join('')}
  </tbody></table></div></div>
  <div class="card" style="margin-top:16px"><h3>Start with a clean rent book</h3>
    <p class="muted small">Remove the sample rooms, tenants, payments, dues, expenses and electricity records so you can enter your own family's data. User accounts and passwords are kept. This cannot be undone and the demo data will not return after a restart.</p>
    <button class="btn danger" data-act="clear-demo-data">Clear all demo data</button>
  </div>
  <div class="card"><h3>Recent activity</h3><div class="table-wrap"><table><thead><tr><th>Who</th><th>Action</th><th>Details</th><th>When</th></tr></thead><tbody>
  ${S.dash.activity.slice(0, 20).map((a) => `<tr><td>${esc(a.user_name || 'System')}</td><td>${esc(a.action)} · ${esc(a.entity)}</td><td class="muted">${esc(a.details || '-')}</td><td class="muted">${dstr(a.created_at)}</td></tr>`).join('')}
  </tbody></table></div></div>`;
}

function viewAccount() {
  return `<div class="grid two">
    <div class="card"><h3>Profile</h3>
      <div style="display:flex;gap:14px;align-items:center"><div class="avatar" style="width:56px;height:56px;font-size:18px">${initials(S.me.name)}</div>
      <div><div class="strong" style="font-size:16px">${esc(S.me.name)}</div><div class="muted small">@${esc(S.me.username)} · ${esc(S.me.role.replace('_', ' '))}</div></div></div>
      <div class="muted small" style="margin-top:14px">Signed in on this device. All family members share the same live database.</div>
    </div>
    <div class="card"><h3>Change password</h3>
      <form data-form="change-password" class="form-grid">
        <div class="field full"><label>Current password</label><input type="password" name="current" required></div>
        <div class="field full"><label>New password (min 6 characters)</label><input type="password" name="next" required minlength="6"></div>
        <div class="field full"><button class="btn" type="submit">Update password</button></div>
      </form>
    </div>
  </div>`;
}

/* ---------------- Modals / forms ---------------- */
function roomOptions(selected) {
  return S.rooms.map((r) => `<option value="${r.id}"${String(selected) === String(r.id) ? ' selected' : ''}>Room ${esc(r.room_no)} · ${money(r.rent)}</option>`).join('');
}
function tenantOptions(selected) {
  return S.tenants.map((t) => `<option value="${t.id}"${String(selected) === String(t.id) ? ' selected' : ''}>${esc(t.name)} · Room ${esc(t.room_no || '-')}</option>`).join('');
}

function openRoomModal(id) {
  const r = S.rooms.find((x) => String(x.id) === String(id)) || {};
  openModal({
    title: id ? 'Edit room' : 'Add room',
    body: `<form data-form="room" class="form-grid">
      <input type="hidden" name="id" value="${esc(r.id || '')}">
      <div class="field"><label>Room number *</label><input name="room_no" value="${esc(r.room_no || '')}" required></div>
      <div class="field"><label>Floor</label><input name="floor" value="${esc(r.floor || '')}" placeholder="Ground / First…"></div>
      <div class="field full"><label>Complete address of this room</label><textarea name="address" rows="2" placeholder="House no., street, area, city, PIN — anything needed to find this room">${esc(r.address || '')}</textarea></div>
      <div class="field"><label>Monthly rent (₹) *</label><input type="number" name="rent" min="0" value="${esc(r.rent || '')}" required></div>
      <div class="field"><label>Electricity bill (₹)</label><input type="number" name="electricity_bill" min="0" value="${esc(r.electricity_bill || 0)}"></div>
      <div class="field"><label>Notes</label><input name="notes" value="${esc(r.notes || '')}"></div>
    </form>`,
    foot: `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn" data-act="submit-form" data-target="room">Save room</button>`,
  });
}

function openTenantModal(id) {
  const t = S.tenants.find((x) => String(x.id) === String(id)) || {};
  openModal({
    title: id ? 'Edit tenant' : 'Add tenant',
    body: `<form data-form="tenant" class="form-grid">
      <input type="hidden" name="id" value="${esc(t.id || '')}">
      <div class="field"><label>Tenant name *</label><input name="name" value="${esc(t.name || '')}" required></div>
      <div class="field"><label>Room</label><select name="room_id"><option value="">— Vacant / unassigned —</option>${roomOptions(t.room_id)}</select></div>
      <div class="field"><label>Phone (with country code)</label><input name="phone" value="${esc(t.phone || '')}" placeholder="9876543210"></div>
      <div class="field"><label>Email</label><input name="email" value="${esc(t.email || '')}"></div>
      <div class="field"><label>Join date</label><input type="month" name="join_date" value="${esc(String(t.join_date || thisMonth()).slice(0, 7))}"></div>
      <div class="field"><label>Notes</label><input name="notes" value="${esc(t.notes || '')}"></div>
      ${id ? '' : '<div class="field full"><label class="check"><input type="checkbox" name="active" checked> Mark as active tenant</label></div>'}
    </form>`,
    foot: `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn" data-act="submit-form" data-target="tenant">Save tenant</button>`,
  });
}

function dueOptionsHtml(tenantId) {
  const dues = S.dues.filter((d) => String(d.tenant_id) === String(tenantId));
  if (!dues.length) return '<div class="muted small">No old dues for this tenant.</div>';
  return `<div class="due-options">${dues.map((d) => `<label class="due-option">
    <input type="checkbox" name="adjust_due_ids" value="${d.id}" checked>
    <span>${mlabel(d.month)} · ${esc(d.reason)}</span><b style="margin-left:auto;color:var(--red)">${money(d.amount)}</b></label>`).join('')}</div>`;
}

function openPaymentModal(tenantId) {
  const tenantsWithRooms = S.tenants.filter((t) => t.room_id);
  const tid = tenantId || (tenantsWithRooms[0] && tenantsWithRooms[0].id);
  const t = S.tenants.find((x) => String(x.id) === String(tid)) || tenantsWithRooms[0] || {};
  openModal({
    title: 'Record rent payment', wide: true,
    body: `<form data-form="payment" class="form-grid">
      <div class="field"><label>Room</label><select data-change="payment-room">
        ${tenantsWithRooms.map((x) => `<option value="${x.id}"${String(x.id) === String(t.id) ? ' selected' : ''}>Room ${esc(x.room_no)} · ${esc(x.name)}</option>`).join('')}
      </select></div>
      <div class="field"><label>Tenant</label><select name="tenant_id" data-change="payment-tenant">${tenantOptions(t.id)}</select></div>
      <div class="field"><label>Month</label><input type="month" name="month" value="${S.month}"></div>
      <div class="field"><label>Rent amount (₹)</label><input type="number" name="rent_amount" min="0" value="${esc(t.room_rent || 0)}"></div>
      <div class="field"><label>Extra due / additional charge (₹)</label><input type="number" name="extra_charges" min="0" value="0" placeholder="Electricity, water…"></div>
      <div class="field"><label>Amount received (₹) *</label><input type="number" name="amount" min="1" required placeholder="0"></div>
      <div class="field"><label>Payment mode</label><select name="mode">
        <option value="cash">Cash</option><option value="upi">UPI / GPay / PhonePe</option><option value="bank">Bank transfer</option><option value="cheque">Cheque</option><option value="other">Other</option>
      </select></div>
      <div class="field"><label>Reference / transaction id</label><input name="reference" placeholder="Optional"></div>
      <div class="field full"><label>Note</label><textarea name="note" placeholder="Optional note for the family"></textarea></div>
      <div class="field full"><label>Adjust old dues with this payment</label><div id="due-options">${dueOptionsHtml(t.id)}</div></div>
      <div class="field full"><label class="check"><input type="checkbox" name="create_due_if_partial" checked> If paid partially, keep the remaining amount visible as a new due</label></div>
      <div class="field full"><div id="pay-hint" class="small muted"></div>
        <button type="button" class="btn soft sm" style="margin-top:8px;width:max-content" data-act="fill-full-amount">Fill full payable amount</button></div>
    </form>`,
    foot: `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn" data-act="submit-form" data-target="payment">Save payment</button>`,
  });
  updatePayHint();
}

function updatePayHint() {
  const f = $('[data-form="payment"]');
  if (!f) return;
  const rent = Number(v(f, 'rent_amount') || 0);
  const extra = Number(v(f, 'extra_charges') || 0);
  const advanced = $$('input[name="adjust_due_ids"]:checked', f)
    .reduce((s, el) => s + Number(S.dues.find((d) => String(d.id) === el.value)?.amount || 0), 0);
  const payable = rent + extra + advanced;
  const received = Number(v(f, 'amount') || 0);
  $('#pay-hint').innerHTML = `Total payable: <b>${money(payable)}</b> (rent ${money(rent)} + extra ${money(extra)} + old dues ${money(advanced)})
    ${received ? ` · ${received >= payable ? 'Fully settled' : `Remaining after this payment: <b style="color:var(--red)">${money(payable - received)}</b>`}` : ''}`;
}

function openDueModal(id) {
  const d = S.dues.find((x) => String(x.id) === String(id)) || {};
  openModal({
    title: id ? 'Edit due' : 'Add extra due',
    body: `<form data-form="due" class="form-grid">
      <input type="hidden" name="id" value="${esc(d.id || '')}">
      <div class="field"><label>Tenant *</label><select name="tenant_id" required>${tenantOptions(d.tenant_id)}</select></div>
      <div class="field"><label>Month</label><input type="month" name="month" value="${esc(d.month || S.month)}"></div>
      <div class="field"><label>Amount (₹) *</label><input type="number" name="amount" min="1" value="${esc(d.amount || '')}" required></div>
      <div class="field"><label>Reason</label><input name="reason" value="${esc(d.reason || 'Extra due / अतिरिक्त बकाया')}"></div>
    </form>`,
    foot: `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn" data-act="submit-form" data-target="due">Save due</button>`,
  });
}

function openExpenseModal(id) {
  const e = S.expenses.find((x) => String(x.id) === String(id)) || {};
  openModal({
    title: id ? 'Edit expense' : 'Add expense',
    body: `<form data-form="expense" class="form-grid">
      <input type="hidden" name="id" value="${esc(e.id || '')}">
      <div class="field"><label>Title *</label><input name="title" value="${esc(e.title || '')}" required></div>
      <div class="field"><label>Amount (₹) *</label><input type="number" name="amount" min="1" value="${esc(e.amount || '')}" required></div>
      <div class="field"><label>Category</label><select name="category">
        ${['maintenance', 'repairs', 'electricity', 'water', 'salary', 'supplies', 'other'].map((c) => `<option value="${c}"${e.category === c ? ' selected' : ''}>${c}</option>`).join('')}
      </select></div>
      <div class="field"><label>Date</label><input type="date" name="expense_date" value="${esc(String(e.expense_date || new Date().toISOString().slice(0, 10)).slice(0, 10))}"></div>
      <div class="field full"><label>Note</label><textarea name="note">${esc(e.note || '')}</textarea></div>
    </form>`,
    foot: `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn" data-act="submit-form" data-target="expense">Save expense</button>`,
  });
}

function elecMeter(roomId) {
  return (S.electricity?.meters || []).find((m) => String(m.room_id) === String(roomId)) || {};
}

function openMeterModal(roomId) {
  const m = elecMeter(roomId);
  const room = S.rooms.find((r) => String(r.id) === String(roomId));
  const providers = ['BSES Rajdhani', 'BSES Yamuna'];
  openModal({
    title: roomId ? `Meter for room ${room ? esc(room.room_no) : ''}` : 'Set a flat meter',
    body: `<form data-form="meter" class="form-grid">
      <input type="hidden" name="id" value="${esc(roomId || '')}">
      <div class="field full"><label>Flat / room *</label><select name="room_id" ${roomId ? 'disabled' : 'required'}>${roomId ? `<option value="${esc(roomId)}">Room ${esc(room ? room.room_no : roomId)}</option>` : `<option value="">— Choose a flat —</option>${roomOptions(m.room_id)}`}</select></div>
      <div class="field"><label>Meter number *</label><input name="meter_no" value="${esc(m.meter_no || '')}" required placeholder="e.g. 12345678"></div>
      <div class="field"><label>CA / consumer number</label><input name="ca_number" value="${esc(m.ca_number || '')}" placeholder="BSES CA number"></div>
      <div class="field"><label>Provider</label><select name="provider">${providers.map((p) => `<option value="${p}"${(m.provider || 'BSES Rajdhani') === p ? ' selected' : ''}>${p}</option>`).join('')}</select></div>
      <div class="field"><label>₹ per unit (for auto bill)</label><input type="number" step="0.01" min="0" name="rate_per_unit" value="${esc(m.rate_per_unit || '')}" placeholder="e.g. 9.5"></div>
      <div class="field full"><label>Notes</label><input name="notes" value="${esc(m.notes || '')}" placeholder="Meter location, phase, etc."></div>
    </form>`,
    foot: `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn" data-act="submit-form" data-target="meter">Save meter</button>`,
  });
}

function openElecReadingModal(roomId, roomNo) {
  const m = elecMeter(roomId);
  const last = m.last_reading;
  openModal({
    title: `Add reading · Room ${roomNo || esc(m.room_no || '')}`,
    body: `<form data-form="elec-reading" class="form-grid">
      <input type="hidden" name="roomId" value="${esc(roomId)}">
      <div class="field"><label>Billing month *</label><input type="month" name="month" value="${esc(S.month)}" required></div>
      <div class="field"><label>Current reading *</label><input type="number" step="0.01" min="0" name="reading" required placeholder="Meter reading"></div>
      <div class="field"><label>Bill amount (₹)</label><input type="number" step="1" min="0" name="amount" placeholder="Auto from units × rate if blank"></div>
      <div class="field"><label>Status</label><select name="status"><option value="pending">Pending</option><option value="paid">Paid</option></select></div>
      <div class="field"><label>Bill date</label><input type="date" name="bill_date"></div>
      <div class="field"><label>Due date</label><input type="date" name="due_date"></div>
      <div class="field full"><div id="elec-reading-hint" class="small muted">${last !== null && last !== undefined ? `Last reading: ${Number(last).toLocaleString('en-IN')} (${mlabel(m.last_month)}). Units are calculated automatically.` : 'First reading — units start from zero.'}</div></div>
    </form>`,
    foot: `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn" data-act="submit-form" data-target="elec-reading">Save reading</button>`,
  });
}

async function openElecHistoryModal(roomId) {
  let data;
  try { data = await api(`/electricity/readings/${roomId}`); }
  catch (e) { toast(e.message, true); return; }
  const rows = data.readings || [];
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  openModal({
    title: `Reading history · Room ${esc((S.electricity?.meters || []).find((m) => String(m.room_id) === String(roomId))?.room_no || roomId)}`,
    wide: true,
    body: rows.length ? `<div class="table-wrap"><table><thead><tr><th>Month</th><th class="num">Previous</th><th class="num">Reading</th><th class="num">Units</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${mlabel(r.month)}</td><td class="num muted">${fmtN(r.previous_reading)}</td><td class="num strong">${fmtN(r.reading)}</td>
        <td class="num">${fmtN(r.units)}</td><td class="num">${money(r.amount)}</td><td><span class="badge ${r.status === 'paid' ? 'ok' : 'info'}">${esc(r.status)}</span></td>
        <td class="small muted">${esc(r.source)}</td><td><button class="btn danger sm" data-act="del-elec-reading" data-id="${r.id}">×</button></td></tr>`).join('')}
      </tbody></table></div><p class="muted small">Total recorded: ${money(total)} · ${rows.length} reading(s)</p>` :
      '<div class="empty">No readings yet for this flat.</div>',
    foot: `<button class="btn ghost" data-act="close-modal">Close</button>`,
  });
}

function fmtN(n) { return Number(n || 0).toLocaleString('en-IN'); }

function openElecFetchModal(roomId) {
  const m = elecMeter(roomId);
  const link = (S.electricity?.config?.providerLinks || {})[m.provider] || S.electricity?.config?.defaultLink || '#';
  const apiOn = !!(S.electricity?.config?.apiConfigured);
  openModal({
    title: 'Get electricity details online',
    wide: true,
    body: `<div class="callout" style="margin-bottom:12px">BSES Delhi has no free public API. ${apiOn ? 'A provider API is configured on this server — try Fetch below.' : 'No provider API is configured yet — use the BSES button to check the bill, then record the reading manually.'}</div>
      <form data-form="elec-fetch" class="form-grid">
        <input type="hidden" name="roomId" value="${esc(roomId)}">
        <input type="hidden" name="meter_no" value="${esc(m.meter_no || '')}">
        <input type="hidden" name="ca_number" value="${esc(m.ca_number || '')}">
        <input type="hidden" name="provider" value="${esc(m.provider || 'BSES Rajdhani')}">
        <div class="field"><label>Meter / CA number</label><input value="${esc(m.meter_no || '')} ${m.ca_number ? '· CA ' + esc(m.ca_number) : ''}" disabled></div>
        <div class="field"><label>From month</label><input type="month" name="fromMonth" value="${esc(monthList()[12] || S.month)}"></div>
        <div class="field"><label>To month</label><input type="month" name="toMonth" value="${esc(S.month)}"></div>
      </form>
      <div id="elec-fetch-result"></div>`,
    foot: `<a class="btn soft" href="${esc(link)}" target="_blank" rel="noopener">Open BSES bill page ↗</a>
      <button class="btn ghost" data-act="close-modal">Close</button>
      ${apiOn ? '<button class="btn" data-act="elec-do-fetch">Fetch online</button>' : ''}`,
  });
}

function openUserModal(id) {
  const u = S.users.find((x) => String(x.id) === String(id)) || {};
  openModal({
    title: id ? 'Edit user' : 'Add family user',
    body: `<form data-form="user" class="form-grid">
      <input type="hidden" name="id" value="${esc(u.id || '')}">
      <div class="field"><label>Name *</label><input name="name" value="${esc(u.name || '')}" required></div>
      <div class="field"><label>Username *</label><input name="username" value="${esc(u.username || '')}" required></div>
      ${id ? '' : `<div class="field"><label>Password (min 6) *</label><input type="password" name="password" minlength="6" required></div>`}
      <div class="field"><label>Role</label><select name="role">
        <option value="member"${u.role === 'member' ? ' selected' : ''}>Member (view only)</option>
        <option value="admin"${u.role === 'admin' || !id ? ' selected' : ''}>Admin (record payments)</option>
        <option value="super_admin"${u.role === 'super_admin' ? ' selected' : ''}>Super admin (full control)</option>
      </select></div>
      ${id ? `<div class="field full"><label class="check"><input type="checkbox" name="active"${u.active ? ' checked' : ''}> Account active</label></div>` : ''}
    </form>`,
    foot: `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn" data-act="submit-form" data-target="user">Save user</button>`,
  });
}

async function openReceipt(id) {
  openModal({ title: 'Rent receipt', body: '<div class="empty">Preparing receipt…</div>' });
  try {
    const r = await api(`/payments/${id}/receipt/text`);
    S.receiptId = id;
    openModal({
      title: `Receipt ${r.payment.receipt_no || ''}`, wide: true,
      body: `<pre class="receipt-text">${esc(r.text)}</pre>
        <div id="share-slot"></div>`,
      foot: `<button class="btn ghost" data-act="copy-text">${IS_NATIVE ? 'Share / copy' : 'Copy text'}</button>
        <button class="btn soft" data-act="receipt-qr" data-id="${id}">🔗 QR / share link</button>
        <button class="btn amber" data-act="receipt-wa" data-id="${id}">💬 WhatsApp</button>
        <a class="btn" href="/api/payments/${id}/receipt/pdf" target="_blank">⬇ Download PDF</a>`,
    });
  } catch (e) { toast(e.message, true); closeModal(); }
}

async function openReminder(dueId, tenantId, month) {
  openModal({ title: 'Remind tenant', body: '<div class="empty">Preparing WhatsApp message…</div>' });
  try {
    const r = await api('/share/reminder', { body: { tenantId: Number(tenantId), month } });
    openModal({
      title: `Reminder · ${esc(r.tenant.name)}`, wide: true,
      body: `<div class="field"><label>Message (edit before sending)</label><textarea id="reminder-text" style="min-height:130px">${esc(r.text)}</textarea></div>
        <div id="share-slot"><img class="qr-img" src="${r.qr}" alt="QR code"><div class="small muted" style="text-align:center">Scan to view dues on any phone · <a href="${r.url}" target="_blank">Open link</a></div></div>`,
      foot: `<button class="btn ghost" data-act="close-modal">Close</button>
        <button class="btn soft" data-act="copy-reminder">Copy message</button>
        <button class="btn" id="send-reminder">💬 Open WhatsApp</button>`,
    });
    $('#send-reminder').onclick = () => {
      const text = $('#reminder-text').value;
      const wa = requireWa(r.tenant.phone, text);
      openExternal(wa);
    };
  } catch (e) { toast(e.message, true); closeModal(); }
}
function requireWa(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  const full = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}

async function openShareQr(paymentId) {
  try {
    const r = await api('/share/receipt', { body: { paymentId: Number(paymentId) } });
    const slot = $('#share-slot');
    if (!slot) return;
    slot.innerHTML = `<div style="text-align:center;margin-top:14px;border-top:1px solid var(--line);padding-top:14px">
      <img class="qr-img" src="${r.qr}" alt="Receipt QR"><div class="small muted">Scan to open the shareable receipt · <a href="${r.url}" target="_blank">Open link</a></div></div>`;
  } catch (e) { toast(e.message, true); }
}

/* ---------------- Form submissions ---------------- */
const FORMS = {
  async room(f) {
    const id = v(f, 'id');
    await api(id ? `/rooms/${id}` : '/rooms', {
      method: id ? 'PUT' : 'POST',
      body: { room_no: v(f, 'room_no'), floor: v(f, 'floor'), address: v(f, 'address'), rent: v(f, 'rent'), electricity_bill: v(f, 'electricity_bill'), notes: v(f, 'notes') },
    });
    return 'Room saved.';
  },
  async tenant(f) {
    const id = v(f, 'id');
    await api(id ? `/tenants/${id}` : '/tenants', {
      method: id ? 'PUT' : 'POST',
      body: {
        room_id: v(f, 'room_id') || null, name: v(f, 'name'), phone: v(f, 'phone'),
        email: v(f, 'email'), join_date: v(f, 'join_date'), notes: v(f, 'notes'),
      },
    });
    return 'Tenant saved.';
  },
  async payment(f) {
    const body = {
      tenant_id: Number(v(f, 'tenant_id')), month: v(f, 'month'),
      amount: Number(v(f, 'amount')), rent_amount: Number(v(f, 'rent_amount') || 0),
      extra_charges: Number(v(f, 'extra_charges') || 0), mode: v(f, 'mode'),
      reference: v(f, 'reference'), note: v(f, 'note'),
      adjust_due_ids: $$('input[name="adjust_due_ids"]:checked', f).map((el) => Number(el.value)),
      create_due_if_partial: checked(f, 'create_due_if_partial'),
    };
    const r = await api('/payments', { body });
    closeModal();
    await loadData();
    await renderView();
    toast(`Payment recorded · ${r.payment.receipt_no}`);
    if (r.payment.remaining > 0) toast(`${money(r.payment.remaining)} remains visible as a due.`);
    return null;
  },
  async due(f) {
    const id = v(f, 'id');
    await api(id ? `/dues/${id}` : '/dues', {
      method: id ? 'PUT' : 'POST',
      body: { tenant_id: Number(v(f, 'tenant_id')), month: v(f, 'month'), amount: Number(v(f, 'amount')), reason: v(f, 'reason') },
    });
    return 'Due saved.';
  },
  async meter(f) {
    const roomId = v(f, 'id');
    await api(`/electricity/meters/${roomId}`, {
      method: 'PUT',
      body: {
        meter_no: v(f, 'meter_no'), ca_number: v(f, 'ca_number'), provider: v(f, 'provider'),
        rate_per_unit: v(f, 'rate_per_unit'), notes: v(f, 'notes'),
      },
    });
    return 'Meter saved.';
  },
  async 'elec-reading'(f) {
    await api('/electricity/readings', {
      body: {
        roomId: Number(v(f, 'roomId')), month: v(f, 'month'), reading: Number(v(f, 'reading')),
        amount: v(f, 'amount') || null, status: v(f, 'status'),
        bill_date: v(f, 'bill_date'), due_date: v(f, 'due_date'),
      },
    });
    return 'Electricity reading saved.';
  },
  async 'elec-import'(f) {
    const readings = $$('input[name="elec_reading"]:checked', f).map((el) => JSON.parse(el.dataset.reading));
    if (!readings.length) throw new Error('Select at least one reading.');
    const r = await api('/electricity/readings/import', { body: { roomId: Number(v(f, 'roomId')), readings } });
    return `${r.saved} online reading(s) imported.`;
  },
  async expense(f) {
    const id = v(f, 'id');
    await api(id ? `/expenses/${id}` : '/expenses', {
      method: id ? 'PUT' : 'POST',
      body: {
        title: v(f, 'title'), amount: Number(v(f, 'amount')), category: v(f, 'category'),
        expense_date: v(f, 'expense_date'), note: v(f, 'note'),
      },
    });
    return 'Expense saved.';
  },
  async user(f) {
    const id = v(f, 'id');
    const body = { name: v(f, 'name'), username: v(f, 'username'), role: v(f, 'role') };
    if (!id) body.password = v(f, 'password');
    else body.active = checked(f, 'active');
    await api(id ? `/users/${id}` : '/users', { method: id ? 'PUT' : 'POST', body });
    return 'User saved.';
  },
  async 'change-password'(f) {
    await api('/auth/change-password', { body: { current: v(f, 'current'), next: v(f, 'next') } });
    f.reset();
    return 'Password updated.';
  },
  async 'upload-photo'(f) {
    await api(`/tenants/${f.dataset.id}/photo`, { body: new FormData(f) });
    S.detail = await api(`/tenants/${f.dataset.id}`);
    await loadData();
    await renderView();
    toast('Photo uploaded.');
    return null;
  },
  async 'upload-doc'(f) {
    await api(`/tenants/${f.dataset.id}/documents`, { body: new FormData(f) });
    await loadData();
    await renderView();
    toast('Document uploaded.');
    return null;
  },
};

document.addEventListener('submit', async (ev) => {
  const f = ev.target.closest('form[data-form]');
  if (!f) return;
  ev.preventDefault();
  const btn = $('button[type=submit]', f) || $('button', f);
  if (btn) btn.disabled = true;
  try {
    const msg = await FORMS[f.dataset.form](f);
    if (msg) { closeModal(); await loadData(); await renderView(); toast(msg); }
  } catch (e) {
    toast(e.message, true);
    if (btn) btn.disabled = false;
  }
});

/* ---------------- Actions ---------------- */
async function nativeCapture(kind, tenantId, source) {
  if (!N) return;
  try {
    toast(source === 'camera' ? 'Opening camera…' : 'Opening gallery…');
    const file = source === 'camera' ? await N.takePhoto() : await N.pickFromGallery();
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    const endpoint = kind === 'photo' ? `/tenants/${tenantId}/photo` : `/tenants/${tenantId}/documents`;
    await api(endpoint, { body: form });
    closeModal();
    await loadData();
    await renderView();
    toast(kind === 'photo' ? 'Photo saved.' : 'Document uploaded.');
  } catch (e) {
    const msg = String(e && e.message || '');
    if (/cancel/i.test(msg)) return;
    toast(msg || 'Could not capture image.', true);
  }
}

const ACTIONS = {
  nav: (el) => go(el.dataset.view),
  logout: async () => { await api('/auth/logout', { method: 'POST' }); location.hash = ''; location.reload(); },
  'close-modal': () => closeModal(),
  'modal-backdrop': (el, ev) => { if (ev.target === el) closeModal(); },
  'submit-form': (el) => {
    const f = $(`[data-form="${el.dataset.target}"]`);
    if (f) f.requestSubmit();
  },
  'add-room': () => openRoomModal(),
  'edit-room': (el) => openRoomModal(el.dataset.id),
  'del-room': (el) => confirmAction('Delete room', 'Permanently delete this room? Its tenant must be vacated first.', async () => {
    await api(`/rooms/${el.dataset.id}`, { method: 'DELETE' }); await loadData(); renderView(); toast('Room deleted.');
  }),
  'add-tenant': () => openTenantModal(),
  'edit-tenant': (el) => openTenantModal(el.dataset.id),
  'view-tenant': (el) => go('tenants', el.dataset.id),
  'vacate-tenant': (el) => confirmAction('Mark vacated', 'Mark this tenant as vacated? The room becomes available. Payment history is kept.', async () => {
    await api(`/tenants/${el.dataset.id}/vacate`, { method: 'POST' }); await loadData(); renderView(); toast('Tenant marked vacated.');
  }, 'Mark vacated'),
  'del-tenant': (el) => confirmAction('Delete tenant permanently', 'This permanently removes the tenant, their payments, dues and documents. This cannot be undone.', async () => {
    await api(`/tenants/${el.dataset.id}`, { method: 'DELETE' }); await loadData(); go('tenants'); toast('Tenant permanently deleted.');
  }),
  'open-payment': (el) => openPaymentModal(el.dataset.id),
  'fill-full-amount': () => {
    const f = $('[data-form="payment"]');
    if (!f) return;
    const rent = Number(v(f, 'rent_amount') || 0);
    const extra = Number(v(f, 'extra_charges') || 0);
    const adv = $$('input[name="adjust_due_ids"]:checked', f).reduce((s, el) => s + Number(S.dues.find((d) => String(d.id) === el.value)?.amount || 0), 0);
    f.elements.amount.value = rent + extra + adv;
    updatePayHint();
  },
  receipt: (el) => openReceipt(el.dataset.id),
  'receipt-wa': async (el) => {
    try {
      const r = await api('/share/receipt', { body: { paymentId: Number(el.dataset.id) } });
      openExternal(r.waLink || requireWa(null, r.text));
    } catch (e) { toast(e.message, true); }
  },
  'receipt-qr': (el) => openShareQr(el.dataset.id),
  'copy-text': async () => {
    const text = $('.receipt-text')?.textContent || '';
    if (N) {
      const result = await N.shareOrCopy({ title: 'RentFlow receipt', text });
      if (result === 'copied') toast('Receipt text copied.');
      else if (result === 'failed') toast('Sharing is unavailable here.', true);
      return;
    }
    try { await navigator.clipboard.writeText(text); toast('Receipt text copied.'); }
    catch (e) { toast('Copy failed. Select the text manually.', true); }
  },
  'copy-reminder': async () => {
    const text = $('#reminder-text')?.value || '';
    if (N) {
      const result = await N.shareOrCopy({ title: 'Rent reminder', text });
      if (result === 'copied') toast('Message copied.');
      else if (result === 'failed') toast('Sharing is unavailable here.', true);
      return;
    }
    try { await navigator.clipboard.writeText(text); toast('Message copied.'); }
    catch (e) { toast('Copy failed.', true); }
  },
  'del-payment': (el) => confirmAction('Delete payment', 'Permanently delete this payment? Related generated dues will be removed and settled dues reopened.', async () => {
    await api(`/payments/${el.dataset.id}`, { method: 'DELETE' }); await loadData(); renderView(); toast('Payment deleted.');
  }),
  'add-due': () => openDueModal(),
  'edit-due': (el) => openDueModal(el.dataset.id),
  'dues-tab': (el) => { S.duesTab = el.dataset.tab; renderView(); },
  'settle-due': (el) => confirmAction('Settle due', 'Create a settlement receipt and mark this due as paid?', async () => {
    await api(`/dues/${el.dataset.id}/settle`, { method: 'POST' }); await loadData(); renderView(); toast('Due settled with receipt.');
  }, 'Settle now'),
  'carry-due': (el) => confirmAction('Carry forward', 'Move this due to the next month?', async () => {
    await api(`/dues/${el.dataset.id}/carry-forward`, { method: 'POST' }); await loadData(); renderView(); toast('Due carried forward.');
  }, 'Carry forward'),
  'remind-due': (el) => openReminder(el.dataset.id, el.dataset.tenant, el.dataset.month),
  'del-due': (el) => confirmAction('Delete due', 'Permanently remove this due entry?', async () => {
    await api(`/dues/${el.dataset.id}`, { method: 'DELETE' }); await loadData(); renderView(); toast('Due deleted.');
  }),
  'add-expense': () => openExpenseModal(),
  'edit-expense': (el) => openExpenseModal(el.dataset.id),
  'del-expense': (el) => confirmAction('Delete expense', 'Remove this expense entry?', async () => {
    await api(`/expenses/${el.dataset.id}`, { method: 'DELETE' }); await loadData(); renderView(); toast('Expense deleted.');
  }),
  'add-elec-meter': (el) => openMeterModal(el.dataset.id),
  'del-elec-meter': (el) => confirmAction('Remove meter', 'Remove this meter and all its reading history?', async () => {
    await api(`/electricity/meters/${el.dataset.id}`, { method: 'DELETE' });
    await loadData(); renderView(); toast('Meter removed.');
  }),
  'add-elec-reading': (el) => openElecReadingModal(el.dataset.id, el.dataset.room),
  'elec-history': async (el) => { await openElecHistoryModal(el.dataset.id); },
  'del-elec-reading': (el) => confirmAction('Delete reading', 'Remove this meter reading?', async () => {
    await api(`/electricity/readings/${el.dataset.id}`, { method: 'DELETE' });
    closeModal(); await loadData(); renderView(); toast('Reading deleted.');
  }),
  'elec-fetch': (el) => openElecFetchModal(el.dataset.id),
  'elec-do-fetch': async () => {
    const f = $('[data-form="elec-fetch"]');
    if (!f) return;
    const btn = $('[data-act="elec-do-fetch"]');
    if (btn) btn.disabled = true;
    const provider = v(f, 'provider');
    const link = (S.electricity?.config?.providerLinks || {})[provider] || S.electricity?.config?.defaultLink || '#';
    try {
      const r = await api('/electricity/fetch', {
        body: {
          roomId: Number(v(f, 'roomId')), meter_no: v(f, 'meter_no'), ca_number: v(f, 'ca_number'),
          provider, fromMonth: v(f, 'fromMonth'), toMonth: v(f, 'toMonth'),
        },
      });
      const result = $('#elec-fetch-result');
      if (!r.readings || !r.readings.length) {
        result.innerHTML = '<div class="empty">No readings returned for that period.</div>';
        return;
      }
      result.innerHTML = `<div class="small muted" style="margin:10px 0">Select the readings to save:</div>
        <form data-form="elec-import"><input type="hidden" name="roomId" value="${esc(v(f, 'roomId'))}">
        <div class="table-wrap"><table><thead><tr><th></th><th>Month</th><th class="num">Reading</th><th class="num">Amount</th></tr></thead><tbody>
        ${r.readings.map((item, i) => `<tr><td><input type="checkbox" name="elec_reading" data-reading="${esc(JSON.stringify(item))}" ${i === 0 ? 'checked' : ''}></td>
          <td>${mlabel(item.month)}</td><td class="num">${fmtN(item.reading)}</td><td class="num">${money(item.amount)}</td></tr>`).join('')}
        </tbody></table></div></form>
        <div class="btn-row" style="margin-top:10px"><button class="btn" data-act="submit-form" data-target="elec-import">Import selected</button></div>`;
      toast(`${r.readings.length} reading(s) found online.`);
    } catch (e) {
      const msg = e.message || 'Fetch failed.';
      if (/No electricity data provider/i.test(msg)) {
        $('#elec-fetch-result').innerHTML = `<div class="callout" style="margin-top:12px">Online fetch is not configured on this server. Check the bill on the BSES website and use <b>＋ Reading</b> to save it.
          <div class="btn-row" style="margin-top:8px"><a class="btn soft sm" href="${esc(link)}" target="_blank" rel="noopener">Open BSES bill page ↗</a></div></div>`;
      } else toast(msg, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  },
  'clear-demo-data': () => confirmAction('Clear demo data',
    'Permanently delete all rooms, tenants, payments, dues, expenses and electricity records? Family user accounts stay. This cannot be undone.',
    async () => {
      await api('/admin/clear-demo-data', { method: 'POST' });
      await loadData(); renderView(); toast('Demo data cleared. You can now add your own rooms.');
    }),
  'add-user': () => openUserModal(),
  'edit-user': (el) => openUserModal(el.dataset.id),
  'toggle-user': (el) => confirmAction(el.dataset.active === '0' ? 'Activate user' : 'Deactivate user',
    el.dataset.active === '0' ? 'Allow this person to sign in again?' : 'This person will no longer be able to sign in until reactivated.', async () => {
      await api(`/users/${el.dataset.id}`, { method: 'PUT', body: { active: Number(el.dataset.active) } });
      await loadData(); renderView(); toast('User updated.');
    }, el.dataset.active === '0' ? 'Activate' : 'Deactivate'),
  'reset-password': (el) => openModal({
    title: 'Reset password',
    body: `<form data-form="reset-password" data-id="${el.dataset.id}" class="field"><label>New password (min 6 characters)</label><input type="password" name="password" minlength="6" required></form>`,
    foot: `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn" data-act="submit-form" data-target="reset-password">Reset password</button>`,
  }),
  'del-user': (el) => confirmAction('Permanently delete account', 'This permanently deletes the user account and its activity log. Cannot be undone.', async () => {
    await api(`/users/${el.dataset.id}`, { method: 'DELETE' }); await loadData(); renderView(); toast('User deleted.');
  }),
  'del-file': (el) => confirmAction('Delete file', 'Permanently delete this document?', async () => {
    await api(`/files/${el.dataset.id}`, { method: 'DELETE' }); await loadData(); await renderView(); toast('File deleted.');
  }),
  'upload-photo': (el) => {
    const t = S.detail?.tenant;
    openModal({
      title: 'Upload tenant photo',
      body: `<form data-form="upload-photo" data-id="${el.dataset.id}"><div class="field"><label>JPG / PNG / WebP photo</label><input type="file" name="file" accept="image/*" required></div>
        ${IS_NATIVE ? `<div class="btn-row" style="margin-top:10px"><button class="btn soft sm" type="button" data-act="camera-photo" data-id="${el.dataset.id}" data-source="camera">📷 Take photo</button>
        <button class="btn ghost sm" type="button" data-act="camera-photo" data-id="${el.dataset.id}" data-source="gallery">🖼 Choose from gallery</button></div>` : ''}</form>`,
      foot: `<button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn" data-act="submit-form" data-target="upload-photo">Upload photo</button>`,
    });
  },
  'camera-photo': (el) => nativeCapture('photo', el.dataset.id, el.dataset.source),
  'camera-doc': (el) => nativeCapture('document', el.dataset.id, el.dataset.source),
  'toggle-all-payments': () => { S.paymentsAll = !S.paymentsAll; renderView(); },
  voice: () => toggleVoice(),
  'voice-cmd': (el) => runVoiceCommand(el.dataset.cmd),
};
FORMS['reset-password'] = async (f) => {
  await api(`/users/${f.dataset.id}/reset-password`, { method: 'POST', body: { password: v(f, 'password') } });
  return 'Password reset.';
};

const CHANGES = {
  'room-electricity-bill': async (el) => {
    const amount = Math.max(0, Math.round(Number(el.value) || 0));
    el.value = amount;
    const room = S.rooms.find((r) => String(r.id) === el.dataset.id);
    if (!room) return;
    try {
      await api(`/rooms/${el.dataset.id}`, { method: 'PUT', body: { electricity_bill: amount } });
      room.electricity_bill = amount;
      toast('Electricity bill saved.');
    } catch (e) {
      el.value = room.electricity_bill || 0;
      toast(e.message, true);
    }
  },
  month: (el) => { S.month = el.value; loadData().then(renderView); },
  'payment-tenant': (el) => {
    const f = el.closest('form');
    const t = S.tenants.find((x) => String(x.id) === el.value);
    if (t) {
      f.elements.rent_amount.value = t.room_rent || 0;
      const roomSelect = $('[data-change="payment-room"]', f);
      if (roomSelect) roomSelect.value = t.id;
    }
    $('#due-options').innerHTML = dueOptionsHtml(el.value);
    updatePayHint();
  },
  'payment-room': (el) => {
    const f = el.closest('form');
    f.elements.tenant_id.value = el.value;
    const t = S.tenants.find((x) => String(x.id) === el.value);
    if (t) f.elements.rent_amount.value = t.room_rent || 0;
    $('#due-options').innerHTML = dueOptionsHtml(el.value);
    updatePayHint();
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { ev.preventDefault(); fn(el, ev); }
});
document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-change]');
  if (el && CHANGES[el.dataset.change]) CHANGES[el.dataset.change](el, ev);
});
document.addEventListener('input', (ev) => {
  if (ev.target.closest('[data-form="payment"]')) updatePayHint();
});

/* ---------------- Voice assistant (UI stub) ---------------- */
const VOICE_COMMANDS = [
  { cmd: 'collect', hi: 'किराया लें', en: 'Collect rent', ico: '💰' },
  { cmd: 'dues', hi: 'बकाया दिखाओ', en: 'Show pending dues', ico: '⏳' },
  { cmd: 'expense', hi: 'खर्च जोड़ें', en: 'Add an expense', ico: '🧾' },
  { cmd: 'reports', hi: 'मासिक रिपोर्ट', en: 'Open monthly report', ico: '📊' },
  { cmd: 'remind', hi: 'टेनेंट को याद दिलाओ', en: 'Remind a tenant', ico: '💬' },
  { cmd: 'dashboard', hi: 'डैशबोर्ड खोलो', en: 'Open dashboard', ico: '🏠' },
];
function renderVoice() {
  $('#voice-root').innerHTML = `
    <button id="voice-fab" data-act="voice" title="Voice assistant / वॉइस सहायक">🎤</button>
    ${S.voiceOpen ? `<div class="voice-panel">
      <h3>Voice Assistant · वॉइस सहायक</h3><div class="sub">Hindi + English commands</div>
      <button class="mic-big" id="mic-big" title="Tap to speak">🎙️</button>
      <div class="voice-status" id="voice-status">Tap the mic, or choose a command below.</div>
      <div class="cmd-grid">${VOICE_COMMANDS.map((c) => `<button class="cmd" data-act="voice-cmd" data-cmd="${c.cmd}"><b>${c.ico} ${c.hi}</b><small>${c.en}</small></button>`).join('')}</div>
      <div class="small muted" style="margin-top:12px;text-align:center">Voice input is being prepared. Command buttons already work.</div>
    </div>` : ''}`;
  if (S.voiceOpen) {
    $('#mic-big').onclick = () => {
      const b = $('#mic-big');
      const st = $('#voice-status');
      b.classList.add('listening');
      st.textContent = 'Listening… (voice input coming soon)';
      setTimeout(() => { b.classList.remove('listening'); st.textContent = 'Tap a command below to continue.'; }, 1600);
    };
  }
}
function toggleVoice() { S.voiceOpen = !S.voiceOpen; renderVoice(); }
function runVoiceCommand(cmd) {
  S.voiceOpen = false;
  renderVoice();
  if (cmd === 'collect') openPaymentModal();
  else if (cmd === 'dues') go('dues');
  else if (cmd === 'expense') openExpenseModal();
  else if (cmd === 'reports') go('reports');
  else if (cmd === 'remind') go('dues');
  else go('dashboard');
}

/* ---------------- Start ---------------- */
boot();
