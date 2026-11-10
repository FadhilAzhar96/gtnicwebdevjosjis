require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

const PRICES = { Reguler: 6000, Kering: 12000, Basah: 4000, Express: 10000 };
const PICKUP_FEE = 5000;
const STATUSES = ['Menunggu', 'Diproses', 'Selesai', 'Diambil'];
const PICKUPS = ['antar-jemput', 'antar-sendiri'];

/* ---------- Penyimpanan (file JSON) ---------- */
let db = { users: [], orders: [], notifications: [], sessions: {}, messages: [], seq: 1000 };
fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) {
  try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
  catch (e) { console.error('data/db.json rusak:', e.message); process.exit(1); }
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- Helper keamanan ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const attempts = new Map();
const blocked = k => { const a = attempts.get(k); return a && a.count >= 8 && Date.now() - a.first < 15 * 60 * 1000; };
function failed(k) {
  const now = Date.now(), a = attempts.get(k);
  if (!a || now - a.first > 15 * 60 * 1000) attempts.set(k, { count: 1, first: now }); else a.count++;
}

/* ---------- Akun admin (dibuat/diperbarui saat server start) ---------- */
(function ensureAdmin() {
  const key = ADMIN_USERNAME.toLowerCase();
  const found = db.users.find(u => u.key === key);
  if (found) { found.passwordHash = hashPassword(ADMIN_PASSWORD); found.role = 'admin'; }
  else db.users.push({ key, username: ADMIN_USERNAME, passwordHash: hashPassword(ADMIN_PASSWORD), role: 'admin', createdAt: new Date().toISOString() });
  saveDb();
})();
const ADMIN_KEY = ADMIN_USERNAME.toLowerCase();

function notify(userKey, message) {
  db.notifications.push({ id: crypto.randomUUID(), userKey, message, read: false, createdAt: new Date().toISOString() });
  if (db.notifications.length > 2000) db.notifications = db.notifications.slice(-2000);
}
const rp = n => 'Rp ' + Number(n).toLocaleString('id-ID');
const publicUser = u => ({ username: u.username, role: u.role });
const publicOrder = ({ userKey, ...o }) => o;

/* ---------- App ---------- */
const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

function auth(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Silakan masuk terlebih dahulu.' });
  const h = sha(m[1]), s = db.sessions[h];
  if (!s || s.expires < Date.now()) {
    if (s) { delete db.sessions[h]; saveDb(); }
    return res.status(401).json({ error: 'Sesi berakhir, silakan masuk kembali.' });
  }
  const user = db.users.find(u => u.key === s.userKey);
  if (!user) return res.status(401).json({ error: 'Akun tidak ditemukan.' });
  req.user = user; req.tokenHash = h;
  next();
}
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Hanya untuk admin.' });

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { userKey: user.key, expires: Date.now() + SESSION_TTL };
  for (const [h, s] of Object.entries(db.sessions)) if (s.expires < Date.now()) delete db.sessions[h];
  saveDb();
  return token;
}

