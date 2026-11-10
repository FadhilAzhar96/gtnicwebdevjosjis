# Laundry Akbar - Web System Order Laundry (Fullstack)

Tampilan sama persis dengan prototipe HTML Anda (landing page, dashboard pelanggan, panel admin, QRIS, notifikasi),
tetapi datanya kini disimpan di server, bukan di localStorage browser.

**Stack:** Node.js + Express (REST API) · HTML + Tailwind CDN + JavaScript (frontend) · penyimpanan file JSON.

## Struktur folder
```
laundry-akbar-fullstack/
├── backend/
│   ├── server.js          # REST API + menyajikan frontend
│   ├── package.json
│   ├── .env.example       # salin menjadi .env
│   └── data/db.json       # "database" (user, pesanan, notifikasi)
├── frontend/
│   ├── index.html         # tampilan (dari prototipe Anda)
│   └── app.js             # logika, memanggil API
├── .vscode/               # pengaturan & konfigurasi debug
├── buat-zip.ps1  buat-zip.sh
└── README.md
```

## Menjalankan (butuh Node.js 18+ dan internet untuk CDN Tailwind)
```bash
cd backend
cp .env.example .env        # Windows: copy .env.example .env
npm install
npm start
```
Buka http://localhost:3000

**Akun admin:** username `admin`, password `admin123` (ubah di `.env` lewat `ADMIN_PASSWORD`, lalu restart server).
Pelanggan mendaftar sendiri lewat tombol **Daftar**.

## Yang berubah dari prototipe
- Akun, pesanan, dan notifikasi tersimpan di server; kata sandi di-hash (scrypt), login memakai token sesi.
- Pelanggan hanya melihat pesanannya sendiri; admin melihat semua dan mengubah status.
- Harga dihitung ulang di server (tidak bisa dimanipulasi dari browser).
- Notifikasi per akun: admin menerima pesanan baru, pembayaran, dan pesan kontak; pelanggan menerima perubahan status.
- Data otomatis disegarkan tiap 15 detik.
- Form "Hubungi Kami" kini tersimpan (lihat di lonceng admin atau `GET /api/admin/messages`).
- Total Pendapatan di panel admin hanya menghitung pesanan berstatus Lunas.

## API
| Method | Endpoint | Akses |
|---|---|---|
| POST | /api/auth/register, /api/auth/login | publik |
| GET | /api/auth/me · POST /api/auth/logout | login |
| GET | /api/pricing | publik |
| GET, POST | /api/orders | login (admin: semua, pelanggan: milik sendiri) |
| PATCH | /api/orders/:id/status | admin |
| POST | /api/orders/:id/pay | pemilik pesanan |
| GET, POST | /api/notifications, /api/notifications/read | login |
| POST | /api/contact | publik |
| GET | /api/admin/messages | admin |

## Catatan penting
- Pembayaran QRIS masih **simulasi** (tombol konfirmasi), sama seperti prototipe. Untuk pembayaran nyata,
  hubungkan ke payment gateway (mis. Midtrans/Xendit) dan konfirmasi lewat webhook.
- Penyimpanan file JSON cocok untuk skala kecil. Untuk lalu lintas tinggi, ganti dengan MySQL/PostgreSQL.
- Jika dipublikasikan, gunakan HTTPS dan ganti `ADMIN_PASSWORD`.
