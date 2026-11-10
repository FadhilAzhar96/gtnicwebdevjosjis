require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { kv } = require('@vercel/kv'); // Menggunakan Vercel KV

const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

const PRICES = { Reguler: 6000, Kering: 12000, Basah: 4000, Express: 10000 };
const PICKUP_FEE = 5000;
const STATUSES = ['Menunggu', 'Diproses', 'Selesai', 'Diambil'];
const PICKUPS = ['antar-jemput', 'antar-sendiri'];

/* ---------- Fungsi Database Vercel KV ---------- */
const DB_KEY = 'laundry_akbar_db';

async function getDb() {
  let db = await kv.get(DB_KEY);
  if (!db) {
    db = { users: [], orders: [], notifications: [], sessions: {}, messages: [], seq: 1000 };
    await kv.set(DB_KEY, db);
  }
  return db;
}

async function saveDb(db) {
  await kv.set(DB_KEY, db);
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

/* ---------- Inisialisasi Akun Admin ---------- */
async function ensureAdmin() {
  const db = await getDb();
  const key = ADMIN_USERNAME.toLowerCase();
  const found = db.users.find(u => u.key === key);
  if (found) { 
    found.passwordHash = hashPassword(ADMIN_PASSWORD); 
    found.role = 'admin'; 
  } else {
    db.users.push({ key, username: ADMIN_USERNAME, passwordHash: hashPassword(ADMIN_PASSWORD), role: 'admin', createdAt: new Date().toISOString() });
  }
  await saveDb(db);
}
ensureAdmin();
const ADMIN_KEY = ADMIN_USERNAME.toLowerCase();

async function notify(db, userKey, message) {
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

async function auth(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Silakan masuk terlebih dahulu.' });
  
  const db = await getDb();
  const h = sha(m[1]), s = db.sessions[h];
  if (!s || s.expires < Date.now()) {
    if (s) { delete db.sessions[h]; await saveDb(db); }
    return res.status(401).json({ error: 'Sesi berakhir, silakan masuk kembali.' });
  }
  const user = db.users.find(u => u.key === s.userKey);
  if (!user) return res.status(401).json({ error: 'Akun tidak ditemukan.' });
  req.user = user; req.tokenHash = h; req.db = db;
  next();
}

const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Hanya untuk admin.' });

async function createSession(db, user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { userKey: user.key, expires: Date.now() + SESSION_TTL };
  for (const [h, s] of Object.entries(db.sessions)) if (s.expires < Date.now()) delete db.sessions[h];
  await saveDb(db);
  return token;
}

/* ---------- Auth ---------- */
app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username))
    return res.status(400).json({ error: 'Nama pengguna 3-30 karakter (huruf, angka, _ . -).' });
  if (password.length < 6) return res.status(400).json({ error: 'Kata sandi minimal 6 karakter.' });
  const key = username.toLowerCase();
  if (key === ADMIN_KEY) return res.status(400).json({ error: 'Nama pengguna "admin" tidak dapat digunakan!' });
  
  const db = await getDb();
  if (db.users.some(u => u.key === key)) return res.status(409).json({ error: 'Nama pengguna sudah terdaftar! Silakan masuk.' });
  const user = { key, username, passwordHash: hashPassword(password), role: 'user', createdAt: new Date().toISOString() };
  db.users.push(user);
  const token = await createSession(db, user);
  res.status(201).json({ token, user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const limitKey = req.ip + ':' + username.toLowerCase();
  if (blocked(limitKey)) return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.' });
  
  const db = await getDb();
  const user = db.users.find(u => u.key === username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Akun tidak ditemukan. Silakan daftar akun terlebih dahulu.' });
  if (!verifyPassword(password, user.passwordHash)) {
    failed(limitKey);
    return res.status(401).json({ error: 'Kata sandi salah! Silakan coba lagi.' });
  }
  attempts.delete(limitKey);
  const token = await createSession(db, user);
  res.json({ token, user: publicUser(user) });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/auth/logout', auth, async (req, res) => {
  delete req.db.sessions[req.tokenHash]; 
  await saveDb(req.db);
  res.json({ ok: true });
});

/* ---------- Harga ---------- */
app.get('/api/pricing', (req, res) => res.json({ prices: PRICES, pickupFee: PICKUP_FEE, statuses: STATUSES }));

/* ---------- Pesanan ---------- */
app.get('/api/orders', auth, (req, res) => {
  const list = req.user.role === 'admin' ? req.db.orders : req.db.orders.filter(o => o.userKey === req.user.key);
  res.json({ orders: list.slice().reverse().map(publicOrder) });
});

app.post('/api/orders', auth, async (req, res) => {
  if (req.user.role === 'admin') return res.status(403).json({ error: 'Admin tidak dapat membuat pesanan.' });
  const { service, pickup } = req.body;
  const weight = Number(req.body.weight);
  let address = String(req.body.address || '').trim().slice(0, 300);
  if (!(service in PRICES)) return res.status(400).json({ error: 'Layanan tidak valid.' });
  if (!PICKUPS.includes(pickup)) return res.status(400).json({ error: 'Opsi pengambilan tidak valid.' });
  if (!(weight > 0 && weight <= 100)) return res.status(400).json({ error: 'Berat harus antara 0.1 - 100 kg.' });
  if (pickup === 'antar-jemput' && !address) return res.status(400).json({ error: 'Alamat penjemputan wajib diisi.' });
  if (!address) address = 'Ambil di outlet';

  const db = req.db;
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
  await notify(db, ADMIN_KEY, `Pesanan baru ${order.id} dari ${order.customerName} (${service}, ${weight} kg, ${rp(order.totalPrice)}).`);
  await saveDb(db);
  res.status(201).json(publicOrder(order));
});

app.patch('/api/orders/:id/status', auth, adminOnly, async (req, res) => {
  const db = req.db;
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Status tidak valid.' });
  order.status = req.body.status;
  await notify(db, order.userKey, `Status pesanan ${order.id} diperbarui menjadi "${order.status}".`);
  await saveDb(db);
  res.json(publicOrder(order));
});

app.post('/api/orders/:id/pay', auth, async (req, res) => {
  const db = req.db;
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order || (req.user.role !== 'admin' && order.userKey !== req.user.key))
    return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  if (order.paymentStatus !== 'Lunas') {
    order.paymentStatus = 'Lunas';
    const msg = `Pembayaran QRIS untuk pesanan ${order.id} (${rp(order.totalPrice)}) telah Lunas.`;
    await notify(db, order.userKey, msg);
    await notify(db, ADMIN_KEY, `${msg} Pelanggan: ${order.customerName}.`);
    await saveDb(db);
  }
  res.json(publicOrder(order));
});

