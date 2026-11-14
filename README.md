# SI-KARCIS — Sistem Manajemen Inventaris, Distribusi Seri & Rekapitulasi Retribusi Karcis

Aplikasi web *Clean Enterprise SaaS* berbasis **HTML5, Tailwind CSS, Vanilla JavaScript (ES6 Modules), Firebase v10 (Authentication & Cloud Firestore), Chart.js, dan SheetJS (xlsx)** untuk mengelola inventaris karcis fisik (1 Bendel = 100 Lembar), persetujuan akun petugas, pengajuan permintaan karcis, pengembalian sisa nomor seri 5-digit anti-bentrok, dan cetak rekapitulasi pemasukan & pengeluaran karcis.

---

## 1. Akun Administrator Bawaan (Siap Pakai)

Sistem telah dilengkapi dengan akun **Administrator Utama** yang langsung aktif:

| Parameter | Nilai Kredensial |
| :--- | :--- |
| **Email Admin** | `admin@sikarcis.go.id` |
| **Kata Sandi (Password)** | `AdminSiKarcis2026!` |
| **Peran (Role)** | `admin` (Hak akses penuh seluruh modul) |
| **Status Akun** | `approved` (Otomatis aktif) |

> **Tips Cepat di Halaman Login (`index.html`):** Klik tombol **"Isi Akun Admin"** pada kartu informasi di halaman login untuk mengisi otomatis email & kata sandi Admin, lalu klik **"Masuk ke Sistem SI-KARCIS"**.

---

## 2. Pembagian Hak Akses (Admin vs User / Petugas)

### A. Hak Akses User / Petugas Lapangan (`role: 'user'`)
1. **Pendaftaran Akun Mandiri:** Petugas baru dapat mengajukan pendaftaran akun melalui tab **"Ajukan Pendaftaran Akun"** di `index.html`. Akun baru otomatis berstatus `Menunggu Persetujuan (pending)` dan belum dapat masuk sebelum disetujui Admin.
2. **Pengajuan Permintaan Karcis:** Setelah akun disetujui Admin, petugas yang login otomatis diarahkan ke **Portal Layanan Petugas** (`#view-portal-user`) untuk mengajukan permintaan karcis (memilih jenis fasilitas, jumlah lembar/bendel, dan keterangan lokasi/shift tugas).
3. **Pengembalian Sisa Karcis Sesuai Nomor Seri:** Setelah permintaan disetujui Admin dan nomor seri diterbitkan (misal `PKL 00001 - PKL 00100`), petugas dapat mengklik **"Kembalikan Sisa Karcis"** untuk menginput jumlah lembar sisa yang tidak terpakai. Sistem otomatis menghitung:
   - Rentang nomor seri yang **telah digunakan/terpakai** (misal `PKL 00001 - PKL 00080`) beserta nilai rupiahnya.
   - Rentang nomor seri **sisa yang dikembalikan** (misal `PKL 00081 - PKL 00100`) dan mengembalikannya ke gudang stok menggunakan algoritma **Anti-Bentrok Seri**.
4. **Pembatasan Ketat (Proteksi Komponen Sistem):** User/Petugas **tidak dapat** menambah/mengubah/menghapus batch stok gudang, **tidak dapat** mengubah master fasilitas & tarif, **tidak dapat** mengubah status lunas setoran secara sepihak, dan **tidak dapat** mengubah pengaturan pejabat/komponen sistem.

### B. Hak Akses Administrator (`role: 'admin'`)
1. **Kelola & Setujui Pendaftaran Akun User (`Kelola Akun User`):** Melihat daftar pengajuan akun petugas baru dan memilih **Terima Akun (`approved`)** atau **Tolak / Nonaktifkan (`rejected`)**.
2. **Setujui / Tolak Permintaan Karcis (`Permintaan & Distribusi`):**
   - Menyetujui permintaan karcis petugas dengan memilih batch stok gudang yang tersedia (nomor seri 5-digit otomatis dialokasikan secara berurutan dari `angkaSisaMulai`).
   - Menolak permintaan karcis disertai alasan penolakan.
3. **Gudang Stok & Master Fasilitas:** Mendaftarkan batch stok karcis baru (dilengkapi validasi anti-overlap nomor seri) serta mengelola CRUD Master Jenis Fasilitas & Tarif.
4. **Cetak Rekapitulasi Pemasukan & Pengeluaran Karcis (`Laporan & Cetak`):**
   - Mencetak laporan resmi (`@media print` A4 Landscape) atau mengekspor file Excel (`.xlsx`) yang mencakup:
     - **Bagian I: Rekapitulasi Pemasukan Karcis** (pendaftaran batch stok gudang utama & batch retur sisa beserta nomor seri dan volume bendel/lembar).
     - **Bagian II: Rekapitulasi Pengeluaran Karcis & Realisasi Retribusi** (distribusi ke petugas, nomor seri keluar, nomor seri terpakai, nomor seri retur, dan nilai setoran Rp).

---

## 3. Struktur File Proyek

- `index.html`: Halaman Login & Pengajuan Pendaftaran Akun Petugas (dilengkapi tombol isi cepat akun Admin).
- `dashboard.html`: Halaman utama aplikasi dengan antarmuka khusus Administrator (6 menu) dan Portal Khusus Petugas/User.
- `js/firebase-config.js`: Konfigurasi Firebase v10 (Authentication & Cloud Firestore) beserta kredensial `DEFAULT_ADMIN_ACCOUNT`.
- `js/app.js`: Logika bisnis utama, RBAC (Admin vs User), manajemen akun, alur persetujuan permintaan karcis, kalkulasi seri 5-digit, anti-bentrok retur, grafik analitik, serta cetak & ekspor laporan pemasukan/pengeluaran karcis.
- `css/style.css`: Animasi transisi, kustomisasi scrollbar, dan aturan cetak resmi `@media print`.
