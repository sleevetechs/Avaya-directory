const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

const JS_FILES = [
  'server.js',
  'app.js',
  'sw.js',
  'register-sw.js',
  'scripts/init-local-db.js',
  'scripts/build.js',
];

const REQUIRED_FILES = [
  'server.js',
  'package.json',
  'package-lock.json',
  'index.html',
  'login.html',
  'admin.html',
  'superadmin.html',
  'app.js',
  'logo.png',
  'favicon.svg',
  'manifest.webmanifest',
  'sw.js',
  'register-sw.js',
];

const REQUIRED_ICONS = [
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png',
];

const COPY_PATHS = [
  'server.js',
  'package.json',
  'package-lock.json',
  'index.html',
  'login.html',
  'admin.html',
  'superadmin.html',
  'app.js',
  'logo.png',
  'favicon.svg',
  'manifest.webmanifest',
  'sw.js',
  'register-sw.js',
  'web.config',
  'icons',
];

function fail(message) {
  console.error('BUILD FAILED:', message);
  process.exit(1);
}

function step(label) {
  console.log('→', label);
}

function ensure(condition, message) {
  if (!condition) fail(message);
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

step('Checking required files');
for (const rel of [...REQUIRED_FILES, ...REQUIRED_ICONS]) {
  const abs = path.join(root, rel);
  ensure(fs.existsSync(abs), `Missing required file: ${rel}`);
}

step('Validating manifest.webmanifest');
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  ensure(typeof manifest.name === 'string' && manifest.name.length > 0, 'manifest.name is required');
  ensure(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest.icons is required');
} catch (err) {
  fail(`Invalid manifest.webmanifest: ${err.message}`);
}

step('Syntax-checking JavaScript');
for (const rel of JS_FILES) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) continue;
  try {
    execSync(`node --check "${abs}"`, { stdio: 'pipe' });
  } catch (err) {
    fail(`Syntax error in ${rel}`);
  }
}

step('Preparing dist/');
if (fs.existsSync(dist)) {
  fs.rmSync(dist, { recursive: true, force: true });
}
fs.mkdirSync(dist, { recursive: true });

for (const rel of COPY_PATHS) {
  const src = path.join(root, rel);
  const dest = path.join(dist, rel);
  ensure(fs.existsSync(src), `Missing copy source: ${rel}`);
  copyRecursive(src, dest);
}

step('Installing production dependencies in dist/');
execSync('npm ci --omit=dev', { cwd: dist, stdio: 'inherit' });

step('Verifying dist/server.js');
execSync(`node --check "${path.join(dist, 'server.js')}"`, { stdio: 'pipe' });

const distSize = fs.readdirSync(dist).length;
console.log('');
console.log('BUILD OK');
console.log(`Output: ${dist}`);
console.log(`Top-level items: ${distSize}`);
console.log('Upload dist/ contents to your Node app root on cPanel, then Restart the app.');