/* ---------- Auth ---------- */
app.post('/api/auth/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username))
    return res.status(400).json({ error: 'Nama pengguna 3-30 karakter (huruf, angka, _ . -).' });
  if (password.length < 6) return res.status(400).json({ error: 'Kata sandi minimal 6 karakter.' });
  const key = username.toLowerCase();
  if (key === ADMIN_KEY) return res.status(400).json({ error: 'Nama pengguna "admin" tidak dapat digunakan!' });
  if (db.users.some(u => u.key === key)) return res.status(409).json({ error: 'Nama pengguna sudah terdaftar! Silakan masuk.' });
  const user = { key, username, passwordHash: hashPassword(password), role: 'user', createdAt: new Date().toISOString() };
  db.users.push(user);
  res.status(201).json({ token: createSession(user), user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const limitKey = req.ip + ':' + username.toLowerCase();
  if (blocked(limitKey)) return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.' });
  const user = db.users.find(u => u.key === username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Akun tidak ditemukan. Silakan daftar akun terlebih dahulu.' });
  if (!verifyPassword(password, user.passwordHash)) {
    failed(limitKey);
    return res.status(401).json({ error: 'Kata sandi salah! Silakan coba lagi.' });
  }
  attempts.delete(limitKey);
  res.json({ token: createSession(user), user: publicUser(user) });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/auth/logout', auth, (req, res) => {
  delete db.sessions[req.tokenHash]; saveDb();
  res.json({ ok: true });
});

/* ---------- Harga ---------- */
app.get('/api/pricing', (req, res) => res.json({ prices: PRICES, pickupFee: PICKUP_FEE, statuses: STATUSES }));

/* ---------- Pesanan ---------- */
app.get('/api/orders', auth, (req, res) => {
  const list = req.user.role === 'admin' ? db.orders : db.orders.filter(o => o.userKey === req.user.key);
  res.json({ orders: list.slice().reverse().map(publicOrder) });
});

app.post('/api/orders', auth, (req, res) => {
  if (req.user.role === 'admin') return res.status(403).json({ error: 'Admin tidak dapat membuat pesanan.' });
  const { service, pickup } = req.body;
  const weight = Number(req.body.weight);
  let address = String(req.body.address || '').trim().slice(0, 300);
  if (!(service in PRICES)) return res.status(400).json({ error: 'Layanan tidak valid.' });
  if (!PICKUPS.includes(pickup)) return res.status(400).json({ error: 'Opsi pengambilan tidak valid.' });
  if (!(weight > 0 && weight <= 100)) return res.status(400).json({ error: 'Berat harus antara 0.1 - 100 kg.' });
  if (pickup === 'antar-jemput' && !address) return res.status(400).json({ error: 'Alamat penjemputan wajib diisi.' });
  if (!address) address = 'Ambil di outlet';

  const order = {
    id: `ORD-${++db.seq}`,
    userKey: req.user.key,
    customerName: req.user.username,
    service, weight, pickup, address,
    totalPrice: Math.round(PRICES[service] * weight + (pickup === 'antar-jemput' ? PICKUP_FEE : 0)),
    status: 'Menunggu',
    paymentStatus: 'Menunggu Pembayaran',
    date: new Date().toISOString().split('T')[0]
  };
  db.orders.push(order);
  notify(ADMIN_KEY, `Pesanan baru ${order.id} dari ${order.customerName} (${service}, ${weight} kg, ${rp(order.totalPrice)}).`);
  saveDb();
  res.status(201).json(publicOrder(order));
});

app.patch('/api/orders/:id/status', auth, adminOnly, (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Status tidak valid.' });
  order.status = req.body.status;
  notify(order.userKey, `Status pesanan ${order.id} diperbarui menjadi "${order.status}".`);
  saveDb();
  res.json(publicOrder(order));
});

// Simulasi pembayaran QRIS (lihat README untuk integrasi payment gateway sungguhan)
app.post('/api/orders/:id/pay', auth, (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order || (req.user.role !== 'admin' && order.userKey !== req.user.key))
    return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  if (order.paymentStatus !== 'Lunas') {
    order.paymentStatus = 'Lunas';
    const msg = `Pembayaran QRIS untuk pesanan ${order.id} (${rp(order.totalPrice)}) telah Lunas.`;
    notify(order.userKey, msg);
    notify(ADMIN_KEY, `${msg} Pelanggan: ${order.customerName}.`);
    saveDb();
  }
  res.json(publicOrder(order));
});

/* ---------- Notifikasi ---------- */
app.get('/api/notifications', auth, (req, res) => {
  const list = db.notifications.filter(n => n.userKey === req.user.key).slice(-50).reverse()
    .map(({ userKey, ...n }) => n);
  res.json({ notifications: list });
});

app.post('/api/notifications/read', auth, (req, res) => {
  db.notifications.forEach(n => { if (n.userKey === req.user.key) n.read = true; });
  saveDb();
  res.json({ ok: true });
});

/* ---------- Form kontak ---------- */
app.post('/api/contact', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const phone = String(req.body.phone || '').trim().slice(0, 30);
  const message = String(req.body.message || '').trim().slice(0, 1000);
  if (!name || !phone || !message) return res.status(400).json({ error: 'Semua kolom wajib diisi.' });
  db.messages.push({ id: crypto.randomUUID(), name, phone, message, createdAt: new Date().toISOString() });
  notify(ADMIN_KEY, `Pesan baru dari ${name} (${phone}): ${message.slice(0, 120)}`);
  saveDb();
  res.status(201).json({ ok: true });
});

app.get('/api/admin/messages', auth, adminOnly, (req, res) => res.json({ messages: db.messages.slice().reverse() }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Format data tidak valid.' });
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

app.listen(PORT, () => console.log(`Laundry Akbar berjalan di http://localhost:${PORT}`));