/* ---------- Notifikasi ---------- */
app.get('/api/notifications', auth, (req, res) => {
  const list = req.db.notifications.filter(n => n.userKey === req.user.key).slice(-50).reverse()
    .map(({ userKey, ...n }) => n);
  res.json({ notifications: list });
});

app.post('/api/notifications/read', auth, async (req, res) => {
  req.db.notifications.forEach(n => { if (n.userKey === req.user.key) n.read = true; });
  await saveDb(req.db);
  res.json({ ok: true });
});

/* ---------- Form kontak ---------- */
app.post('/api/contact', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const phone = String(req.body.phone || '').trim().slice(0, 30);
  const message = String(req.body.message || '').trim().slice(0, 1000);
  if (!name || !phone || !message) return res.status(400).json({ error: 'Semua kolom wajib diisi.' });
  
  const db = await getDb();
  db.messages.push({ id: crypto.randomUUID(), name, phone, message, createdAt: new Date().toISOString() });
  await notify(db, ADMIN_KEY, `Pesan baru dari ${name} (${phone}): ${message.slice(0, 120)}`);
  await saveDb(db);
  res.status(201).json({ ok: true });
});

app.get('/api/admin/messages', auth, adminOnly, (req, res) => res.json({ messages: req.db.messages.slice().reverse() }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Format data tidak valid.' });
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

// Ekspor app untuk Vercel Serverless
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Laundry Akbar berjalan di http://localhost:${PORT}`));
}

module.exports = app;
