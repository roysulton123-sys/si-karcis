/**
 * ============================================================================
 * SI-KARCIS — Sistem Manajemen Inventaris, Distribusi Seri & Retribusi Karcis
 * ============================================================================
 * Modul Utama Aplikasi (js/app.js)
 * Fitur Utama:
 * 1. Otentikasi & Role-Based Access Control (Admin vs User/Petugas)
 *    - Mendukung Firebase v10 (Auth + Cloud Firestore) & Local Fallback Mode
 * 2. Manajemen & Persetujuan Pendaftaran Akun User (Pending -> Approved / Rejected)
 * 3. Portal Khusus User/Petugas:
 *    - Pengajuan Permintaan Karcis Baru
 *    - Pengembalian Sisa Karcis Sesuai Nomor Seri yang Diterima & Digunakan
 *    - Proteksi Penuh (User tidak dapat mengubah komponen/master sistem)
 * 4. Persetujuan / Penolakan Permintaan Karcis oleh Admin (Alokasi Seri 5-Digit)
 * 5. Anti-Bentrok Seri saat Retur (Rollback Batch Induk atau Buat Batch Retur Baru)
 * 6. Cetak Rekapitulasi Pemasukan & Pengeluaran Karcis (Print/PDF & Export Excel)
 * ============================================================================
 */

import {
  auth,
  db,
  isFirebaseConfigured,
  DEFAULT_ADMIN_ACCOUNT,
  isAdminEmail
} from './firebase-config.js';

import {
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  limit,
  writeBatch,
  runTransaction,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

/* ==========================================================================
   1. KONSTANTA KOLEKSI & LOCAL STORAGE KEYS
   ========================================================================== */
const COL_FACILITIES = 'karcis_facilities';
const COL_STOCK = 'karcis_stock';
const COL_DISTRIBUSI = 'karcis_distribusi';
const COL_LOGS = 'karcis_logs';
const COL_USERS = 'karcis_users';
const COL_REQUESTS = 'karcis_requests';
const COL_SETTINGS = 'karcis_settings';

const LS_SIGNATORIES_KEY = 'sikarcis_signatories_v1';
const LS_TAHUN_KEY = 'sikarcis_selected_tahun_v1';

// Keys Local Fallback Mode (sinkron dengan index.html)
const LS_USERS_KEY = 'sikarcis_local_users_v1';
const LS_SESSION_KEY = 'sikarcis_local_session_v1';
const LS_LOGS_KEY = 'sikarcis_local_logs_v1';
const LS_FACILITIES_KEY = 'sikarcis_local_facilities_v1';
const LS_STOCK_KEY = 'sikarcis_local_stock_v1';
const LS_DISTRIBUSI_KEY = 'sikarcis_local_distribusi_v1';
const LS_REQUESTS_KEY = 'sikarcis_local_requests_v1';
const LS_FACILITIES_SEEDED_KEY = 'sikarcis_facilities_seeded_v1';

const STOCK_LOW_THRESHOLD_LEMBAR = 200; // Peringatan stok menipis: di bawah 2 bendel (< 200 lembar)

/**
 * 7 Data Awal Master Jenis Fasilitas (Auto-Seeding)
 */
const INITIAL_FACILITIES_SEED = [
  { namaFasilitas: 'Pedagang Kaki Lima (PKL)', tarifSatuan: 2000, kodeDefault: 'PKL', batasMinimum: 300, isActive: true },
  { namaFasilitas: 'Mainan', tarifSatuan: 3000, kodeDefault: 'MNN', batasMinimum: 200, isActive: true },
  { namaFasilitas: 'Kolam Renang Anak', tarifSatuan: 5000, kodeDefault: 'KRA', batasMinimum: 200, isActive: true },
  { namaFasilitas: 'Kolam Dewasa', tarifSatuan: 10000, kodeDefault: 'KRD', batasMinimum: 200, isActive: true },
  { namaFasilitas: 'Kolam Renang Indoor', tarifSatuan: 15000, kodeDefault: 'KRI', batasMinimum: 150, isActive: true },
  { namaFasilitas: 'Kolam Renang Outdoor', tarifSatuan: 12000, kodeDefault: 'KRO', batasMinimum: 150, isActive: true },
  { namaFasilitas: 'Toilet', tarifSatuan: 2000, kodeDefault: 'TLT', batasMinimum: 400, isActive: true }
];

/* ==========================================================================
   2. STATE GLOBAL APLIKASI
   ========================================================================== */
const state = {
  mode: isFirebaseConfigured() ? 'cloud' : 'local',
  currentUser: null, // { uid, nama, nip, unitTugas, noHp, email, role: 'admin'|'user', status: 'approved' }
  tahun: localStorage.getItem(LS_TAHUN_KEY) || '2026',
  activeView: 'dashboard',
  compositionChartMode: 'doughnut',

  // Data Collections
  facilities: [],
  stocks: [],
  distributions: [],
  logs: [],
  users: [],
  requests: [],

  // Loading Flags
  loaded: {
    facilities: false,
    stocks: false,
    distributions: false,
    logs: false,
    users: false,
    requests: false
  },

  // Unsubscribe functions for Firestore listeners
  unsubscribers: {
    facilities: null,
    stocks: null,
    distributions: null,
    logs: null,
    users: null,
    requests: null,
    settings: null
  },

  // Selection state untuk hapus riwayat aktivitas via checkbox
  selectedLogIds: new Set(),

  // Filter & Pagination States
  filters: {
    adminReq: { status: 'ALL' },
    dist: { search: '', facilityId: 'ALL', status: 'ALL', page: 1, perPage: 10 },
    stok: { search: '', facilityId: 'ALL', status: 'ALL', page: 1, perPage: 10 },
    fac: { search: '' },
    users: { search: '', status: 'ALL' },
    rep: { type: 'ALL', startDate: '', endDate: '', facilityId: 'ALL', status: 'ALL' },
    logsSearch: ''
  },

  // Chart.js Instances
  charts: {
    monthlyTrend: null,
    facilityComposition: null
  },

  // Sinkronisasi otomatis lintas perangkat & tab tanpa reload
  sync: {
    timer: null,
    retryTimer: null,
    inFlight: false,
    mutationSeq: 0,
    fingerprints: {},
    channel: null,
    hooksBound: false
  },

  seedingInProgress: false,
  cloudSeedChecked: false,
  facilitiesSeededKnown: false,
  cloudMetaMarked: false
};

/* ==========================================================================
   3. FUNGSI UTILITAS FORMATTER & KALKULASI SERI 5-DIGIT
   ========================================================================== */

export function padSeri(num) {
  const n = Math.max(0, Math.floor(Number(num) || 0));
  return String(n).padStart(5, '0');
}

export function formatSingleSeri(kodeHuruf, num) {
  const code = String(kodeHuruf || '').trim().toUpperCase();
  return `${code} ${padSeri(num)}`.trim();
}

export function formatSeriRange(kodeHuruf, startNum, endNum) {
  const code = String(kodeHuruf || '').trim().toUpperCase();
  return `${code} ${padSeri(startNum)} - ${code} ${padSeri(endNum)}`.trim();
}

export function parseSeriRange(seriStr) {
  if (!seriStr || typeof seriStr !== 'string') return null;
  const cleaned = seriStr.trim();
  const match = cleaned.match(/^([A-Za-z0-9_-]+)\s+(\d+)\s*-\s*(?:[A-Za-z0-9_-]+\s+)?(\d+)$/);
  if (!match) return null;
  return {
    kodeHuruf: match[1].toUpperCase(),
    start: parseInt(match[2], 10),
    end: parseInt(match[3], 10)
  };
}

export function formatRupiah(amount) {
  const n = Math.round(Number(amount) || 0);
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(n);
}

export function formatNumber(num) {
  return new Intl.NumberFormat('id-ID').format(Math.round(Number(num) || 0));
}

export function toBendelLembar(totalLembar) {
  const total = Math.max(0, Math.floor(Number(totalLembar) || 0));
  const bendel = Math.floor(total / 100);
  const lembar = total % 100;
  return {
    total,
    bendel,
    lembar,
    formatted: `${formatNumber(bendel)} Bendel + ${formatNumber(lembar)} Lembar`,
    shortFormatted: `${formatNumber(bendel)} Bdl ${formatNumber(lembar)} Lbr`
  };
}

export function getTodayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatDateIndo(dateStr) {
  if (!dateStr) return '—';
  const parts = String(dateStr).split('-');
  if (parts.length !== 3) return dateStr;
  const months = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
  ];
  const y = parts[0];
  const mIdx = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  return `${d} ${months[mIdx] || parts[1]} ${y}`;
}

export function formatDateShort(dateStr) {
  if (!dateStr) return '—';
  const parts = String(dateStr).split('-');
  if (parts.length !== 3) return dateStr;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const y = parts[0];
  const mIdx = parseInt(parts[1], 10) - 1;
  const d = parts[2];
  return `${d} ${months[mIdx] || parts[1]} ${y}`;
}

