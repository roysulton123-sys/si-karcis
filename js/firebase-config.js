/**
 * SI-KARCIS — Konfigurasi Firebase v10 (Authentication & Cloud Firestore)
 * Dilengkapi Akun Admin Default & Mode Fallback Penyimpanan Lokal Otomatis
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDUyhlJSht__37O9zYQJHCHTpUMRhygwok",
  authDomain: "karcis-11113.firebaseapp.com",
  projectId: "karcis-11113",
  storageBucket: "karcis-11113.firebasestorage.app",
  messagingSenderId: "827178485909",
  appId: "1:827178485909:web:c58811ed96384cbba3739c"
};

/**
 * Konfigurasi Akun Administrator Utama (Default).
 * Email yang terdaftar pada ADMIN_EMAIL_WHITELIST otomatis mendapatkan
 * role: "admin" dan status: "approved".
 */
export const DEFAULT_ADMIN_ACCOUNT = {
  email: "admin@sikarcis.go.id",
  password: "AdminSiKarcis2026!",
  nama: "Administrator Utama SI-KARCIS",
  nip: "19850101 201001 1 001",
  unitTugas: "UPT Pengelola Retribusi Daerah",
  noHp: "081234567890",
  role: "admin",
  status: "approved"
};

export const ADMIN_EMAIL_WHITELIST = [
  "admin@sikarcis.go.id",
  "admin@instansi.go.id"
];

/**
 * Mengecek apakah konfigurasi Firebase sudah diisi oleh pengguna.
 * Jika belum diisi (masih bernilai YOUR_...), aplikasi otomatis menyediakan
 * penyimpanan lokal (Local Fallback Mode) agar seluruh fitur Login, Pendaftaran,
 * Persetujuan Admin, Permintaan Karcis, Retur Seri & Cetak tetap dapat langsung diuji.
 * @returns {boolean}
 */
export function isFirebaseConfigured() {
  return Boolean(
    firebaseConfig.apiKey &&
    !firebaseConfig.apiKey.startsWith("YOUR_") &&
    firebaseConfig.projectId &&
    !firebaseConfig.projectId.startsWith("YOUR_") &&
    firebaseConfig.appId &&
    !firebaseConfig.appId.startsWith("YOUR_")
  );
}

export function isAdminEmail(email) {
  const clean = String(email || "").trim().toLowerCase();
  return ADMIN_EMAIL_WHITELIST.includes(clean);
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db, firebaseConfig };
