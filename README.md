# mempool.my.id

Dasbor & explorer Bitcoin yang berjalan penuh di **Cloudflare Workers + D1**. Fee, mempool, mining, Lightning, explorer, dan konverter, semuanya data live (tanpa data dummy).

- `src/index.js`: Worker (API, proxy mempool ber-allowlist, cron, kontak)
- `src/page.html`: tampilan (HTML/CSS/JS, satu berkas)
- `schema.sql`: tabel D1 (`fees`, `fee_history`, `rates_cache`)
- `wrangler.toml`: konfigurasi (binding D1 `stagingconnect`)

## Menjalankan

```bash
npm install
cp .dev.vars.example .dev.vars          # opsional, untuk uji form kontak
npx wrangler d1 execute stagingconnect --local --file=schema.sql
npm run dev
```

## Deploy lewat GitHub (Workers Builds)

1. Isi `database_name` dan `database_id` di `wrangler.toml` (lihat `npx wrangler d1 list`). `database_id` hanya pengenal, bukan kredensial.
2. Push ke repo GitHub.
3. Cloudflare Dashboard → **Workers & Pages → Create → Import a repository** → hubungkan GitHub.
4. Saat memasang **Cloudflare Workers and Pages** GitHub App, pilih **Only select repositories** dan centang **hanya repo ini**, bukan "All repositories".
5. Build command kosong, deploy command `npx wrangler deploy`.
6. Pasang secret (Settings → Variables and Secrets, tipe *Secret*), atau `npx wrangler secret put NAMA`:
   `TURNSTILE_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
   `TURNSTILE_SITEKEY` (publik) diisi di `[vars]`.

> Variabel biasa yang diubah di dashboard akan tertimpa isi `wrangler.toml` saat deploy; ubah lewat berkas itu. Secret tidak tertimpa.

## Keamanan

**Database**
- D1 hanya bisa diakses lewat binding Worker. Tidak ada endpoint SQL publik.
- Semua query memakai `prepare().bind()`; input pengguna tidak pernah digabung ke string SQL.
- Endpoint publik hanya membaca. Penulisan hanya dari cron (`fees`, `fee_history`, `rates_cache`).
- Bila Worker staging dan produksi memakai database yang sama, keduanya sama-sama menulis tiap menit. Pakai database terpisah, atau kosongkan `crons` di staging.
- Cadangan: D1 Time Travel (`npx wrangler d1 time-travel info <DB>`) dan `npx wrangler d1 export <DB> --remote --output=backup.sql`.

**Repo open source**
- Jangan commit secret. `.dev.vars` sudah di `.gitignore`; aktifkan *Secret scanning* dan *Push protection* di GitHub.
- Aktifkan 2FA GitHub & Cloudflare, dan proteksi branch `main`.
- Tambahkan aturan *Rate limiting* di Cloudflare WAF untuk `/api/*` (batas di kode hanya per instance Worker).

**Aplikasi**
- Proxy `/api/m/*` hanya meneruskan path dalam allowlist ke mempool.space dan mirror; query string tidak diteruskan.
- CSP bernonce, `X-Frame-Options: DENY`, semua teks dari API di-escape sebelum masuk HTML.
- Form kontak: Turnstile, honeypot, cek Origin, batas 3 pesan/10 menit/IP.

## Lisensi

MIT