export function formatTimestamp(ts) {
  if (!ts) return 'Baru saja';
  try {
    const date = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
    if (isNaN(date.getTime())) return 'Baru saja';
    return new Intl.DateTimeFormat('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  } catch {
    return 'Baru saja';
  }
}

export function getTimestampMillis(ts) {
  if (!ts) return Date.now();
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return isNaN(parsed) ? 0 : parsed;
  }
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  return 0;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ==========================================================================
   4. KOMPONEN UX MODERN: TOAST NOTIFICATION & CUSTOM CONFIRM MODAL
   ========================================================================== */

export function showToast(type = 'info', title = '', message = '', duration = 4200) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const styles = {
    success: {
      border: 'border-emerald-500/40',
      bg: 'bg-slate-900/95',
      iconBg: 'bg-emerald-500/20 text-emerald-400',
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>`
    },
    error: {
      border: 'border-rose-500/50',
      bg: 'bg-slate-900/95',
      iconBg: 'bg-rose-500/20 text-rose-400',
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`
    },
    warning: {
      border: 'border-amber-500/50',
      bg: 'bg-slate-900/95',
      iconBg: 'bg-amber-500/20 text-amber-400',
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>`
    },
    info: {
      border: 'border-blue-500/40',
      bg: 'bg-slate-900/95',
      iconBg: 'bg-blue-500/20 text-blue-400',
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`
    }
  };

  const st = styles[type] || styles.info;
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto flex items-start gap-3 p-4 rounded-2xl border ${st.border} ${st.bg} text-white shadow-2xl backdrop-blur-md toast-enter`;
  toast.innerHTML = `
    <div class="w-9 h-9 rounded-xl ${st.iconBg} flex items-center justify-center shrink-0 mt-0.5">
      ${st.icon}
    </div>
    <div class="flex-1 min-w-0">
      <p class="text-xs sm:text-sm font-bold text-white leading-snug">${escapeHtml(title)}</p>
      ${message ? `<p class="text-xs text-slate-300 mt-0.5 leading-relaxed">${escapeHtml(message)}</p>` : ''}
    </div>
    <button type="button" aria-label="Tutup notifikasi" class="text-slate-400 hover:text-white p-1 rounded-lg transition">
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  `;

  const closeBtn = toast.querySelector('button');
  const removeToast = () => {
    toast.classList.remove('toast-enter');
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 200);
  };
  closeBtn.addEventListener('click', removeToast);
  container.appendChild(toast);
  setTimeout(removeToast, duration);
}

/**
 * Custom Confirmation Modal (Menggantikan dialog konfirmasi bawaan browser)
 */
let confirmResolveFn = null;

export function showConfirmModal({
  title = 'Konfirmasi Tindakan',
  message = 'Apakah Anda yakin ingin melanjutkan tindakan ini?',
  confirmText = 'Ya, Lanjutkan',
  cancelText = 'Batal',
  variant = 'primary'
} = {}) {
  const modal = document.getElementById('modal-confirm');
  const titleEl = document.getElementById('confirm-modal-title');
  const msgEl = document.getElementById('confirm-modal-message');
  const okBtn = document.getElementById('btn-confirm-ok');
  const cancelBtn = document.getElementById('btn-confirm-cancel');
  const iconBox = document.getElementById('confirm-modal-icon');

  if (!modal || !titleEl || !msgEl || !okBtn || !cancelBtn) {
    return Promise.resolve(false);
  }

  titleEl.textContent = title;
  msgEl.textContent = message;
  okBtn.textContent = confirmText;
  cancelBtn.textContent = cancelText;

  if (variant === 'danger') {
    okBtn.className = 'px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs sm:text-sm font-semibold shadow-sm transition';
    iconBox.className = 'w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center shrink-0';
  } else if (variant === 'warning') {
    okBtn.className = 'px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs sm:text-sm font-semibold shadow-sm transition';
    iconBox.className = 'w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center shrink-0';
  } else {
    okBtn.className = 'px-4 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs sm:text-sm font-semibold shadow-sm transition';
    iconBox.className = 'w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center shrink-0';
  }

  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    confirmResolveFn = resolve;
  });
}

function closeConfirmModal(result) {
  const modal = document.getElementById('modal-confirm');
  if (modal) modal.classList.add('hidden');
  if (typeof confirmResolveFn === 'function') {
    const fn = confirmResolveFn;
    confirmResolveFn = null;
    fn(Boolean(result));
  }
}

/* ==========================================================================
   5. DATA ABSTRACTION LAYER (CLOUD FIRESTORE & LOCAL STORAGE FALLBACK)
   ========================================================================== */

function readLocalArray(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalArray(key, arr) {
  try {
    localStorage.setItem(key, JSON.stringify(arr));
  } catch (err) {
    console.warn('Gagal menyimpan ke localStorage:', err);
  }
}

function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Mencatat aktivitas ke Audit Trail (karcis_logs)
 */
async function logActivity(aksi, detail, customTahun = null) {
  const tahunTarget = customTahun || state.tahun || '2026';
  const userEmail = state.currentUser?.email || 'system@sikarcis.go.id';

  if (state.mode === 'cloud') {
    try {
      await addDoc(collection(db, COL_LOGS), {
        tahun: String(tahunTarget),
        waktu: serverTimestamp(),
        aksi: String(aksi),
        detail: String(detail),
        userEmail: String(userEmail)
      });
    } catch (err) {
      console.warn('Gagal menulis audit log ke Firestore:', err);
    }
  } else {
    const logs = readLocalArray(LS_LOGS_KEY);
    logs.unshift({
      id: generateId('log'),
      tahun: String(tahunTarget),
      waktu: new Date().toISOString(),
      aksi: String(aksi),
      detail: String(detail),
      userEmail: String(userEmail)
    });
    writeLocalArray(LS_LOGS_KEY, logs.slice(0, 300));
    refreshLocalState();
  }
  notifyCrossTabSync('logs');
}

/**
 * Proteksi Hak Akses Admin: Mencegah user biasa mengeksekusi fungsi perubahan sistem
 */
function requireAdmin(actionLabel = 'tindakan ini') {
  if (!state.currentUser || state.currentUser.role !== 'admin') {
    showToast(
      'error',
      'Akses Ditolak (Khusus Administrator)',
      `Akun Petugas tidak diizinkan melakukan ${actionLabel}.`
    );
    return false;
  }
  return true;
}

/* ==========================================================================
   6. AUTO-SEEDING DATA AWAL & SINKRONISASI REAL-TIME / LOCAL
   ========================================================================== */

function hasFacilitiesInitializedLocal() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(LS_FACILITIES_SEEDED_KEY) === '1';
  } catch {
    return false;
  }
}

function markFacilitiesInitializedLocal() {
  state.facilitiesSeededKnown = true;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_FACILITIES_SEEDED_KEY, '1');
    }
  } catch {
    // Abaikan jika localStorage penuh atau dibatasi
  }
}

async function markFacilitiesInitializedCloud() {
  markFacilitiesInitializedLocal();
  if (state.mode !== 'cloud' || !isFirebaseConfigured()) return;
  try {
    await setDoc(
      doc(db, COL_SETTINGS, 'facilities_meta'),
      {
        initialSeedDone: true,
        updatedAt: new Date().toISOString()
      },
      { merge: true }
    );
    state.cloudMetaMarked = true;
  } catch (err) {
    console.warn('Gagal menyimpan penanda inisialisasi fasilitas di Cloud:', err?.message || err);
  }
}

async function ensureFacilitiesSeededCloud() {
  if (
    state.seedingInProgress ||
    state.cloudSeedChecked ||
    state.facilitiesSeededKnown ||
    hasFacilitiesInitializedLocal()
  ) {
    return false;
  }
  if (state.currentUser?.role !== 'admin') {
    return false;
  }

  state.seedingInProgress = true;
  try {
    const [snap, metaSnap, logsSnap, stockSnap, distSnap, reqSnap] = await Promise.all([
      getDocs(collection(db, COL_FACILITIES)),
      getDoc(doc(db, COL_SETTINGS, 'facilities_meta')).catch(() => null),
      getDocs(query(collection(db, COL_LOGS), limit(1))).catch(() => null),
      getDocs(query(collection(db, COL_STOCK), limit(1))).catch(() => null),
      getDocs(query(collection(db, COL_DISTRIBUSI), limit(1))).catch(() => null),
      getDocs(query(collection(db, COL_REQUESTS), limit(1))).catch(() => null)
    ]);

    // Jika salah satu pengecekan gagal karena jaringan/izin, batalkan seeding agar tidak menimpa data yang ada
    if (!metaSnap || !logsSnap || !stockSnap || !distSnap || !reqSnap) {
      return false;
    }

    state.cloudSeedChecked = true;

    const alreadySeededInMeta = Boolean(metaSnap.exists() && metaSnap.data()?.initialSeedDone);
    const hasHistoricalActivity =
      !logsSnap.empty || !stockSnap.empty || !distSnap.empty || !reqSnap.empty;

    // Auto-seeding hanya berjalan sekali pada database benar-benar baru;
    // jika admin menghapus semua fasilitas, kondisi ini mencegah data awal muncul kembali.
    if (!snap.empty || alreadySeededInMeta || hasHistoricalActivity) {
      if (alreadySeededInMeta) state.cloudMetaMarked = true;
      markFacilitiesInitializedLocal();
      if (!alreadySeededInMeta) {
        await markFacilitiesInitializedCloud();
      }
      return false;
    }

    const batch = writeBatch(db);
    const seededFacs = [];
    INITIAL_FACILITIES_SEED.forEach((item, idx) => {
      const facId = `fac_seed_${idx + 1}`;
      const newRef = doc(db, COL_FACILITIES, facId);
      const facData = {
        namaFasilitas: item.namaFasilitas,
        tarifSatuan: Number(item.tarifSatuan),
        kodeDefault: String(item.kodeDefault).toUpperCase(),
        batasMinimum: Number(item.batasMinimum),
        isActive: Boolean(item.isActive),
        createdAt: serverTimestamp()
      };
      batch.set(newRef, facData, { merge: true });
      seededFacs.push({ id: facId, ...facData });
    });

    if (stockSnap.empty && seededFacs.length >= 4) {
      const sampleStocks = [
        {
          id: 'stk_seed_1',
          tahun: '2026',
          facilityId: seededFacs[0].id,
          jenisFasilitas: seededFacs[0].namaFasilitas,
          tarifSatuan: seededFacs[0].tarifSatuan,
          kodeHuruf: seededFacs[0].kodeDefault,
          angkaMulai: 1,
          angkaSampai: 1000,
          totalAwal: 1000,
          sisaStok: 900,
          angkaSisaMulai: 101,
          isReturBatch: false,
          createdAt: serverTimestamp()
        },
        {
          id: 'stk_seed_2',
          tahun: '2026',
          facilityId: seededFacs[2].id,
          jenisFasilitas: seededFacs[2].namaFasilitas,
          tarifSatuan: seededFacs[2].tarifSatuan,
          kodeHuruf: seededFacs[2].kodeDefault,
          angkaMulai: 1,
          angkaSampai: 500,
          totalAwal: 500,
          sisaStok: 500,
          angkaSisaMulai: 1,
          isReturBatch: false,
          createdAt: serverTimestamp()
        },
        {
          id: 'stk_seed_3',
          tahun: '2026',
          facilityId: seededFacs[3].id,
          jenisFasilitas: seededFacs[3].namaFasilitas,
          tarifSatuan: seededFacs[3].tarifSatuan,
          kodeHuruf: seededFacs[3].kodeDefault,
          angkaMulai: 1,
          angkaSampai: 500,
          totalAwal: 500,
          sisaStok: 500,
          angkaSisaMulai: 1,
          isReturBatch: false,
          createdAt: serverTimestamp()
        }
      ];
      sampleStocks.forEach((stk) => {
        const stkRef = doc(db, COL_STOCK, stk.id);
        const { id, ...stkPayload } = stk;
        batch.set(stkRef, stkPayload, { merge: true });
      });

      const distRef = doc(db, COL_DISTRIBUSI, 'dist_seed_1');
      batch.set(
        distRef,
        {
          tahun: '2026',
          stockId: 'stk_seed_1',
          facilityId: seededFacs[0].id,
          tanggal: getTodayISO(),
          jenisFasilitas: seededFacs[0].namaFasilitas,
          tarifSatuan: seededFacs[0].tarifSatuan,
          penerima: 'Budi Santoso (Loket PKL Area Timur)',
          userUid: '',
          userEmail: '',
          jumlahKeluar: 100,
          jumlahTerjual: 85,
          jumlahRetur: 15,
          totalNominal: 85 * seededFacs[0].tarifSatuan,
          seriKeluar: 'PKL 00001 - PKL 00100',
          seriTerjual: 'PKL 00001 - PKL 00085',
          seriRetur: 'PKL 00086 - PKL 00100',
          statusSetoran: 'Lunas Setor',
          catatan: 'Shift Pagi - Sisa 15 lembar telah diretur',
          createdAt: serverTimestamp()
        },
        { merge: true }
      );
    }

    batch.set(
      doc(db, COL_SETTINGS, 'facilities_meta'),
      {
        initialSeedDone: true,
        updatedAt: new Date().toISOString()
      },
      { merge: true }
    );

    await batch.commit();
    state.cloudMetaMarked = true;
    markFacilitiesInitializedLocal();
    await logActivity(
      'AUTO_SEED_FASILITAS',
      'Sistem mengisi otomatis 7 jenis fasilitas awal beserta tarif retribusinya.'
    );
    return true;
  } catch (err) {
    console.error('Gagal melakukan auto-seeding fasilitas:', err);
    return false;
  } finally {
    state.seedingInProgress = false;
  }
}

async function migrateLocalDataToCloudOnce() {
  if (typeof localStorage === 'undefined') return;
  if (localStorage.getItem('sikarcis_cloud_migrated_v2') === '1') return;

  try {
    const [cloudFacsSnap, cloudUsersSnap, cloudMetaSnap] = await Promise.all([
      getDocs(collection(db, COL_FACILITIES)),
      getDocs(collection(db, COL_USERS)),
      getDoc(doc(db, COL_SETTINGS, 'facilities_meta')).catch(() => null)
    ]);
    const cloudHasMeta = Boolean(cloudMetaSnap && cloudMetaSnap.exists() && cloudMetaSnap.data()?.initialSeedDone);
    const cloudHasData = !cloudFacsSnap.empty || !cloudUsersSnap.empty || cloudHasMeta;

    if (cloudHasMeta || !cloudFacsSnap.empty) {
      markFacilitiesInitializedLocal();
    }

    const batch = writeBatch(db);
    let writeCount = 0;

    // 1. Unggah user lokal non-dummy jika Cloud masih kosong atau user belum ada
    const localUsers = readLocalArray(LS_USERS_KEY);
    const existingCloudUserIds = new Set(cloudUsersSnap.docs.map((d) => d.id));
    for (const u of localUsers) {
      const uid = u.uid || u.id;
      if (!uid || uid === 'local-admin-001') continue;
      if (cloudHasData && existingCloudUserIds.has(uid)) continue;
      if (!cloudHasData || String(uid).startsWith('user_')) {
        batch.set(doc(db, COL_USERS, uid), { ...u, uid }, { merge: true });
        writeCount++;
      }
    }

    // Jika Cloud sudah pernah aktif/memiliki data, jangan unggah ulang cache fasilitas/stok/distribusi lokal
    // karena dapat memunculkan kembali item yang sudah dihapus di Cloud.
    if (!cloudHasData) {
      const localFacs = readLocalArray(LS_FACILITIES_KEY);
      for (const f of localFacs) {
        if (!f.id) continue;
        const { id, ...payload } = f;
        batch.set(doc(db, COL_FACILITIES, id), payload, { merge: true });
        writeCount++;
      }

      const localStocks = readLocalArray(LS_STOCK_KEY);
      for (const s of localStocks) {
        if (!s.id) continue;
        const { id, ...payload } = s;
        batch.set(doc(db, COL_STOCK, id), payload, { merge: true });
        writeCount++;
      }

      const localDists = readLocalArray(LS_DISTRIBUSI_KEY);
      for (const d of localDists) {
        if (!d.id) continue;
        const { id, ...payload } = d;
        batch.set(doc(db, COL_DISTRIBUSI, id), payload, { merge: true });
        writeCount++;
      }

      const localReqs = readLocalArray(LS_REQUESTS_KEY);
      for (const r of localReqs) {
        if (!r.id) continue;
        const { id, ...payload } = r;
        batch.set(doc(db, COL_REQUESTS, id), payload, { merge: true });
        writeCount++;
      }

      if (localFacs.length > 0 || hasFacilitiesInitializedLocal()) {
        batch.set(
          doc(db, COL_SETTINGS, 'facilities_meta'),
          { initialSeedDone: true, updatedAt: new Date().toISOString() },
          { merge: true }
        );
        writeCount++;
      }
    }

    if (writeCount > 0) {
      await batch.commit();
    }
    localStorage.setItem('sikarcis_cloud_migrated_v2', '1');
  } catch (err) {
    console.warn('Migrasi data lokal ke Cloud dilewati:', err);
  }
}

function ensureLocalDataSeeded() {
  // 1. Pastikan Akun Default Admin tersedia di local users
  const users = readLocalArray(LS_USERS_KEY);
  const hasAdmin = users.some(
    (u) => String(u.email).toLowerCase() === DEFAULT_ADMIN_ACCOUNT.email.toLowerCase()
  );
  if (!hasAdmin) {
    users.unshift({
      uid: 'local-admin-001',
      nama: DEFAULT_ADMIN_ACCOUNT.nama,
      nip: DEFAULT_ADMIN_ACCOUNT.nip,
      unitTugas: DEFAULT_ADMIN_ACCOUNT.unitTugas,
      noHp: DEFAULT_ADMIN_ACCOUNT.noHp,
      email: DEFAULT_ADMIN_ACCOUNT.email.toLowerCase(),
      password: DEFAULT_ADMIN_ACCOUNT.password,
      role: 'admin',
      status: 'approved',
      createdAt: new Date().toISOString()
    });
    writeLocalArray(LS_USERS_KEY, users);
  }

  // 2. Auto-Seed 7 Master Jenis Fasilitas HANYA sekali jika penyimpanan lokal benar-benar baru
  let facilities = readLocalArray(LS_FACILITIES_KEY);
  const existingStocks = readLocalArray(LS_STOCK_KEY);
  const existingDist = readLocalArray(LS_DISTRIBUSI_KEY);
  const existingLogs = readLocalArray(LS_LOGS_KEY);
  const alreadyInitialized =
    hasFacilitiesInitializedLocal() ||
    existingStocks.length > 0 ||
    existingDist.length > 0 ||
    existingLogs.length > 0;

  if (facilities.length > 0) {
    markFacilitiesInitializedLocal();
  } else if (!alreadyInitialized) {
    const nowIso = new Date().toISOString();
    facilities = INITIAL_FACILITIES_SEED.map((item, idx) => ({
      id: `fac_seed_${idx + 1}`,
      namaFasilitas: item.namaFasilitas,
      tarifSatuan: Number(item.tarifSatuan),
      kodeDefault: String(item.kodeDefault).toUpperCase(),
      batasMinimum: Number(item.batasMinimum),
      isActive: Boolean(item.isActive),
      createdAt: nowIso
    }));
    writeLocalArray(LS_FACILITIES_KEY, facilities);
    markFacilitiesInitializedLocal();

    // Seed contoh Batch Stok awal di TA 2026 agar fitur pengeluaran & cetak langsung siap diuji
    if (existingStocks.length === 0 && facilities.length >= 3) {
      const sampleStocks = [
        {
          id: 'stk_seed_1',
          tahun: '2026',
          facilityId: facilities[0].id,
          jenisFasilitas: facilities[0].namaFasilitas,
          tarifSatuan: facilities[0].tarifSatuan,
          kodeHuruf: facilities[0].kodeDefault,
          angkaMulai: 1,
          angkaSampai: 1000,
          totalAwal: 1000,
          sisaStok: 900,
          angkaSisaMulai: 101,
          isReturBatch: false,
          createdAt: nowIso
        },
        {
          id: 'stk_seed_2',
          tahun: '2026',
          facilityId: facilities[2].id,
          jenisFasilitas: facilities[2].namaFasilitas,
          tarifSatuan: facilities[2].tarifSatuan,
          kodeHuruf: facilities[2].kodeDefault,
          angkaMulai: 1,
          angkaSampai: 500,
          totalAwal: 500,
          sisaStok: 500,
          angkaSisaMulai: 1,
          isReturBatch: false,
          createdAt: nowIso
        },
        {
          id: 'stk_seed_3',
          tahun: '2026',
          facilityId: facilities[3].id,
          jenisFasilitas: facilities[3].namaFasilitas,
          tarifSatuan: facilities[3].tarifSatuan,
          kodeHuruf: facilities[3].kodeDefault,
          angkaMulai: 1,
          angkaSampai: 500,
          totalAwal: 500,
          sisaStok: 500,
          angkaSisaMulai: 1,
          isReturBatch: false,
          createdAt: nowIso
        }
      ];
      writeLocalArray(LS_STOCK_KEY, sampleStocks);

      // Seed 1 contoh transaksi distribusi awal
      const existingDist = readLocalArray(LS_DISTRIBUSI_KEY);
      if (existingDist.length === 0) {
        writeLocalArray(LS_DISTRIBUSI_KEY, [
          {
            id: 'dist_seed_1',
            tahun: '2026',
            stockId: 'stk_seed_1',
            facilityId: facilities[0].id,
            tanggal: getTodayISO(),
            jenisFasilitas: facilities[0].namaFasilitas,
            tarifSatuan: facilities[0].tarifSatuan,
            penerima: 'Budi Santoso (Loket PKL Area Timur)',
            userUid: '',
            userEmail: '',
            jumlahKeluar: 100,
            jumlahTerjual: 85,
            jumlahRetur: 15,
            totalNominal: 85 * facilities[0].tarifSatuan,
            seriKeluar: 'PKL 00001 - PKL 00100',
            seriTerjual: 'PKL 00001 - PKL 00085',
            seriRetur: 'PKL 00086 - PKL 00100',
            statusSetoran: 'Lunas Setor',
            catatan: 'Shift Pagi - Sisa 15 lembar telah diretur',
            createdAt: nowIso
          }
        ]);
      }
    }
  } else {
    markFacilitiesInitializedLocal();
  }
}

function refreshLocalState() {
  ensureLocalDataSeeded();
  const tahun = String(state.tahun);

  const allFacs = readLocalArray(LS_FACILITIES_KEY);
  state.facilities = allFacs.sort((a, b) =>
    String(a.namaFasilitas || '').localeCompare(String(b.namaFasilitas || ''), 'id')
  );

  const allStocks = readLocalArray(LS_STOCK_KEY).filter((s) => String(s.tahun) === tahun);
  state.stocks = allStocks.sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));

  const allDist = readLocalArray(LS_DISTRIBUSI_KEY).filter((d) => String(d.tahun) === tahun);
  state.distributions = allDist.sort((a, b) => {
    const dateCmp = String(b.tanggal || '').localeCompare(String(a.tanggal || ''));
    if (dateCmp !== 0) return dateCmp;
    return getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt);
  });

  const allLogs = readLocalArray(LS_LOGS_KEY).filter((l) => String(l.tahun || tahun) === tahun);
  state.logs = allLogs.sort((a, b) => getTimestampMillis(b.waktu) - getTimestampMillis(a.waktu));

  const allUsers = readLocalArray(LS_USERS_KEY).map((u) => ({
    ...u,
    id: u.uid || u.id
  }));
  state.users = allUsers.sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));

  const allReqs = readLocalArray(LS_REQUESTS_KEY).filter((r) => String(r.tahun || tahun) === tahun);
  state.requests = allReqs.sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));

  state.loaded = {
    facilities: true,
    stocks: true,
    distributions: true,
    logs: true,
    users: true,
    requests: true
  };

  checkInitialSkeletonDismiss();
  renderAllViews();
}

function getSyncBroadcastChannel() {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!state.sync.channel) {
    try {
      state.sync.channel = new BroadcastChannel('sikarcis_sync_v1');
      state.sync.channel.onmessage = (event) => {
        const msg = event?.data;
        if (!msg || msg.type !== 'data-updated') return;
        if (state.mode === 'cloud') {
          syncCloudDataSilently(true);
        } else {
          refreshLocalState();
        }
      };
    } catch {
      return null;
    }
  }
  return state.sync.channel;
}

function notifyCrossTabSync(scope = 'all') {
  try {
    const ch = getSyncBroadcastChannel();
    if (ch) {
      ch.postMessage({ type: 'data-updated', scope, tahun: state.tahun, ts: Date.now() });
    }
  } catch {
    // Abaikan jika BroadcastChannel tidak tersedia
  }
}

function normalizeFingerprintValue(val) {
  if (val && typeof val.toMillis === 'function') return val.toMillis();
  if (val && typeof val === 'object' && typeof val.seconds === 'number') {
    return val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6);
  }
  if (Array.isArray(val)) return val.map(normalizeFingerprintValue);
  if (val && typeof val === 'object') {
    const out = {};
    Object.keys(val)
      .sort()
      .forEach((k) => {
        out[k] = normalizeFingerprintValue(val[k]);
      });
    return out;
  }
  return val ?? null;
}

function buildCollectionFingerprint(items) {
  return JSON.stringify((items || []).map(normalizeFingerprintValue));
}

function pruneSelectedLogIds() {
  if (!(state.selectedLogIds instanceof Set)) {
    state.selectedLogIds = new Set();
    return;
  }
  const validIds = new Set(state.logs.map((l) => l.id));
  Array.from(state.selectedLogIds).forEach((id) => {
    if (!validIds.has(id)) state.selectedLogIds.delete(id);
  });
}

function stopAutoSyncLoop() {
  if (state.sync.timer) {
    clearInterval(state.sync.timer);
    state.sync.timer = null;
  }
  if (state.sync.retryTimer) {
    clearTimeout(state.sync.retryTimer);
    state.sync.retryTimer = null;
  }
}

function scheduleCloudReconnect() {
  if (!isFirebaseConfigured() || state.sync.retryTimer) return;
  state.sync.retryTimer = setTimeout(() => {
    state.sync.retryTimer = null;
    if (isFirebaseConfigured()) {
      state.mode = 'cloud';
      attachRealtimeListeners();
      syncCloudDataSilently(true);
    }
  }, 4000);
}

function applySyncedUsersState(items) {
  state.users = items;
  writeLocalArray(LS_USERS_KEY, items);
  state.loaded.users = true;
  if (state.currentUser && items.length > 0) {
    const me = items.find(
      (u) =>
        (u.uid && state.currentUser.uid && u.uid === state.currentUser.uid) ||
        String(u.email || '').toLowerCase() === String(state.currentUser.email || '').toLowerCase()
    );
    if (state.currentUser.role !== 'admin' && (!me || me.status !== 'approved')) {
      localStorage.removeItem(LS_SESSION_KEY);
      window.location.replace('./index.html');
      return false;
    }
    if (me) {
      state.currentUser = { ...state.currentUser, ...me, uid: me.uid || state.currentUser.uid };
      try {
        localStorage.setItem(LS_SESSION_KEY, JSON.stringify(state.currentUser));
      } catch {
        // Abaikan quota storage error
      }
      if (typeof applyUserProfileHeaderUI === 'function') {
        applyUserProfileHeaderUI();
      }
    }
  }
  return true;
}

async function syncCloudDataSilently(force = false) {
  if (state.mode !== 'cloud' || !isFirebaseConfigured()) return;
  if (state.sync.inFlight) return;
  if (!force && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

  state.sync.inFlight = true;
  const tahun = String(state.tahun);
  const seqAtStart = state.sync.mutationSeq;

  try {
    const [facSnap, stockSnap, distSnap, logsSnap, usersSnap, reqSnap] = await Promise.all([
      getDocs(collection(db, COL_FACILITIES)),
      getDocs(query(collection(db, COL_STOCK), where('tahun', '==', tahun))),
      getDocs(query(collection(db, COL_DISTRIBUSI), where('tahun', '==', tahun))),
      getDocs(query(collection(db, COL_LOGS), where('tahun', '==', tahun))),
      getDocs(collection(db, COL_USERS)),
      getDocs(query(collection(db, COL_REQUESTS), where('tahun', '==', tahun)))
    ]);

    // Pastikan state.tahun belum berubah dan tidak ada mutasi baru yang berjalan saat fetch berlangsung
    if (String(state.tahun) !== tahun || state.sync.mutationSeq !== seqAtStart) return;

    const facItems = facSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.namaFasilitas || '').localeCompare(String(b.namaFasilitas || ''), 'id'));
    const stockItems = stockSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));
    const distItems = distSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const dCmp = String(b.tanggal || '').localeCompare(String(a.tanggal || ''));
        return dCmp !== 0 ? dCmp : getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt);
      });
    const logItems = logsSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => getTimestampMillis(b.waktu) - getTimestampMillis(a.waktu));
    const userItems = usersSnap.docs
      .map((d) => ({ id: d.id, uid: d.id, ...d.data() }))
      .sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));
    const reqItems = reqSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));

    let viewNeedsRefresh = false;

    const fpFac = buildCollectionFingerprint(facItems);
    if (fpFac !== state.sync.fingerprints.facilities) {
      state.sync.fingerprints.facilities = fpFac;
      state.facilities = facItems;
      writeLocalArray(LS_FACILITIES_KEY, facItems);
      state.loaded.facilities = true;
      populateFacilitySelects();
      viewNeedsRefresh = true;
    }

    const fpStock = buildCollectionFingerprint(stockItems);
    if (fpStock !== state.sync.fingerprints.stocks) {
      state.sync.fingerprints.stocks = fpStock;
      state.stocks = stockItems;
      writeLocalArray(LS_STOCK_KEY, stockItems);
      state.loaded.stocks = true;
      populateDistStockSelect();
      viewNeedsRefresh = true;
    }

    const fpDist = buildCollectionFingerprint(distItems);
    if (fpDist !== state.sync.fingerprints.distributions) {
      state.sync.fingerprints.distributions = fpDist;
      state.distributions = distItems;
      writeLocalArray(LS_DISTRIBUSI_KEY, distItems);
      state.loaded.distributions = true;
      viewNeedsRefresh = true;
    }

    const fpLogs = buildCollectionFingerprint(logItems);
    if (fpLogs !== state.sync.fingerprints.logs) {
      state.sync.fingerprints.logs = fpLogs;
      state.logs = logItems;
      writeLocalArray(LS_LOGS_KEY, logItems);
      state.loaded.logs = true;
      pruneSelectedLogIds();
      renderAuditLogsUI();
    }

    const fpUsers = buildCollectionFingerprint(userItems);
    if (fpUsers !== state.sync.fingerprints.users) {
      state.sync.fingerprints.users = fpUsers;
      const keepSession = applySyncedUsersState(userItems);
      if (!keepSession) return;
      populatePetugasDatalist();
      renderUsersView();
      renderDashboardAlerts();
    }

    const fpReq = buildCollectionFingerprint(reqItems);
    if (fpReq !== state.sync.fingerprints.requests) {
      state.sync.fingerprints.requests = fpReq;
      state.requests = reqItems;
      writeLocalArray(LS_REQUESTS_KEY, reqItems);
      state.loaded.requests = true;
      renderAdminRequestsQueue();
      renderUserPortalView();
      renderDashboardAlerts();
    }

    checkInitialSkeletonDismiss();
    if (viewNeedsRefresh) {
      renderAllViews();
    }
  } catch (err) {
    console.warn('Sinkronisasi latar belakang tertunda:', err?.message || err);
  } finally {
    state.sync.inFlight = false;
  }
}

function startAutoSyncLoop() {
  stopAutoSyncLoop();
  getSyncBroadcastChannel();

  if (typeof window !== 'undefined' && !state.sync.hooksBound) {
    state.sync.hooksBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (state.mode === 'cloud') {
          syncCloudDataSilently(true);
        } else if (isFirebaseConfigured()) {
          scheduleCloudReconnect();
        }
      }
    });
    window.addEventListener('focus', () => {
      if (state.mode === 'cloud') {
        syncCloudDataSilently(true);
      }
    });
    window.addEventListener('online', () => {
      if (isFirebaseConfigured()) {
        if (state.mode !== 'cloud') {
          state.mode = 'cloud';
          attachRealtimeListeners();
        }
        syncCloudDataSilently(true);
      }
    });
    window.addEventListener('sikarcis-force-sync', () => {
      if (isFirebaseConfigured()) {
        if (state.mode !== 'cloud') {
          state.mode = 'cloud';
          attachRealtimeListeners();
        }
        syncCloudDataSilently(true);
      } else {
        refreshLocalState();
      }
    });
    window.addEventListener('sikarcis-native-resume', () => {
      if (state.mode === 'cloud') {
        syncCloudDataSilently(true);
      } else if (isFirebaseConfigured()) {
        scheduleCloudReconnect();
      }
    });
  }

  if (state.mode === 'cloud') {
    state.sync.timer = setInterval(() => {
      syncCloudDataSilently(false);
    }, 3500);
  }
}

function detachAllListeners() {
  Object.keys(state.unsubscribers).forEach((key) => {
    if (typeof state.unsubscribers[key] === 'function') {
      state.unsubscribers[key]();
      state.unsubscribers[key] = null;
    }
  });
  stopAutoSyncLoop();
}

function switchToLocalFallbackMode(reason = '') {
  if (isFirebaseConfigured()) {
    console.warn('Koneksi Cloud terganggu sementara, menjadwalkan sinkronisasi ulang:', reason);
    scheduleCloudReconnect();
    return;
  }
  if (state.mode === 'local') return;
  console.warn('Beralih otomatis ke penyimpanan lokal:', reason);
  detachAllListeners();
  state.mode = 'local';
  refreshLocalState();
}

function attachRealtimeListeners() {
  detachAllListeners();

  if (state.mode === 'local') {
    refreshLocalState();
    startAutoSyncLoop();
    return;
  }

  state.sync.fingerprints = {};

  // CLOUD FIRESTORE LISTENERS (Real-time + Auto-sync fallback)
  const tahun = String(state.tahun);

  // 1. Listener karcis_facilities
  state.unsubscribers.facilities = onSnapshot(
    collection(db, COL_FACILITIES),
    async (snapshot) => {
      if (!snapshot.empty) {
        state.cloudSeedChecked = true;
        markFacilitiesInitializedLocal();
        if (!state.cloudMetaMarked && state.currentUser?.role === 'admin') {
          markFacilitiesInitializedCloud();
        }
      } else if (!state.cloudSeedChecked && !state.seedingInProgress) {
        const didSeed = await ensureFacilitiesSeededCloud();
        if (didSeed) return;
      }

      const items = [];
      snapshot.forEach((docSnap) => {
        items.push({ id: docSnap.id, ...docSnap.data() });
      });
      items.sort((a, b) =>
        String(a.namaFasilitas || '').localeCompare(String(b.namaFasilitas || ''), 'id')
      );
      state.sync.fingerprints.facilities = buildCollectionFingerprint(items);
      state.facilities = items;
      writeLocalArray(LS_FACILITIES_KEY, items);
      state.loaded.facilities = true;
      checkInitialSkeletonDismiss();
      populateFacilitySelects();
      renderAllViews();
    },
    (err) => {
      console.error('Error listener karcis_facilities:', err);
      switchToLocalFallbackMode(err?.message || err?.code || 'karcis_facilities');
    }
  );

  // 2. Listener karcis_stock
  const stockQ = query(collection(db, COL_STOCK), where('tahun', '==', tahun));
  state.unsubscribers.stocks = onSnapshot(
    stockQ,
    (snapshot) => {
      const items = [];
      snapshot.forEach((docSnap) => {
        items.push({ id: docSnap.id, ...docSnap.data() });
      });
      items.sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));
      state.sync.fingerprints.stocks = buildCollectionFingerprint(items);
      state.stocks = items;
      writeLocalArray(LS_STOCK_KEY, items);
      state.loaded.stocks = true;
      checkInitialSkeletonDismiss();
      populateDistStockSelect();
      renderAllViews();
    },
    (err) => {
      console.error('Error listener karcis_stock:', err);
      switchToLocalFallbackMode(err?.message || err?.code || 'karcis_stock');
    }
  );

  // 3. Listener karcis_distribusi
  const distQ = query(collection(db, COL_DISTRIBUSI), where('tahun', '==', tahun));
  state.unsubscribers.distributions = onSnapshot(
    distQ,
    (snapshot) => {
      const items = [];
      snapshot.forEach((docSnap) => {
        items.push({ id: docSnap.id, ...docSnap.data() });
      });
      items.sort((a, b) => {
        const dCmp = String(b.tanggal || '').localeCompare(String(a.tanggal || ''));
        if (dCmp !== 0) return dCmp;
        return getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt);
      });
      state.sync.fingerprints.distributions = buildCollectionFingerprint(items);
      state.distributions = items;
      writeLocalArray(LS_DISTRIBUSI_KEY, items);
      state.loaded.distributions = true;
      checkInitialSkeletonDismiss();
      renderAllViews();
    },
    (err) => {
      console.error('Error listener karcis_distribusi:', err);
      switchToLocalFallbackMode(err?.message || err?.code || 'karcis_distribusi');
    }
  );

  // 4. Listener karcis_logs
  const logsQ = query(collection(db, COL_LOGS), where('tahun', '==', tahun));
  state.unsubscribers.logs = onSnapshot(
    logsQ,
    (snapshot) => {
      const items = [];
      snapshot.forEach((docSnap) => {
        items.push({ id: docSnap.id, ...docSnap.data() });
      });
      items.sort((a, b) => getTimestampMillis(b.waktu) - getTimestampMillis(a.waktu));
      state.sync.fingerprints.logs = buildCollectionFingerprint(items);
      state.logs = items;
      writeLocalArray(LS_LOGS_KEY, items);
      state.loaded.logs = true;
      pruneSelectedLogIds();
      checkInitialSkeletonDismiss();
      renderAuditLogsUI();
    },
    (err) => {
      console.error('Error listener karcis_logs:', err);
      scheduleCloudReconnect();
    }
  );

  // 5. Listener karcis_users
  state.unsubscribers.users = onSnapshot(
    collection(db, COL_USERS),
    (snapshot) => {
      const items = [];
      snapshot.forEach((docSnap) => {
        items.push({ id: docSnap.id, uid: docSnap.id, ...docSnap.data() });
      });
      items.sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));
      state.sync.fingerprints.users = buildCollectionFingerprint(items);
      if (!applySyncedUsersState(items)) return;
      checkInitialSkeletonDismiss();
      populatePetugasDatalist();
      renderUsersView();
      renderDashboardAlerts();
    },
    (err) => {
      console.error('Error listener karcis_users:', err);
      scheduleCloudReconnect();
    }
  );

  // 6. Listener karcis_requests
  const reqQ = query(collection(db, COL_REQUESTS), where('tahun', '==', tahun));
  state.unsubscribers.requests = onSnapshot(
    reqQ,
    (snapshot) => {
      const items = [];
      snapshot.forEach((docSnap) => {
        items.push({ id: docSnap.id, ...docSnap.data() });
      });
      items.sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));
      state.sync.fingerprints.requests = buildCollectionFingerprint(items);
      state.requests = items;
      writeLocalArray(LS_REQUESTS_KEY, items);
      state.loaded.requests = true;
      checkInitialSkeletonDismiss();
      renderAdminRequestsQueue();
      renderUserPortalView();
      renderDashboardAlerts();
    },
    (err) => {
      console.error('Error listener karcis_requests:', err);
      scheduleCloudReconnect();
    }
  );

  // 7. Listener karcis_settings/signatories (Sinkronisasi Pejabat Penanda Tangan Desktop <-> Android)
  state.unsubscribers.settings = onSnapshot(
    doc(db, COL_SETTINGS, 'signatories'),
    (docSnap) => {
      if (!docSnap.exists()) return;
      const data = docSnap.data() || {};
      const cfg = { ...DEFAULT_SIGNATORIES, ...data };
      try {
        localStorage.setItem(LS_SIGNATORIES_KEY, JSON.stringify(cfg));
      } catch {}
      const fieldMap = {
        'sig-instansi': cfg.instansi,
        'sig-kota': cfg.kota,
        'sig-mengetahui-jabatan': cfg.mengetahuiJabatan,
        'sig-mengetahui-nama': cfg.mengetahuiNama,
        'sig-mengetahui-nip': cfg.mengetahuiNip,
        'sig-pengelola-jabatan': cfg.pengelolaJabatan,
        'sig-pengelola-nama': cfg.pengelolaNama,
        'sig-pengelola-nip': cfg.pengelolaNip
      };
      Object.entries(fieldMap).forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (el && document.activeElement !== el) {
          el.value = val || '';
        }
      });
      applySignatoriesToPrintDOM(cfg);
    },
    () => {
      // Abaikan jika dokumen pengaturan belum dibuat
    }
  );

  startAutoSyncLoop();
}

function checkInitialSkeletonDismiss() {
  const skeleton = document.getElementById('initial-skeleton');
  const viewsContainer = document.getElementById('views-container');
  if (state.loaded.facilities && state.loaded.stocks && state.loaded.distributions) {
    if (skeleton) skeleton.classList.add('hidden');
    if (viewsContainer) viewsContainer.classList.remove('hidden');
  }
}

/* ==========================================================================
   7. AUTH GUARD, ROLE ENFORCEMENT & NAVIGASI SPA
   ========================================================================== */

function hideAuthGuardScreen() {
  const guard = document.getElementById('auth-guard-screen');
  if (guard) guard.classList.add('hidden');
}

function applyUserProfileHeaderUI() {
  const user = state.currentUser;
  if (!user) return;

  const isAdmin = user.role === 'admin';
  const roleBadge = document.getElementById('sidebar-role-badge');
  const avatarEl = document.getElementById('user-avatar-initial');
  const nameEl = document.getElementById('user-name-display');
  const roleEl = document.getElementById('user-role-display');

  const initial = String(user.nama || user.email || 'U')
    .trim()
    .charAt(0)
    .toUpperCase();
  if (avatarEl) {
    avatarEl.textContent = initial;
    avatarEl.className = isAdmin
      ? 'w-8 h-8 rounded-xl bg-blue-700 text-white text-xs font-bold flex items-center justify-center shrink-0'
      : 'w-8 h-8 rounded-xl bg-emerald-600 text-white text-xs font-bold flex items-center justify-center shrink-0';
  }
  if (nameEl) nameEl.textContent = user.nama || user.email;
  if (roleEl) {
    roleEl.textContent = isAdmin ? 'Administrator Utama' : `Petugas • ${user.unitTugas || 'Lapangan'}`;
    roleEl.className = isAdmin
      ? 'text-[10px] text-blue-700 font-bold truncate'
      : 'text-[10px] text-emerald-600 font-semibold truncate';
  }

  if (roleBadge) {
    roleBadge.textContent = isAdmin ? 'ADMIN' : 'PETUGAS';
    roleBadge.className = isAdmin
      ? 'text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30'
      : 'text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
  }

  if (!isAdmin) {
    const welcomeName = document.getElementById('portal-user-welcome-name');
    const unitLabel = document.getElementById('portal-user-unit-label');
    if (welcomeName) welcomeName.textContent = user.nama || user.email;
    if (unitLabel) unitLabel.textContent = user.unitTugas || 'Petugas Retribusi Lapangan';
  }
}

function applyRoleAccessUI() {
  const user = state.currentUser;
  if (!user) return;

  applyUserProfileHeaderUI();

  const isAdmin = user.role === 'admin';
  const adminNav = document.getElementById('admin-nav-group');
  const userNav = document.getElementById('user-nav-group');
  const adminAudit = document.getElementById('admin-audit-group');
  const topbarLowstockBtn = document.getElementById('btn-topbar-lowstock');

  if (isAdmin) {
    if (adminNav) adminNav.classList.remove('hidden');
    if (adminAudit) adminAudit.classList.remove('hidden');
    if (topbarLowstockBtn) topbarLowstockBtn.classList.remove('hidden');
    if (userNav) userNav.classList.add('hidden');
    switchView('dashboard');
  } else {
    // ROLE USER / PETUGAS: Hanya boleh akses Portal Petugas (Permintaan & Retur Seri)
    if (adminNav) adminNav.classList.add('hidden');
    if (adminAudit) adminAudit.classList.add('hidden');
    if (topbarLowstockBtn) topbarLowstockBtn.classList.add('hidden');
    if (userNav) userNav.classList.remove('hidden');
    switchView('portal-user');
  }
}

const VIEW_METADATA = {
  dashboard: {
    title: 'Dashboard',
    subtitle: 'Ringkasan stok, pengeluaran karcis, dan realisasi retribusi'
  },
  distribusi: {
    title: 'Permintaan & Pengeluaran',
    subtitle: 'Setujui permintaan petugas dan catat pengeluaran karcis'
  },
  stok: {
    title: 'Stok Karcis',
    subtitle: 'Input batch karcis baru dan pantau sisa stok (1 Bendel = 100 Lbr)'
  },
  fasilitas: {
    title: 'Fasilitas & Tarif',
    subtitle: 'Atur daftar fasilitas, tarif satuan karcis, dan kode serinya'
  },
  users: {
    title: 'Akun Petugas',
    subtitle: 'Setujui atau tolak pendaftaran akun baru dari petugas'
  },
  laporan: {
    title: 'Laporan & Cetak',
    subtitle: 'Cetak rekapitulasi pemasukan & pengeluaran atau download Excel'
  },
  'portal-user': {
    title: 'Portal Petugas',
    subtitle: 'Ajukan permintaan karcis dan laporkan sisa yang dikembalikan'
  }
};

export function switchView(viewName) {
  if (!state.currentUser) return;

  // Proteksi navigasi: User hanya boleh membuka 'portal-user'
  if (state.currentUser.role !== 'admin' && viewName !== 'portal-user') {
    viewName = 'portal-user';
  }

  state.activeView = viewName;

  // Toggle section visibility
  document.querySelectorAll('.view-section').forEach((sec) => {
    if (sec.id === `view-${viewName}`) {
      sec.classList.remove('hidden');
    } else {
      sec.classList.add('hidden');
    }
  });

  // Update active nav item styling
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    const navTarget = btn.getAttribute('data-nav');
    if (navTarget === viewName) {
      btn.className =
        'nav-item w-full flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition bg-blue-700 text-white shadow-sm';
    } else {
      btn.className =
        'nav-item w-full flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-800/80 transition';
    }
  });

  // Update topbar title & subtitle
  const meta = VIEW_METADATA[viewName] || VIEW_METADATA.dashboard;
  const titleEl = document.getElementById('topbar-title');
  const subtitleEl = document.getElementById('topbar-subtitle');
  if (titleEl) titleEl.textContent = meta.title;
  if (subtitleEl) subtitleEl.textContent = meta.subtitle;

  closeMobileSidebar();

  if (viewName === 'dashboard') {
    updateCharts();
  } else if (viewName === 'laporan') {
    renderReportView();
  } else if (viewName === 'portal-user') {
    renderUserPortalView();
  }
}

function openMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('mobile-sidebar-backdrop');
  if (sidebar) sidebar.classList.remove('-translate-x-full');
  if (backdrop) backdrop.classList.remove('hidden');
}

function closeMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('mobile-sidebar-backdrop');
  if (sidebar) sidebar.classList.add('-translate-x-full');
  if (backdrop) backdrop.classList.add('hidden');
}

/* ==========================================================================
   8. RENDER KOORDINATOR, DROPDOWN DINAMIS & DASHBOARD ANALITIK
   ========================================================================== */

function updateYearLabels() {
  document.querySelectorAll('.kpi-year-label').forEach((el) => {
    el.textContent = state.tahun;
  });
}

function normalizeFacilityName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeKodeSeri(kode) {
  return String(kode || '').trim().toUpperCase();
}

function findFacilityByName(name) {
  const target = normalizeFacilityName(name);
  if (!target) return null;
  return state.facilities.find((f) => normalizeFacilityName(f.namaFasilitas) === target) || null;
}

function findFacilityByNameAndKode(name, kodeHuruf) {
  const targetName = normalizeFacilityName(name);
  const targetKode = normalizeKodeSeri(kodeHuruf);
  if (!targetName) return null;
  if (!targetKode) return findFacilityByName(name);
  return (
    state.facilities.find(
      (f) =>
        normalizeFacilityName(f.namaFasilitas) === targetName &&
        normalizeKodeSeri(f.kodeDefault) === targetKode
    ) || null
  );
}

function hasDuplicateFacilityName(name) {
  const target = normalizeFacilityName(name);
  if (!target) return false;
  let count = 0;
  for (const f of state.facilities) {
    if (normalizeFacilityName(f.namaFasilitas) === target) {
      count++;
      if (count > 1) return true;
    }
  }
  return false;
}

function findExistingStockGroupByNameAndKode(name, kodeHuruf) {
  const targetName = normalizeFacilityName(name);
  const targetKode = normalizeKodeSeri(kodeHuruf);
  if (!targetName || !targetKode) return null;
  const facById = new Map(state.facilities.map((f) => [f.id, f]));
  return (
    state.stocks.find((s) => {
      const linkedFac = facById.get(s.facilityId);
      const sName = normalizeFacilityName(linkedFac?.namaFasilitas || s.jenisFasilitas);
      const sKode = normalizeKodeSeri(s.kodeHuruf || linkedFac?.kodeDefault);
      return sName === targetName && sKode === targetKode;
    }) || null
  );
}

function suggestKodeFromFacilityName(name) {
  const words = String(name || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 3);
  if (words.length === 2) return (words[0].slice(0, 2) + words[1].slice(0, 1)).slice(0, 3);
  return words
    .map((w) => w[0])
    .join('')
    .slice(0, 4);
}

function populateFacilitySelects() {
  const allFacilities = state.facilities;
  const formatFacilityOptionName = (fac) =>
    hasDuplicateFacilityName(fac.namaFasilitas) && fac.kodeDefault
      ? `${fac.namaFasilitas} [${fac.kodeDefault}]`
      : fac.namaFasilitas;

  const activeSelectIds = ['dist-facility', 'req-facility'];
  activeSelectIds.forEach((selectId) => {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const prevVal = sel.value;
    sel.innerHTML = '<option value="">Pilih fasilitas...</option>';
    allFacilities.forEach((fac) => {
      const opt = document.createElement('option');
      opt.value = fac.id;
      opt.textContent = `${formatFacilityOptionName(fac)} (${formatRupiah(fac.tarifSatuan)} / lbr)`;
      sel.appendChild(opt);
    });
    if (prevVal && allFacilities.some((f) => f.id === prevVal)) {
      sel.value = prevVal;
    }
  });

  // Datalist autocomplete fasilitas untuk form Tambah Stok Karcis (dukung input fasilitas baru maupun lama)
  const stokDatalist = document.getElementById('datalist-stok-facilities');
  if (stokDatalist) {
    stokDatalist.innerHTML = '';
    const byName = new Map();
    allFacilities
      .slice()
      .sort((a, b) => String(a.namaFasilitas || '').localeCompare(String(b.namaFasilitas || ''), 'id'))
      .forEach((fac) => {
        const key = normalizeFacilityName(fac.namaFasilitas);
        if (!key) return;
        if (!byName.has(key)) {
          byName.set(key, {
            namaFasilitas: fac.namaFasilitas,
            tarifs: new Set([formatRupiah(fac.tarifSatuan) + '/lbr']),
            kodes: new Set([normalizeKodeSeri(fac.kodeDefault)].filter(Boolean))
          });
        } else {
          const entry = byName.get(key);
          entry.tarifs.add(formatRupiah(fac.tarifSatuan) + '/lbr');
          if (fac.kodeDefault) entry.kodes.add(normalizeKodeSeri(fac.kodeDefault));
        }
      });

    byName.forEach((entry) => {
      const opt = document.createElement('option');
      opt.value = entry.namaFasilitas;
      const kodeLabel = Array.from(entry.kodes).join(', ');
      const tarifLabel = Array.from(entry.tarifs).join(' / ');
      opt.textContent = `${tarifLabel}${kodeLabel ? ` • Seri: ${kodeLabel}` : ''}`;
      stokDatalist.appendChild(opt);
    });
  }

  const filterSelectIds = ['filter-dist-facility', 'filter-stok-facility', 'rep-facility'];
  filterSelectIds.forEach((selectId) => {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const prevVal = sel.value || 'ALL';
    sel.innerHTML = '<option value="ALL">Semua Fasilitas</option>';
    allFacilities.forEach((fac) => {
      const opt = document.createElement('option');
      opt.value = fac.id;
      opt.textContent = formatFacilityOptionName(fac);
      sel.appendChild(opt);
    });
    if (prevVal === 'ALL' || allFacilities.some((f) => f.id === prevVal)) {
      sel.value = prevVal;
    }
  });

  populateDistStockSelect();
}

function populatePetugasDatalist() {
  const dl = document.getElementById('datalist-petugas');
  if (!dl) return;

  const approvedOfficers = state.users
    .filter((u) => u.status === 'approved' && u.role !== 'admin')
    .slice()
    .sort((a, b) => String(a.nama || '').localeCompare(String(b.nama || ''), 'id'));

  dl.innerHTML = '';
  approvedOfficers.forEach((u) => {
    const opt = document.createElement('option');
    opt.value = u.unitTugas ? `${u.nama} (${u.unitTugas})` : u.nama;
    dl.appendChild(opt);
  });
}

function renderAllViews() {
  updateYearLabels();
  populateFacilitySelects();

  if (state.currentUser?.role === 'admin') {
    populatePetugasDatalist();
    renderDashboardAlerts();
    renderDashboardKPIs();
    updateCharts();
    renderAuditLogsUI();
    renderAdminRequestsQueue();
    renderDistribusiLivePreview();
    renderDistribusiTable();
    renderStokSummaryAndPreview();
    renderStokTable();
    renderFacilitiesTable();
    renderUsersView();
    renderReportView();
  } else {
    renderUserPortalView();
  }
}

/**
 * Menampilkan Alert Cepat di Dashboard Admin jika ada Pendaftaran Akun User atau Permintaan Karcis yang Menunggu
 */
function renderDashboardAlerts() {
  const pendingUsersCount = state.users.filter((u) => u.status === 'pending' && u.role !== 'admin').length;
  const pendingReqsCount = state.requests.filter((r) => r.statusPermintaan === 'Menunggu').length;

  // Update Sidebar Badges
  const userBadge = document.getElementById('nav-badge-pending-users');
  if (userBadge) {
    if (pendingUsersCount > 0) {
      userBadge.textContent = String(pendingUsersCount);
      userBadge.classList.remove('hidden');
    } else {
      userBadge.classList.add('hidden');
    }
  }

  const reqBadge = document.getElementById('nav-badge-requests');
  if (reqBadge) {
    if (pendingReqsCount > 0) {
      reqBadge.textContent = String(pendingReqsCount);
      reqBadge.classList.remove('hidden');
    } else {
      reqBadge.classList.add('hidden');
    }
  }

  const alertsContainer = document.getElementById('admin-action-alerts');
  if (!alertsContainer) return;

  if (pendingUsersCount === 0 && pendingReqsCount === 0) {
    alertsContainer.classList.add('hidden');
    alertsContainer.innerHTML = '';
    return;
  }

  alertsContainer.classList.remove('hidden');
  const cards = [];

  if (pendingUsersCount > 0) {
    cards.push(`
      <div class="rounded-2xl bg-amber-50 border border-amber-200 p-4 flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-amber-500 text-slate-950 flex items-center justify-center shrink-0 font-bold">
            ${pendingUsersCount}
          </div>
          <h4 class="text-xs sm:text-sm font-semibold text-amber-950">${pendingUsersCount} Akun Petugas Menunggu Persetujuan</h4>
        </div>
        <button type="button" data-jump-nav="users" class="shrink-0 px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold transition">
          Cek Akun &rarr;
        </button>
      </div>
    `);
  }

  if (pendingReqsCount > 0) {
    cards.push(`
      <div class="rounded-2xl bg-blue-50 border border-blue-200 p-4 flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-blue-700 text-white flex items-center justify-center shrink-0 font-bold">
            ${pendingReqsCount}
          </div>
          <h4 class="text-xs sm:text-sm font-semibold text-blue-950">${pendingReqsCount} Permintaan Karcis Menunggu</h4>
        </div>
        <button type="button" data-jump-nav="distribusi" class="shrink-0 px-3.5 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold transition">
          Proses &rarr;
        </button>
      </div>
    `);
  }

  alertsContainer.innerHTML = cards.join('');
}

function renderDashboardKPIs() {
  // 1. Total Stok Gudang
  const totalSisaStok = state.stocks.reduce((sum, s) => sum + (Number(s.sisaStok) || 0), 0);
  const stokBdl = toBendelLembar(totalSisaStok);
  const kpiStokUtama = document.getElementById('kpi-stok-utama');
  const kpiStokSub = document.getElementById('kpi-stok-sub');
  if (kpiStokUtama) kpiStokUtama.textContent = stokBdl.shortFormatted;
  if (kpiStokSub) kpiStokSub.textContent = `${formatNumber(totalSisaStok)} Lembar tersedia`;

  // 2. Total Karcis Terjual & Retur
  const totalTerjual = state.distributions.reduce((sum, d) => sum + (Number(d.jumlahTerjual) || 0), 0);
  const totalRetur = state.distributions.reduce((sum, d) => sum + (Number(d.jumlahRetur) || 0), 0);
  const terjualBdl = toBendelLembar(totalTerjual);
  const kpiTerjualUtama = document.getElementById('kpi-terjual-utama');
  const kpiTerjualSub = document.getElementById('kpi-terjual-sub');
  if (kpiTerjualUtama) kpiTerjualUtama.textContent = `${formatNumber(totalTerjual)} Lembar`;
  if (kpiTerjualSub) {
    kpiTerjualSub.textContent = `${terjualBdl.shortFormatted} • Retur: ${formatNumber(totalRetur)} Lbr`;
  }

  // 3. Realisasi Pendapatan Retribusi
  let totalLunas = 0;
  let totalBelum = 0;
  state.distributions.forEach((d) => {
    const nom = Number(d.totalNominal) || 0;
    if (d.statusSetoran === 'Lunas Setor') {
      totalLunas += nom;
    } else {
      totalBelum += nom;
    }
  });
  const totalPendapatan = totalLunas + totalBelum;
  const kpiPendapatanUtama = document.getElementById('kpi-pendapatan-utama');
  const kpiPendapatanLunas = document.getElementById('kpi-pendapatan-lunas');
  const kpiPendapatanBelum = document.getElementById('kpi-pendapatan-belum');
  if (kpiPendapatanUtama) kpiPendapatanUtama.textContent = formatRupiah(totalPendapatan);
  if (kpiPendapatanLunas) kpiPendapatanLunas.textContent = formatRupiah(totalLunas);
  if (kpiPendapatanBelum) kpiPendapatanBelum.textContent = formatRupiah(totalBelum);

  // Badge notifikasi pada menu Stok Karcis & lonceng topbar jika ada stok terdaftar < 2 bendel (< 200 lembar)
  const lowCount = getRegisteredStockSummaries().filter((item) => item.isLow).length;
  const navLowBadge = document.getElementById('nav-badge-lowstock');
  const topbarLowBadge = document.getElementById('topbar-lowstock-badge');
  [navLowBadge, topbarLowBadge].forEach((badge) => {
    if (!badge) return;
    if (lowCount > 0) {
      badge.textContent = String(lowCount);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  });
}

/* ==========================================================================
   9. GRAFIK ANALITIK (CHART.JS) & LOG AUDIT
   ========================================================================== */

function updateCharts() {
  if (typeof window.Chart === 'undefined') return;
  if (state.currentUser?.role !== 'admin') return;

  const monthlyLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const monthlyLembar = new Array(12).fill(0);
  const monthlyNominal = new Array(12).fill(0);

  state.distributions.forEach((d) => {
    if (!d.tanggal) return;
    const parts = String(d.tanggal).split('-');
    if (parts.length >= 2) {
      const mIdx = parseInt(parts[1], 10) - 1;
      if (mIdx >= 0 && mIdx < 12) {
        monthlyLembar[mIdx] += Number(d.jumlahTerjual) || 0;
        monthlyNominal[mIdx] += Number(d.totalNominal) || 0;
      }
    }
  });

  const trendCanvas = document.getElementById('chart-monthly-trend');
  if (trendCanvas) {
    if (state.charts.monthlyTrend) {
      state.charts.monthlyTrend.data.datasets[0].data = monthlyLembar;
      state.charts.monthlyTrend.data.datasets[1].data = monthlyNominal;
      state.charts.monthlyTrend.update();
    } else {
      state.charts.monthlyTrend = new window.Chart(trendCanvas, {
        type: 'bar',
        data: {
          labels: monthlyLabels,
          datasets: [
            {
              type: 'bar',
              label: 'Karcis Terjual (Lembar)',
              data: monthlyLembar,
              backgroundColor: 'rgba(29, 78, 216, 0.82)',
              borderRadius: 6,
              yAxisID: 'yLembar',
              order: 2
            },
            {
              type: 'line',
              label: 'Pendapatan Retribusi (Rp)',
              data: monthlyNominal,
              borderColor: '#059669',
              backgroundColor: 'rgba(5, 150, 105, 0.15)',
              borderWidth: 2.5,
              tension: 0.35,
              pointRadius: 3.5,
              fill: true,
              yAxisID: 'yRupiah',
              order: 1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false }
          },
          scales: {
            yLembar: {
              type: 'linear',
              position: 'left',
              beginAtZero: true,
              ticks: { font: { size: 11 } },
              grid: { color: 'rgba(226, 232, 240, 0.7)' }
            },
            yRupiah: {
              type: 'linear',
              position: 'right',
              beginAtZero: true,
              ticks: {
                font: { size: 11 },
                callback: (val) => 'Rp ' + formatNumber(val)
              },
              grid: { drawOnChartArea: false }
            }
          }
        }
      });
    }
  }

  // Grafik 2: Komposisi per Jenis Fasilitas
  const facStatsMap = new Map();
  state.facilities.forEach((f) => {
    facStatsMap.set(f.id, {
      nama: f.namaFasilitas,
      lembar: 0,
      nominal: 0
    });
  });

  state.distributions.forEach((d) => {
    const item = facStatsMap.get(d.facilityId) || {
      nama: d.jenisFasilitas || 'Lainnya',
      lembar: 0,
      nominal: 0
    };
    item.lembar += Number(d.jumlahTerjual) || 0;
    item.nominal += Number(d.totalNominal) || 0;
    facStatsMap.set(d.facilityId || d.jenisFasilitas, item);
  });

  const facStats = Array.from(facStatsMap.values()).sort((a, b) => b.nominal - a.nominal);
  const compLabels = facStats.map((f) => f.nama);
  const compData =
    state.compositionChartMode === 'doughnut'
      ? facStats.map((f) => f.nominal)
      : facStats.map((f) => f.lembar);

  const palette = ['#1d4ed8', '#059669', '#0284c7', '#7c3aed', '#d97706', '#e11d48', '#475569', '#0d9488'];

  const compCanvas = document.getElementById('chart-facility-composition');
  if (compCanvas) {
    if (state.charts.facilityComposition) {
      state.charts.facilityComposition.destroy();
      state.charts.facilityComposition = null;
    }
    state.charts.facilityComposition = new window.Chart(compCanvas, {
      type: state.compositionChartMode === 'doughnut' ? 'doughnut' : 'bar',
      data: {
        labels: compLabels,
        datasets: [
          {
            label: state.compositionChartMode === 'doughnut' ? 'Pendapatan (Rp)' : 'Terjual (Lembar)',
            data: compData,
            backgroundColor: palette.slice(0, Math.max(compLabels.length, 1)),
            borderWidth: 1,
            borderRadius: state.compositionChartMode === 'bar' ? 6 : 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: state.compositionChartMode === 'doughnut',
            position: 'bottom',
            labels: { boxWidth: 10, font: { size: 10 } }
          }
        }
      }
    });
  }

  // Breakdown list di bawah grafik komposisi
  const breakdownEl = document.getElementById('facility-breakdown-list');
  if (breakdownEl) {
    const grandNominal = facStats.reduce((s, x) => s + x.nominal, 0) || 1;
    breakdownEl.innerHTML = facStats
      .map((item, idx) => {
        const pct = item.nominal > 0 ? Math.round((item.nominal / grandNominal) * 100) : 0;
        const dotColor = palette[idx % palette.length];
        return `
          <div class="flex items-center justify-between py-1">
            <div class="flex items-center gap-2 min-w-0">
              <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${dotColor}"></span>
              <span class="font-medium text-slate-700 truncate">${escapeHtml(item.nama)}</span>
            </div>
            <div class="text-right shrink-0 tabular-nums">
              <span class="font-bold text-slate-900">${formatRupiah(item.nominal)}</span>
              <span class="text-slate-400 ml-1">(${formatNumber(item.lembar)} lbr • ${pct}%)</span>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

const ACTION_LABELS = {
  TAMBAH_STOK: 'Stok Masuk',
  HAPUS_STOK: 'Hapus Stok',
  DISTRIBUSI_KARCIS: 'Karcis Keluar',
  HAPUS_DISTRIBUSI: 'Hapus Pengeluaran',
  RETUR_REKONSILIASI: 'Retur / Setor',
  PENGAJUAN_KARCIS: 'Permintaan Karcis',
  SETUJUI_PERMINTAAN: 'Permintaan Disetujui',
  TOLAK_PERMINTAAN: 'Permintaan Ditolak',
  TAMBAH_FASILITAS: 'Tambah Fasilitas',
  EDIT_FASILITAS: 'Edit Fasilitas',
  TOGGLE_FASILITAS: 'Status Fasilitas',
  HAPUS_FASILITAS: 'Hapus Fasilitas',
  DAFTAR_AKUN: 'Daftar Akun',
  PENDAFTARAN_AKUN: 'Daftar Akun',
  APPROVE_USER: 'Akun Disetujui',
  REJECT_USER: 'Akun Ditolak',
  DELETE_USER: 'Hapus Akun',
  SIMPAN_TTD: 'Pengaturan Cetak',
  AUTO_SEED_FASILITAS: 'Data Awal'
};

function formatActionLabel(aksi) {
  const key = String(aksi || '').trim();
  if (ACTION_LABELS[key]) return ACTION_LABELS[key];
  return key
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isSyntheticPetugasEmail(email) {
  return String(email || '').trim().toLowerCase().endsWith('@petugas.sikarcis.id');
}

function formatActorLabel(userEmail) {
  const email = String(userEmail || '').trim();
  if (!email) return '';
  if (isSyntheticPetugasEmail(email)) {
    const matched = state.users.find(
      (u) => String(u.email || '').toLowerCase() === email.toLowerCase()
    );
    if (matched?.nama) return matched.nama;
    const localPart = email.split('@')[0] || 'Petugas';
    return localPart
      .split('.')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return email;
}

function updateLogsSelectionUI() {
  if (!(state.selectedLogIds instanceof Set)) {
    state.selectedLogIds = new Set();
  }
  const count = state.selectedLogIds.size;
  const countEl = document.getElementById('logs-selected-count');
  const delBtn = document.getElementById('btn-delete-selected-logs');
  const clearBtn = document.getElementById('btn-clear-log-selection');

  if (countEl) countEl.textContent = String(count);
  if (delBtn) {
    delBtn.disabled = count === 0;
    delBtn.textContent = `Hapus Terpilih (${count})`;
  }
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', count === 0);
  }
}

async function handleDeleteLogs(rawIds) {
  if (!requireAdmin('menghapus riwayat aktivitas')) return;

  const targetList = Array.isArray(rawIds) ? rawIds : [rawIds];
  const existingSet = new Set(state.logs.map((l) => l.id));
  const uniqueIds = Array.from(new Set(targetList.filter((id) => id && existingSet.has(id))));
  if (uniqueIds.length === 0) return;

  const isSingle = uniqueIds.length === 1;
  const sampleLog = isSingle ? state.logs.find((l) => l.id === uniqueIds[0]) : null;
  const confirmed = await showConfirmModal({
    title: isSingle ? 'Hapus Riwayat Aktivitas?' : `Hapus ${uniqueIds.length} Riwayat Aktivitas?`,
    message: isSingle
      ? `Catatan "${sampleLog?.detail || formatActionLabel(sampleLog?.aksi)}" akan dihapus permanen dari riwayat.`
      : `${uniqueIds.length} catatan riwayat aktivitas yang dipilih akan dihapus permanen dari sistem.`,
    confirmText: isSingle ? 'Ya, Hapus Catatan' : `Ya, Hapus (${uniqueIds.length})`,
    variant: 'danger'
  });
  if (!confirmed) return;

  try {
    if (state.mode === 'cloud') {
      const CHUNK_SIZE = 450;
      for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
        const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
        const batch = writeBatch(db);
        chunk.forEach((logId) => {
          batch.delete(doc(db, COL_LOGS, logId));
        });
        await batch.commit();
      }
      const deletedSet = new Set(uniqueIds);
      state.logs = state.logs.filter((l) => !deletedSet.has(l.id));
      writeLocalArray(LS_LOGS_KEY, state.logs);
      state.sync.fingerprints.logs = buildCollectionFingerprint(state.logs);
    } else {
      const deletedSet = new Set(uniqueIds);
      const remaining = readLocalArray(LS_LOGS_KEY).filter((l) => !deletedSet.has(l.id));
      writeLocalArray(LS_LOGS_KEY, remaining);
      refreshLocalState();
    }

    uniqueIds.forEach((id) => state.selectedLogIds.delete(id));
    renderAuditLogsUI();
    notifyCrossTabSync('logs');
    showToast(
      'info',
      'Riwayat Aktivitas Dihapus',
      isSingle
        ? '1 catatan riwayat aktivitas telah dihapus.'
        : `${uniqueIds.length} catatan riwayat aktivitas terpilih telah dihapus.`
    );
  } catch (err) {
    console.error('Gagal menghapus riwayat aktivitas:', err);
    showToast('error', 'Gagal Menghapus Riwayat', err.message || 'Terjadi kesalahan saat menghapus riwayat.');
  }
}

function renderAuditLogsUI() {
  pruneSelectedLogIds();

  const sidebarCount = document.getElementById('sidebar-logs-count');
  if (sidebarCount) sidebarCount.textContent = formatNumber(state.logs.length);

  const dashList = document.getElementById('dashboard-logs-list');
  if (dashList) {
    const recent = state.logs.slice(0, 6);
    if (recent.length === 0) {
      dashList.innerHTML = `<p class="py-6 text-center text-slate-400">Belum ada catatan aktivitas pada TA ${escapeHtml(state.tahun)}.</p>`;
    } else {
      dashList.innerHTML = recent
        .map(
          (log) => `
          <div class="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
            <div class="flex items-start sm:items-center gap-2.5 min-w-0">
              <span class="px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-100 text-slate-700 border border-slate-200 shrink-0">${escapeHtml(formatActionLabel(log.aksi))}</span>
              <span class="text-slate-700 truncate">${escapeHtml(log.detail)}</span>
            </div>
            <div class="flex items-center justify-between sm:justify-end gap-2 shrink-0">
              <span class="text-[11px] text-slate-400 font-mono-seri">
                ${escapeHtml(formatActorLabel(log.userEmail))} • ${formatTimestamp(log.waktu)}
              </span>
              <button
                type="button"
                data-delete-log="${escapeHtml(log.id)}"
                title="Hapus catatan ini"
                class="px-2 py-0.5 rounded-md text-[11px] font-medium text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 transition-colors shrink-0"
              >
                Hapus
              </button>
            </div>
          </div>
        `
        )
        .join('');
    }
  }

  const modalBody = document.getElementById('modal-logs-body');
  if (modalBody) {
    const q = state.filters.logsSearch.trim().toLowerCase();
    const filtered = state.logs.filter((l) => {
      if (!q) return true;
      const friendly = formatActionLabel(l.aksi).toLowerCase();
      const actor = formatActorLabel(l.userEmail).toLowerCase();
      return (
        String(l.aksi || '').toLowerCase().includes(q) ||
        friendly.includes(q) ||
        actor.includes(q) ||
        String(l.detail || '').toLowerCase().includes(q) ||
        String(l.userEmail || '').toLowerCase().includes(q)
      );
    });

    if (filtered.length === 0) {
      modalBody.innerHTML = `<p class="py-8 text-center text-slate-400">Tidak ada catatan aktivitas yang cocok.</p>`;
    } else {
      modalBody.innerHTML = filtered
        .map((log) => {
          const isChecked = state.selectedLogIds.has(log.id);
          return `
          <div class="py-3 flex items-start gap-3 ${isChecked ? 'bg-rose-50/40 -mx-1 px-1 rounded-lg' : ''}">
            <input
              type="checkbox"
              data-log-checkbox="${escapeHtml(log.id)}"
              ${isChecked ? 'checked' : ''}
              aria-label="Pilih riwayat ${escapeHtml(formatActionLabel(log.aksi))}"
              class="mt-1 h-4 w-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500 cursor-pointer shrink-0"
            />
            <div class="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div class="space-y-0.5 min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="px-2 py-0.5 rounded-md text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">${escapeHtml(formatActionLabel(log.aksi))}</span>
                  <span class="text-[11px] text-slate-500">${escapeHtml(formatActorLabel(log.userEmail))}</span>
                </div>
                <p class="text-slate-800 font-medium break-words">${escapeHtml(log.detail)}</p>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <span class="text-[11px] font-mono-seri text-slate-400">${formatTimestamp(log.waktu)}</span>
                <button
                  type="button"
                  data-delete-log="${escapeHtml(log.id)}"
                  class="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-rose-600 bg-rose-50/70 hover:bg-rose-100 border border-rose-200 transition-colors"
                >
                  Hapus
                </button>
              </div>
            </div>
          </div>
        `;
        })
        .join('');
    }
  }

  updateLogsSelectionUI();
}

/* ==========================================================================
   10. VIEW 5: KELOLA AKUN USER & PERSETUJUAN PENDAFTARAN (OLEH ADMIN)
   ========================================================================== */

function renderUsersView() {
  const tbody = document.getElementById('users-table-body');
  const mobileCards = document.getElementById('users-mobile-cards');
  const sumPending = document.getElementById('users-summary-pending');
  const sumApproved = document.getElementById('users-summary-approved');

  const pendingCount = state.users.filter((u) => u.status === 'pending').length;
  const approvedCount = state.users.filter((u) => u.status === 'approved').length;

  if (sumPending) sumPending.textContent = `${pendingCount} Menunggu`;
  if (sumApproved) sumApproved.textContent = `${approvedCount} Aktif`;

  if (!tbody || !mobileCards) return;

  const q = state.filters.users.search.trim().toLowerCase();
  const statusFilter = state.filters.users.status;

  const filtered = state.users.filter((u) => {
    if (statusFilter !== 'ALL' && u.status !== statusFilter) return false;
    if (!q) return true;
    const displayEmail = isSyntheticPetugasEmail(u.email) ? '' : String(u.email || '').toLowerCase();
    return (
      String(u.nama || '').toLowerCase().includes(q) ||
      String(u.unitTugas || '').toLowerCase().includes(q) ||
      displayEmail.includes(q)
    );
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-10 text-center text-slate-400">Belum ada data akun petugas yang cocok.</td>
      </tr>
    `;
    mobileCards.innerHTML = `<div class="py-8 text-center text-slate-400 text-xs">Belum ada data akun petugas.</div>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((u) => {
      const uid = u.uid || u.id;
      const isPrimaryAdmin = isAdminEmail(u.email) || u.role === 'admin';
      const showSubEmail = !isSyntheticPetugasEmail(u.email);
      const roleBadge =
        u.role === 'admin'
          ? '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-blue-100 text-blue-800 border border-blue-200">Admin</span>'
          : '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-700 border border-slate-200">Petugas</span>';

      let statusBadge = '';
      if (u.status === 'approved') {
        statusBadge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Aktif</span>';
      } else if (u.status === 'rejected') {
        statusBadge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-50 text-rose-700 border border-rose-200">Ditolak</span>';
      } else {
        statusBadge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800 border border-amber-200">Menunggu</span>';
      }

      const deleteBtnHtml = `
        <button type="button" data-user-delete="${escapeHtml(uid)}" title="Hapus Akun" class="p-1.5 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      `;

      let actionButtons = '';
      if (isPrimaryAdmin) {
        actionButtons = '<span class="text-[11px] text-slate-400 font-medium">Admin Utama</span>';
      } else if (u.status === 'pending') {
        actionButtons = `
          <div class="inline-flex items-center justify-end gap-1.5">
            <button type="button" data-user-approve="${escapeHtml(uid)}" class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-2xs transition">
              Setujui
            </button>
            <button type="button" data-user-reject="${escapeHtml(uid)}" class="px-3 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-semibold transition">
              Tolak
            </button>
            ${deleteBtnHtml}
          </div>
        `;
      } else if (u.status === 'approved') {
        actionButtons = `
          <div class="inline-flex items-center justify-end gap-1.5">
            <button type="button" data-user-reject="${escapeHtml(uid)}" class="px-3 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-medium transition">
              Nonaktifkan
            </button>
            ${deleteBtnHtml}
          </div>
        `;
      } else {
        actionButtons = `
          <div class="inline-flex items-center justify-end gap-1.5">
            <button type="button" data-user-approve="${escapeHtml(uid)}" class="px-3 py-1.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 text-xs font-medium transition">
              Aktifkan
            </button>
            ${deleteBtnHtml}
          </div>
        `;
      }

      return `
        <tr class="hover:bg-slate-50/80 transition">
          <td class="py-3 px-4">
            <p class="font-semibold text-slate-900">${escapeHtml(u.nama || 'Tanpa Nama')}</p>
            ${showSubEmail ? `<p class="text-[11px] text-slate-500">${escapeHtml(u.email)}</p>` : ''}
          </td>
          <td class="py-3 px-4 font-medium text-slate-700">${escapeHtml(u.unitTugas || '-')}</td>
          <td class="py-3 px-4 text-center">${roleBadge}</td>
          <td class="py-3 px-4 text-center">${statusBadge}</td>
          <td class="py-3 px-4 text-xs text-slate-500">${formatTimestamp(u.createdAt)}</td>
          <td class="py-3 px-4 text-right">${actionButtons}</td>
        </tr>
      `;
    })
    .join('');

  mobileCards.innerHTML = filtered
    .map((u) => {
      const uid = u.uid || u.id;
      const isPrimaryAdmin = isAdminEmail(u.email) || u.role === 'admin';
      const statusLabel =
        u.status === 'approved' ? 'Aktif' : u.status === 'rejected' ? 'Ditolak' : 'Menunggu';
      return `
        <div class="rounded-xl border border-slate-200 p-4 space-y-2.5 bg-white">
          <div class="flex items-start justify-between gap-2">
            <div>
              <p class="font-semibold text-slate-900 text-sm">${escapeHtml(u.nama)}</p>
              <p class="text-xs text-slate-500">${escapeHtml(u.unitTugas || '-')}</p>
            </div>
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${
              u.status === 'approved'
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : u.status === 'rejected'
                ? 'bg-rose-50 text-rose-700 border border-rose-200'
                : 'bg-amber-100 text-amber-800 border border-amber-200'
            }">${statusLabel}</span>
          </div>
          ${
            !isPrimaryAdmin
              ? `<div class="pt-2 border-t border-slate-100 flex flex-wrap gap-2 justify-end">
                  ${
                    u.status !== 'approved'
                      ? `<button type="button" data-user-approve="${escapeHtml(uid)}" class="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold">Setujui</button>`
                      : ''
                  }
                  ${
                    u.status !== 'rejected'
                      ? `<button type="button" data-user-reject="${escapeHtml(uid)}" class="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 text-xs font-semibold">Tolak / Nonaktifkan</button>`
                      : ''
                  }
                  <button type="button" data-user-delete="${escapeHtml(uid)}" class="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-rose-50 text-rose-700 border border-slate-200 text-xs font-semibold">Hapus</button>
                </div>`
              : ''
          }
        </div>
      `;
    })
    .join('');
}

async function handleUserStatusDecision(uid, newStatus) {
  if (!requireAdmin('memverifikasi akun pengguna')) return;
  const userObj = state.users.find((u) => (u.uid || u.id) === uid);
  if (!userObj) return;

  const isApprove = newStatus === 'approved';
  const confirmed = await showConfirmModal({
    title: isApprove ? 'Setujui Pendaftaran Akun Petugas?' : 'Tolak / Nonaktifkan Akun Petugas?',
    message: isApprove
      ? `Akun "${userObj.nama}" (${userObj.unitTugas || '-'}) akan diaktifkan dan dapat masuk sebagai Petugas untuk mengajukan permintaan karcis serta mengembalikan sisa seri.`
      : `Akun "${userObj.nama}" (${userObj.unitTugas || '-'}) tidak akan diizinkan masuk ke dalam sistem SI-KARCIS.`,
    confirmText: isApprove ? 'Ya, Setujui Akun' : 'Ya, Tolak / Nonaktifkan',
    variant: isApprove ? 'primary' : 'danger'
  });

  if (!confirmed) return;

  try {
    if (state.mode === 'cloud') {
      await updateDoc(doc(db, COL_USERS, uid), {
        status: newStatus,
        verifiedBy: state.currentUser.email,
        verifiedAt: serverTimestamp()
      });
    } else {
      const users = readLocalArray(LS_USERS_KEY);
      const idx = users.findIndex((u) => (u.uid || u.id) === uid);
      if (idx !== -1) {
        users[idx].status = newStatus;
        users[idx].verifiedBy = state.currentUser.email;
        users[idx].verifiedAt = new Date().toISOString();
        writeLocalArray(LS_USERS_KEY, users);
      }
      refreshLocalState();
    }

    await logActivity(
      isApprove ? 'APPROVE_USER' : 'REJECT_USER',
      `Admin mengubah status akun ${userObj.nama} (${userObj.unitTugas || '-'}) menjadi ${newStatus.toUpperCase()}.`
    );

    showToast(
      isApprove ? 'success' : 'warning',
      isApprove ? 'Akun Petugas Disetujui' : 'Status Akun Diperbarui',
      `Akun ${userObj.nama} kini berstatus ${isApprove ? 'AKTIF' : 'DITOLAK / NONAKTIF'}.`
    );
  } catch (err) {
    console.error('Gagal memperbarui status akun:', err);
    showToast('error', 'Gagal Memperbarui Akun', err.message || 'Terjadi kesalahan saat menyimpan status akun.');
  }
}

async function handleDeleteUser(uid) {
  if (!requireAdmin('menghapus akun petugas')) return;
  const userObj = state.users.find((u) => (u.uid || u.id) === uid);
  if (!userObj) return;

  if (
    isAdminEmail(userObj.email) ||
    userObj.role === 'admin' ||
    uid === state.currentUser?.uid
  ) {
    showToast('warning', 'Tidak Dapat Dihapus', 'Akun Administrator utama tidak dapat dihapus.');
    return;
  }

  const confirmed = await showConfirmModal({
    title: 'Hapus Akun Petugas Ini?',
    message: `Akun "${userObj.nama}" (${userObj.unitTugas || '-'}) akan dihapus permanen dari daftar Akun Petugas dan tidak dapat digunakan untuk masuk lagi.`,
    confirmText: 'Ya, Hapus Akun',
    variant: 'danger'
  });

  if (!confirmed) return;

  try {
    if (state.mode === 'cloud') {
      await deleteDoc(doc(db, COL_USERS, uid));
    } else {
      const users = readLocalArray(LS_USERS_KEY).filter((u) => (u.uid || u.id) !== uid);
      writeLocalArray(LS_USERS_KEY, users);

      try {
        const rawSession = localStorage.getItem(LS_SESSION_KEY);
        if (rawSession) {
          const parsed = JSON.parse(rawSession);
          if (parsed && (parsed.uid || parsed.id) === uid) {
            localStorage.removeItem(LS_SESSION_KEY);
          }
        }
      } catch {
        // ignore
      }

      refreshLocalState();
    }

    await logActivity(
      'DELETE_USER',
      `Admin menghapus akun petugas: ${userObj.nama} (${userObj.unitTugas || '-'}).`
    );

    showToast(
      'success',
      'Akun Dihapus',
      `Akun "${userObj.nama}" telah dihapus dan tidak tampil lagi di daftar Akun Petugas.`
    );
  } catch (err) {
    console.error('Gagal menghapus akun petugas:', err);
    showToast('error', 'Gagal Menghapus Akun', err.message || 'Terjadi kesalahan saat menghapus akun petugas.');
  }
}

/* ==========================================================================
   11. PORTAL KHUSUS PETUGAS / USER (PENGAJUAN PERMINTAAN & RETUR SERI)
   ========================================================================== */

function getMyRequests() {
  if (!state.currentUser) return [];
  const uid = state.currentUser.uid;
  const email = String(state.currentUser.email || '').toLowerCase();
  return state.requests.filter(
    (r) => r.userUid === uid || String(r.userEmail || '').toLowerCase() === email
  );
}

function getMyDistributions() {
  if (!state.currentUser) return [];
  const uid = state.currentUser.uid;
  const email = String(state.currentUser.email || '').toLowerCase();
  const nama = String(state.currentUser.nama || '').toLowerCase();

  return state.distributions.filter((d) => {
    if (d.userUid && d.userUid === uid) return true;
    if (d.userEmail && String(d.userEmail).toLowerCase() === email) return true;
    if (nama && String(d.penerima || '').toLowerCase().includes(nama)) return true;
    return false;
  });
}

function updateUserRequestPreview() {
  const facId = document.getElementById('req-facility')?.value || '';
  const jml = Math.max(0, parseInt(document.getElementById('req-jumlah')?.value || '0', 10) || 0);
  const fac = state.facilities.find((f) => f.id === facId);
  const tarif = fac ? Number(fac.tarifSatuan) || 0 : 0;

  const bdl = toBendelLembar(jml);
  const nominal = jml * tarif;

  const bdlEl = document.getElementById('preview-req-bendel');
  const nomEl = document.getElementById('preview-req-nominal');
  if (bdlEl) bdlEl.textContent = bdl.formatted;
  if (nomEl) nomEl.textContent = formatRupiah(nominal);
}

function renderUserPortalView() {
  if (!state.currentUser) return;
  updateUserRequestPreview();

  const myReqs = getMyRequests();
  const myDists = getMyDistributions();

  const pendingReqs = myReqs.filter((r) => r.statusPermintaan === 'Menunggu').length;
  const totalDiterima = myDists.reduce((s, d) => s + (Number(d.jumlahKeluar) || 0), 0);
  const totalTerpakai = myDists.reduce((s, d) => s + (Number(d.jumlahTerjual) || 0), 0);
  const totalRetur = myDists.reduce((s, d) => s + (Number(d.jumlahRetur) || 0), 0);
  const totalNominal = myDists.reduce((s, d) => s + (Number(d.totalNominal) || 0), 0);

  const bdlDiterima = toBendelLembar(totalDiterima);

  const elPending = document.getElementById('user-kpi-pending');
  const elDiterima = document.getElementById('user-kpi-diterima');
  const elDiterimaBdl = document.getElementById('user-kpi-diterima-bdl');
  const elTerpakai = document.getElementById('user-kpi-terpakai');
  const elNominal = document.getElementById('user-kpi-nominal');
  const elRetur = document.getElementById('user-kpi-retur');

  if (elPending) elPending.textContent = `${pendingReqs} Pengajuan`;
  if (elDiterima) elDiterima.textContent = `${formatNumber(totalDiterima)} Lembar`;
  if (elDiterimaBdl) elDiterimaBdl.textContent = bdlDiterima.shortFormatted;
  if (elTerpakai) elTerpakai.textContent = `${formatNumber(totalTerpakai)} Lembar`;
  if (elNominal) elNominal.textContent = `Nilai: ${formatRupiah(totalNominal)}`;
  if (elRetur) elRetur.textContent = `${formatNumber(totalRetur)} Lembar`;

  populateUserReturBatchSelect(myDists);

  // 1. Render Tabel Karcis Diterima & Pengembalian Sisa Karcis Sesuai Nomor Seri
  const distBody = document.getElementById('user-dist-table-body');
  const distMobile = document.getElementById('user-dist-mobile-cards');

  if (distBody && distMobile) {
    if (myDists.length === 0) {
      distBody.innerHTML = `
        <tr>
          <td colspan="8" class="py-10 text-center text-slate-400">
            Belum ada karcis yang diterima pada TA ${escapeHtml(state.tahun)}. Silakan ajukan permintaan karcis pada formulir di atas.
          </td>
        </tr>
      `;
      distMobile.innerHTML = `<div class="py-8 text-center text-slate-400 text-xs">Belum ada karcis yang diterima.</div>`;
    } else {
      distBody.innerHTML = myDists
        .map((d) => {
          const alreadyReturned = (Number(d.jumlahRetur) || 0) > 0;
          const sisaBisaRetur = Math.max(0, (Number(d.jumlahKeluar) || 0) - (Number(d.jumlahRetur) || 0));
          const isLunas = d.statusSetoran === 'Lunas Setor';
          const statusPill = isLunas
            ? '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Lunas Setor</span>'
            : '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200">Belum Setor</span>';

          const actionBtn =
            sisaBisaRetur <= 0 || isLunas
              ? `<button type="button" data-open-retur="${escapeHtml(d.id)}" class="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition">
                  Lihat Detail Seri
                </button>`
              : `<button type="button" data-open-retur="${escapeHtml(d.id)}" class="px-3.5 py-1.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-bold shadow-2xs transition">
                  ${alreadyReturned ? 'Kembalikan Lagi' : 'Kembalikan Sisa Karcis'}
                </button>`;

          return `
            <tr class="hover:bg-slate-50/80 transition">
              <td class="py-3 px-3.5 whitespace-nowrap font-medium text-slate-700">${formatDateShort(d.tanggal)}</td>
              <td class="py-3 px-3.5">
                <p class="font-bold text-slate-900">${escapeHtml(d.jenisFasilitas)}</p>
                <p class="text-[11px] text-slate-500">${formatRupiah(d.tarifSatuan)} / lembar</p>
              </td>
              <td class="py-3 px-3.5">
                <span class="px-2 py-0.5 rounded bg-blue-50 text-blue-800 border border-blue-200 font-mono-seri font-bold text-xs">${escapeHtml(d.seriKeluar)}</span>
                <p class="text-[11px] text-slate-500 mt-0.5">${formatNumber(d.jumlahKeluar)} Lembar</p>
              </td>
              <td class="py-3 px-3.5">
                <span class="font-mono-seri font-semibold text-emerald-700 text-xs">${escapeHtml(d.seriTerjual || d.seriKeluar)}</span>
                <p class="text-[11px] text-slate-500 mt-0.5">Terpakai: <strong>${formatNumber(d.jumlahTerjual)} Lbr</strong></p>
              </td>
              <td class="py-3 px-3.5">
                <span class="font-mono-seri font-semibold ${alreadyReturned ? 'text-amber-700' : 'text-slate-400'} text-xs">${escapeHtml(d.seriRetur || '-')}</span>
                <p class="text-[11px] text-slate-500 mt-0.5">Sisa Retur: <strong>${formatNumber(d.jumlahRetur || 0)} Lbr</strong></p>
              </td>
              <td class="py-3 px-3.5 text-right font-extrabold text-emerald-700 tabular-nums">${formatRupiah(d.totalNominal)}</td>
              <td class="py-3 px-3.5 text-center">${statusPill}</td>
              <td class="py-3 px-3.5 text-right">${actionBtn}</td>
            </tr>
          `;
        })
        .join('');

      distMobile.innerHTML = myDists
        .map((d) => {
          const alreadyReturned = (Number(d.jumlahRetur) || 0) > 0;
          const sisaBisaRetur = Math.max(0, (Number(d.jumlahKeluar) || 0) - (Number(d.jumlahRetur) || 0));
          const isLunas = d.statusSetoran === 'Lunas Setor';
          const locked = sisaBisaRetur <= 0 || isLunas;
          return `
            <div class="rounded-xl border border-slate-200 p-4 space-y-2.5 bg-white">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <p class="font-bold text-slate-900 text-sm">${escapeHtml(d.jenisFasilitas)}</p>
                  <p class="text-xs text-slate-500">${formatDateShort(d.tanggal)} • ${formatRupiah(d.tarifSatuan)}/lbr</p>
                </div>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${
                  d.statusSetoran === 'Lunas Setor'
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    : 'bg-amber-50 text-amber-800 border border-amber-200'
                }">${escapeHtml(d.statusSetoran)}</span>
              </div>
              <div class="rounded-lg bg-slate-50 p-2.5 text-xs space-y-1 font-mono-seri">
                <p>Diterima: <strong class="text-blue-700">${escapeHtml(d.seriKeluar)}</strong> (${formatNumber(d.jumlahKeluar)} Lbr)</p>
                <p>Terpakai: <strong class="text-emerald-700">${escapeHtml(d.seriTerjual)}</strong> (${formatNumber(d.jumlahTerjual)} Lbr)</p>
                <p>Retur Sisa: <strong class="text-amber-700">${escapeHtml(d.seriRetur || '-')}</strong> (${formatNumber(d.jumlahRetur || 0)} Lbr)</p>
              </div>
              <div class="flex items-center justify-between pt-2 border-t border-slate-100">
                <span class="font-extrabold text-emerald-700 text-sm">${formatRupiah(d.totalNominal)}</span>
                <button type="button" data-open-retur="${escapeHtml(d.id)}" class="px-3 py-1.5 rounded-xl ${
                  locked ? 'bg-slate-100 text-slate-700' : 'bg-blue-700 text-white'
                } text-xs font-bold">
                  ${locked ? 'Detail Seri' : alreadyReturned ? 'Kembalikan Lagi' : 'Kembalikan Sisa Karcis'}
                </button>
              </div>
            </div>
          `;
        })
        .join('');
    }
  }

  // 2. Render Tabel Riwayat Pengajuan Permintaan Karcis Saya
  const reqBody = document.getElementById('user-requests-table-body');
  const reqMobile = document.getElementById('user-requests-mobile-cards');

  if (reqBody && reqMobile) {
    if (myReqs.length === 0) {
      reqBody.innerHTML = `
        <tr>
          <td colspan="6" class="py-8 text-center text-slate-400">Belum ada riwayat pengajuan permintaan karcis.</td>
        </tr>
      `;
      reqMobile.innerHTML = `<div class="py-6 text-center text-slate-400 text-xs">Belum ada pengajuan permintaan karcis.</div>`;
    } else {
      reqBody.innerHTML = myReqs
        .map((r) => {
          const bdl = toBendelLembar(r.jumlahDiminta);
          let badge = '';
          let infoSeri = '';
          if (r.statusPermintaan === 'Disetujui') {
            badge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Disetujui Admin</span>';
            infoSeri = `<span class="px-2 py-0.5 rounded bg-blue-50 text-blue-800 border border-blue-200 font-mono-seri font-bold text-xs">${escapeHtml(r.seriDiberikan || '-')}</span>`;
          } else if (r.statusPermintaan === 'Ditolak') {
            badge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-rose-50 text-rose-700 border border-rose-200">Ditolak</span>';
            infoSeri = `<span class="text-xs text-rose-600 font-medium">Alasan: ${escapeHtml(r.alasanPenolakan || 'Stok belum tersedia')}</span>`;
          } else {
            badge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-amber-100 text-amber-800 border border-amber-300">Menunggu Verifikasi</span>';
            infoSeri = '<span class="text-xs text-slate-400 italic">Menunggu alokasi nomor seri oleh Admin</span>';
          }

          return `
            <tr class="hover:bg-slate-50/80 transition">
              <td class="py-3 px-3.5 whitespace-nowrap font-medium text-slate-700">${formatDateShort(r.tanggalPermintaan)}</td>
              <td class="py-3 px-3.5 font-bold text-slate-900">${escapeHtml(r.jenisFasilitas)}</td>
              <td class="py-3 px-3.5 tabular-nums">
                <span class="font-bold text-slate-900">${formatNumber(r.jumlahDiminta)} Lembar</span>
                <span class="block text-[11px] text-slate-500">(${bdl.shortFormatted})</span>
              </td>
              <td class="py-3 px-3.5 text-slate-600">${escapeHtml(r.catatan || '-')}</td>
              <td class="py-3 px-3.5 text-center">${badge}</td>
              <td class="py-3 px-3.5">${infoSeri}</td>
            </tr>
          `;
        })
        .join('');

      reqMobile.innerHTML = myReqs
        .map((r) => `
          <div class="rounded-xl border border-slate-200 p-3.5 space-y-1.5 bg-white">
            <div class="flex items-center justify-between">
              <span class="font-bold text-slate-900 text-xs">${escapeHtml(r.jenisFasilitas)}</span>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${
                r.statusPermintaan === 'Disetujui'
                  ? 'bg-emerald-50 text-emerald-700'
                  : r.statusPermintaan === 'Ditolak'
                  ? 'bg-rose-50 text-rose-700'
                  : 'bg-amber-100 text-amber-800'
              }">${escapeHtml(r.statusPermintaan)}</span>
            </div>
            <p class="text-xs text-slate-600">${formatDateShort(r.tanggalPermintaan)} • <strong>${formatNumber(r.jumlahDiminta)} Lembar</strong></p>
            <p class="text-[11px] text-slate-500">Tugas: ${escapeHtml(r.catatan || '-')}</p>
            ${
              r.seriDiberikan
                ? `<p class="text-xs font-mono-seri font-bold text-blue-700">Seri: ${escapeHtml(r.seriDiberikan)}</p>`
                : ''
            }
          </div>
        `)
        .join('');
    }
  }
}

function populateUserReturBatchSelect(myDistsArg) {
  const selectEl = document.getElementById('user-retur-batch');
  if (!selectEl) return;

  const prevVal = selectEl.value;
  const myDists = Array.isArray(myDistsArg) ? myDistsArg : getMyDistributions();
  const returnableDists = myDists.filter(
    (d) => (Number(d.jumlahKeluar) || 0) - (Number(d.jumlahRetur) || 0) > 0 && d.statusSetoran !== 'Lunas Setor'
  );

  selectEl.innerHTML = '';

  if (returnableDists.length > 0) {
    const grpBatch = document.createElement('optgroup');
    grpBatch.label = 'Batch Karcis Diterima (Sesuai Nomor Seri)';
    returnableDists.forEach((d) => {
      const sisa = Math.max(0, (Number(d.jumlahKeluar) || 0) - (Number(d.jumlahRetur) || 0));
      const opt = document.createElement('option');
      opt.value = `dist:${d.id}`;
      opt.textContent = `${d.jenisFasilitas} • ${d.seriKeluar} (Tersisa ${formatNumber(sisa)} Lembar)`;
      grpBatch.appendChild(opt);
    });
    selectEl.appendChild(grpBatch);
  }

  if (state.facilities.length > 0) {
    const grpFac = document.createElement('optgroup');
    grpFac.label = 'Pengembalian Karcis Berdasarkan Jenis Fasilitas';
    state.facilities.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = `fac:${f.id}`;
      opt.textContent = `${f.namaFasilitas} (${formatRupiah(f.tarifSatuan)} / lembar)`;
      grpFac.appendChild(opt);
    });
    selectEl.appendChild(grpFac);
  }

  if (prevVal && Array.from(selectEl.options).some((o) => o.value === prevVal)) {
    selectEl.value = prevVal;
  }

  updateUserDirectReturPreview();
}

function updateUserDirectReturPreview() {
  const selectEl = document.getElementById('user-retur-batch');
  const jmlInput = document.getElementById('user-retur-jumlah-input');
  const summaryEl = document.getElementById('preview-user-retur-summary');
  if (!selectEl || !jmlInput || !summaryEl) return;

  const val = selectEl.value || '';
  const jml = Math.max(0, parseInt(jmlInput.value || '0', 10) || 0);

  if (val.startsWith('dist:')) {
    const distId = val.slice(5);
    const distObj = state.distributions.find((d) => d.id === distId);
    if (!distObj) {
      summaryEl.textContent = '';
      return;
    }
    const prevRetur = Number(distObj.jumlahRetur) || 0;
    const maxCanReturn = Math.max(0, (Number(distObj.jumlahKeluar) || 0) - prevRetur);
    jmlInput.max = String(maxCanReturn);

    if (jml <= 0) {
      summaryEl.innerHTML = `Sisa: <strong>${formatNumber(maxCanReturn)} Lembar</strong> (${escapeHtml(distObj.seriKeluar)})`;
      return;
    }
    const effectiveAdd = Math.min(maxCanReturn, jml);
    const calc = calculateReturBreakdown(distObj, prevRetur + effectiveAdd);
    const bdl = toBendelLembar(effectiveAdd);
    summaryEl.innerHTML = `Dikembalikan: <strong>${formatNumber(effectiveAdd)} Lembar</strong> (${bdl.shortFormatted}) • Terpakai: <strong>${formatNumber(calc.jumlahTerjual)} Lbr</strong> (${formatRupiah(calc.totalNominal)})`;
  } else if (val.startsWith('fac:')) {
    const facId = val.slice(4);
    const fac = state.facilities.find((f) => f.id === facId);
    jmlInput.removeAttribute('max');
    if (!fac || jml <= 0) {
      summaryEl.textContent = '';
      return;
    }
    const bdl = toBendelLembar(jml);
    summaryEl.innerHTML = `Dikembalikan: <strong>${formatNumber(jml)} Lembar</strong> (${bdl.shortFormatted}) — <strong>${escapeHtml(fac.namaFasilitas)}</strong>`;
  } else {
    summaryEl.textContent = '';
  }
}

async function handleUserDirectReturSubmit(e) {
  e.preventDefault();
  if (!state.currentUser) return;

  const selectEl = document.getElementById('user-retur-batch');
  const jmlInput = document.getElementById('user-retur-jumlah-input');
  const catatanInput = document.getElementById('user-retur-catatan-input');

  const val = selectEl?.value || '';
  const lembar = parseInt(jmlInput?.value || '0', 10);
  const catatan = (catatanInput?.value || '').trim();

  if (!val) {
    showToast('warning', 'Karcis Belum Dipilih', 'Pilih batch atau jenis karcis yang akan dikembalikan ke Admin.');
    return;
  }
  if (!Number.isInteger(lembar) || lembar <= 0) {
    showToast('warning', 'Jumlah Lembar Tidak Valid', 'Masukkan jumlah lembar karcis yang dikembalikan (minimal 1 lembar).');
    return;
  }

  const namaPetugas = state.currentUser.nama || state.currentUser.email || 'Petugas';
  const unitPetugas = state.currentUser.unitTugas || 'Petugas Lapangan';

  try {
    if (val.startsWith('dist:')) {
      const distId = val.slice(5);
      const distObj = state.distributions.find((d) => d.id === distId);
      if (!distObj) {
        showToast('error', 'Data Tidak Ditemukan', 'Batch distribusi karcis tidak ditemukan.');
        return;
      }

      const prevRetur = Number(distObj.jumlahRetur) || 0;
      const maxCanReturn = Math.max(0, (Number(distObj.jumlahKeluar) || 0) - prevRetur);
      if (lembar > maxCanReturn) {
        showToast(
          'warning',
          'Melebihi Sisa Karcis',
          `Jumlah pengembalian maksimal untuk batch ini adalah ${formatNumber(maxCanReturn)} lembar.`
        );
        return;
      }

      const newTotalRetur = prevRetur + lembar;
      const calc = calculateReturBreakdown(distObj, newTotalRetur);
      const parsed = parseSeriRange(distObj.seriKeluar);
      const thisReturnStart = parsed ? parsed.end - newTotalRetur + 1 : 1;
      const thisReturnEnd = parsed ? parsed.end - prevRetur : lembar;
      const kodeHuruf = calc.kodeHuruf || suggestKodeFromFacilityName(distObj.jenisFasilitas);
      const finalCatatan = catatan || distObj.catatan || `Pengembalian ${lembar} lembar oleh ${namaPetugas}`;

      if (state.mode === 'cloud') {
        await runTransaction(db, async (tx) => {
          const distRef = doc(db, COL_DISTRIBUSI, distObj.id);
          const distSnap = await tx.get(distRef);
          if (!distSnap.exists()) throw new Error('Data distribusi tidak ditemukan.');

          const parentRef = distObj.stockId ? doc(db, COL_STOCK, distObj.stockId) : null;
          const parentSnap = parentRef ? await tx.get(parentRef) : null;

          if (
            parentSnap &&
            parentSnap.exists() &&
            thisReturnEnd + 1 === Number(parentSnap.data().angkaSisaMulai)
          ) {
            const pData = parentSnap.data();
            tx.update(parentRef, {
              sisaStok: Number(pData.sisaStok) + lembar,
              angkaSisaMulai: thisReturnStart
            });
          } else {
            const newReturStockRef = doc(collection(db, COL_STOCK));
            tx.set(newReturStockRef, {
              tahun: String(state.tahun),
              facilityId: distObj.facilityId,
              jenisFasilitas: distObj.jenisFasilitas,
              tarifSatuan: Number(distObj.tarifSatuan) || 0,
              kodeHuruf,
              angkaMulai: thisReturnStart,
              angkaSampai: thisReturnEnd,
              totalAwal: lembar,
              sisaStok: lembar,
              angkaSisaMulai: thisReturnStart,
              isReturBatch: true,
              createdAt: serverTimestamp()
            });
          }

          tx.update(distRef, {
            jumlahTerjual: calc.jumlahTerjual,
            jumlahRetur: calc.jumlahRetur,
            totalNominal: calc.totalNominal,
            seriTerjual: calc.seriTerjual,
            seriRetur: calc.seriRetur,
            catatan: finalCatatan
          });
        });
      } else {
        const stocks = readLocalArray(LS_STOCK_KEY);
        const pIdx = stocks.findIndex((s) => s.id === distObj.stockId);
        if (pIdx !== -1 && thisReturnEnd + 1 === Number(stocks[pIdx].angkaSisaMulai)) {
          stocks[pIdx].sisaStok = Number(stocks[pIdx].sisaStok) + lembar;
          stocks[pIdx].angkaSisaMulai = thisReturnStart;
        } else {
          stocks.unshift({
            id: generateId('stk_ret'),
            tahun: String(state.tahun),
            facilityId: distObj.facilityId,
            jenisFasilitas: distObj.jenisFasilitas,
            tarifSatuan: Number(distObj.tarifSatuan) || 0,
            kodeHuruf,
            angkaMulai: thisReturnStart,
            angkaSampai: thisReturnEnd,
            totalAwal: lembar,
            sisaStok: lembar,
            angkaSisaMulai: thisReturnStart,
            isReturBatch: true,
            createdAt: new Date().toISOString()
          });
        }
        writeLocalArray(LS_STOCK_KEY, stocks);

        const dists = readLocalArray(LS_DISTRIBUSI_KEY);
        const dIdx = dists.findIndex((d) => d.id === distObj.id);
        if (dIdx !== -1) {
          dists[dIdx].jumlahTerjual = calc.jumlahTerjual;
          dists[dIdx].jumlahRetur = calc.jumlahRetur;
          dists[dIdx].totalNominal = calc.totalNominal;
          dists[dIdx].seriTerjual = calc.seriTerjual;
          dists[dIdx].seriRetur = calc.seriRetur;
          dists[dIdx].catatan = finalCatatan;
          writeLocalArray(LS_DISTRIBUSI_KEY, dists);
        }
        refreshLocalState();
      }

      await logActivity(
        'RETUR_SERI_KARCIS',
        `Petugas ${namaPetugas} mengembalikan ${formatNumber(lembar)} lembar karcis ${distObj.jenisFasilitas} (${formatSeriRange(kodeHuruf, thisReturnStart, thisReturnEnd)}) ke Admin.`
      );

      if (jmlInput) jmlInput.value = '';
      if (catatanInput) catatanInput.value = '';
      updateUserDirectReturPreview();

      showToast(
        'success',
        'Pengembalian Karcis Berhasil',
        `${formatNumber(lembar)} lembar karcis ${distObj.jenisFasilitas} berhasil dikembalikan ke Gudang Stok Admin.`
      );
      return;
    }

    if (val.startsWith('fac:')) {
      const facId = val.slice(4);
      const fac = state.facilities.find((f) => f.id === facId);
      if (!fac) {
        showToast('error', 'Fasilitas Tidak Ditemukan', 'Pilih jenis fasilitas karcis yang valid.');
        return;
      }

      const kodeHuruf = String(fac.kodeDefault || suggestKodeFromFacilityName(fac.namaFasilitas)).toUpperCase();
      const sameFacStocks = state.stocks.filter(
        (s) =>
          s.facilityId === fac.id ||
          normalizeFacilityKey(s.jenisFasilitas) === normalizeFacilityKey(fac.namaFasilitas)
      );
      const maxEnd = sameFacStocks.reduce((mx, s) => Math.max(mx, Number(s.angkaSampai) || 0), 0);
      const returnStart = maxEnd + 1;
      const returnEnd = returnStart + lembar - 1;
      const seriReturRange = formatSeriRange(kodeHuruf, returnStart, returnEnd);
      const penerimaStr = `${namaPetugas} (${unitPetugas})`;
      const finalCatatan = catatan || `Pengembalian langsung ${lembar} lembar oleh petugas ke Admin`;

      if (state.mode === 'cloud') {
        const batch = writeBatch(db);
        const newStockRef = doc(collection(db, COL_STOCK));
        batch.set(newStockRef, {
          tahun: String(state.tahun),
          facilityId: fac.id,
          jenisFasilitas: fac.namaFasilitas,
          tarifSatuan: Number(fac.tarifSatuan) || 0,
          kodeHuruf,
          angkaMulai: returnStart,
          angkaSampai: returnEnd,
          totalAwal: lembar,
          sisaStok: lembar,
          angkaSisaMulai: returnStart,
          isReturBatch: true,
          createdAt: serverTimestamp()
        });

        const newDistRef = doc(collection(db, COL_DISTRIBUSI));
        batch.set(newDistRef, {
          tahun: String(state.tahun),
          stockId: newStockRef.id,
          facilityId: fac.id,
          tanggal: getTodayISO(),
          jenisFasilitas: fac.namaFasilitas,
          tarifSatuan: Number(fac.tarifSatuan) || 0,
          penerima: penerimaStr,
          userUid: state.currentUser.uid || '',
          userEmail: state.currentUser.email || '',
          jumlahKeluar: lembar,
          jumlahTerjual: 0,
          jumlahRetur: lembar,
          totalNominal: 0,
          seriKeluar: seriReturRange,
          seriTerjual: 'Habis Diretur (0 Terjual)',
          seriRetur: seriReturRange,
          statusSetoran: 'Lunas Setor',
          catatan: finalCatatan,
          createdAt: serverTimestamp()
        });

        await batch.commit();
      } else {
        const newStockId = generateId('stk_ret');
        const stocks = readLocalArray(LS_STOCK_KEY);
        stocks.unshift({
          id: newStockId,
          tahun: String(state.tahun),
          facilityId: fac.id,
          jenisFasilitas: fac.namaFasilitas,
          tarifSatuan: Number(fac.tarifSatuan) || 0,
          kodeHuruf,
          angkaMulai: returnStart,
          angkaSampai: returnEnd,
          totalAwal: lembar,
          sisaStok: lembar,
          angkaSisaMulai: returnStart,
          isReturBatch: true,
          createdAt: new Date().toISOString()
        });
        writeLocalArray(LS_STOCK_KEY, stocks);

        const dists = readLocalArray(LS_DISTRIBUSI_KEY);
        dists.unshift({
          id: generateId('dist'),
          tahun: String(state.tahun),
          stockId: newStockId,
          facilityId: fac.id,
          tanggal: getTodayISO(),
          jenisFasilitas: fac.namaFasilitas,
          tarifSatuan: Number(fac.tarifSatuan) || 0,
          penerima: penerimaStr,
          userUid: state.currentUser.uid || '',
          userEmail: state.currentUser.email || '',
          jumlahKeluar: lembar,
          jumlahTerjual: 0,
          jumlahRetur: lembar,
          totalNominal: 0,
          seriKeluar: seriReturRange,
          seriTerjual: 'Habis Diretur (0 Terjual)',
          seriRetur: seriReturRange,
          statusSetoran: 'Lunas Setor',
          catatan: finalCatatan,
          createdAt: new Date().toISOString()
        });
        writeLocalArray(LS_DISTRIBUSI_KEY, dists);
        refreshLocalState();
      }

      await logActivity(
        'RETUR_SERI_KARCIS',
        `Petugas ${namaPetugas} mengembalikan langsung ${formatNumber(lembar)} lembar karcis ${fac.namaFasilitas} (${seriReturRange}) ke Admin.`
      );

      if (jmlInput) jmlInput.value = '';
      if (catatanInput) catatanInput.value = '';
      updateUserDirectReturPreview();

      showToast(
        'success',
        'Pengembalian Karcis Berhasil',
        `${formatNumber(lembar)} lembar karcis ${fac.namaFasilitas} (${seriReturRange}) telah masuk ke Gudang Stok Admin.`
      );
    }
  } catch (err) {
    console.error('Gagal memproses pengembalian karcis petugas:', err);
    showToast('error', 'Gagal Mengembalikan Karcis', err.message || 'Terjadi kesalahan saat menyimpan pengembalian.');
  }
}

async function handleUserRequestSubmit(e) {
  e.preventDefault();
  if (!state.currentUser) return;

  const tanggal = document.getElementById('req-tanggal')?.value || getTodayISO();
  const facilityId = document.getElementById('req-facility')?.value || '';
  const jumlah = parseInt(document.getElementById('req-jumlah')?.value || '0', 10);
  const catatan = (document.getElementById('req-catatan')?.value || '').trim();

  if (!facilityId) {
    showToast('warning', 'Fasilitas Belum Dipilih', 'Silakan pilih jenis fasilitas karcis yang ingin diajukan.');
    return;
  }
  if (!Number.isInteger(jumlah) || jumlah <= 0) {
    showToast('warning', 'Jumlah Tidak Valid', 'Masukkan jumlah lembar karcis yang diminta (minimal 1 lembar).');
    return;
  }
  if (!catatan) {
    showToast('warning', 'Keterangan Tugas Wajib Diisi', 'Tuliskan lokasi jaga atau shift tugas Anda.');
    return;
  }

  const fac = state.facilities.find((f) => f.id === facilityId);
  if (!fac) {
    showToast('error', 'Fasilitas Tidak Ditemukan', 'Pilih jenis fasilitas yang aktif.');
    return;
  }

  const payload = {
    tahun: String(state.tahun),
    tanggalPermintaan: tanggal,
    facilityId: fac.id,
    jenisFasilitas: fac.namaFasilitas,
    tarifSatuan: Number(fac.tarifSatuan) || 0,
    jumlahDiminta: jumlah,
    catatan,
    userUid: state.currentUser.uid,
    userEmail: state.currentUser.email,
    namaPemohon: state.currentUser.nama || state.currentUser.email,
    unitTugas: state.currentUser.unitTugas || 'Petugas Lapangan',
    statusPermintaan: 'Menunggu',
    seriDiberikan: '',
    alasanPenolakan: '',
    distribusiId: ''
  };

  try {
    if (state.mode === 'cloud') {
      await addDoc(collection(db, COL_REQUESTS), {
        ...payload,
        createdAt: serverTimestamp()
      });
    } else {
      const reqs = readLocalArray(LS_REQUESTS_KEY);
      reqs.unshift({
        id: generateId('req'),
        ...payload,
        createdAt: new Date().toISOString()
      });
      writeLocalArray(LS_REQUESTS_KEY, reqs);
      refreshLocalState();
    }

    await logActivity(
      'PENGAJUAN_KARCIS',
      `Petugas ${payload.namaPemohon} mengajukan permintaan ${formatNumber(jumlah)} lembar karcis ${fac.namaFasilitas}.`
    );

    const form = document.getElementById('form-user-request');
    if (form) form.reset();
    const dateInput = document.getElementById('req-tanggal');
    if (dateInput) dateInput.value = getTodayISO();
    updateUserRequestPreview();

    showToast(
      'success',
      'Permintaan Karcis Terkirim',
      `Pengajuan ${formatNumber(jumlah)} lembar karcis ${fac.namaFasilitas} sedang menunggu persetujuan Admin.`
    );
  } catch (err) {
    console.error('Gagal mengirim permintaan karcis:', err);
    showToast('error', 'Gagal Mengirim Permintaan', err.message || 'Terjadi kesalahan saat menyimpan pengajuan.');
  }
}

/* ==========================================================================
   12. VERIFIKASI PERMINTAAN KARCIS OLEH ADMIN (SETUJUI / TOLAK)
   ========================================================================== */

function renderAdminRequestsQueue() {
  const tbody = document.getElementById('admin-requests-table-body');
  const mobileCards = document.getElementById('admin-requests-mobile-cards');
  const pendingPill = document.getElementById('admin-req-pending-pill');

  const pendingCount = state.requests.filter((r) => r.statusPermintaan === 'Menunggu').length;
  if (pendingPill) {
    pendingPill.textContent = `${pendingCount} Menunggu`;
  }

  if (!tbody || !mobileCards) return;

  const statusFilter = state.filters.adminReq.status || 'ALL';
  const filtered = state.requests.filter((r) => {
    if (statusFilter !== 'ALL' && r.statusPermintaan !== statusFilter) return false;
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="py-8 text-center text-slate-400">
          Tidak ada antrean permintaan karcis dari petugas yang sesuai filter.
        </td>
      </tr>
    `;
    mobileCards.innerHTML = `<div class="py-6 text-center text-slate-400 text-xs">Tidak ada data permintaan karcis.</div>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((r) => {
      const bdl = toBendelLembar(r.jumlahDiminta);
      let badge = '';
      let actions = '';
      let infoCol = escapeHtml(r.catatan || '-');

      if (r.statusPermintaan === 'Menunggu') {
        badge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-amber-100 text-amber-800 border border-amber-300">Menunggu</span>';
        actions = `
          <div class="inline-flex items-center gap-1.5">
            <button type="button" data-req-approve="${escapeHtml(r.id)}" class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-2xs transition">
              Setujui &amp; Seri
            </button>
            <button type="button" data-req-reject="${escapeHtml(r.id)}" class="px-2.5 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold transition">
              Tolak
            </button>
          </div>
        `;
      } else if (r.statusPermintaan === 'Disetujui') {
        badge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Disetujui</span>';
        infoCol = `<span class="px-2 py-0.5 rounded-md bg-blue-50 text-blue-800 border border-blue-200 font-mono-seri font-semibold text-xs">${escapeHtml(r.seriDiberikan || '-')}</span>`;
        actions = `<span class="text-[11px] text-emerald-700 font-medium">Sudah diproses</span>`;
      } else {
        badge = '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-50 text-rose-700 border border-rose-200">Ditolak</span>';
        infoCol = `<span class="text-xs text-rose-600">${escapeHtml(r.alasanPenolakan || '-')}</span>`;
        actions = `<span class="text-[11px] text-slate-400">Ditolak</span>`;
      }

      return `
        <tr class="hover:bg-slate-50/80 transition">
          <td class="py-3 px-3.5 whitespace-nowrap font-medium text-slate-700">${formatDateShort(r.tanggalPermintaan)}</td>
          <td class="py-3 px-3.5">
            <p class="font-semibold text-slate-900">${escapeHtml(r.namaPemohon)}</p>
            <p class="text-[11px] text-slate-500">${escapeHtml(r.unitTugas || formatActorLabel(r.userEmail) || '')}</p>
          </td>
          <td class="py-3 px-3.5">
            <p class="font-medium text-slate-800">${escapeHtml(r.jenisFasilitas)}</p>
            <p class="text-[11px] text-slate-500">${formatRupiah(r.tarifSatuan)} / lbr</p>
          </td>
          <td class="py-3 px-3.5 tabular-nums">
            <span class="font-bold text-slate-900">${formatNumber(r.jumlahDiminta)} Lbr</span>
            <span class="block text-[11px] text-slate-500">${bdl.shortFormatted}</span>
          </td>
          <td class="py-3 px-3.5">${infoCol}</td>
          <td class="py-3 px-3.5 text-center">${badge}</td>
          <td class="py-3 px-3.5 text-right">${actions}</td>
        </tr>
      `;
    })
    .join('');

  mobileCards.innerHTML = filtered
    .map((r) => `
      <div class="rounded-xl border border-slate-200 p-4 space-y-2 bg-white">
        <div class="flex items-start justify-between">
          <div>
            <p class="font-semibold text-slate-900 text-sm">${escapeHtml(r.namaPemohon)}</p>
            <p class="text-xs text-slate-500">${escapeHtml(r.jenisFasilitas)} • <strong>${formatNumber(r.jumlahDiminta)} Lbr</strong></p>
          </div>
          <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold ${
            r.statusPermintaan === 'Disetujui'
              ? 'bg-emerald-50 text-emerald-700'
              : r.statusPermintaan === 'Ditolak'
              ? 'bg-rose-50 text-rose-700'
              : 'bg-amber-100 text-amber-800'
          }">${escapeHtml(r.statusPermintaan)}</span>
        </div>
        <p class="text-xs text-slate-600">Catatan: ${escapeHtml(r.catatan || '-')}</p>
        ${
          r.statusPermintaan === 'Menunggu'
            ? `<div class="pt-2 border-t border-slate-100 flex justify-end gap-2">
                <button type="button" data-req-approve="${escapeHtml(r.id)}" class="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold">Setujui</button>
                <button type="button" data-req-reject="${escapeHtml(r.id)}" class="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 text-xs font-semibold">Tolak</button>
              </div>`
            : ''
        }
      </div>
    `)
    .join('');
}

function openApproveRequestModal(reqId) {
  if (!requireAdmin('menyetujui permintaan karcis')) return;
  const reqObj = state.requests.find((r) => r.id === reqId);
  if (!reqObj) return;

  const modal = document.getElementById('modal-approve-request');
  const idInput = document.getElementById('approve-req-id');
  const pemohonEl = document.getElementById('approve-req-pemohon');
  const fasEl = document.getElementById('approve-req-fasilitas');
  const jmlEl = document.getElementById('approve-req-jumlah');
  const stockSelect = document.getElementById('approve-req-stock');

  if (!modal || !idInput || !stockSelect) return;

  idInput.value = reqObj.id;
  if (pemohonEl) pemohonEl.textContent = `${reqObj.namaPemohon} (${reqObj.unitTugas || formatActorLabel(reqObj.userEmail)})`;
  if (fasEl) fasEl.textContent = `${reqObj.jenisFasilitas} (${formatRupiah(reqObj.tarifSatuan)}/lbr)`;
  if (jmlEl) {
    const bdl = toBendelLembar(reqObj.jumlahDiminta);
    jmlEl.textContent = `${formatNumber(reqObj.jumlahDiminta)} Lembar (${bdl.shortFormatted})`;
  }

  // Cari batch stok yang tersedia untuk fasilitas ini
  const availableBatches = state.stocks
    .filter((s) => s.facilityId === reqObj.facilityId && Number(s.sisaStok) > 0)
    .sort((a, b) => Number(a.angkaSisaMulai) - Number(b.angkaSisaMulai));

  stockSelect.innerHTML = '';
  if (availableBatches.length === 0) {
    stockSelect.innerHTML = '<option value="">Stok kosong untuk fasilitas ini</option>';
  } else {
    availableBatches.forEach((b) => {
      const opt = document.createElement('option');
      opt.value = b.id;
      const startSeri = formatSingleSeri(b.kodeHuruf, b.angkaSisaMulai);
      const endSeri = formatSingleSeri(b.kodeHuruf, b.angkaSampai);
      const bTarif =
        b.tarifSatuan !== undefined && b.tarifSatuan !== null
          ? Number(b.tarifSatuan) || 0
          : Number(reqObj.tarifSatuan) || 0;
      opt.textContent = `${b.isReturBatch ? 'Retur • ' : ''}${startSeri} – ${endSeri} (Sisa ${formatNumber(b.sisaStok)} Lbr • ${formatRupiah(bTarif)}/lbr)`;
      stockSelect.appendChild(opt);
    });
  }

  updateApproveRequestModalPreview();
  modal.classList.remove('hidden');
}

function updateApproveRequestModalPreview() {
  const reqId = document.getElementById('approve-req-id')?.value || '';
  const stockId = document.getElementById('approve-req-stock')?.value || '';
  const reqObj = state.requests.find((r) => r.id === reqId);
  const batch = state.stocks.find((s) => s.id === stockId);

  const seriEl = document.getElementById('approve-req-preview-seri');
  const nomEl = document.getElementById('approve-req-preview-nominal');
  const warnEl = document.getElementById('approve-req-preview-warning');
  const submitBtn = document.getElementById('btn-submit-approve-req');

  if (!reqObj || !batch) {
    if (seriEl) seriEl.textContent = '—';
    if (nomEl) nomEl.textContent = 'Rp 0';
    if (warnEl) {
      warnEl.textContent = 'Stok gudang untuk fasilitas ini tidak tersedia. Silakan daftarkan batch stok terlebih dahulu.';
      warnEl.classList.remove('hidden');
    }
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  const jml = Number(reqObj.jumlahDiminta) || 0;
  const sisa = Number(batch.sisaStok) || 0;
  const startNum = Number(batch.angkaSisaMulai) || 1;
  const endNum = startNum + jml - 1;
  const seriRange = formatSeriRange(batch.kodeHuruf, startNum, endNum);
  const unitTarif =
    batch.tarifSatuan !== undefined && batch.tarifSatuan !== null
      ? Number(batch.tarifSatuan) || 0
      : Number(reqObj.tarifSatuan) || 0;
  const nominal = jml * unitTarif;

  if (seriEl) seriEl.textContent = seriRange;
  if (nomEl) nomEl.textContent = formatRupiah(nominal);

  if (jml > sisa) {
    if (warnEl) {
      warnEl.textContent = `Sisa batch ini (${formatNumber(sisa)} lembar) kurang dari jumlah yang diminta (${formatNumber(jml)} lembar).`;
      warnEl.classList.remove('hidden');
    }
    if (submitBtn) submitBtn.disabled = true;
  } else {
    if (warnEl) warnEl.classList.add('hidden');
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function handleApproveRequestSubmit(e) {
  e.preventDefault();
  if (!requireAdmin('menyetujui permintaan karcis')) return;

  const reqId = document.getElementById('approve-req-id')?.value || '';
  const stockId = document.getElementById('approve-req-stock')?.value || '';
  const reqObj = state.requests.find((r) => r.id === reqId);
  const batch = state.stocks.find((s) => s.id === stockId);

  if (!reqObj || !batch) return;

  const jml = Number(reqObj.jumlahDiminta) || 0;
  if (jml > Number(batch.sisaStok)) {
    showToast('error', 'Stok Tidak Mencukupi', 'Pilih batch stok lain yang memiliki sisa lembar mencukupi.');
    return;
  }

  const startNum = Number(batch.angkaSisaMulai);
  const endNum = startNum + jml - 1;
  const seriKeluar = formatSeriRange(batch.kodeHuruf, startNum, endNum);
  const tarif =
    batch.tarifSatuan !== undefined && batch.tarifSatuan !== null
      ? Number(batch.tarifSatuan) || 0
      : Number(reqObj.tarifSatuan) || 0;
  const totalNominal = jml * tarif;
  const penerimaStr = `${reqObj.namaPemohon}${reqObj.unitTugas ? ` (${reqObj.unitTugas})` : ''}`;

  try {
    if (state.mode === 'cloud') {
      await runTransaction(db, async (tx) => {
        const stockRef = doc(db, COL_STOCK, batch.id);
        const stockSnap = await tx.get(stockRef);
        if (!stockSnap.exists()) throw new Error('Batch stok tidak ditemukan.');
        const curStock = stockSnap.data();
        if (Number(curStock.sisaStok) < jml) {
          throw new Error('Sisa stok batch berubah dan tidak mencukupi.');
        }

        const sNum = Number(curStock.angkaSisaMulai);
        const eNum = sNum + jml - 1;
        const seriStr = formatSeriRange(curStock.kodeHuruf, sNum, eNum);

        tx.update(stockRef, {
          sisaStok: Number(curStock.sisaStok) - jml,
          angkaSisaMulai: eNum + 1
        });

        const distRef = doc(collection(db, COL_DISTRIBUSI));
        tx.set(distRef, {
          tahun: String(state.tahun),
          stockId: batch.id,
          facilityId: reqObj.facilityId,
          tanggal: reqObj.tanggalPermintaan || getTodayISO(),
          jenisFasilitas: reqObj.jenisFasilitas,
          tarifSatuan: tarif,
          penerima: penerimaStr,
          userUid: reqObj.userUid || '',
          userEmail: reqObj.userEmail || '',
          jumlahKeluar: jml,
          jumlahTerjual: jml,
          jumlahRetur: 0,
          totalNominal,
          seriKeluar: seriStr,
          seriTerjual: seriStr,
          seriRetur: '-',
          statusSetoran: 'Belum Setor',
          catatan: reqObj.catatan || 'Permintaan Petugas Disetujui Admin',
          createdAt: serverTimestamp()
        });

        const reqRef = doc(db, COL_REQUESTS, reqObj.id);
        tx.update(reqRef, {
          statusPermintaan: 'Disetujui',
          seriDiberikan: seriStr,
          distribusiId: distRef.id,
          approvedBy: state.currentUser.email,
          approvedAt: serverTimestamp()
        });
      });
    } else {
      // Local Mode Atomic Update
      const stocks = readLocalArray(LS_STOCK_KEY);
      const sIdx = stocks.findIndex((s) => s.id === batch.id);
      if (sIdx === -1 || Number(stocks[sIdx].sisaStok) < jml) {
        throw new Error('Stok batch tidak mencukupi.');
      }

      stocks[sIdx].sisaStok = Number(stocks[sIdx].sisaStok) - jml;
      stocks[sIdx].angkaSisaMulai = endNum + 1;
      writeLocalArray(LS_STOCK_KEY, stocks);

      const newDistId = generateId('dist');
      const dists = readLocalArray(LS_DISTRIBUSI_KEY);
      dists.unshift({
        id: newDistId,
        tahun: String(state.tahun),
        stockId: batch.id,
        facilityId: reqObj.facilityId,
        tanggal: reqObj.tanggalPermintaan || getTodayISO(),
        jenisFasilitas: reqObj.jenisFasilitas,
        tarifSatuan: tarif,
        penerima: penerimaStr,
        userUid: reqObj.userUid || '',
        userEmail: reqObj.userEmail || '',
        jumlahKeluar: jml,
        jumlahTerjual: jml,
        jumlahRetur: 0,
        totalNominal,
        seriKeluar,
        seriTerjual: seriKeluar,
        seriRetur: '-',
        statusSetoran: 'Belum Setor',
        catatan: reqObj.catatan || 'Permintaan Petugas Disetujui Admin',
        createdAt: new Date().toISOString()
      });
      writeLocalArray(LS_DISTRIBUSI_KEY, dists);

      const reqs = readLocalArray(LS_REQUESTS_KEY);
      const rIdx = reqs.findIndex((r) => r.id === reqObj.id);
      if (rIdx !== -1) {
        reqs[rIdx].statusPermintaan = 'Disetujui';
        reqs[rIdx].seriDiberikan = seriKeluar;
        reqs[rIdx].distribusiId = newDistId;
        reqs[rIdx].approvedBy = state.currentUser.email;
        reqs[rIdx].approvedAt = new Date().toISOString();
        writeLocalArray(LS_REQUESTS_KEY, reqs);
      }
      refreshLocalState();
    }

    await logActivity(
      'SETUJUI_PERMINTAAN',
      `Admin menyetujui permintaan ${reqObj.namaPemohon}: ${formatNumber(jml)} lembar ${reqObj.jenisFasilitas} (${seriKeluar}).`
    );

    document.getElementById('modal-approve-request')?.classList.add('hidden');
    showToast(
      'success',
      'Permintaan Disetujui & Seri Diterbitkan',
      `Seri ${seriKeluar} (${formatNumber(jml)} lembar) telah dialokasikan kepada ${reqObj.namaPemohon}.`
    );
  } catch (err) {
    console.error('Gagal menyetujui permintaan:', err);
    showToast('error', 'Gagal Menyetujui Permintaan', err.message || 'Terjadi kesalahan saat memproses persetujuan.');
  }
}

function openRejectRequestModal(reqId) {
  if (!requireAdmin('menolak permintaan karcis')) return;
  const reqObj = state.requests.find((r) => r.id === reqId);
  if (!reqObj) return;

  const modal = document.getElementById('modal-reject-request');
  const idInput = document.getElementById('reject-req-id');
  const reasonInput = document.getElementById('reject-req-reason');

  if (!modal || !idInput || !reasonInput) return;
  idInput.value = reqObj.id;
  reasonInput.value = '';
  modal.classList.remove('hidden');
}

async function handleRejectRequestSubmit(e) {
  e.preventDefault();
  if (!requireAdmin('menolak permintaan karcis')) return;

  const reqId = document.getElementById('reject-req-id')?.value || '';
  const reason = (document.getElementById('reject-req-reason')?.value || '').trim();
  const reqObj = state.requests.find((r) => r.id === reqId);

  if (!reqObj) return;
  if (!reason) {
    showToast('warning', 'Alasan Wajib Diisi', 'Masukkan alasan penolakan permintaan karcis.');
    return;
  }

  try {
    if (state.mode === 'cloud') {
      await updateDoc(doc(db, COL_REQUESTS, reqObj.id), {
        statusPermintaan: 'Ditolak',
        alasanPenolakan: reason,
        rejectedBy: state.currentUser.email,
        rejectedAt: serverTimestamp()
      });
    } else {
      const reqs = readLocalArray(LS_REQUESTS_KEY);
      const rIdx = reqs.findIndex((r) => r.id === reqObj.id);
      if (rIdx !== -1) {
        reqs[rIdx].statusPermintaan = 'Ditolak';
        reqs[rIdx].alasanPenolakan = reason;
        reqs[rIdx].rejectedBy = state.currentUser.email;
        reqs[rIdx].rejectedAt = new Date().toISOString();
        writeLocalArray(LS_REQUESTS_KEY, reqs);
      }
      refreshLocalState();
    }

    await logActivity(
      'TOLAK_PERMINTAAN',
      `Admin menolak permintaan karcis ${reqObj.namaPemohon} (${reqObj.jenisFasilitas}). Alasan: ${reason}`
    );

    document.getElementById('modal-reject-request')?.classList.add('hidden');
    showToast('warning', 'Permintaan Ditolak', `Permintaan karcis dari ${reqObj.namaPemohon} telah ditolak.`);
  } catch (err) {
    console.error('Gagal menolak permintaan:', err);
    showToast('error', 'Gagal Menolak Permintaan', err.message || 'Terjadi kesalahan.');
  }
}

/* ==========================================================================
   13. VIEW 2: DISTRIBUSI LANGSUNG ADMIN & REKONSILIASI / PENGEMBALIAN SISA SERI
   ========================================================================== */

function populateDistStockSelect() {
  const facSelect = document.getElementById('dist-facility');
  const stockSelect = document.getElementById('dist-stock');
  if (!facSelect || !stockSelect) return;

  const facilityId = facSelect.value;
  const prevStockId = stockSelect.value;

  if (!facilityId) {
    stockSelect.innerHTML = '<option value="">Pilih fasilitas dulu...</option>';
    renderDistribusiLivePreview();
    return;
  }

  const available = state.stocks
    .filter((s) => s.facilityId === facilityId && Number(s.sisaStok) > 0)
    .sort((a, b) => Number(a.angkaSisaMulai) - Number(b.angkaSisaMulai));

  if (available.length === 0) {
    stockSelect.innerHTML = '<option value="">Stok kosong untuk fasilitas ini</option>';
    renderDistribusiLivePreview();
    return;
  }

  const facSelected = state.facilities.find((f) => f.id === facilityId);
  stockSelect.innerHTML = '';
  available.forEach((b) => {
    const opt = document.createElement('option');
    opt.value = b.id;
    const sStart = formatSingleSeri(b.kodeHuruf, b.angkaSisaMulai);
    const sEnd = formatSingleSeri(b.kodeHuruf, b.angkaSampai);
    const bTarif =
      b.tarifSatuan !== undefined && b.tarifSatuan !== null
        ? Number(b.tarifSatuan) || 0
        : facSelected
          ? Number(facSelected.tarifSatuan) || 0
          : 0;
    opt.textContent = `${b.isReturBatch ? 'Retur • ' : ''}${sStart} – ${sEnd} (Sisa ${formatNumber(b.sisaStok)} Lbr • ${formatRupiah(bTarif)}/lbr)`;
    stockSelect.appendChild(opt);
  });

  if (prevStockId && available.some((s) => s.id === prevStockId)) {
    stockSelect.value = prevStockId;
  }

  renderDistribusiLivePreview();
}

function renderDistribusiLivePreview() {
  const facId = document.getElementById('dist-facility')?.value || '';
  const stockId = document.getElementById('dist-stock')?.value || '';
  const jumlah = parseInt(document.getElementById('dist-jumlah')?.value || '0', 10) || 0;

  const badgeEl = document.getElementById('preview-dist-badge');
  const seriEl = document.getElementById('preview-dist-seri');
  const bendelEl = document.getElementById('preview-dist-bendel');
  const tarifEl = document.getElementById('preview-dist-tarif');
  const nominalEl = document.getElementById('preview-dist-nominal');
  const warnEl = document.getElementById('preview-dist-warning');
  const sisaBatchEl = document.getElementById('preview-dist-sisabatch');
  const submitBtn = document.getElementById('btn-submit-distribusi');

  const fac = state.facilities.find((f) => f.id === facId);
  const stock = state.stocks.find((s) => s.id === stockId);
  const tarif =
    stock && stock.tarifSatuan !== undefined && stock.tarifSatuan !== null
      ? Number(stock.tarifSatuan) || 0
      : fac
        ? Number(fac.tarifSatuan) || 0
        : 0;

  if (tarifEl) tarifEl.textContent = formatRupiah(tarif);

  if (!stock || jumlah <= 0) {
    if (badgeEl) {
      badgeEl.textContent = 'Siap input';
      badgeEl.className = 'text-[11px] px-2.5 py-0.5 rounded-full bg-white text-slate-600 border border-slate-200 font-medium';
    }
    if (seriEl) seriEl.textContent = '—';
    if (bendelEl) bendelEl.textContent = '0 Bendel + 0 Lbr';
    if (nominalEl) nominalEl.textContent = 'Rp 0';
    if (warnEl) warnEl.classList.add('hidden');
    if (sisaBatchEl) sisaBatchEl.textContent = stock ? `${formatNumber(stock.sisaStok)} Lembar` : '—';
    if (submitBtn) submitBtn.disabled = false;
    return;
  }

  const sisa = Number(stock.sisaStok) || 0;
  const startNum = Number(stock.angkaSisaMulai) || 1;
  const endNum = startNum + jumlah - 1;
  const seriRange = formatSeriRange(stock.kodeHuruf, startNum, endNum);
  const bdl = toBendelLembar(jumlah);
  const nominal = jumlah * tarif;

  if (seriEl) seriEl.textContent = seriRange;
  if (bendelEl) bendelEl.textContent = bdl.shortFormatted;
  if (nominalEl) nominalEl.textContent = formatRupiah(nominal);

  if (jumlah > sisa) {
    if (badgeEl) {
      badgeEl.textContent = 'Stok kurang';
      badgeEl.className = 'text-[11px] px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200 font-medium';
    }
    if (warnEl) {
      warnEl.textContent = `Jumlah keluar (${formatNumber(jumlah)} lbr) melebihi sisa stok (${formatNumber(sisa)} lbr).`;
      warnEl.classList.remove('hidden');
    }
    if (sisaBatchEl) sisaBatchEl.textContent = 'Tidak Cukup';
    if (submitBtn) submitBtn.disabled = true;
  } else {
    if (badgeEl) {
      badgeEl.textContent = 'Siap simpan';
      badgeEl.className = 'text-[11px] px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 font-medium';
    }
    if (warnEl) warnEl.classList.add('hidden');
    const afterSisa = sisa - jumlah;
    const afterBdl = toBendelLembar(afterSisa);
    if (sisaBatchEl) sisaBatchEl.textContent = `${formatNumber(afterSisa)} Lbr (${afterBdl.shortFormatted})`;
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function handleDistribusiSubmit(e) {
  e.preventDefault();
  if (!requireAdmin('mengeluarkan distribusi karcis')) return;

  const tanggal = document.getElementById('dist-tanggal')?.value || getTodayISO();
  const penerima = (document.getElementById('dist-penerima')?.value || '').trim();
  const facilityId = document.getElementById('dist-facility')?.value || '';
  const stockId = document.getElementById('dist-stock')?.value || '';
  const jumlahKeluar = parseInt(document.getElementById('dist-jumlah')?.value || '0', 10);
  const statusSetoran = document.getElementById('dist-status')?.value || 'Belum Setor';
  const catatan = (document.getElementById('dist-catatan')?.value || '').trim();

  if (!penerima) {
    showToast('warning', 'Nama Petugas Wajib Diisi', 'Masukkan nama petugas penerima karcis.');
    return;
  }
  if (!facilityId || !stockId) {
    showToast('warning', 'Pilih Fasilitas & Batch Stok', 'Pilih jenis fasilitas dan batch stok gudang.');
    return;
  }
  if (!Number.isInteger(jumlahKeluar) || jumlahKeluar <= 0) {
    showToast('warning', 'Jumlah Keluar Tidak Valid', 'Masukkan jumlah lembar karcis minimal 1 lembar.');
    return;
  }

  const stock = state.stocks.find((s) => s.id === stockId);
  const fac = state.facilities.find((f) => f.id === facilityId);
  if (!stock) {
    showToast('error', 'Batch Stok Tidak Ditemukan', 'Pilih batch stok yang masih tersedia.');
    return;
  }
  if (jumlahKeluar > Number(stock.sisaStok)) {
    showToast('error', 'Stok Tidak Mencukupi', `Sisa batch hanya ${formatNumber(stock.sisaStok)} lembar.`);
    return;
  }

  const startNum = Number(stock.angkaSisaMulai);
  const endNum = startNum + jumlahKeluar - 1;
  const seriKeluar = formatSeriRange(stock.kodeHuruf, startNum, endNum);
  const tarifSatuan =
    stock.tarifSatuan !== undefined && stock.tarifSatuan !== null
      ? Number(stock.tarifSatuan) || 0
      : fac
        ? Number(fac.tarifSatuan) || 0
        : 0;
  const totalNominal = jumlahKeluar * tarifSatuan;

  // Cocokkan apakah nama penerima sesuai dengan salah satu akun user terdaftar
  const matchedUser = state.users.find(
    (u) =>
      String(u.nama || '').toLowerCase() === penerima.toLowerCase() ||
      penerima.toLowerCase().includes(String(u.nama || '').toLowerCase())
  );

  try {
    if (state.mode === 'cloud') {
      await runTransaction(db, async (tx) => {
        const stockRef = doc(db, COL_STOCK, stock.id);
        const snap = await tx.get(stockRef);
        if (!snap.exists()) throw new Error('Batch stok tidak ditemukan di database.');
        const sData = snap.data();
        if (Number(sData.sisaStok) < jumlahKeluar) {
          throw new Error('Sisa stok tidak mencukupi.');
        }

        const sStart = Number(sData.angkaSisaMulai);
        const sEnd = sStart + jumlahKeluar - 1;
        const seriStr = formatSeriRange(sData.kodeHuruf, sStart, sEnd);

        tx.update(stockRef, {
          sisaStok: Number(sData.sisaStok) - jumlahKeluar,
          angkaSisaMulai: sEnd + 1
        });

        const distRef = doc(collection(db, COL_DISTRIBUSI));
        tx.set(distRef, {
          tahun: String(state.tahun),
          stockId: stock.id,
          facilityId: stock.facilityId,
          tanggal,
          jenisFasilitas: fac ? fac.namaFasilitas : stock.jenisFasilitas,
          tarifSatuan,
          penerima,
          userUid: matchedUser ? matchedUser.uid || matchedUser.id : '',
          userEmail: matchedUser ? matchedUser.email : '',
          jumlahKeluar,
          jumlahTerjual: jumlahKeluar,
          jumlahRetur: 0,
          totalNominal,
          seriKeluar: seriStr,
          seriTerjual: seriStr,
          seriRetur: '-',
          statusSetoran,
          catatan,
          createdAt: serverTimestamp()
        });
      });
    } else {
      const stocks = readLocalArray(LS_STOCK_KEY);
      const sIdx = stocks.findIndex((s) => s.id === stock.id);
      if (sIdx === -1 || Number(stocks[sIdx].sisaStok) < jumlahKeluar) {
        throw new Error('Stok batch tidak mencukupi.');
      }
      stocks[sIdx].sisaStok = Number(stocks[sIdx].sisaStok) - jumlahKeluar;
      stocks[sIdx].angkaSisaMulai = endNum + 1;
      writeLocalArray(LS_STOCK_KEY, stocks);

      const dists = readLocalArray(LS_DISTRIBUSI_KEY);
      dists.unshift({
        id: generateId('dist'),
        tahun: String(state.tahun),
        stockId: stock.id,
        facilityId: stock.facilityId,
        tanggal,
        jenisFasilitas: fac ? fac.namaFasilitas : stock.jenisFasilitas,
        tarifSatuan,
        penerima,
        userUid: matchedUser ? matchedUser.uid || matchedUser.id : '',
        userEmail: matchedUser ? matchedUser.email : '',
        jumlahKeluar,
        jumlahTerjual: jumlahKeluar,
        jumlahRetur: 0,
        totalNominal,
        seriKeluar,
        seriTerjual: seriKeluar,
        seriRetur: '-',
        statusSetoran,
        catatan,
        createdAt: new Date().toISOString()
      });
      writeLocalArray(LS_DISTRIBUSI_KEY, dists);
      refreshLocalState();
    }

    await logActivity(
      'DISTRIBUSI_KARCIS',
      `Pengeluaran ${formatNumber(jumlahKeluar)} lembar ${fac ? fac.namaFasilitas : stock.jenisFasilitas} (${seriKeluar}) kepada ${penerima}.`
    );

    const form = document.getElementById('form-distribusi');
    if (form) form.reset();
    const dateInput = document.getElementById('dist-tanggal');
    if (dateInput) dateInput.value = getTodayISO();
    populateDistStockSelect();

    showToast(
      'success',
      'Karcis Berhasil Dikeluarkan',
      `Seri ${seriKeluar} (${formatNumber(jumlahKeluar)} lembar) telah diserahkan kepada ${penerima}.`
    );
  } catch (err) {
    console.error('Gagal menyimpan distribusi:', err);
    showToast('error', 'Gagal Mengeluarkan Karcis', err.message || 'Terjadi kesalahan saat menyimpan distribusi.');
  }
}

function renderDistribusiTable() {
  const tbody = document.getElementById('dist-table-body');
  const mobileCards = document.getElementById('dist-mobile-cards');
  const pageInfo = document.getElementById('dist-pagination-info');
  const pageControls = document.getElementById('dist-pagination-controls');

  if (!tbody || !mobileCards) return;

  const { search, facilityId, status, page, perPage } = state.filters.dist;
  const q = search.trim().toLowerCase();

  const filtered = state.distributions.filter((d) => {
    if (facilityId !== 'ALL' && d.facilityId !== facilityId) return false;
    if (status !== 'ALL' && d.statusSetoran !== status) return false;
    if (!q) return true;
    return (
      String(d.penerima || '').toLowerCase().includes(q) ||
      String(d.jenisFasilitas || '').toLowerCase().includes(q) ||
      String(d.seriKeluar || '').toLowerCase().includes(q) ||
      String(d.seriTerjual || '').toLowerCase().includes(q) ||
      String(d.seriRetur || '').toLowerCase().includes(q) ||
      String(d.catatan || '').toLowerCase().includes(q)
    );
  });

  const totalItems = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  state.filters.dist.page = currentPage;

  const startIdx = (currentPage - 1) * perPage;
  const pageItems = filtered.slice(startIdx, startIdx + perPage);

  if (pageInfo) {
    pageInfo.textContent =
      totalItems === 0
        ? 'Menampilkan 0 dari 0 transaksi'
        : `Menampilkan ${startIdx + 1}–${Math.min(startIdx + perPage, totalItems)} dari ${totalItems} transaksi`;
  }

  renderPaginationControls(pageControls, currentPage, totalPages, (newPage) => {
    state.filters.dist.page = newPage;
    renderDistribusiTable();
  });

  if (pageItems.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="py-10 text-center text-slate-400">Tidak ada riwayat distribusi karcis yang sesuai filter.</td>
      </tr>
    `;
    mobileCards.innerHTML = `<div class="py-8 text-center text-slate-400 text-xs">Tidak ada riwayat distribusi.</div>`;
    return;
  }

  tbody.innerHTML = pageItems
    .map((d) => {
      const bdlKeluar = toBendelLembar(d.jumlahKeluar);
      const isLunas = d.statusSetoran === 'Lunas Setor';
      const hasRetur = (Number(d.jumlahRetur) || 0) > 0;

      const statusBadge = isLunas
        ? '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Lunas Setor</span>'
        : '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">Belum Setor</span>';

      return `
        <tr class="hover:bg-slate-50/80 transition">
          <td class="py-3 px-3.5 whitespace-nowrap font-medium text-slate-700">${formatDateShort(d.tanggal)}</td>
          <td class="py-3 px-3.5">
            <p class="font-semibold text-slate-900">${escapeHtml(d.penerima)}</p>
            ${d.catatan ? `<p class="text-[11px] text-slate-500 truncate max-w-[200px]">${escapeHtml(d.catatan)}</p>` : ''}
          </td>
          <td class="py-3 px-3.5">
            <p class="font-medium text-slate-800">${escapeHtml(d.jenisFasilitas)}</p>
            <p class="text-[11px] text-slate-500">${formatRupiah(d.tarifSatuan)} / lbr</p>
          </td>
          <td class="py-3 px-3.5">
            <span class="px-2 py-0.5 rounded-md bg-blue-50 text-blue-800 border border-blue-200 font-mono-seri font-semibold text-xs">${escapeHtml(d.seriKeluar)}</span>
            <p class="text-[11px] text-slate-500 mt-0.5">${formatNumber(d.jumlahKeluar)} Lbr (${bdlKeluar.shortFormatted})</p>
          </td>
          <td class="py-3 px-3.5">
            <p class="text-xs font-mono-seri text-emerald-700 font-medium">Pakai: ${escapeHtml(d.seriTerjual)} (${formatNumber(d.jumlahTerjual)})</p>
            <p class="text-[11px] font-mono-seri ${hasRetur ? 'text-amber-700 font-medium' : 'text-slate-400'}">Retur: ${escapeHtml(d.seriRetur || '-')} (${formatNumber(d.jumlahRetur || 0)})</p>
          </td>
          <td class="py-3 px-3.5 text-right font-bold text-emerald-700 tabular-nums">${formatRupiah(d.totalNominal)}</td>
          <td class="py-3 px-3.5 text-center">${statusBadge}</td>
          <td class="py-3 px-3.5 text-right whitespace-nowrap">
            <div class="inline-flex items-center gap-1.5">
              <button type="button" data-open-retur="${escapeHtml(d.id)}" class="px-3 py-1.5 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 text-xs font-semibold transition">
                Retur / Setor
              </button>
              <button type="button" data-delete-dist="${escapeHtml(d.id)}" title="Hapus Transaksi" class="p-1.5 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  mobileCards.innerHTML = pageItems
    .map((d) => `
      <div class="rounded-xl border border-slate-200 p-4 space-y-2.5 bg-white">
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="font-semibold text-slate-900 text-sm">${escapeHtml(d.penerima)}</p>
            <p class="text-xs text-slate-500">${formatDateShort(d.tanggal)} • ${escapeHtml(d.jenisFasilitas)}</p>
          </div>
          <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold ${
            d.statusSetoran === 'Lunas Setor'
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : 'bg-amber-50 text-amber-800 border border-amber-200'
          }">${escapeHtml(d.statusSetoran)}</span>
        </div>
        <div class="rounded-lg bg-slate-50 p-2.5 text-xs font-mono-seri space-y-1">
          <p>Keluar: <strong class="text-blue-700">${escapeHtml(d.seriKeluar)}</strong> (${formatNumber(d.jumlahKeluar)} Lbr)</p>
          <p>Terpakai: <strong class="text-emerald-700">${escapeHtml(d.seriTerjual)}</strong> (${formatNumber(d.jumlahTerjual)} Lbr)</p>
          <p>Retur: <strong class="text-amber-700">${escapeHtml(d.seriRetur || '-')}</strong> (${formatNumber(d.jumlahRetur || 0)} Lbr)</p>
        </div>
        <div class="flex items-center justify-between pt-2 border-t border-slate-100">
          <span class="font-bold text-emerald-700 text-sm">${formatRupiah(d.totalNominal)}</span>
          <div class="flex items-center gap-1.5">
            <button type="button" data-open-retur="${escapeHtml(d.id)}" class="px-3 py-1.5 rounded-lg bg-blue-700 text-white text-xs font-semibold">Retur / Setor</button>
            <button type="button" data-delete-dist="${escapeHtml(d.id)}" class="px-2.5 py-1.5 rounded-lg bg-rose-50 text-rose-700 text-xs font-semibold">Hapus</button>
          </div>
        </div>
      </div>
    `)
    .join('');
}

async function handleDeleteDistribusi(distId) {
  if (!requireAdmin('menghapus riwayat distribusi')) return;
  const distObj = state.distributions.find((d) => d.id === distId);
  if (!distObj) return;

  const confirmed = await showConfirmModal({
    title: 'Hapus Transaksi Distribusi Ini?',
    message: `Transaksi distribusi "${distObj.seriKeluar}" atas nama ${distObj.penerima} (${formatRupiah(distObj.totalNominal)}) akan dihapus dari log distribusi.`,
    confirmText: 'Ya, Hapus Transaksi',
    variant: 'danger'
  });
  if (!confirmed) return;

  try {
    if (state.mode === 'cloud') {
      await deleteDoc(doc(db, COL_DISTRIBUSI, distId));
    } else {
      const dists = readLocalArray(LS_DISTRIBUSI_KEY).filter((d) => d.id !== distId);
      writeLocalArray(LS_DISTRIBUSI_KEY, dists);
      refreshLocalState();
    }

    await logActivity(
      'HAPUS_DISTRIBUSI',
      `Admin menghapus transaksi distribusi ${distObj.seriKeluar} (${distObj.penerima}).`
    );
    showToast('info', 'Transaksi Dihapus', `Data distribusi ${distObj.seriKeluar} telah dihapus.`);
  } catch (err) {
    console.error('Gagal menghapus distribusi:', err);
    showToast('error', 'Gagal Menghapus', err.message || 'Terjadi kesalahan.');
  }
}

/* ==========================================================================
   14. MODAL REKONSILIASI & PENGEMBALIAN SISA NOMOR SERI (ADMIN & USER)
   ========================================================================== */

function openReturModal(distId) {
  const distObj = state.distributions.find((d) => d.id === distId);
  if (!distObj) return;

  const isAdmin = state.currentUser?.role === 'admin';
  const modal = document.getElementById('modal-retur');
  const titleEl = document.getElementById('modal-retur-title');
  const idInput = document.getElementById('retur-dist-id');
  const infoPenerima = document.getElementById('retur-info-penerima');
  const infoFasilitas = document.getElementById('retur-info-fasilitas');
  const infoSeriKeluar = document.getElementById('retur-info-serikeluar');
  const infoJmlKeluar = document.getElementById('retur-info-jmlkeluar');
  const bannerProcessed = document.getElementById('retur-already-processed-banner');
  const jmlInput = document.getElementById('retur-jumlah');
  const statusSelect = document.getElementById('retur-status');
  const statusWrapper = document.getElementById('retur-status-wrapper');
  const catatanInput = document.getElementById('retur-catatan');
  const submitBtn = document.getElementById('btn-submit-retur');

  if (!modal || !idInput || !jmlInput || !statusSelect) return;

  idInput.value = distObj.id;
  if (titleEl) {
    titleEl.textContent = isAdmin
      ? 'Rekonsiliasi Setoran & Pengembalian Sisa Seri (Admin)'
      : 'Pengembalian Sisa Karcis Sesuai Nomor Seri (Petugas)';
  }
  if (infoPenerima) infoPenerima.textContent = distObj.penerima;
  if (infoFasilitas) infoFasilitas.textContent = `${distObj.jenisFasilitas} (${formatRupiah(distObj.tarifSatuan)} / lbr)`;
  if (infoSeriKeluar) infoSeriKeluar.textContent = distObj.seriKeluar;
  if (infoJmlKeluar) infoJmlKeluar.textContent = `${formatNumber(distObj.jumlahKeluar)} Lembar`;

  const prevRetur = Number(distObj.jumlahRetur) || 0;
  const fullyReturned = prevRetur >= (Number(distObj.jumlahKeluar) || 0);
  const isLockedForPetugas = !isAdmin && (fullyReturned || distObj.statusSetoran === 'Lunas Setor');

  jmlInput.min = String(prevRetur);
  jmlInput.max = String(distObj.jumlahKeluar);
  jmlInput.value = String(prevRetur);
  jmlInput.disabled = isLockedForPetugas;

  if (bannerProcessed) {
    if (prevRetur > 0) bannerProcessed.classList.remove('hidden');
    else bannerProcessed.classList.add('hidden');
  }

  statusSelect.value = distObj.statusSetoran || 'Belum Setor';
  // User biasa tidak dapat mengubah status Lunas Setor sendiri (hanya Admin)
  if (!isAdmin) {
    statusSelect.disabled = true;
    if (statusWrapper) statusWrapper.classList.add('opacity-70');
  } else {
    statusSelect.disabled = false;
    if (statusWrapper) statusWrapper.classList.remove('opacity-70');
  }

  if (catatanInput) catatanInput.value = distObj.catatan || '';

  // Jika user biasa membuka transaksi yang sudah lunas atau habis diretur, kunci tombol submit
  if (submitBtn) {
    if (isLockedForPetugas) {
      submitBtn.classList.add('hidden');
    } else {
      submitBtn.classList.remove('hidden');
    }
  }

  updateReturModalPreview();
  modal.classList.remove('hidden');
}

export function calculateReturBreakdown(distObj, jumlahReturInput) {
  const jumlahKeluar = Number(distObj.jumlahKeluar) || 0;
  const jumlahRetur = Math.max(0, Math.min(jumlahKeluar, Math.floor(Number(jumlahReturInput) || 0)));
  const jumlahTerjual = jumlahKeluar - jumlahRetur;
  const tarif = Number(distObj.tarifSatuan) || 0;
  const totalNominal = jumlahTerjual * tarif;

  const parsed = parseSeriRange(distObj.seriKeluar);
  if (!parsed) {
    return {
      jumlahKeluar,
      jumlahRetur,
      jumlahTerjual,
      totalNominal,
      seriTerjual: jumlahTerjual > 0 ? distObj.seriKeluar : 'Habis Diretur (0 Terjual)',
      seriRetur: jumlahRetur > 0 ? `${jumlahRetur} Lembar` : '-',
      returnStart: null,
      returnEnd: null,
      kodeHuruf: ''
    };
  }

  const { kodeHuruf, start, end } = parsed;
  let seriTerjual = 'Habis Diretur (0 Terjual)';
  if (jumlahTerjual > 0) {
    const soldEnd = start + jumlahTerjual - 1;
    seriTerjual = formatSeriRange(kodeHuruf, start, soldEnd);
  }

  let seriRetur = '-';
  let returnStart = null;
  let returnEnd = null;
  if (jumlahRetur > 0) {
    returnStart = end - jumlahRetur + 1;
    returnEnd = end;
    seriRetur = formatSeriRange(kodeHuruf, returnStart, returnEnd);
  }

  return {
    jumlahKeluar,
    jumlahRetur,
    jumlahTerjual,
    totalNominal,
    seriTerjual,
    seriRetur,
    returnStart,
    returnEnd,
    kodeHuruf
  };
}

function updateReturModalPreview() {
  const distId = document.getElementById('retur-dist-id')?.value || '';
  const distObj = state.distributions.find((d) => d.id === distId);
  if (!distObj) return;

  const jmlReturRaw = parseInt(document.getElementById('retur-jumlah')?.value || '0', 10) || 0;
  const calc = calculateReturBreakdown(distObj, jmlReturRaw);

  const elTerjualJml = document.getElementById('retur-preview-terjual-jml');
  const elTerjualSeri = document.getElementById('retur-preview-terjual-seri');
  const elReturJml = document.getElementById('retur-preview-retur-jml');
  const elReturSeri = document.getElementById('retur-preview-retur-seri');
  const elNominal = document.getElementById('retur-preview-nominal');
  const elMech = document.getElementById('retur-preview-mechanism');

  if (elTerjualJml) elTerjualJml.textContent = `${formatNumber(calc.jumlahTerjual)} Lembar`;
  if (elTerjualSeri) elTerjualSeri.textContent = calc.seriTerjual;
  if (elReturJml) elReturJml.textContent = `${formatNumber(calc.jumlahRetur)} Lembar`;
  if (elReturSeri) elReturSeri.textContent = calc.seriRetur;
  if (elNominal) elNominal.textContent = formatRupiah(calc.totalNominal);

  if (elMech) {
    const alreadyReturned = (Number(distObj.jumlahRetur) || 0) > 0;
    if (alreadyReturned) {
      elMech.innerHTML = `<span class="text-amber-700 font-semibold">Info:</span> Sisa nomor seri (${escapeHtml(distObj.seriRetur)}) sudah dikembalikan ke stok.`;
    } else if (calc.jumlahRetur === 0) {
      elMech.innerHTML = `Semua nomor seri (<strong>${escapeHtml(distObj.seriKeluar)}</strong>) tercatat terpakai tanpa sisa.`;
    } else {
      const parentStock = state.stocks.find((s) => s.id === distObj.stockId);
      const canRollbackParent =
        parentStock &&
        calc.returnEnd !== null &&
        calc.returnEnd + 1 === Number(parentStock.angkaSisaMulai);

      if (canRollbackParent) {
        elMech.innerHTML = `<span class="text-emerald-700 font-semibold">Otomatis ke stok asal:</span> Sisa seri <strong>${escapeHtml(calc.seriRetur)}</strong> (+${formatNumber(calc.jumlahRetur)} Lbr) kembali ke batch asal.`;
      } else {
        elMech.innerHTML = `<span class="text-amber-700 font-semibold">Disimpan terpisah:</span> Sisa seri <strong>${escapeHtml(calc.seriRetur)}</strong> (+${formatNumber(calc.jumlahRetur)} Lbr) masuk ke stok retur.`;
      }
    }
  }
}

async function handleReturSubmit(e) {
  e.preventDefault();
  const distId = document.getElementById('retur-dist-id')?.value || '';
  const distObj = state.distributions.find((d) => d.id === distId);
  if (!distObj) return;

  const isAdmin = state.currentUser?.role === 'admin';
  const prevRetur = Number(distObj.jumlahRetur) || 0;
  const rawRetur = parseInt(document.getElementById('retur-jumlah')?.value || '0', 10);

  if (isNaN(rawRetur) || rawRetur < prevRetur || rawRetur > Number(distObj.jumlahKeluar)) {
    showToast(
      'warning',
      'Jumlah Retur Tidak Valid',
      `Jumlah sisa karcis harus antara ${formatNumber(prevRetur)} hingga ${formatNumber(distObj.jumlahKeluar)} lembar.`
    );
    return;
  }

  const effectiveRetur = rawRetur;
  const deltaRetur = Math.max(0, effectiveRetur - prevRetur);
  const calc = calculateReturBreakdown(distObj, effectiveRetur);
  const parsed = parseSeriRange(distObj.seriKeluar);
  const deltaStart = parsed ? parsed.end - effectiveRetur + 1 : calc.returnStart;
  const deltaEnd = parsed ? parsed.end - prevRetur : calc.returnEnd;
  const newStatus = isAdmin
    ? document.getElementById('retur-status')?.value || distObj.statusSetoran
    : distObj.statusSetoran;
  const newCatatan = (document.getElementById('retur-catatan')?.value || '').trim();

  try {
    let returnMechanismNote = '';

    if (state.mode === 'cloud') {
      await runTransaction(db, async (tx) => {
        const distRef = doc(db, COL_DISTRIBUSI, distObj.id);
        const distSnap = await tx.get(distRef);
        if (!distSnap.exists()) throw new Error('Data distribusi tidak ditemukan.');

        if (deltaRetur > 0 && deltaStart !== null) {
          const parentRef = distObj.stockId ? doc(db, COL_STOCK, distObj.stockId) : null;
          const parentSnap = parentRef ? await tx.get(parentRef) : null;

          if (
            parentSnap &&
            parentSnap.exists() &&
            deltaEnd + 1 === Number(parentSnap.data().angkaSisaMulai)
          ) {
            const pData = parentSnap.data();
            tx.update(parentRef, {
              sisaStok: Number(pData.sisaStok) + deltaRetur,
              angkaSisaMulai: deltaStart
            });
            returnMechanismNote = 'Rollback ke Batch Induk';
          } else {
            const newReturStockRef = doc(collection(db, COL_STOCK));
            tx.set(newReturStockRef, {
              tahun: String(state.tahun),
              facilityId: distObj.facilityId,
              jenisFasilitas: distObj.jenisFasilitas,
              tarifSatuan: Number(distObj.tarifSatuan) || 0,
              kodeHuruf: calc.kodeHuruf || 'RET',
              angkaMulai: deltaStart,
              angkaSampai: deltaEnd,
              totalAwal: deltaRetur,
              sisaStok: deltaRetur,
              angkaSisaMulai: deltaStart,
              isReturBatch: true,
              createdAt: serverTimestamp()
            });
            returnMechanismNote = 'Batch Retur Baru (isReturBatch: true)';
          }
        }

        tx.update(distRef, {
          jumlahTerjual: calc.jumlahTerjual,
          jumlahRetur: calc.jumlahRetur,
          totalNominal: calc.totalNominal,
          seriTerjual: calc.seriTerjual,
          seriRetur: calc.seriRetur,
          statusSetoran: newStatus,
          catatan: newCatatan
        });
      });
    } else {
      // Local Mode Atomic Update
      const stocks = readLocalArray(LS_STOCK_KEY);
      if (deltaRetur > 0 && deltaStart !== null) {
        const pIdx = stocks.findIndex((s) => s.id === distObj.stockId);
        if (pIdx !== -1 && deltaEnd + 1 === Number(stocks[pIdx].angkaSisaMulai)) {
          stocks[pIdx].sisaStok = Number(stocks[pIdx].sisaStok) + deltaRetur;
          stocks[pIdx].angkaSisaMulai = deltaStart;
          returnMechanismNote = 'Rollback ke Batch Induk';
        } else {
          stocks.unshift({
            id: generateId('stk_ret'),
            tahun: String(state.tahun),
            facilityId: distObj.facilityId,
            jenisFasilitas: distObj.jenisFasilitas,
            tarifSatuan: Number(distObj.tarifSatuan) || 0,
            kodeHuruf: calc.kodeHuruf || 'RET',
            angkaMulai: deltaStart,
            angkaSampai: deltaEnd,
            totalAwal: deltaRetur,
            sisaStok: deltaRetur,
            angkaSisaMulai: deltaStart,
            isReturBatch: true,
            createdAt: new Date().toISOString()
          });
          returnMechanismNote = 'Batch Retur Baru (isReturBatch: true)';
        }
        writeLocalArray(LS_STOCK_KEY, stocks);
      }

      const dists = readLocalArray(LS_DISTRIBUSI_KEY);
      const dIdx = dists.findIndex((d) => d.id === distObj.id);
      if (dIdx !== -1) {
        dists[dIdx].jumlahTerjual = calc.jumlahTerjual;
        dists[dIdx].jumlahRetur = calc.jumlahRetur;
        dists[dIdx].totalNominal = calc.totalNominal;
        dists[dIdx].seriTerjual = calc.seriTerjual;
        dists[dIdx].seriRetur = calc.seriRetur;
        dists[dIdx].statusSetoran = newStatus;
        dists[dIdx].catatan = newCatatan;
        writeLocalArray(LS_DISTRIBUSI_KEY, dists);
      }
      refreshLocalState();
    }

    await logActivity(
      'RETUR_REKONSILIASI',
      `${isAdmin ? 'Admin' : 'Petugas'} memproses penyelesaian ${distObj.penerima}: Terpakai ${calc.jumlahTerjual} lbr (${calc.seriTerjual}), Retur ${calc.jumlahRetur} lbr (${calc.seriRetur}) [${newStatus}].`
    );

    document.getElementById('modal-retur')?.classList.add('hidden');
    showToast(
      'success',
      'Pengembalian Seri Berhasil Disimpan',
      calc.jumlahRetur > 0
        ? `Sisa ${formatNumber(calc.jumlahRetur)} lembar (${calc.seriRetur}) telah dikembalikan ke gudang stok (${returnMechanismNote || 'Tersimpan'}).`
        : `Data penggunaan nomor seri (${calc.seriTerjual}) berhasil diperbarui.`
    );
  } catch (err) {
    console.error('Gagal menyimpan retur:', err);
    showToast('error', 'Gagal Menyimpan Retur', err.message || 'Terjadi kesalahan saat memproses retur.');
  }
}

/* ==========================================================================
   15. VIEW 3: GUDANG STOK & VALIDASI ANTI-OVERLAP NOMOR SERI (ADMIN)
   ========================================================================== */

export function findOverlappingStockBatch(stocksList, facilityId, kodeHuruf, startNum, endNum, facilityName = '') {
  const code = String(kodeHuruf || '').trim().toUpperCase();
  const s = Number(startNum);
  const e = Number(endNum);
  const targetFacName = String(facilityName || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if ((!facilityId && !targetFacName) || !code || isNaN(s) || isNaN(e) || e < s) return null;

  const facNameById =
    typeof state !== 'undefined' && Array.isArray(state.facilities)
      ? new Map(
          state.facilities.map((f) => [
            f.id,
            String(f.namaFasilitas || '').trim().replace(/\s+/g, ' ').toLowerCase()
          ])
        )
      : null;

  return (
    stocksList.find((batch) => {
      if (batch.isReturBatch) return false;
      if (String(batch.kodeHuruf || '').trim().toUpperCase() !== code) return false;

      const sameId = Boolean(facilityId) && batch.facilityId === facilityId;
      const batchFacName = String(
        (facNameById && facNameById.get(batch.facilityId)) || batch.jenisFasilitas || ''
      )
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
      const sameName = Boolean(targetFacName) && batchFacName === targetFacName;
      if (!sameId && !sameName) return false;

      const bStart = Number(batch.angkaMulai);
      const bEnd = Number(batch.angkaSampai);
      return Math.max(s, bStart) <= Math.min(e, bEnd);
    }) || null
  );
}

function getRegisteredStockSummaries() {
  const facById = new Map(state.facilities.map((f) => [f.id, f]));
  const boardMap = new Map();

  // Papan informasi dipisahkan jika nama fasilitas, kode seri, atau tarifnya berbeda
  state.stocks.forEach((stk) => {
    const linkedFac = facById.get(stk.facilityId) || null;
    const displayName = String(linkedFac?.namaFasilitas || stk.jenisFasilitas || '').trim();
    const nameKey = normalizeFacilityName(displayName);
    if (!nameKey) return;

    const kodeSeri = normalizeKodeSeri(stk.kodeHuruf || linkedFac?.kodeDefault || '') || 'KRC';
    const matchedFac =
      linkedFac ||
      findFacilityByNameAndKode(displayName, kodeSeri) ||
      findFacilityByName(displayName) ||
      null;

    const resolvedTarif =
      stk.tarifSatuan !== undefined && stk.tarifSatuan !== null
        ? Math.max(0, Number(stk.tarifSatuan) || 0)
        : Math.max(0, Number(linkedFac?.tarifSatuan ?? matchedFac?.tarifSatuan ?? 0) || 0);

    const groupKey = `${nameKey}__${kodeSeri}__${resolvedTarif}`;
    const existing = boardMap.get(groupKey);
    const stkSisa = Number(stk.sisaStok) || 0;
    const stkSisaMulai = Number(stk.angkaSisaMulai) || 0;
    const stkSampai = Number(stk.angkaSampai) || 0;

    if (existing) {
      existing.sisa += stkSisa;
      existing.totalAwal += Number(stk.totalAwal) || 0;
      existing.batchCount += 1;
      if (stkSisa > 0 && stkSisaMulai > 0 && stkSampai >= stkSisaMulai) {
        existing.minSisaMulai =
          existing.minSisaMulai > 0 ? Math.min(existing.minSisaMulai, stkSisaMulai) : stkSisaMulai;
        existing.maxSampai = Math.max(existing.maxSampai, stkSampai);
      }
    } else {
      boardMap.set(groupKey, {
        key: groupKey,
        namaFasilitas: matchedFac?.namaFasilitas || displayName,
        kodeDefault: kodeSeri,
        tarifSatuan: resolvedTarif,
        sisa: stkSisa,
        totalAwal: Number(stk.totalAwal) || 0,
        batchCount: 1,
        minSisaMulai: stkSisa > 0 && stkSisaMulai > 0 && stkSampai >= stkSisaMulai ? stkSisaMulai : 0,
        maxSampai: stkSisa > 0 && stkSisaMulai > 0 && stkSampai >= stkSisaMulai ? stkSampai : 0
      });
    }
  });

  return Array.from(boardMap.values())
    .map((item) => ({
      ...item,
      isEmpty: item.sisa === 0,
      isLow: item.sisa < STOCK_LOW_THRESHOLD_LEMBAR
    }))
    .sort((a, b) => {
      const cmpName = String(a.namaFasilitas || '').localeCompare(String(b.namaFasilitas || ''), 'id');
      if (cmpName !== 0) return cmpName;
      const cmpKode = String(a.kodeDefault || '').localeCompare(String(b.kodeDefault || ''), 'id');
      if (cmpKode !== 0) return cmpKode;
      return (a.tarifSatuan || 0) - (b.tarifSatuan || 0);
    });
}

function prefillStockForm({ namaFasilitas, kodeHuruf, tarifSatuan }) {
  const nameInp = document.getElementById('stok-facility-name');
  const tarifInp = document.getElementById('stok-tarif');
  const kodeInp = document.getElementById('stok-kode');
  const formEl = document.getElementById('form-stok');
  if (!nameInp || !tarifInp || !kodeInp) return;

  resetStokFormHelperState();
  nameInp.value = namaFasilitas || '';
  kodeInp.value = normalizeKodeSeri(kodeHuruf || '');
  tarifInp.value =
    tarifSatuan !== undefined && tarifSatuan !== null ? String(Math.max(0, Number(tarifSatuan) || 0)) : '';

  if (kodeInp.value) kodeInp.dataset.manualEdited = 'true';
  if (tarifInp.value !== '') tarifInp.dataset.manualEdited = 'true';

  switchView('stok');
  handleStokFacilityNameChange({ forceSuggest: true });

  const mulaiInp = document.getElementById('stok-mulai');
  if (mulaiInp && !mulaiInp.value) {
    suggestNextStockSerial();
  }
  if (tarifSatuan !== undefined && tarifSatuan !== null) {
    tarifInp.value = String(Math.max(0, Number(tarifSatuan) || 0));
    tarifInp.dataset.manualEdited = 'true';
    renderStokSummaryAndPreview();
  }
  if (formEl) {
    formEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderStokSummaryAndPreview() {
  const boardItems = getRegisteredStockSummaries();
  const lowItems = boardItems.filter((item) => item.isLow);

  const warningPanel = document.getElementById('stok-low-warning-panel');
  if (warningPanel) {
    if (lowItems.length === 0) {
      warningPanel.className = 'hidden';
      warningPanel.innerHTML = '';
    } else {
      const hasEmpty = lowItems.some((item) => item.isEmpty);
      warningPanel.className = `rounded-2xl border ${
        hasEmpty ? 'border-rose-200 bg-rose-50/80' : 'border-amber-300 bg-amber-50/80'
      } p-4 sm:p-5 space-y-3`;

      const itemsHtml = lowItems
        .map((item) => {
          const bdl = toBendelLembar(item.sisa);
          const pillClass = item.isEmpty
            ? 'bg-rose-600 text-white'
            : 'bg-amber-500 text-slate-950';
          const pillText = item.isEmpty ? 'Habis (0)' : '< 2 Bendel';
          return `
            <div class="flex items-center justify-between gap-2.5 bg-white rounded-xl border ${
              item.isEmpty ? 'border-rose-200' : 'border-amber-200'
            } px-3.5 py-2.5 shadow-2xs">
              <div class="min-w-0">
                <div class="flex items-center gap-1.5">
                  <p class="text-xs font-bold text-slate-900 truncate">${escapeHtml(item.namaFasilitas)}</p>
                  <span class="px-1.5 py-0.5 rounded text-[10px] font-mono-seri font-semibold bg-slate-100 text-slate-700 border border-slate-200 shrink-0">${escapeHtml(item.kodeDefault)}</span>
                </div>
                <p class="text-[11px] text-slate-600 mt-0.5 tabular-nums">
                  Sisa: <strong class="${item.isEmpty ? 'text-rose-600' : 'text-amber-700'}">${bdl.shortFormatted}</strong> (${formatNumber(item.sisa)} Lbr)
                </p>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold ${pillClass}">${pillText}</span>
                <button
                  type="button"
                  data-prefill-stok-name="${escapeHtml(item.namaFasilitas)}"
                  data-prefill-stok-kode="${escapeHtml(item.kodeDefault)}"
                  data-prefill-stok-tarif="${escapeHtml(String(item.tarifSatuan))}"
                  class="px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11px] font-semibold transition"
                >
                  + Tambah
                </button>
              </div>
            </div>
          `;
        })
        .join('');

      warningPanel.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2.5">
            <span class="w-2.5 h-2.5 rounded-full ${hasEmpty ? 'bg-rose-600' : 'bg-amber-500'} animate-ping"></span>
            <h3 class="text-xs sm:text-sm font-extrabold ${
              hasEmpty ? 'text-rose-950' : 'text-amber-950'
            } uppercase tracking-wide">
              Peringatan Stok Di Bawah 2 Bendel / 200 Lembar (${lowItems.length} Stok)
            </h3>
          </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          ${itemsHtml}
        </div>
      `;
    }
  }

  const cardsEl = document.getElementById('stok-facility-summary-cards');
  if (cardsEl) {
    if (boardItems.length === 0) {
      cardsEl.innerHTML = `
        <div class="col-span-full bg-white rounded-2xl border border-dashed border-slate-300 p-5 text-center text-xs sm:text-sm text-slate-500">
          Belum ada stok karcis pada tahun anggaran ini.
        </div>
      `;
    } else {
      cardsEl.innerHTML = boardItems
        .map((item) => {
          const bdl = toBendelLembar(item.sisa);
          const cardStyle = item.isEmpty
            ? 'border-rose-300 bg-rose-50/40'
            : item.isLow
              ? 'border-amber-300 bg-amber-50/40'
              : 'border-slate-200/90 bg-white';
          const qtyColor = item.isEmpty
            ? 'text-rose-600'
            : item.isLow
              ? 'text-amber-700'
              : 'text-slate-900';
          const lowBadge = item.isEmpty
            ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-600 text-white shrink-0">Habis</span>'
            : item.isLow
              ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-slate-950 shrink-0">&lt; 2 Bendel</span>'
              : '';
          const seriRangeLine =
            item.minSisaMulai > 0 && item.maxSampai >= item.minSisaMulai
              ? `<p class="text-[11px] font-mono-seri text-slate-400 mt-0.5 truncate">Seri: ${escapeHtml(formatSeriRange(item.kodeDefault, item.minSisaMulai, item.maxSampai))}</p>`
              : '';
          return `
            <div class="rounded-2xl border ${cardStyle} p-4 shadow-2xs flex flex-col justify-between">
              <div class="flex items-start justify-between gap-2">
                <p class="text-xs font-semibold text-slate-800 truncate">${escapeHtml(item.namaFasilitas)}</p>
                <span class="px-1.5 py-0.5 rounded text-[10px] font-mono-seri font-semibold bg-slate-100 text-slate-700 border border-slate-200 shrink-0">${escapeHtml(item.kodeDefault || 'KRC')}</span>
              </div>
              <div class="mt-2">
                <div class="flex items-center justify-between gap-2">
                  <p class="text-base font-bold ${qtyColor} tabular-nums">${bdl.shortFormatted}</p>
                  ${lowBadge}
                </div>
                <p class="text-[11px] text-slate-500 tabular-nums">${formatNumber(item.sisa)} Lembar • ${formatRupiah(item.tarifSatuan)}/lbr</p>
                ${seriRangeLine}
              </div>
            </div>
          `;
        })
        .join('');
    }
  }

  // Live Preview Pendaftaran Batch Stok Baru
  const rawFacName = (document.getElementById('stok-facility-name')?.value || '').trim();
  const kode = normalizeKodeSeri(document.getElementById('stok-kode')?.value || '');
  const matchedFac = kode ? findFacilityByNameAndKode(rawFacName, kode) : findFacilityByName(rawFacName);
  const existingGroup = rawFacName && kode ? findExistingStockGroupByNameAndKode(rawFacName, kode) : null;
  const facId = matchedFac?.id || '';
  const tarifRaw = document.getElementById('stok-tarif')?.value ?? '';
  const tarifVal =
    tarifRaw !== ''
      ? Math.max(0, Number(tarifRaw) || 0)
      : matchedFac
        ? Math.max(0, Number(matchedFac.tarifSatuan) || 0)
        : existingGroup
          ? Math.max(0, Number(existingGroup.tarifSatuan) || 0)
          : 0;
  const mulai = parseInt(document.getElementById('stok-mulai')?.value || '0', 10);
  const sampai = parseInt(document.getElementById('stok-sampai')?.value || '0', 10);

  const badgeEl = document.getElementById('preview-stok-status-badge');
  const seriEl = document.getElementById('preview-stok-seri');
  const fisikEl = document.getElementById('preview-stok-fisik');
  const lembarSubEl = document.getElementById('preview-stok-lembar-sub');
  const nilaiEl = document.getElementById('preview-stok-nilai');
  const overlapEl = document.getElementById('preview-stok-overlap');
  const submitBtn = document.getElementById('btn-submit-stok');

  if (!rawFacName || !kode || isNaN(mulai) || isNaN(sampai) || mulai <= 0 || sampai <= 0) {
    if (badgeEl) {
      badgeEl.textContent = 'Siap input';
      badgeEl.className = 'text-[11px] px-2.5 py-0.5 rounded-full bg-white text-slate-600 border border-slate-200 font-medium';
    }
    if (seriEl) seriEl.textContent = '—';
    if (fisikEl) fisikEl.textContent = '0 Bendel + 0 Lembar';
    if (lembarSubEl) lembarSubEl.textContent = '(0 Lembar)';
    if (nilaiEl) nilaiEl.textContent = 'Rp 0';
    if (overlapEl) overlapEl.classList.add('hidden');
    if (submitBtn) submitBtn.disabled = false;
    return;
  }

  if (sampai < mulai) {
    if (badgeEl) {
      badgeEl.textContent = 'Cek nomor';
      badgeEl.className = 'text-[11px] px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200 font-medium';
    }
    if (seriEl) seriEl.textContent = 'Nomor Sampai < Nomor Mulai';
    if (overlapEl) {
      overlapEl.className = 'rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-700';
      overlapEl.textContent = 'Angka sampai harus lebih besar atau sama dengan angka mulai.';
      overlapEl.classList.remove('hidden');
    }
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  const totalAwal = sampai - mulai + 1;
  const bdl = toBendelLembar(totalAwal);
  const nilai = totalAwal * tarifVal;

  if (seriEl) seriEl.textContent = formatSeriRange(kode, mulai, sampai);
  if (fisikEl) fisikEl.textContent = bdl.formatted;
  if (lembarSubEl) lembarSubEl.textContent = `(${formatNumber(totalAwal)} Lembar)`;
  if (nilaiEl) nilaiEl.textContent = formatRupiah(nilai);

  const overlapBatch =
    rawFacName && kode ? findOverlappingStockBatch(state.stocks, facId, kode, mulai, sampai, rawFacName) : null;
  if (overlapBatch) {
    if (badgeEl) {
      badgeEl.textContent = 'Seri sudah ada';
      badgeEl.className = 'text-[11px] px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200 font-medium';
    }
    if (overlapEl) {
      overlapEl.className = 'rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-700';
      overlapEl.innerHTML = `<strong>Nomor seri bentrok:</strong> Sudah ada di batch <strong>${formatSeriRange(overlapBatch.kodeHuruf, overlapBatch.angkaMulai, overlapBatch.angkaSampai)}</strong>.`;
      overlapEl.classList.remove('hidden');
    }
    if (submitBtn) submitBtn.disabled = true;
  } else {
    if (badgeEl) {
      badgeEl.textContent = 'Siap simpan';
      badgeEl.className = 'text-[11px] px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 font-medium';
    }
    if (overlapEl) overlapEl.classList.add('hidden');
    if (submitBtn) submitBtn.disabled = false;
  }
}

function resetStokFormHelperState() {
  const nameInp = document.getElementById('stok-facility-name');
  const tarifInp = document.getElementById('stok-tarif');
  const kodeInp = document.getElementById('stok-kode');
  const mulaiInp = document.getElementById('stok-mulai');
  const sampaiInp = document.getElementById('stok-sampai');
  const hintEl = document.getElementById('stok-facility-match-hint');

  [nameInp, tarifInp, kodeInp, mulaiInp, sampaiInp].forEach((el) => {
    if (!el) return;
    delete el.dataset.autofilled;
    delete el.dataset.manualEdited;
    delete el.dataset.lastMatchedFacId;
  });

  if (hintEl) {
    hintEl.textContent = '';
    hintEl.className = 'hidden text-[11px] font-medium mt-1';
  }
}

function updateStokMatchHint() {
  const hintEl = document.getElementById('stok-facility-match-hint');
  if (hintEl) {
    hintEl.textContent = '';
    hintEl.className = 'hidden';
  }
}

function handleStokFacilityNameChange(options = {}) {
  const nameInp = document.getElementById('stok-facility-name');
  const tarifInp = document.getElementById('stok-tarif');
  const kodeInp = document.getElementById('stok-kode');
  if (!nameInp || !tarifInp || !kodeInp) return;

  const trimmed = (nameInp.value || '').trim();
  const manualKode = kodeInp.dataset.manualEdited ? normalizeKodeSeri(kodeInp.value) : '';
  const matchedFac = manualKode
    ? findFacilityByNameAndKode(trimmed, manualKode)
    : findFacilityByName(trimmed);
  const existingStockGroup =
    !matchedFac && manualKode ? findExistingStockGroupByNameAndKode(trimmed, manualKode) : null;

  if (matchedFac) {
    const isNewMatch = nameInp.dataset.lastMatchedFacId !== matchedFac.id;
    nameInp.dataset.lastMatchedFacId = matchedFac.id;

    if (isNewMatch || !tarifInp.dataset.manualEdited) {
      tarifInp.value = String(Number(matchedFac.tarifSatuan) || 0);
      tarifInp.dataset.autofilled = 'true';
    }
    if (!kodeInp.dataset.manualEdited && (isNewMatch || !kodeInp.value)) {
      kodeInp.value = matchedFac.kodeDefault || '';
      kodeInp.dataset.autofilled = 'true';
    }

    updateStokMatchHint();
    if (isNewMatch || options.forceSuggest) {
      const mulaiInp = document.getElementById('stok-mulai');
      if (mulaiInp && (!mulaiInp.value || mulaiInp.dataset.autofilled === 'true')) {
        suggestNextStockSerial();
        return;
      }
    }
  } else if (existingStockGroup) {
    nameInp.dataset.lastMatchedFacId = '';
    if (!tarifInp.dataset.manualEdited && existingStockGroup.tarifSatuan != null) {
      tarifInp.value = String(Number(existingStockGroup.tarifSatuan) || 0);
      tarifInp.dataset.autofilled = 'true';
    }
    updateStokMatchHint();
  } else {
    nameInp.dataset.lastMatchedFacId = '';

    if (tarifInp.dataset.autofilled === 'true' && !tarifInp.dataset.manualEdited) {
      tarifInp.value = '';
      delete tarifInp.dataset.autofilled;
    }
    if (!kodeInp.dataset.manualEdited) {
      kodeInp.value = trimmed ? suggestKodeFromFacilityName(trimmed) : '';
      if (trimmed) {
        kodeInp.dataset.autofilled = 'true';
      } else {
        delete kodeInp.dataset.autofilled;
      }
    }
    updateStokMatchHint();
  }

  renderStokSummaryAndPreview();
}

function suggestNextStockSerial() {
  const rawName = (document.getElementById('stok-facility-name')?.value || '').trim();
  const targetNameKey = normalizeFacilityName(rawName);
  const kode = normalizeKodeSeri(document.getElementById('stok-kode')?.value || '');
  const matchedFac = kode ? findFacilityByNameAndKode(rawName, kode) : findFacilityByName(rawName);
  const facId = matchedFac?.id || '';
  const mulaiInput = document.getElementById('stok-mulai');
  const sampaiInput = document.getElementById('stok-sampai');
  if (!mulaiInput) return;

  const facNameById = new Map(
    state.facilities.map((f) => [f.id, normalizeFacilityName(f.namaFasilitas)])
  );

  const sameBatches = targetNameKey
    ? state.stocks.filter((s) => {
        if (s.isReturBatch) return false;
        const sNameKey = normalizeFacilityName(facNameById.get(s.facilityId) || s.jenisFasilitas);
        const sameFac = (facId && s.facilityId === facId) || sNameKey === targetNameKey;
        if (!sameFac) return false;
        return !kode || normalizeKodeSeri(s.kodeHuruf) === kode;
      })
    : [];

  const maxEnd = sameBatches.reduce((max, b) => Math.max(max, Number(b.angkaSampai) || 0), 0);
  const nextStart = maxEnd + 1;
  mulaiInput.value = String(nextStart);
  mulaiInput.dataset.autofilled = 'true';
  if (sampaiInput && (!sampaiInput.value || Number(sampaiInput.value) < nextStart || sampaiInput.dataset.autofilled === 'true')) {
    sampaiInput.value = String(nextStart + 499); // Default +5 Bendel (500 lembar)
    sampaiInput.dataset.autofilled = 'true';
  }
  renderStokSummaryAndPreview();
}

async function handleStokSubmit(e) {
  e.preventDefault();
  if (!requireAdmin('mendaftarkan batch stok gudang')) return;

  const rawNama = (document.getElementById('stok-facility-name')?.value || '').trim().replace(/\s+/g, ' ');
  const rawTarif = (document.getElementById('stok-tarif')?.value ?? '').trim();
  const kodeHuruf = normalizeKodeSeri(document.getElementById('stok-kode')?.value || '');
  const angkaMulai = parseInt(document.getElementById('stok-mulai')?.value || '0', 10);
  const angkaSampai = parseInt(document.getElementById('stok-sampai')?.value || '0', 10);

  if (!rawNama || !kodeHuruf) {
    showToast('warning', 'Data Belum Lengkap', 'Isi nama fasilitas dan kode huruf seri.');
    return;
  }

  const tarifSatuan = Number(rawTarif);
  if (rawTarif === '' || !Number.isFinite(tarifSatuan) || tarifSatuan < 0) {
    showToast('warning', 'Tarif Belum Valid', 'Masukkan tarif harga karcis per lembar dalam Rupiah.');
    return;
  }

  if (!Number.isInteger(angkaMulai) || !Number.isInteger(angkaSampai) || angkaMulai < 1 || angkaSampai < angkaMulai) {
    showToast('warning', 'Rentang Nomor Seri Tidak Valid', 'Pastikan nomor seri mulai >= 1 dan nomor sampai >= nomor mulai.');
    return;
  }

  const hadSameNameDifferentSeri = Boolean(findFacilityByName(rawNama));
  let matchedFac = findFacilityByNameAndKode(rawNama, kodeHuruf);
  const overlap = findOverlappingStockBatch(
    state.stocks,
    matchedFac?.id || '',
    kodeHuruf,
    angkaMulai,
    angkaSampai,
    rawNama
  );
  if (overlap) {
    showToast(
      'error',
      'Nomor Seri Tumpang Tindih (Overlap)',
      `Rentang tersebut beririsan dengan batch ${formatSeriRange(overlap.kodeHuruf, overlap.angkaMulai, overlap.angkaSampai)}.`
    );
    return;
  }

  const totalAwal = angkaSampai - angkaMulai + 1;
  const seriRange = formatSeriRange(kodeHuruf, angkaMulai, angkaSampai);
  let createdNewFacility = false;

  try {
    if (!matchedFac) {
      createdNewFacility = true;
      state.cloudSeedChecked = true;
      markFacilitiesInitializedLocal();
      state.sync.mutationSeq++;
      if (state.mode === 'cloud') {
        await markFacilitiesInitializedCloud();
        const facRef = await addDoc(collection(db, COL_FACILITIES), {
          namaFasilitas: rawNama,
          tarifSatuan,
          kodeDefault: kodeHuruf,
          batasMinimum: 200,
          isActive: true,
          createdAt: serverTimestamp()
        });
        matchedFac = {
          id: facRef.id,
          namaFasilitas: rawNama,
          tarifSatuan,
          kodeDefault: kodeHuruf,
          batasMinimum: 200,
          isActive: true
        };
      } else {
        const facs = readLocalArray(LS_FACILITIES_KEY);
        const newFac = {
          id: generateId('fac'),
          namaFasilitas: rawNama,
          tarifSatuan,
          kodeDefault: kodeHuruf,
          batasMinimum: 200,
          isActive: true,
          createdAt: new Date().toISOString()
        };
        facs.push(newFac);
        writeLocalArray(LS_FACILITIES_KEY, facs);
        matchedFac = newFac;
      }
    } else if (Number(matchedFac.tarifSatuan) !== tarifSatuan || matchedFac.isActive === false) {
      // Sinkronkan perubahan tarif manual hanya untuk fasilitas dengan kode seri yang sama
      if (state.mode === 'cloud') {
        await updateDoc(doc(db, COL_FACILITIES, matchedFac.id), {
          tarifSatuan,
          isActive: true
        });
      } else {
        const facs = readLocalArray(LS_FACILITIES_KEY);
        const idx = facs.findIndex((f) => f.id === matchedFac.id);
        if (idx !== -1) {
          facs[idx].tarifSatuan = tarifSatuan;
          facs[idx].isActive = true;
          writeLocalArray(LS_FACILITIES_KEY, facs);
        }
      }
      matchedFac = { ...matchedFac, tarifSatuan, isActive: true };
    }

    const newBatchPayload = {
      tahun: String(state.tahun),
      facilityId: matchedFac.id,
      jenisFasilitas: matchedFac.namaFasilitas,
      tarifSatuan,
      kodeHuruf,
      angkaMulai,
      angkaSampai,
      totalAwal,
      sisaStok: totalAwal,
      angkaSisaMulai: angkaMulai,
      isReturBatch: false
    };

    if (state.mode === 'cloud') {
      await addDoc(collection(db, COL_STOCK), {
        ...newBatchPayload,
        createdAt: serverTimestamp()
      });
    } else {
      const stocks = readLocalArray(LS_STOCK_KEY);
      stocks.unshift({
        id: generateId('stk'),
        ...newBatchPayload,
        createdAt: new Date().toISOString()
      });
      writeLocalArray(LS_STOCK_KEY, stocks);
      refreshLocalState();
    }

    const actionDesc = createdNewFacility
      ? hadSameNameDifferentSeri
        ? `Mendaftarkan seri terpisah [${kodeHuruf}] untuk ${matchedFac.namaFasilitas}`
        : 'Mendaftarkan fasilitas baru & pemasukan'
      : `Pemasukan (gabung seri ${kodeHuruf}) stok ${matchedFac.namaFasilitas}`;
    await logActivity(
      'TAMBAH_STOK',
      `${actionDesc} (${formatRupiah(tarifSatuan)}/lbr): ${seriRange} (${formatNumber(totalAwal)} lembar).`
    );
    notifyCrossTabSync('stocks');

    const form = document.getElementById('form-stok');
    if (form) form.reset();
    resetStokFormHelperState();
    renderStokSummaryAndPreview();

    showToast(
      'success',
      createdNewFacility
        ? hadSameNameDifferentSeri
          ? `Seri Terpisah [${kodeHuruf}] Ditambahkan`
          : 'Fasilitas & Stok Karcis Didaftarkan'
        : `Stok Seri ${kodeHuruf} Berhasil Digabungkan`,
      `${matchedFac.namaFasilitas}: batch ${seriRange} (${toBendelLembar(totalAwal).shortFormatted}) telah ditambahkan.`
    );
  } catch (err) {
    console.error('Gagal menyimpan batch stok:', err);
    showToast('error', 'Gagal Menyimpan Stok', err.message || 'Terjadi kesalahan.');
  }
}

function renderStokTable() {
  const tbody = document.getElementById('stok-table-body');
  const mobileCards = document.getElementById('stok-mobile-cards');
  const pageInfo = document.getElementById('stok-pagination-info');
  const pageControls = document.getElementById('stok-pagination-controls');

  if (!tbody || !mobileCards) return;

  const { search, facilityId, status, page, perPage } = state.filters.stok;
  const q = search.trim().toLowerCase();

  const filtered = state.stocks.filter((s) => {
    const sisaNum = Number(s.sisaStok) || 0;
    if (facilityId !== 'ALL' && s.facilityId !== facilityId) return false;
    if (status === 'AVAILABLE' && sisaNum <= 0) return false;
    if (status === 'LOW' && sisaNum >= STOCK_LOW_THRESHOLD_LEMBAR) return false;
    if (status === 'EMPTY' && sisaNum > 0) return false;
    if (status === 'RETUR' && !s.isReturBatch) return false;
    if (!q) return true;
    const rangeStr = formatSeriRange(s.kodeHuruf, s.angkaMulai, s.angkaSampai).toLowerCase();
    return (
      String(s.jenisFasilitas || '').toLowerCase().includes(q) ||
      String(s.kodeHuruf || '').toLowerCase().includes(q) ||
      rangeStr.includes(q)
    );
  });

  const totalItems = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  state.filters.stok.page = currentPage;

  const startIdx = (currentPage - 1) * perPage;
  const pageItems = filtered.slice(startIdx, startIdx + perPage);

  if (pageInfo) {
    pageInfo.textContent =
      totalItems === 0
        ? 'Menampilkan 0 dari 0 batch'
        : `Menampilkan ${startIdx + 1}–${Math.min(startIdx + perPage, totalItems)} dari ${totalItems} batch`;
  }

  renderPaginationControls(pageControls, currentPage, totalPages, (newPage) => {
    state.filters.stok.page = newPage;
    renderStokTable();
  });

  if (pageItems.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="py-10 text-center text-slate-400">Tidak ada batch stok karcis yang sesuai filter.</td>
      </tr>
    `;
    mobileCards.innerHTML = `<div class="py-8 text-center text-slate-400 text-xs">Tidak ada batch stok.</div>`;
    return;
  }

  tbody.innerHTML = pageItems
    .map((s) => {
      const awalRange = formatSeriRange(s.kodeHuruf, s.angkaMulai, s.angkaSampai);
      const totalAwal = Number(s.totalAwal) || 0;
      const sisa = Number(s.sisaStok) || 0;
      const sisaRange =
        sisa > 0
          ? formatSeriRange(s.kodeHuruf, s.angkaSisaMulai, s.angkaSampai)
          : 'Habis';
      const bdlAwal = toBendelLembar(totalAwal);
      const bdlSisa = toBendelLembar(sisa);

      const batchBadge = s.isReturBatch
        ? '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800 border border-amber-200">Stok Retur</span>'
        : '<span class="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">Stok Utama</span>';

      const sisaWarnBadge =
        sisa === 0
          ? '<span class="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-700 border border-rose-200">Habis</span>'
          : sisa < STOCK_LOW_THRESHOLD_LEMBAR
            ? '<span class="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">&lt; 2 Bdl</span>'
            : '';
      const sisaTextColor =
        sisa === 0 ? 'text-rose-600' : sisa < STOCK_LOW_THRESHOLD_LEMBAR ? 'text-amber-700' : 'text-emerald-700';

      return `
        <tr class="hover:bg-slate-50/80 transition">
          <td class="py-3 px-3.5">
            <p class="font-semibold text-slate-900">${escapeHtml(s.jenisFasilitas)}</p>
            <p class="text-[11px] text-slate-500">${formatRupiah(s.tarifSatuan)} / lembar</p>
          </td>
          <td class="py-3 px-3.5">${batchBadge}</td>
          <td class="py-3 px-3.5 font-mono-seri font-semibold text-slate-800 text-xs">${escapeHtml(awalRange)}</td>
          <td class="py-3 px-3.5 font-mono-seri font-semibold ${
            sisa > 0 ? 'text-blue-700' : 'text-slate-400'
          } text-xs">${escapeHtml(sisaRange)}</td>
          <td class="py-3 px-3.5 tabular-nums">
            <span class="font-bold text-slate-800">${bdlAwal.shortFormatted}</span>
            <span class="block text-[11px] text-slate-500">${formatNumber(totalAwal)} Lembar</span>
          </td>
          <td class="py-3 px-3.5 tabular-nums">
            <span class="font-bold ${sisaTextColor}">${bdlSisa.shortFormatted}</span>${sisaWarnBadge}
            <span class="block text-[11px] text-slate-500">${formatNumber(sisa)} Lembar</span>
          </td>
          <td class="py-3 px-3.5 text-right">
            <button type="button" data-delete-stok="${escapeHtml(s.id)}" title="Hapus Stok" class="p-1.5 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </td>
        </tr>
      `;
    })
    .join('');

  mobileCards.innerHTML = pageItems
    .map((s) => {
      const awalRange = formatSeriRange(s.kodeHuruf, s.angkaMulai, s.angkaSampai);
      const totalAwal = Number(s.totalAwal) || 0;
      const sisa = Number(s.sisaStok) || 0;
      const bdlAwal = toBendelLembar(totalAwal);
      const bdlSisa = toBendelLembar(sisa);
      const sisaWarnBadge =
        sisa === 0
          ? '<span class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-700">Habis</span>'
          : sisa < STOCK_LOW_THRESHOLD_LEMBAR
            ? '<span class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">&lt; 2 Bdl</span>'
            : '';
      const sisaTextColor =
        sisa === 0 ? 'text-rose-600' : sisa < STOCK_LOW_THRESHOLD_LEMBAR ? 'text-amber-700' : 'text-emerald-700';
      return `
        <div class="rounded-xl border border-slate-200 p-4 space-y-2 bg-white">
          <div class="flex items-start justify-between">
            <div>
              <p class="font-semibold text-slate-900 text-sm">${escapeHtml(s.jenisFasilitas)}</p>
              <p class="text-xs font-mono-seri text-blue-700 font-semibold">${escapeHtml(awalRange)}</p>
            </div>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold ${
              s.isReturBatch ? 'bg-amber-100 text-amber-800' : 'bg-blue-50 text-blue-700'
            }">${s.isReturBatch ? 'Retur' : 'Utama'}</span>
          </div>
          <div class="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 text-xs tabular-nums">
            <div>
              <span class="text-slate-500 block text-[11px]">Jumlah Awal</span>
              <strong class="text-slate-800">${bdlAwal.shortFormatted}</strong>
              <span class="block text-[11px] text-slate-500">${formatNumber(totalAwal)} Lembar</span>
            </div>
            <div>
              <span class="text-slate-500 block text-[11px]">Sisa Stok</span>
              <strong class="${sisaTextColor}">${bdlSisa.shortFormatted}</strong>${sisaWarnBadge}
              <span class="block text-[11px] text-slate-500">${formatNumber(sisa)} Lembar</span>
            </div>
          </div>
          <div class="flex justify-end pt-1">
            <button type="button" data-delete-stok="${escapeHtml(s.id)}" class="text-xs text-rose-600 font-semibold">Hapus</button>
          </div>
        </div>
      `;
    })
    .join('');
}

async function handleDeleteStockBatch(stockId) {
  if (!requireAdmin('menghapus batch stok gudang')) return;
  const stk = state.stocks.find((s) => s.id === stockId);
  if (!stk) return;

  const rangeStr = formatSeriRange(stk.kodeHuruf, stk.angkaMulai, stk.angkaSampai);
  const confirmed = await showConfirmModal({
    title: 'Hapus Batch Stok Gudang?',
    message: `Batch stok "${stk.jenisFasilitas}" (${rangeStr}) dengan sisa ${formatNumber(stk.sisaStok)} lembar akan dihapus dari gudang.`,
    confirmText: 'Ya, Hapus Batch',
    variant: 'danger'
  });
  if (!confirmed) return;

  try {
    if (state.mode === 'cloud') {
      await deleteDoc(doc(db, COL_STOCK, stockId));
    } else {
      const stocks = readLocalArray(LS_STOCK_KEY).filter((s) => s.id !== stockId);
      writeLocalArray(LS_STOCK_KEY, stocks);
      refreshLocalState();
    }

    await logActivity('HAPUS_STOK', `Admin menghapus batch stok ${stk.jenisFasilitas} (${rangeStr}).`);
    showToast('info', 'Batch Stok Dihapus', `Batch ${rangeStr} telah dihapus.`);
  } catch (err) {
    console.error('Gagal menghapus batch stok:', err);
    showToast('error', 'Gagal Menghapus Stok', err.message || 'Terjadi kesalahan.');
  }
}

/* ==========================================================================
   16. VIEW 4: MASTER JENIS FASILITAS CRUD (ADMIN)
   ========================================================================== */

function renderFacilitiesTable() {
  const tbody = document.getElementById('fac-table-body');
  const mobileCards = document.getElementById('fac-mobile-cards');
  if (!tbody || !mobileCards) return;

  const q = state.filters.fac.search.trim().toLowerCase();

  const filtered = state.facilities.filter((f) => {
    if (!q) return true;
    return (
      String(f.namaFasilitas || '').toLowerCase().includes(q) ||
      String(f.kodeDefault || '').toLowerCase().includes(q)
    );
  });

  if (filtered.length === 0) {
    const emptyMsg =
      state.facilities.length === 0 && !q
        ? 'Belum ada data fasilitas & tarif. Klik + Tambah Fasilitas untuk menambahkan.'
        : 'Tidak ada jenis fasilitas yang sesuai filter.';
    const emptyMobileMsg =
      state.facilities.length === 0 && !q ? 'Belum ada data fasilitas & tarif.' : 'Tidak ada fasilitas.';
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="py-10 text-center text-slate-400">${emptyMsg}</td>
      </tr>
    `;
    mobileCards.innerHTML = `<div class="py-8 text-center text-slate-400 text-xs">${emptyMobileMsg}</div>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((f) => {
      return `
        <tr class="hover:bg-slate-50/80 transition">
          <td class="py-3 px-4 font-bold text-slate-900">${escapeHtml(f.namaFasilitas)}</td>
          <td class="py-3 px-4">
            <span class="px-2.5 py-0.5 rounded bg-blue-50 text-blue-800 border border-blue-200 font-mono-seri font-bold text-xs">${escapeHtml(f.kodeDefault)}</span>
          </td>
          <td class="py-3 px-4 text-right font-extrabold text-slate-900 tabular-nums">${formatRupiah(f.tarifSatuan)}</td>
          <td class="py-3 px-4 text-right whitespace-nowrap">
            <div class="inline-flex items-center gap-1.5">
              <button type="button" data-edit-fac="${escapeHtml(f.id)}" class="px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-blue-50 hover:text-blue-700 text-slate-700 text-xs font-semibold transition">
                Edit
              </button>
              <button type="button" data-delete-fac="${escapeHtml(f.id)}" class="px-2.5 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-semibold transition">
                Hapus
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  mobileCards.innerHTML = filtered
    .map((f) => {
      return `
        <div class="rounded-xl border border-slate-200 p-4 space-y-2.5 bg-white">
          <div class="flex items-center justify-between gap-2">
            <p class="font-bold text-slate-900 text-sm">${escapeHtml(f.namaFasilitas)}</p>
            <span class="px-2 py-0.5 rounded bg-blue-50 text-blue-800 border border-blue-200 font-mono-seri font-bold text-xs shrink-0">${escapeHtml(f.kodeDefault)}</span>
          </div>
          <p class="text-xs text-slate-600">Tarif Perda: <strong class="text-slate-900">${formatRupiah(f.tarifSatuan)}</strong></p>
          <div class="pt-2 border-t border-slate-100 flex flex-wrap justify-end gap-2">
            <button type="button" data-edit-fac="${escapeHtml(f.id)}" class="px-3 py-1 rounded-lg bg-slate-100 text-slate-700 text-xs font-bold">Edit</button>
            <button type="button" data-delete-fac="${escapeHtml(f.id)}" class="px-3 py-1 rounded-lg bg-rose-50 text-rose-700 text-xs font-bold">Hapus</button>
          </div>
        </div>
      `;
    })
    .join('');
}

function openFacilityModal(facId = null) {
  if (!requireAdmin('mengelola master fasilitas')) return;
  const modal = document.getElementById('modal-facility');
  const titleEl = document.getElementById('modal-facility-title');
  const idInput = document.getElementById('fac-id');
  const namaInput = document.getElementById('fac-nama');
  const kodeInput = document.getElementById('fac-kode');
  const tarifInput = document.getElementById('fac-tarif');

  if (!modal || !idInput || !namaInput || !kodeInput || !tarifInput) return;

  if (facId) {
    const fac = state.facilities.find((f) => f.id === facId);
    if (!fac) return;
    if (titleEl) titleEl.textContent = 'Edit Fasilitas & Tarif Perda';
    idInput.value = fac.id;
    namaInput.value = fac.namaFasilitas || '';
    kodeInput.value = fac.kodeDefault || '';
    tarifInput.value = String(fac.tarifSatuan ?? 0);
  } else {
    if (titleEl) titleEl.textContent = 'Tambah Fasilitas & Tarif Perda';
    idInput.value = '';
    namaInput.value = '';
    kodeInput.value = '';
    tarifInput.value = '';
  }

  modal.classList.remove('hidden');
}

async function handleFacilitySubmit(e) {
  e.preventDefault();
  if (!requireAdmin('menyimpan master fasilitas')) return;

  const id = (document.getElementById('fac-id')?.value || '').trim();
  const namaFasilitas = (document.getElementById('fac-nama')?.value || '').trim();
  const kodeDefault = (document.getElementById('fac-kode')?.value || '').trim().toUpperCase();
  const tarifSatuan = Number(document.getElementById('fac-tarif')?.value || 0);
  const existing = id ? state.facilities.find((f) => f.id === id) : null;
  const batasMinimum = Number(existing?.batasMinimum ?? STOCK_LOW_THRESHOLD_LEMBAR);

  if (!namaFasilitas || !kodeDefault) {
    showToast('warning', 'Data Belum Lengkap', 'Nama fasilitas dan kode seri wajib diisi.');
    return;
  }

  try {
    state.cloudSeedChecked = true;
    markFacilitiesInitializedLocal();
    state.sync.mutationSeq++;

    if (state.mode === 'cloud') {
      await markFacilitiesInitializedCloud();
      if (id) {
        await updateDoc(doc(db, COL_FACILITIES, id), {
          namaFasilitas,
          kodeDefault,
          tarifSatuan,
          batasMinimum,
          isActive: true
        });
      } else {
        await addDoc(collection(db, COL_FACILITIES), {
          namaFasilitas,
          kodeDefault,
          tarifSatuan,
          batasMinimum,
          isActive: true,
          createdAt: serverTimestamp()
        });
      }
      state.sync.mutationSeq++;
    } else {
      const facs = readLocalArray(LS_FACILITIES_KEY);
      if (id) {
        const idx = facs.findIndex((f) => f.id === id);
        if (idx !== -1) {
          facs[idx] = {
            ...facs[idx],
            namaFasilitas,
            kodeDefault,
            tarifSatuan,
            batasMinimum,
            isActive: true
          };
        }
      } else {
        facs.push({
          id: generateId('fac'),
          namaFasilitas,
          kodeDefault,
          tarifSatuan,
          batasMinimum,
          isActive: true,
          createdAt: new Date().toISOString()
        });
      }
      writeLocalArray(LS_FACILITIES_KEY, facs);
      refreshLocalState();
    }

    await logActivity(
      id ? 'EDIT_FASILITAS' : 'TAMBAH_FASILITAS',
      `Admin ${id ? 'memperbarui' : 'menambahkan'} fasilitas "${namaFasilitas}" (Kode: ${kodeDefault}, Tarif: ${formatRupiah(tarifSatuan)}).`
    );

    document.getElementById('modal-facility')?.classList.add('hidden');
    showToast('success', 'Fasilitas & Tarif Tersimpan', `Data fasilitas "${namaFasilitas}" telah disimpan.`);
  } catch (err) {
    console.error('Gagal menyimpan fasilitas:', err);
    showToast('error', 'Gagal Menyimpan Fasilitas', err.message || 'Terjadi kesalahan.');
  }
}

async function handleDeleteFacility(facId) {
  if (!requireAdmin('menghapus fasilitas dan tarif')) return;
  const fac = state.facilities.find((f) => f.id === facId);
  if (!fac) return;

  const confirmed = await showConfirmModal({
    title: 'Hapus Fasilitas & Tarif?',
    message: `Data fasilitas "${fac.namaFasilitas}" (${fac.kodeDefault} • ${formatRupiah(fac.tarifSatuan)}) akan dihapus.`,
    confirmText: 'Ya, Hapus',
    variant: 'danger'
  });
  if (!confirmed) return;

  try {
    state.cloudSeedChecked = true;
    markFacilitiesInitializedLocal();
    state.sync.mutationSeq++;

    if (state.mode === 'cloud') {
      await markFacilitiesInitializedCloud();
      await deleteDoc(doc(db, COL_FACILITIES, facId));
      state.sync.mutationSeq++;
      state.facilities = state.facilities.filter((f) => f.id !== facId);
      state.sync.fingerprints.facilities = buildCollectionFingerprint(state.facilities);
      writeLocalArray(LS_FACILITIES_KEY, state.facilities);
      populateFacilitySelects();
      renderFacilitiesTable();
    } else {
      const facs = readLocalArray(LS_FACILITIES_KEY).filter((f) => f.id !== facId);
      writeLocalArray(LS_FACILITIES_KEY, facs);
      refreshLocalState();
    }

    notifyCrossTabSync('facilities');
    await logActivity(
      'HAPUS_FASILITAS',
      `Admin menghapus fasilitas "${fac.namaFasilitas}" (Kode: ${fac.kodeDefault}, Tarif: ${formatRupiah(fac.tarifSatuan)}).`
    );
    showToast('info', 'Fasilitas Dihapus', `Data "${fac.namaFasilitas}" telah dihapus.`);
  } catch (err) {
    console.error('Gagal menghapus fasilitas:', err);
    showToast('error', 'Gagal Menghapus Fasilitas', err.message || 'Terjadi kesalahan.');
  }
}

function renderPaginationControls(container, currentPage, totalPages, onPageSelect) {
  if (!container) return;
  container.innerHTML = '';
  if (totalPages <= 1) return;

  const createBtn = (label, targetPage, disabled = false, active = false) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.disabled = disabled;
    btn.textContent = label;
    btn.className = active
      ? 'px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-700 text-white shadow-2xs'
      : 'px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40';
    if (!disabled && !active) {
      btn.addEventListener('click', () => onPageSelect(targetPage));
    }
    return btn;
  };

  container.appendChild(createBtn('‹ Prev', currentPage - 1, currentPage <= 1));
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1) {
      container.appendChild(createBtn(String(p), p, false, p === currentPage));
    }
  }
  container.appendChild(createBtn('Next ›', currentPage + 1, currentPage >= totalPages));
}

/* ==========================================================================
   17. VIEW 6: LAPORAN & CETAK REKAPITULASI PEMASUKAN & PENGELUARAN KARCIS
   ========================================================================== */

const DEFAULT_SIGNATORIES = {
  instansi: 'PEMERINTAH DAERAH / UPT PENGELOLA RETRIBUSI DAERAH',
  kota: 'Malang',
  mengetahuiJabatan: 'Kepala UPT Pengelola Retribusi',
  mengetahuiNama: 'Drs. H. Ahmad Fauzi, M.Si',
  mengetahuiNip: 'NIP. 19750412 200112 1 003',
  pengelolaJabatan: 'Bendahara Penerimaan Pembantu',
  pengelolaNama: 'Siti Aminah, S.E.',
  pengelolaNip: 'NIP. 19860819 201001 2 009'
};

function loadSignatories() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(LS_SIGNATORIES_KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  const cfg = { ...DEFAULT_SIGNATORIES, ...saved };

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || '';
  };
  setVal('sig-instansi', cfg.instansi);
  setVal('sig-kota', cfg.kota);
  setVal('sig-mengetahui-jabatan', cfg.mengetahuiJabatan);
  setVal('sig-mengetahui-nama', cfg.mengetahuiNama);
  setVal('sig-mengetahui-nip', cfg.mengetahuiNip);
  setVal('sig-pengelola-jabatan', cfg.pengelolaJabatan);
  setVal('sig-pengelola-nama', cfg.pengelolaNama);
  setVal('sig-pengelola-nip', cfg.pengelolaNip);

  applySignatoriesToPrintDOM(cfg);
  return cfg;
}

function applySignatoriesToPrintDOM(cfg) {
  const setTxt = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  setTxt('print-kop-instansi', cfg.instansi || DEFAULT_SIGNATORIES.instansi);
  setTxt('print-sig-mengetahui-jabatan', cfg.mengetahuiJabatan || DEFAULT_SIGNATORIES.mengetahuiJabatan);
  setTxt(
    'print-sig-mengetahui-nama',
    cfg.mengetahuiNama ? cfg.mengetahuiNama : '( ................................................ )'
  );
  setTxt('print-sig-mengetahui-nip', cfg.mengetahuiNip || '');
  setTxt('print-sig-kota-tanggal', `${cfg.kota || 'Malang'}, ${formatDateIndo(getTodayISO())}`);
  setTxt('print-sig-pengelola-jabatan', cfg.pengelolaJabatan || DEFAULT_SIGNATORIES.pengelolaJabatan);
  setTxt(
    'print-sig-pengelola-nama',
    cfg.pengelolaNama ? cfg.pengelolaNama : '( ................................................ )'
  );
  setTxt('print-sig-pengelola-nip', cfg.pengelolaNip || '');
}

function saveSignatories(silent = false) {
  const cfg = {
    instansi: (document.getElementById('sig-instansi')?.value || '').trim() || DEFAULT_SIGNATORIES.instansi,
    kota: (document.getElementById('sig-kota')?.value || '').trim() || DEFAULT_SIGNATORIES.kota,
    mengetahuiJabatan:
      (document.getElementById('sig-mengetahui-jabatan')?.value || '').trim() ||
      DEFAULT_SIGNATORIES.mengetahuiJabatan,
    mengetahuiNama: (document.getElementById('sig-mengetahui-nama')?.value || '').trim(),
    mengetahuiNip: (document.getElementById('sig-mengetahui-nip')?.value || '').trim(),
    pengelolaJabatan:
      (document.getElementById('sig-pengelola-jabatan')?.value || '').trim() ||
      DEFAULT_SIGNATORIES.pengelolaJabatan,
    pengelolaNama: (document.getElementById('sig-pengelola-nama')?.value || '').trim(),
    pengelolaNip: (document.getElementById('sig-pengelola-nip')?.value || '').trim()
  };

  try {
    localStorage.setItem(LS_SIGNATORIES_KEY, JSON.stringify(cfg));
  } catch (err) {
    console.warn('Gagal menyimpan pengaturan penanda tangan:', err);
  }
  if (state.mode === 'cloud' && isFirebaseConfigured()) {
    setDoc(
      doc(db, COL_SETTINGS, 'signatories'),
      { ...cfg, updatedAt: new Date().toISOString() },
      { merge: true }
    ).catch((err) => {
      console.warn('Gagal menyinkronkan pejabat penanda tangan ke Cloud:', err);
    });
  }
  applySignatoriesToPrintDOM(cfg);
  if (!silent) {
    showToast('success', 'Pengaturan Cetak Disimpan', 'Blok kop surat dan pejabat penanda tangan telah diperbarui & disinkronkan.');
  }
  return cfg;
}

function getFilteredReportData() {
  const { type, startDate, endDate, facilityId, status } = state.filters.rep;

  // 1. Data Pemasukan Karcis (Batch Gudang Stok Masuk & Batch Retur)
  const pemasukanList = state.stocks
    .filter((s) => {
      if (facilityId !== 'ALL' && s.facilityId !== facilityId) return false;
      return true;
    })
    .slice()
    .sort((a, b) => {
      const fCmp = String(a.jenisFasilitas || '').localeCompare(String(b.jenisFasilitas || ''), 'id');
      if (fCmp !== 0) return fCmp;
      return (Number(a.angkaMulai) || 0) - (Number(b.angkaMulai) || 0);
    });

  // 2. Data Pengeluaran Karcis (Distribusi ke Petugas & Realisasi Setoran)
  const pengeluaranList = state.distributions
    .filter((d) => {
      if (facilityId !== 'ALL' && d.facilityId !== facilityId) return false;
      if (status !== 'ALL' && d.statusSetoran !== status) return false;
      if (startDate && String(d.tanggal || '') < startDate) return false;
      if (endDate && String(d.tanggal || '') > endDate) return false;
      return true;
    })
    .slice()
    .sort((a, b) => String(a.tanggal || '').localeCompare(String(b.tanggal || '')));

  return { type, pemasukanList, pengeluaranList };
}

function renderReportView() {
  const { type, pemasukanList, pengeluaranList } = getFilteredReportData();
  const { startDate, endDate, facilityId } = state.filters.rep;

  // Update Judul & Meta Kop Surat
  const kopJudul = document.getElementById('print-kop-judul');
  const kopMeta = document.getElementById('print-kop-meta');
  if (kopJudul) {
    if (type === 'PEMASUKAN') {
      kopJudul.textContent = 'LAPORAN REKAPITULASI PEMASUKAN KARCIS (STOK GUDANG MASUK & RETUR)';
    } else if (type === 'PENGELUARAN') {
      kopJudul.textContent = 'LAPORAN REKAPITULASI PENGELUARAN KARCIS DAN REALISASI RETRIBUSI';
    } else {
      kopJudul.textContent = 'LAPORAN REKAPITULASI PEMASUKAN DAN PENGELUARAN KARCIS RETRIBUSI';
    }
  }

  const facObj = state.facilities.find((f) => f.id === facilityId);
  const facName = facilityId === 'ALL' ? 'Semua Fasilitas' : facObj?.namaFasilitas || 'Fasilitas Terpilih';
  const periodStr =
    startDate && endDate
      ? `${formatDateShort(startDate)} s/d ${formatDateShort(endDate)}`
      : startDate
      ? `Mulai ${formatDateShort(startDate)}`
      : endDate
      ? `Sampai ${formatDateShort(endDate)}`
      : 'Semua Tanggal';

  if (kopMeta) {
    kopMeta.textContent = `Tahun Anggaran: ${state.tahun} | Periode: ${periodStr} | Fasilitas: ${facName}`;
  }

  // Toggle Visibilitas Bagian I (Pemasukan) & Bagian II (Pengeluaran)
  const secPemasukan = document.getElementById('rep-section-pemasukan');
  const secPengeluaran = document.getElementById('rep-section-pengeluaran');
  if (secPemasukan) {
    if (type === 'PENGELUARAN') secPemasukan.classList.add('hidden');
    else secPemasukan.classList.remove('hidden');
  }
  if (secPengeluaran) {
    if (type === 'PEMASUKAN') secPengeluaran.classList.add('hidden');
    else secPengeluaran.classList.remove('hidden');
  }

  // Kalkulasi Ringkasan Eksekutif Pemasukan & Pengeluaran
  const totalStokMasuk = pemasukanList.reduce((s, b) => s + (Number(b.totalAwal) || 0), 0);
  const totalStokSisa = pemasukanList.reduce((s, b) => s + (Number(b.sisaStok) || 0), 0);
  const totalPotensiMasuk = pemasukanList.reduce(
    (s, b) => s + (Number(b.totalAwal) || 0) * (Number(b.tarifSatuan) || 0),
    0
  );

  const totalKeluar = pengeluaranList.reduce((s, d) => s + (Number(d.jumlahKeluar) || 0), 0);
  const totalTerjual = pengeluaranList.reduce((s, d) => s + (Number(d.jumlahTerjual) || 0), 0);
  const totalRetur = pengeluaranList.reduce((s, d) => s + (Number(d.jumlahRetur) || 0), 0);
  let totalLunas = 0;
  let totalBelum = 0;
  pengeluaranList.forEach((d) => {
    const nom = Number(d.totalNominal) || 0;
    if (d.statusSetoran === 'Lunas Setor') totalLunas += nom;
    else totalBelum += nom;
  });
  const totalNominal = totalLunas + totalBelum;

  const bdlMasuk = toBendelLembar(totalStokMasuk);
  const bdlKeluar = toBendelLembar(totalKeluar);

  const setTxt = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setTxt('rep-sum-stok-masuk', `${formatNumber(totalStokMasuk)} Lembar`);
  setTxt('rep-sum-stok-masuk-bdl', `${bdlMasuk.shortFormatted} • Sisa: ${formatNumber(totalStokSisa)} Lbr`);
  setTxt('rep-sum-keluar', `${formatNumber(totalKeluar)} Lembar`);
  setTxt('rep-sum-keluar-bdl', bdlKeluar.shortFormatted);
  setTxt('rep-sum-terjual', `${formatNumber(totalTerjual)} Lbr`);
  setTxt('rep-sum-retur', `Retur: ${formatNumber(totalRetur)} Lbr`);
  setTxt('rep-sum-nominal', formatRupiah(totalNominal));
  setTxt('rep-sum-lunas', `Lunas: ${formatRupiah(totalLunas)}`);
  setTxt('rep-sum-belum', formatRupiah(totalBelum));
  setTxt('rep-sum-count', `${formatNumber(pengeluaranList.length)} Transaksi Distribusi`);

  // Render Tabel I: Rekapitulasi Pemasukan Karcis (Stok Gudang Masuk & Retur)
  const inBody = document.getElementById('rep-pemasukan-body');
  const inFoot = document.getElementById('rep-pemasukan-foot');
  if (inBody && inFoot) {
    if (pemasukanList.length === 0) {
      inBody.innerHTML = `
        <tr>
          <td colspan="10" class="py-6 text-center text-slate-400">Belum ada data pemasukan stok karcis untuk filter ini.</td>
        </tr>
      `;
      inFoot.innerHTML = '';
    } else {
      inBody.innerHTML = pemasukanList
        .map((b, idx) => {
          const rangeAwal = formatSeriRange(b.kodeHuruf, b.angkaMulai, b.angkaSampai);
          const bdl = toBendelLembar(b.totalAwal);
          const potensi = (Number(b.totalAwal) || 0) * (Number(b.tarifSatuan) || 0);
          return `
            <tr>
              <td class="py-2 px-3 text-center">${idx + 1}</td>
              <td class="py-2 px-3 font-semibold">${escapeHtml(b.jenisFasilitas)}</td>
              <td class="py-2 px-3 text-center font-mono-seri font-bold">${escapeHtml(b.kodeHuruf)}</td>
              <td class="py-2 px-3">${b.isReturBatch ? 'Pemasukan Retur Sisa' : 'Batch Gudang Utama'}</td>
              <td class="py-2 px-3 font-mono-seri font-bold">${escapeHtml(rangeAwal)}</td>
              <td class="py-2 px-3 text-right tabular-nums font-semibold">${formatNumber(b.totalAwal)}</td>
              <td class="py-2 px-3 text-center tabular-nums">${bdl.shortFormatted}</td>
              <td class="py-2 px-3 text-right tabular-nums">${formatNumber(b.sisaStok)}</td>
              <td class="py-2 px-3 text-right tabular-nums">${formatRupiah(b.tarifSatuan)}</td>
              <td class="py-2 px-3 text-right tabular-nums font-bold">${formatRupiah(potensi)}</td>
            </tr>
          `;
        })
        .join('');

      inFoot.innerHTML = `
        <tr class="print-total-row border-t-2 border-slate-400 bg-slate-100 font-extrabold text-xs">
          <td colspan="5" class="py-2.5 px-3 text-right uppercase">TOTAL PEMASUKAN KARCIS (STOK GUDANG):</td>
          <td class="py-2.5 px-3 text-right tabular-nums">${formatNumber(totalStokMasuk)} Lbr</td>
          <td class="py-2.5 px-3 text-center tabular-nums">${bdlMasuk.shortFormatted}</td>
          <td class="py-2.5 px-3 text-right tabular-nums">${formatNumber(totalStokSisa)} Lbr</td>
          <td class="py-2.5 px-3 text-right">&mdash;</td>
          <td class="py-2.5 px-3 text-right tabular-nums text-blue-800">${formatRupiah(totalPotensiMasuk)}</td>
        </tr>
      `;
    }
  }

  // Render Tabel II: Rekapitulasi Pengeluaran Karcis & Realisasi Setoran Retribusi
  const outBody = document.getElementById('rep-table-body');
  const outFoot = document.getElementById('rep-table-foot');
  const outMobile = document.getElementById('report-mobile-cards');

  if (outBody && outFoot && outMobile) {
    if (pengeluaranList.length === 0) {
      outBody.innerHTML = `
        <tr>
          <td colspan="13" class="py-8 text-center text-slate-400">Belum ada data pengeluaran/distribusi karcis untuk filter ini.</td>
        </tr>
      `;
      outFoot.innerHTML = '';
      outMobile.innerHTML = `<div class="py-6 text-center text-slate-400 text-xs">Tidak ada data pengeluaran karcis.</div>`;
    } else {
      outBody.innerHTML = pengeluaranList
        .map(
          (d, idx) => `
          <tr>
            <td class="py-2 px-2.5 text-center">${idx + 1}</td>
            <td class="py-2 px-2.5 whitespace-nowrap">${formatDateShort(d.tanggal)}</td>
            <td class="py-2 px-2.5 font-semibold">${escapeHtml(d.penerima)}</td>
            <td class="py-2 px-2.5">${escapeHtml(d.jenisFasilitas)}</td>
            <td class="py-2 px-2.5 text-right tabular-nums">${formatNumber(d.tarifSatuan)}</td>
            <td class="py-2 px-2.5 font-mono-seri font-bold">${escapeHtml(d.seriKeluar)}</td>
            <td class="py-2 px-2.5 text-right tabular-nums">${formatNumber(d.jumlahKeluar)}</td>
            <td class="py-2 px-2.5 font-mono-seri">${escapeHtml(d.seriTerjual)}</td>
            <td class="py-2 px-2.5 text-right tabular-nums font-bold">${formatNumber(d.jumlahTerjual)}</td>
            <td class="py-2 px-2.5 font-mono-seri">${escapeHtml(d.seriRetur || '-')}</td>
            <td class="py-2 px-2.5 text-right tabular-nums">${formatNumber(d.jumlahRetur || 0)}</td>
            <td class="py-2 px-2.5 text-right tabular-nums font-extrabold text-emerald-700">${formatRupiah(d.totalNominal)}</td>
            <td class="py-2 px-2.5 text-center font-semibold">${escapeHtml(d.statusSetoran)}</td>
          </tr>
        `
        )
        .join('');

      outFoot.innerHTML = `
        <tr class="print-total-row border-t-2 border-slate-400 bg-slate-100 font-extrabold text-xs">
          <td colspan="6" class="py-2.5 px-3 text-right uppercase">GRAND TOTAL PENGELUARAN &amp; RETRIBUSI:</td>
          <td class="py-2.5 px-2.5 text-right tabular-nums">${formatNumber(totalKeluar)}</td>
          <td class="py-2.5 px-2.5 text-right">&mdash;</td>
          <td class="py-2.5 px-2.5 text-right tabular-nums text-blue-800">${formatNumber(totalTerjual)}</td>
          <td class="py-2.5 px-2.5 text-right">&mdash;</td>
          <td class="py-2.5 px-2.5 text-right tabular-nums text-amber-800">${formatNumber(totalRetur)}</td>
          <td class="py-2.5 px-2.5 text-right tabular-nums text-emerald-800">${formatRupiah(totalNominal)}</td>
          <td class="py-2.5 px-2.5 text-center text-[10px]">Lunas: ${formatRupiah(totalLunas)}</td>
        </tr>
      `;

      outMobile.innerHTML = pengeluaranList
        .map(
          (d, idx) => `
          <div class="rounded-xl border border-slate-200 p-3.5 space-y-1.5 bg-white">
            <div class="flex items-center justify-between">
              <span class="font-bold text-slate-900 text-xs">#${idx + 1} • ${escapeHtml(d.penerima)}</span>
              <span class="text-[11px] font-bold text-emerald-700">${formatRupiah(d.totalNominal)}</span>
            </div>
            <p class="text-xs text-slate-600">${formatDateShort(d.tanggal)} • ${escapeHtml(d.jenisFasilitas)}</p>
            <p class="text-[11px] font-mono-seri text-slate-500">Keluar: ${escapeHtml(d.seriKeluar)} | Terpakai: ${formatNumber(d.jumlahTerjual)} Lbr | Retur: ${formatNumber(d.jumlahRetur || 0)} Lbr</p>
          </div>
        `
        )
        .join('');
    }
  }
}

function handlePrintReport() {
  saveSignatories(true);
  renderReportView();
  if (typeof window !== 'undefined' && window.AndroidBridge && typeof window.AndroidBridge.printPage === 'function') {
    window.AndroidBridge.printPage(`Laporan_SI_KARCIS_TA_${state.tahun}`);
  } else {
    window.print();
  }
}

function handleExportExcel() {
  if (typeof window.XLSX === 'undefined') {
    showToast('error', 'Pustaka SheetJS Belum Siap', 'Pastikan koneksi internet aktif untuk memuat modul ekspor Excel.');
    return;
  }

  saveSignatories(true);
  const { type, pemasukanList, pengeluaranList } = getFilteredReportData();
  const wb = window.XLSX.utils.book_new();

  // Sheet 1: Rekapitulasi Pemasukan Karcis
  if (type === 'ALL' || type === 'PEMASUKAN') {
    const inRows = pemasukanList.map((b, idx) => ({
      No: idx + 1,
      'Tahun Anggaran': b.tahun,
      'Jenis Fasilitas': b.jenisFasilitas,
      'Kode Seri': b.kodeHuruf,
      'Tipe Batch': b.isReturBatch ? 'Batch Retur' : 'Batch Utama',
      'Rentang Nomor Seri Masuk': formatSeriRange(b.kodeHuruf, b.angkaMulai, b.angkaSampai),
      'Jumlah Masuk (Lembar)': Number(b.totalAwal) || 0,
      'Volume (Bendel)': toBendelLembar(b.totalAwal).shortFormatted,
      'Sisa Saat Ini (Lembar)': Number(b.sisaStok) || 0,
      'Posisi Seri Sisa':
        Number(b.sisaStok) > 0
          ? formatSeriRange(b.kodeHuruf, b.angkaSisaMulai, b.angkaSampai)
          : 'HABIS',
      'Tarif Satuan (Rp)': Number(b.tarifSatuan) || 0,
      'Nilai Potensi (Rp)': (Number(b.totalAwal) || 0) * (Number(b.tarifSatuan) || 0)
    }));

    const wsIn = window.XLSX.utils.json_to_sheet(
      inRows.length > 0 ? inRows : [{ Info: 'Tidak ada data pemasukan karcis' }]
    );
    window.XLSX.utils.book_append_sheet(wb, wsIn, 'Pemasukan Karcis');
  }

  // Sheet 2: Rekapitulasi Pengeluaran Karcis & Setoran
  if (type === 'ALL' || type === 'PENGELUARAN') {
    const outRows = pengeluaranList.map((d, idx) => ({
      No: idx + 1,
      Tanggal: d.tanggal,
      'Petugas Penerima': d.penerima,
      'Jenis Fasilitas': d.jenisFasilitas,
      'Tarif Satuan (Rp)': Number(d.tarifSatuan) || 0,
      'Nomor Seri Keluar': d.seriKeluar,
      'Jumlah Keluar (Lembar)': Number(d.jumlahKeluar) || 0,
      'Nomor Seri Terpakai': d.seriTerjual,
      'Jumlah Terpakai (Lembar)': Number(d.jumlahTerjual) || 0,
      'Nomor Seri Retur': d.seriRetur || '-',
      'Jumlah Retur (Lembar)': Number(d.jumlahRetur) || 0,
      'Total Nominal Setoran (Rp)': Number(d.totalNominal) || 0,
      'Status Setoran': d.statusSetoran,
      Catatan: d.catatan || ''
    }));

    const wsOut = window.XLSX.utils.json_to_sheet(
      outRows.length > 0 ? outRows : [{ Info: 'Tidak ada data pengeluaran karcis' }]
    );
    window.XLSX.utils.book_append_sheet(wb, wsOut, 'Pengeluaran & Retribusi');
  }

  const fileName = `Rekapitulasi_Karcis_TA_${state.tahun}_${getTodayISO()}.xlsx`;
  if (typeof window !== 'undefined' && window.AndroidBridge && typeof window.AndroidBridge.saveBase64File === 'function') {
    const b64 = window.XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
    window.AndroidBridge.saveBase64File(
      fileName,
      b64,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    showToast('success', 'File Excel Siap Dibagikan', `File ${fileName} berhasil diekspor di Android.`);
  } else {
    window.XLSX.writeFile(wb, fileName);
    showToast('success', 'File Excel Berhasil Diunduh', `Laporan disimpan sebagai ${fileName}.`);
  }
}

/* ==========================================================================
   18. EVENT LISTENERS & INISIALISASI APLIKASI
   ========================================================================== */

function bindEvents() {
  // Sidebar Mobile Toggle
  document.getElementById('btn-open-sidebar')?.addEventListener('click', openMobileSidebar);
  document.getElementById('btn-close-sidebar')?.addEventListener('click', closeMobileSidebar);
  document.getElementById('mobile-sidebar-backdrop')?.addEventListener('click', closeMobileSidebar);

  // Navigasi Sidebar
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-nav');
      if (target) switchView(target);
    });
  });

  // Delegated Click Handler untuk tombol dinamis di seluruh halaman
  document.addEventListener('click', (e) => {
    const jumpBtn = e.target.closest('[data-jump-nav]');
    if (jumpBtn) {
      switchView(jumpBtn.getAttribute('data-jump-nav'));
      return;
    }

    const approveUserBtn = e.target.closest('[data-user-approve]');
    if (approveUserBtn) {
      handleUserStatusDecision(approveUserBtn.getAttribute('data-user-approve'), 'approved');
      return;
    }

    const rejectUserBtn = e.target.closest('[data-user-reject]');
    if (rejectUserBtn) {
      handleUserStatusDecision(rejectUserBtn.getAttribute('data-user-reject'), 'rejected');
      return;
    }

    const delUserBtn = e.target.closest('[data-user-delete]');
    if (delUserBtn) {
      handleDeleteUser(delUserBtn.getAttribute('data-user-delete'));
      return;
    }

    const approveReqBtn = e.target.closest('[data-req-approve]');
    if (approveReqBtn) {
      openApproveRequestModal(approveReqBtn.getAttribute('data-req-approve'));
      return;
    }

    const rejectReqBtn = e.target.closest('[data-req-reject]');
    if (rejectReqBtn) {
      openRejectRequestModal(rejectReqBtn.getAttribute('data-req-reject'));
      return;
    }

    const openReturBtn = e.target.closest('[data-open-retur]');
    if (openReturBtn) {
      openReturModal(openReturBtn.getAttribute('data-open-retur'));
      return;
    }

    const delDistBtn = e.target.closest('[data-delete-dist]');
    if (delDistBtn) {
      handleDeleteDistribusi(delDistBtn.getAttribute('data-delete-dist'));
      return;
    }

    const delStokBtn = e.target.closest('[data-delete-stok]');
    if (delStokBtn) {
      handleDeleteStockBatch(delStokBtn.getAttribute('data-delete-stok'));
      return;
    }

    const prefillLowBtn = e.target.closest('[data-prefill-stok-name]');
    if (prefillLowBtn) {
      prefillStockForm({
        namaFasilitas: prefillLowBtn.getAttribute('data-prefill-stok-name') || '',
        kodeHuruf: prefillLowBtn.getAttribute('data-prefill-stok-kode') || '',
        tarifSatuan: Number(prefillLowBtn.getAttribute('data-prefill-stok-tarif') || 0)
      });
      return;
    }

    const editFacBtn = e.target.closest('[data-edit-fac]');
    if (editFacBtn) {
      openFacilityModal(editFacBtn.getAttribute('data-edit-fac'));
      return;
    }

    const delFacBtn = e.target.closest('[data-delete-fac]');
    if (delFacBtn) {
      handleDeleteFacility(delFacBtn.getAttribute('data-delete-fac'));
      return;
    }

    const delLogBtn = e.target.closest('[data-delete-log]');
    if (delLogBtn) {
      handleDeleteLogs(delLogBtn.getAttribute('data-delete-log'));
      return;
    }
  });

  // Tahun Anggaran Selector
  const tahunSelect = document.getElementById('select-tahun-anggaran');
  if (tahunSelect) {
    tahunSelect.value = state.tahun;
    tahunSelect.addEventListener('change', () => {
      state.tahun = tahunSelect.value;
      localStorage.setItem(LS_TAHUN_KEY, state.tahun);
      attachRealtimeListeners();
      showToast('info', `Tahun Anggaran ${state.tahun}`, `Menampilkan data karcis untuk Tahun Anggaran ${state.tahun}.`);
    });
  }

  // Tombol Sinkronisasi Cloud Langsung (Desktop & Android)
  document.getElementById('btn-manual-cloud-sync')?.addEventListener('click', async () => {
    const icon = document.getElementById('icon-manual-cloud-sync');
    if (icon) icon.classList.add('animate-spin');
    try {
      if (isFirebaseConfigured()) {
        if (state.mode !== 'cloud') {
          state.mode = 'cloud';
          attachRealtimeListeners();
        }
        await syncCloudDataSilently(true);
        showToast('success', 'Data Tersinkronisasi', 'Data Desktop & Aplikasi Android telah diperbarui dari Cloud.');
      } else {
        refreshLocalState();
        showToast('info', 'Data Lokal Diperbarui', 'Status data lokal telah disegarkan.');
      }
    } finally {
      setTimeout(() => {
        if (icon) icon.classList.remove('animate-spin');
      }, 450);
    }
  });

  // Tombol Notifikasi Stok Menipis di Topbar
  document.getElementById('btn-topbar-lowstock')?.addEventListener('click', () => {
    switchView('stok');
  });

  // Tombol Logout
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    const ok = await showConfirmModal({
      title: 'Keluar dari SI-KARCIS?',
      message: 'Sesi Anda akan diakhiri dan Anda akan kembali ke halaman masuk.',
      confirmText: 'Ya, Keluar',
      variant: 'danger'
    });
    if (!ok) return;

    detachAllListeners();
    if (state.mode === 'cloud' && auth) {
      try {
        await signOut(auth);
      } catch (err) {
        console.warn('Error signOut:', err);
      }
    }
    localStorage.removeItem(LS_SESSION_KEY);
    window.location.replace('./index.html');
  });

  // Toggle Mode Grafik Komposisi
  const btnDoughnut = document.getElementById('btn-chart-mode-doughnut');
  const btnBar = document.getElementById('btn-chart-mode-bar');
  btnDoughnut?.addEventListener('click', () => {
    state.compositionChartMode = 'doughnut';
    btnDoughnut.className = 'px-2.5 py-1 rounded-lg bg-white text-slate-900 shadow-2xs transition';
    if (btnBar) btnBar.className = 'px-2.5 py-1 rounded-lg text-slate-600 hover:text-slate-900 transition';
    updateCharts();
  });
  btnBar?.addEventListener('click', () => {
    state.compositionChartMode = 'bar';
    btnBar.className = 'px-2.5 py-1 rounded-lg bg-white text-slate-900 shadow-2xs transition';
    if (btnDoughnut) btnDoughnut.className = 'px-2.5 py-1 rounded-lg text-slate-600 hover:text-slate-900 transition';
    updateCharts();
  });

  // Modal Konfirmasi
  document.getElementById('btn-confirm-ok')?.addEventListener('click', () => closeConfirmModal(true));
  document.getElementById('btn-confirm-cancel')?.addEventListener('click', () => closeConfirmModal(false));

  // Modal Riwayat Aktivitas (termasuk checklist & hapus persatuan)
  const openLogsModal = () => {
    renderAuditLogsUI();
    document.getElementById('modal-logs')?.classList.remove('hidden');
  };
  document.getElementById('btn-open-audit-modal')?.addEventListener('click', openLogsModal);
  document.getElementById('btn-dashboard-all-logs')?.addEventListener('click', openLogsModal);
  document.getElementById('btn-close-logs-modal')?.addEventListener('click', () => {
    document.getElementById('modal-logs')?.classList.add('hidden');
  });
  document.getElementById('filter-logs-search')?.addEventListener('input', (e) => {
    state.filters.logsSearch = e.target.value || '';
    renderAuditLogsUI();
  });
  document.getElementById('modal-logs-body')?.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-log-checkbox]');
    if (!cb) return;
    const logId = cb.getAttribute('data-log-checkbox');
    if (!logId) return;
    if (cb.checked) {
      state.selectedLogIds.add(logId);
    } else {
      state.selectedLogIds.delete(logId);
    }
    const row = cb.closest('div.py-3');
    if (row) {
      row.classList.toggle('bg-rose-50/40', cb.checked);
    }
    updateLogsSelectionUI();
  });
  document.getElementById('btn-clear-log-selection')?.addEventListener('click', () => {
    state.selectedLogIds.clear();
    renderAuditLogsUI();
  });
  document.getElementById('btn-delete-selected-logs')?.addEventListener('click', () => {
    handleDeleteLogs(Array.from(state.selectedLogIds));
  });

  // Filter Antrean Permintaan Karcis (Admin)
  document.getElementById('filter-admin-req-status')?.addEventListener('change', (e) => {
    state.filters.adminReq.status = e.target.value;
    renderAdminRequestsQueue();
  });

  // Modal Persetujuan & Penolakan Permintaan Karcis (Admin)
  document.getElementById('approve-req-stock')?.addEventListener('change', updateApproveRequestModalPreview);
  document.getElementById('form-approve-request')?.addEventListener('submit', handleApproveRequestSubmit);
  document.getElementById('btn-close-approve-modal')?.addEventListener('click', () => {
    document.getElementById('modal-approve-request')?.classList.add('hidden');
  });
  document.getElementById('btn-cancel-approve-modal')?.addEventListener('click', () => {
    document.getElementById('modal-approve-request')?.classList.add('hidden');
  });

  document.getElementById('form-reject-request')?.addEventListener('submit', handleRejectRequestSubmit);
  document.getElementById('btn-close-reject-modal')?.addEventListener('click', () => {
    document.getElementById('modal-reject-request')?.classList.add('hidden');
  });
  document.getElementById('btn-cancel-reject-modal')?.addEventListener('click', () => {
    document.getElementById('modal-reject-request')?.classList.add('hidden');
  });

  // Form Pengajuan Permintaan Karcis (Oleh User)
  const reqDateInput = document.getElementById('req-tanggal');
  if (reqDateInput && !reqDateInput.value) reqDateInput.value = getTodayISO();
  document.getElementById('req-facility')?.addEventListener('change', updateUserRequestPreview);
  document.getElementById('req-jumlah')?.addEventListener('input', updateUserRequestPreview);
  document.getElementById('form-user-request')?.addEventListener('submit', handleUserRequestSubmit);

  // Form Pengembalian Karcis Langsung dari Petugas ke Admin
  document.getElementById('user-retur-batch')?.addEventListener('change', updateUserDirectReturPreview);
  document.getElementById('user-retur-jumlah-input')?.addEventListener('input', updateUserDirectReturPreview);
  document.getElementById('form-user-retur-direct')?.addEventListener('submit', handleUserDirectReturSubmit);

  // Form Pengeluaran Langsung (Oleh Admin)
  const distDateInput = document.getElementById('dist-tanggal');
  if (distDateInput && !distDateInput.value) distDateInput.value = getTodayISO();
  document.getElementById('dist-facility')?.addEventListener('change', populateDistStockSelect);
  document.getElementById('dist-stock')?.addEventListener('change', renderDistribusiLivePreview);
  document.getElementById('dist-jumlah')?.addEventListener('input', renderDistribusiLivePreview);
  document.getElementById('form-distribusi')?.addEventListener('submit', handleDistribusiSubmit);
  document.getElementById('btn-reset-distribusi')?.addEventListener('click', () => {
    setTimeout(() => {
      if (distDateInput) distDateInput.value = getTodayISO();
      populateDistStockSelect();
    }, 10);
  });

  // Filter Tabel Distribusi
  document.getElementById('filter-dist-search')?.addEventListener('input', (e) => {
    state.filters.dist.search = e.target.value || '';
    state.filters.dist.page = 1;
    renderDistribusiTable();
  });
  document.getElementById('filter-dist-facility')?.addEventListener('change', (e) => {
    state.filters.dist.facilityId = e.target.value;
    state.filters.dist.page = 1;
    renderDistribusiTable();
  });
  document.getElementById('filter-dist-status')?.addEventListener('change', (e) => {
    state.filters.dist.status = e.target.value;
    state.filters.dist.page = 1;
    renderDistribusiTable();
  });
  document.getElementById('filter-dist-perpage')?.addEventListener('change', (e) => {
    state.filters.dist.perPage = parseInt(e.target.value, 10) || 10;
    state.filters.dist.page = 1;
    renderDistribusiTable();
  });

  // Modal Retur / Pengembalian Sisa Seri
  document.getElementById('retur-jumlah')?.addEventListener('input', updateReturModalPreview);
  document.getElementById('form-retur')?.addEventListener('submit', handleReturSubmit);
  document.getElementById('btn-close-retur-modal')?.addEventListener('click', () => {
    document.getElementById('modal-retur')?.classList.add('hidden');
  });
  document.getElementById('btn-cancel-retur-modal')?.addEventListener('click', () => {
    document.getElementById('modal-retur')?.classList.add('hidden');
  });

  // Form Gudang Stok (Admin: input fasilitas manual/terdaftar, tarif manual & seri)
  document.getElementById('stok-facility-name')?.addEventListener('input', () => {
    handleStokFacilityNameChange({ forceSuggest: false });
  });
  document.getElementById('stok-facility-name')?.addEventListener('change', () => {
    handleStokFacilityNameChange({ forceSuggest: true });
  });
  document.getElementById('stok-tarif')?.addEventListener('input', (e) => {
    const val = (e.target.value || '').trim();
    if (val === '') {
      delete e.target.dataset.manualEdited;
      delete e.target.dataset.autofilled;
    } else {
      e.target.dataset.manualEdited = 'true';
      delete e.target.dataset.autofilled;
    }
    renderStokSummaryAndPreview();
  });
  document.getElementById('stok-kode')?.addEventListener('input', (e) => {
    const val = (e.target.value || '').trim();
    if (val === '') {
      delete e.target.dataset.manualEdited;
      delete e.target.dataset.autofilled;
    } else {
      e.target.dataset.manualEdited = 'true';
      delete e.target.dataset.autofilled;
    }
    updateStokMatchHint();
    renderStokSummaryAndPreview();
  });
  document.getElementById('stok-mulai')?.addEventListener('input', (e) => {
    delete e.target.dataset.autofilled;
    e.target.dataset.manualEdited = 'true';
    renderStokSummaryAndPreview();
  });
  document.getElementById('stok-sampai')?.addEventListener('input', (e) => {
    delete e.target.dataset.autofilled;
    e.target.dataset.manualEdited = 'true';
    renderStokSummaryAndPreview();
  });
  document.getElementById('btn-stok-suggest-next')?.addEventListener('click', suggestNextStockSerial);
  document.getElementById('form-stok')?.addEventListener('submit', handleStokSubmit);
  document.getElementById('btn-reset-stok')?.addEventListener('click', () => {
    setTimeout(() => {
      resetStokFormHelperState();
      renderStokSummaryAndPreview();
    }, 10);
  });

  // Filter Tabel Stok
  document.getElementById('filter-stok-search')?.addEventListener('input', (e) => {
    state.filters.stok.search = e.target.value || '';
    state.filters.stok.page = 1;
    renderStokTable();
  });
  document.getElementById('filter-stok-facility')?.addEventListener('change', (e) => {
    state.filters.stok.facilityId = e.target.value;
    state.filters.stok.page = 1;
    renderStokTable();
  });
  document.getElementById('filter-stok-status')?.addEventListener('change', (e) => {
    state.filters.stok.status = e.target.value;
    state.filters.stok.page = 1;
    renderStokTable();
  });
  document.getElementById('filter-stok-perpage')?.addEventListener('change', (e) => {
    state.filters.stok.perPage = parseInt(e.target.value, 10) || 10;
    state.filters.stok.page = 1;
    renderStokTable();
  });

  // Master Fasilitas (Admin)
  document.getElementById('btn-add-facility')?.addEventListener('click', () => openFacilityModal(null));
  document.getElementById('form-facility')?.addEventListener('submit', handleFacilitySubmit);
  document.getElementById('btn-close-facility-modal')?.addEventListener('click', () => {
    document.getElementById('modal-facility')?.classList.add('hidden');
  });
  document.getElementById('btn-cancel-facility-modal')?.addEventListener('click', () => {
    document.getElementById('modal-facility')?.classList.add('hidden');
  });
  document.getElementById('filter-fac-search')?.addEventListener('input', (e) => {
    state.filters.fac.search = e.target.value || '';
    renderFacilitiesTable();
  });

  // Filter Kelola Akun User (Admin)
  document.getElementById('filter-users-search')?.addEventListener('input', (e) => {
    state.filters.users.search = e.target.value || '';
    renderUsersView();
  });
  document.getElementById('filter-users-status')?.addEventListener('change', (e) => {
    state.filters.users.status = e.target.value;
    renderUsersView();
  });

  // Filter Laporan & Cetak Rekapitulasi Pemasukan / Pengeluaran
  document.getElementById('rep-type')?.addEventListener('change', (e) => {
    state.filters.rep.type = e.target.value;
    renderReportView();
  });
  document.getElementById('rep-start-date')?.addEventListener('change', (e) => {
    state.filters.rep.startDate = e.target.value || '';
    renderReportView();
  });
  document.getElementById('rep-end-date')?.addEventListener('change', (e) => {
    state.filters.rep.endDate = e.target.value || '';
    renderReportView();
  });
  document.getElementById('rep-facility')?.addEventListener('change', (e) => {
    state.filters.rep.facilityId = e.target.value;
    renderReportView();
  });
  document.getElementById('rep-status')?.addEventListener('change', (e) => {
    state.filters.rep.status = e.target.value;
    renderReportView();
  });

  document.getElementById('btn-rep-range-month')?.addEventListener('click', () => {
    const now = new Date();
    const y = state.tahun || String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Number(y), now.getMonth() + 1, 0).getDate();
    const start = `${y}-${m}-01`;
    const end = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
    state.filters.rep.startDate = start;
    state.filters.rep.endDate = end;
    const sEl = document.getElementById('rep-start-date');
    const eEl = document.getElementById('rep-end-date');
    if (sEl) sEl.value = start;
    if (eEl) eEl.value = end;
    renderReportView();
  });

  document.getElementById('btn-rep-range-year')?.addEventListener('click', () => {
    const start = `${state.tahun}-01-01`;
    const end = `${state.tahun}-12-31`;
    state.filters.rep.startDate = start;
    state.filters.rep.endDate = end;
    const sEl = document.getElementById('rep-start-date');
    const eEl = document.getElementById('rep-end-date');
    if (sEl) sEl.value = start;
    if (eEl) eEl.value = end;
    renderReportView();
  });

  document.getElementById('btn-rep-range-clear')?.addEventListener('click', () => {
    state.filters.rep.startDate = '';
    state.filters.rep.endDate = '';
    const sEl = document.getElementById('rep-start-date');
    const eEl = document.getElementById('rep-end-date');
    if (sEl) sEl.value = '';
    if (eEl) eEl.value = '';
    renderReportView();
  });

  document.getElementById('btn-save-signatories')?.addEventListener('click', () => saveSignatories(false));
  document.getElementById('btn-print-report')?.addEventListener('click', handlePrintReport);
  document.getElementById('btn-export-excel')?.addEventListener('click', handleExportExcel);

  // Sinkronisasi antar-tab jika menggunakan mode lokal
  window.addEventListener('storage', () => {
    if (state.mode === 'local') {
      refreshLocalState();
    }
  });
}

function setupAndroidNativeAndPwaDashboard() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const isAndroidNative = Boolean(
    window.AndroidBridge || /SIKarcisAndroid/i.test(navigator.userAgent || '')
  );
  const dlSidebarBtn = document.getElementById('btn-download-apk-sidebar');

  if (isAndroidNative && dlSidebarBtn) {
    dlSidebarBtn.classList.add('hidden');
  }
  if (isAndroidNative && 'serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
  }

  // Handler Tombol Back Hardware Android
  window.sikarcisHandleBackPress = function () {
    const modalIds = [
      'modal-confirm',
      'modal-logs',
      'modal-facility',
      'modal-retur',
      'modal-approve-request',
      'modal-reject-request'
    ];
    for (const id of modalIds) {
      const m = document.getElementById(id);
      if (m && !m.classList.contains('hidden')) {
        if (id === 'modal-confirm') {
          closeConfirmModal(false);
        } else {
          m.classList.add('hidden');
        }
        return true;
      }
    }

    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('-translate-x-full')) {
      closeMobileSidebar();
      return true;
    }

    if (state.currentUser?.role === 'admin' && state.activeView !== 'dashboard') {
      switchView('dashboard');
      return true;
    }

    return false;
  };

  if (
    !isAndroidNative &&
    'serviceWorker' in navigator &&
    location.protocol.startsWith('http') &&
    location.hostname !== 'appassets.androidplatform.net'
  ) {
    let swRefreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!swRefreshing && !location.search.includes('v=1.2.4')) {
        swRefreshing = true;
        window.location.replace('./dashboard.html?v=1.2.4');
      }
    });
    navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});
  }
}

async function initAuthAndBoot() {
  if (typeof document === 'undefined') return;

  setupAndroidNativeAndPwaDashboard();
  loadSignatories();
  bindEvents();

  async function bootWithSession() {
    let session = null;
    try {
      session = JSON.parse(localStorage.getItem(LS_SESSION_KEY) || 'null');
    } catch {
      session = null;
    }

    if (!session || !session.email) {
      window.location.replace('./index.html');
      return false;
    }

    // Jika Firebase Cloud aktif, verifikasi sesi langsung ke Cloud Firestore & aktifkan sinkronisasi otomatis
    if (isFirebaseConfigured()) {
      try {
        await migrateLocalDataToCloudOnce();
        const usersSnap = await getDocs(collection(db, COL_USERS));
        const cloudUsers = [];
        usersSnap.forEach((docSnap) => {
          const d = docSnap.data() || {};
          cloudUsers.push({ ...d, uid: d.uid || docSnap.id, id: docSnap.id });
        });

        let freshUser =
          cloudUsers.find(
            (u) =>
              (u.uid && session.uid && u.uid === session.uid) ||
              String(u.email || '').toLowerCase() === String(session.email).toLowerCase()
          ) || null;

        if (!freshUser && isAdminEmail(session.email)) {
          freshUser = {
            uid: session.uid || 'admin_default_uid',
            nama: DEFAULT_ADMIN_ACCOUNT.nama,
            nip: DEFAULT_ADMIN_ACCOUNT.nip,
            unitTugas: DEFAULT_ADMIN_ACCOUNT.unitTugas,
            noHp: DEFAULT_ADMIN_ACCOUNT.noHp,
            email: DEFAULT_ADMIN_ACCOUNT.email.toLowerCase(),
            password: DEFAULT_ADMIN_ACCOUNT.password,
            role: 'admin',
            status: 'approved'
          };
          await setDoc(
            doc(db, COL_USERS, freshUser.uid),
            {
              ...freshUser,
              createdAt: new Date().toISOString()
            },
            { merge: true }
          );
        }

        if (!freshUser || (freshUser.role !== 'admin' && freshUser.status !== 'approved')) {
          localStorage.removeItem(LS_SESSION_KEY);
          window.location.replace('./index.html');
          return false;
        }

        state.mode = 'cloud';
        state.currentUser = freshUser;
        localStorage.setItem(LS_SESSION_KEY, JSON.stringify(freshUser));
        hideAuthGuardScreen();
        applyRoleAccessUI();
        attachRealtimeListeners();
        return true;
      } catch (cloudErr) {
        console.warn('Cloud Firestore sedang offline, beralih ke cache lokal:', cloudErr);
      }
    }

    ensureLocalDataSeeded();
    const users = readLocalArray(LS_USERS_KEY);
    const freshUser =
      users.find(
        (u) =>
          (u.uid && session.uid && u.uid === session.uid) ||
          String(u.email || '').toLowerCase() === String(session.email).toLowerCase()
      ) ||
      (isAdminEmail(session.email)
        ? {
            uid: session.uid || 'local-admin-001',
            nama: DEFAULT_ADMIN_ACCOUNT.nama,
            nip: DEFAULT_ADMIN_ACCOUNT.nip,
            unitTugas: DEFAULT_ADMIN_ACCOUNT.unitTugas,
            noHp: DEFAULT_ADMIN_ACCOUNT.noHp,
            email: DEFAULT_ADMIN_ACCOUNT.email.toLowerCase(),
            role: 'admin',
            status: 'approved'
          }
        : null);

    if (!freshUser || (freshUser.role !== 'admin' && freshUser.status !== 'approved')) {
      localStorage.removeItem(LS_SESSION_KEY);
      window.location.replace('./index.html');
      return false;
    }

    state.mode = 'local';
    state.currentUser = freshUser;
    hideAuthGuardScreen();
    applyRoleAccessUI();
    attachRealtimeListeners();
    return true;
  }

  await bootWithSession();
}

if (typeof document !== 'undefined') {
  initAuthAndBoot();
}
