/**
 * Sinkronisasi aset web (index.html, dashboard.html, css/, js/, assets/)
 * ke dalam proyek Android Native (android/app/src/main/assets/www/)
 * serta ikon peluncur aplikasi dari assets/logo-kab-malang.png.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const androidWwwDir = path.join(rootDir, 'android', 'app', 'src', 'main', 'assets', 'www');
const androidResDir = path.join(rootDir, 'android', 'app', 'src', 'main', 'res');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(androidWwwDir, { recursive: true, force: true });
fs.mkdirSync(androidWwwDir, { recursive: true });

const rootFiles = ['index.html', 'dashboard.html', 'manifest.webmanifest', 'sw.js'];
for (const file of rootFiles) {
  const srcPath = path.join(rootDir, file);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, path.join(androidWwwDir, file));
  }
}

const dirs = ['css', 'js', 'assets'];
for (const dir of dirs) {
  const srcDir = path.join(rootDir, dir);
  if (fs.existsSync(srcDir)) {
    copyRecursive(srcDir, path.join(androidWwwDir, dir));
  }
}

// Salin ikon aplikasi SI-KARCIS ke drawable Android (adaptive icon) dan pertahankan mipmap presisi
const drawableDir = path.join(androidResDir, 'drawable');
fs.mkdirSync(drawableDir, { recursive: true });
for (const legacyDrawable of ['ic_launcher_foreground.xml', 'ic_launcher_logo.png']) {
  const legacyPath = path.join(drawableDir, legacyDrawable);
  if (fs.existsSync(legacyPath)) {
    fs.rmSync(legacyPath, { force: true });
  }
}

const fgSrc = path.join(rootDir, 'assets', 'app-icon-adaptive-fg.png');
const bgSrc = path.join(rootDir, 'assets', 'app-icon-adaptive-bg.png');
if (fs.existsSync(fgSrc)) {
  fs.copyFileSync(fgSrc, path.join(drawableDir, 'ic_launcher_foreground.png'));
}
if (fs.existsSync(bgSrc)) {
  fs.copyFileSync(bgSrc, path.join(drawableDir, 'ic_launcher_bg.png'));
}

// Fallback isi mipmap hanya jika belum ada (agar mipmap presisi multi-DPI tidak tertimpa)
const fallbackIcon = path.join(rootDir, 'assets', 'app-icon-192.png');
if (fs.existsSync(fallbackIcon)) {
  const mipmapDirs = ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'];
  for (const mDir of mipmapDirs) {
    const targetDir = path.join(androidResDir, mDir);
    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const targetFile = path.join(targetDir, file);
      if (!fs.existsSync(targetFile)) {
        fs.copyFileSync(fallbackIcon, targetFile);
      }
    }
  }
}

console.log('[OK] Aset web & ikon Android berhasil disinkronkan ke android/app/src/main/assets/www/');
