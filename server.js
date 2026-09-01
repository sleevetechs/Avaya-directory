const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

(function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

// ── File-based debug logging (writes to debug.log, never to console) ──
// On the cPanel server this writes to the absolute path below.
// On Windows (local dev) it falls back to ./debug.log so it can be tested locally.
const LOG_FILE = (() => {
  if (process.platform === 'win32') return path.join(__dirname, 'debug.log');
  try {
    if (fs.existsSync('/home/compas30/new-avaya-app')) {
      return '/home/compas30/new-avaya-app/debug.log';
    }
  } catch (e) { /* ignore */ }
  return path.join(__dirname, 'debug.log');
})();

function debug(message, data = null) {
  try {
    let output = '[' + new Date().toISOString() + '] ' + message;

    if (data !== null) {
      if (data instanceof Error) {
        output += '\n' + (data.stack || data.message);
      } else if (typeof data === 'object') {
        output += '\n' + JSON.stringify(data, null, 2);
      } else {
        output += ' ' + data;
      }
    }

    fs.appendFileSync(LOG_FILE, output + '\n');
  } catch (err) {
    // Never allow logging failure to crash the application
  }
}

debug('========================================');
debug('SERVER STARTING');
debug('========================================');
debug('Server file: ' + __filename);
debug('Application directory: ' + __dirname);
debug('Node version: ' + process.version);
debug('Environment: ' + (process.env.NODE_ENV || 'not set'));
debug('PORT: ' + (process.env.PORT || 'not set'));
debug('LOG_FILE: ' + LOG_FILE);

// ── Module loading (each require logged; a failure aborts with the module named) ──
debug('Loading modules');
let express;
try {
  express = require('express');
  debug('express loaded successfully');
} catch (err) {
  debug('express FAILED', err);
  throw err;
}

let mysql;
try {
  mysql = require('mysql2/promise');
  debug('mysql2 loaded successfully');
} catch (err) {
  debug('mysql2 FAILED', err);
  throw err;
}

let jwt;
try {
  jwt = require('jsonwebtoken');
  debug('jsonwebtoken loaded successfully');
} catch (err) {
  debug('jsonwebtoken FAILED', err);
  throw err;
}

let CryptoJS;
try {
  CryptoJS = require('crypto-js');
  debug('crypto-js loaded successfully');
} catch (err) {
  debug('crypto-js FAILED', err);
  throw err;
}

let ExcelJS;
try {
  ExcelJS = require('exceljs');
  debug('exceljs loaded successfully');
} catch (err) {
  debug('exceljs FAILED', err);
  throw err;
}

const app = express();
debug('Express app created');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'compass-directory-secret-key-2024';
debug('Environment configuration loaded');
debug('JWT_SECRET configured: ' + Boolean(process.env.JWT_SECRET));
const PRIMARY_SUPER_ADMIN_EMAIL = 'super-admin@compasslog.com';

function isPrimarySuperAdmin(admin) {
  return String(admin?.email || '').trim().toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL;
}
// Needed behind cPanel / reverse proxies so req.ip and X-Forwarded-For work
app.set('trust proxy', true);

debug('Database configuration loaded');
debug('DB_HOST configured: ' + Boolean(process.env.DB_HOST));
debug('DB_NAME configured: ' + Boolean(process.env.DB_NAME));
debug('DB_USER configured: ' + Boolean(process.env.DB_USER));
debug('DB_PASSWORD configured: ' + Boolean(process.env.DB_PASSWORD));
debug('Using DB host: ' + (process.env.DB_HOST || 'localhost'));
debug('Using DB name: ' + (process.env.DB_NAME || 'avaya_list'));
debug('Using DB user: ' + (process.env.DB_USER || 'root'));

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'avaya_list',
  waitForConnections: true,
  connectionLimit: 10,
  // Optional TLS for remote MySQL hosts (e.g. TiDB Cloud): set DB_SSL=1 in env
  ...(process.env.DB_SSL === '1' || process.env.DB_SSL === 'true'
    ? { ssl: { rejectUnauthorized: false } }
    : {}),
});
debug('Database pool created');

const UNCATEGORISED_DEPT = 'Uncategorised';

async function ensureDepartmentsTable() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS departments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_department_name (name)
    )
  `);
  // Seed any depts already used on employees
  await pool.execute(`
    INSERT IGNORE INTO departments (name)
    SELECT DISTINCT TRIM(dept) FROM employees
    WHERE deleted_at IS NULL AND dept IS NOT NULL AND TRIM(dept) <> ''
  `);
  await pool.execute('INSERT IGNORE INTO departments (name) VALUES (?)', [UNCATEGORISED_DEPT]);
}

/** Station a backoffice person supports (Dubai, Dammam, Jeddah, Qatar…) — independent of where they sit. */
async function ensureWorksForStationColumn() {
  try {
    await pool.execute(`
      ALTER TABLE employees
      ADD COLUMN works_for_station VARCHAR(100) NOT NULL DEFAULT ''
      AFTER station_name
    `);
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
}

async function ensureAdminRoleColumn() {
  const [cols] = await pool.execute(
    `SELECT COLUMN_TYPE AS column_type
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admins' AND COLUMN_NAME = 'role'`
  );
  if (!cols.length) return;
  const colType = String(cols[0].column_type || '').toLowerCase();
  if (colType !== 'varchar(32)') {
    await pool.execute(
      `ALTER TABLE admins MODIFY COLUMN role VARCHAR(32) NOT NULL DEFAULT 'admin'`
    );
  }
}

async function ensureAdminNameEditColumn() {
  try {
    await pool.execute(
      `ALTER TABLE admins ADD COLUMN can_edit_employee_names TINYINT(1) NOT NULL DEFAULT 0`
    );
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e;
  }
}

async function adminCanEditEmployeeName(admin) {
  if (!admin || !admin.id) return false;
  if (admin.role === 'super_admin') return true;
  if (admin.can_edit_employee_names !== undefined) {
    return !!admin.can_edit_employee_names;
  }
  const [rows] = await pool.execute(
    'SELECT role, can_edit_employee_names FROM admins WHERE id = ? AND is_active = 1',
    [admin.id]
  );
  if (!rows.length) return false;
  if (rows[0].role === 'super_admin') return true;
  return !!rows[0].can_edit_employee_names;
}

function adminPayloadFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    can_edit_employee_names: row.role === 'super_admin' || !!row.can_edit_employee_names,
  };
}

function normalizeWorksForStation(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || /^none$/i.test(s) || s === '—') return '';
  return s.slice(0, 100);
}

async function ensureDepartmentName(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const [existing] = await pool.execute('SELECT * FROM departments WHERE LOWER(name) = LOWER(?)', [n]);
  if (existing.length) return existing[0];
  const [ins] = await pool.execute('INSERT INTO departments (name) VALUES (?)', [n]);
  const [rows] = await pool.execute('SELECT * FROM departments WHERE id = ?', [ins.insertId]);
  return rows[0] || null;
}

// ── Request logging (to debug.log, first middleware in the stack) ──
app.use((req, res, next) => {
  debug('REQUEST -> ' + req.method + ' ' + req.originalUrl);

  res.on('finish', () => {
    debug('RESPONSE -> ' + req.method + ' ' + req.originalUrl + ' ' + res.statusCode);
  });

  next();
});

app.use(express.json({ limit: '10mb' }));
debug('Middleware initialized (request logger + express.json)');
app.set('trust proxy', true);

const ACCESS_DEFAULT_AMOUNT = 7;
const ACCESS_DEFAULT_UNIT = 'days';

async function ensureAccessTables() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS access_allowed_ips (
      id INT AUTO_INCREMENT PRIMARY KEY,
      entry_type VARCHAR(8) NOT NULL DEFAULT 'ip',
      ip_address VARCHAR(64) NOT NULL DEFAULT '',
      host_name VARCHAR(255) NOT NULL DEFAULT '',
      label VARCHAR(255) NOT NULL DEFAULT '',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_access_entry_type (entry_type)
    )
  `);
  try {
    await pool.execute(`ALTER TABLE access_allowed_ips ADD COLUMN entry_type VARCHAR(8) NOT NULL DEFAULT 'ip'`);
  } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  try {
    await pool.execute(`ALTER TABLE access_allowed_ips ADD COLUMN host_name VARCHAR(255) NOT NULL DEFAULT ''`);
  } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  try {
    await pool.execute(`ALTER TABLE access_allowed_ips MODIFY ip_address VARCHAR(64) NOT NULL DEFAULT ''`);
  } catch (e) { /* column may already allow default */ }
  try {
    await pool.execute(`ALTER TABLE access_allowed_ips DROP INDEX uq_access_ip`);
  } catch (e) { /* index may not exist on older/newer schemas */ }
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS access_passcodes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      label VARCHAR(255) NOT NULL DEFAULT '',
      passcode_hash VARCHAR(255) NOT NULL,
      duration_amount INT NOT NULL DEFAULT 7,
      duration_unit VARCHAR(16) NOT NULL DEFAULT 'days',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Upgrade older installs
  try {
    await pool.execute(`ALTER TABLE access_passcodes ADD COLUMN duration_amount INT NOT NULL DEFAULT 7`);
  } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  try {
    await pool.execute(`ALTER TABLE access_passcodes ADD COLUMN duration_unit VARCHAR(16) NOT NULL DEFAULT 'days'`);
  } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS access_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      action VARCHAR(50) NOT NULL,
      ip_address VARCHAR(64) NOT NULL DEFAULT '',
      passcode_id INT NULL,
      passcode_label VARCHAR(255) NOT NULL DEFAULT '',
      details VARCHAR(500) NOT NULL DEFAULT '',
      user_agent VARCHAR(500) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_access_logs_created (created_at),
      INDEX idx_access_logs_action (action)
    )
  `);
  try {
    await pool.execute(`ALTER TABLE access_logs ADD COLUMN device_name VARCHAR(255) NOT NULL DEFAULT ''`);
  } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
}

async function logAccessEvent(action, req, extra = {}) {
  try {
    const ua = String(req.headers['user-agent'] || '').slice(0, 500);
    const publicIp = await resolveClientIp(req);
    const localIp = getReportedLocalIp(req);
    // Prefer auto-detected public IP (unique per visitor); include LAN in details when found
    const logIp = publicIp || localIp || '';
    let details = String(extra.details || '').slice(0, 350);
    if (localIp && localIp !== logIp) {
      const suffix = 'LAN: ' + localIp;
      details = details ? (details + ' · ' + suffix) : suffix;
    }
    await pool.execute(
      `INSERT INTO access_logs (action, ip_address, device_name, passcode_id, passcode_label, details, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        action,
        logIp,
        '',
        extra.passcodeId || null,
        String(extra.passcodeLabel || '').slice(0, 255),
        details.slice(0, 500),
        ua,
      ]
    );
  } catch (e) {
    debug('Access log write failed', e);
  }
}

function normalizeDuration(amount, unit) {
  let a = parseInt(amount, 10);
  if (!Number.isFinite(a) || a < 1) a = ACCESS_DEFAULT_AMOUNT;
  if (a > 999999) a = 999999;
  const u = String(unit || '').toLowerCase();
  const allowed = ['seconds', 'days', 'months'];
  return { amount: a, unit: allowed.includes(u) ? u : ACCESS_DEFAULT_UNIT };
}

/** Convert duration to seconds for JWT Max-Age / expiresIn. */
function durationToSeconds(amount, unit) {
  const { amount: a, unit: u } = normalizeDuration(amount, unit);
  if (u === 'seconds') return a;
  if (u === 'months') return a * 30 * 24 * 60 * 60;
  return a * 24 * 60 * 60; // days
}

function durationLabel(amount, unit) {
  const { amount: a, unit: u } = normalizeDuration(amount, unit);
  const names = { seconds: 'second', days: 'day', months: 'month' };
  const base = names[u] || 'day';
  return a + ' ' + base + (a === 1 ? '' : 's');
}

function getForwardedIps(req) {
  const list = [];
  const add = (raw) => {
    const ip = normalizeIp(raw);
    if (ip && isValidIp(ip) && !list.includes(ip)) list.push(ip);
  };
  // Left-most in X-Forwarded-For is the original visitor (IIS / CDN / proxy)
  for (const part of String(req.headers['x-forwarded-for'] || '').split(',')) {
    add(part);
  }
  add(req.headers['cf-connecting-ip']);
  add(req.headers['true-client-ip']);
  add(req.headers['x-real-ip']);
  return list;
}

function getClientIp(req) {
  const ips = getForwardedIps(req);
  const pub = ips.find((ip) => !isLoopbackOrPrivateIp(ip));
  if (pub) return pub;
  if (ips.length) return ips[0];
  return normalizeIp(req.ip || req.socket?.remoteAddress || '');
}

function isLoopbackOrPrivateIp(ip) {
  const v = normalizeIp(ip).toLowerCase();
  if (!v) return true;
  if (v === '::1' || v === '0:0:0:0:0:0:0:1' || v === 'localhost') return true;
  if (v.startsWith('127.')) return true;
  if (v.startsWith('10.')) return true;
  if (v.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(v)) return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')) return true;
  return false;
}

let cachedPublicIp = { value: '', at: 0 };

// Intentionally unused for visitor identity — calling ipify from Node returns
// the SERVER'S public IP and was incorrectly applied to every user (e.g. 106.x for all).
async function lookupPublicIp() {
  return '';
}

/** ISP public IP reported by the visitor's browser (ipify), sent on each request. */
function getBrowserPublicIps(req) {
  const ips = [];
  const add = (raw) => {
    for (const part of String(raw || '').split(',')) {
      const v = normalizeIp(part.trim());
      if (v && isValidIp(v) && !isLoopbackOrPrivateIp(v) && !ips.includes(v)) ips.push(v);
    }
  };
  add(req.headers['x-client-public-ips']);
  add(req.headers['x-client-public-ip']);
  return ips;
}

/**
 * IP shown in logs / admin — prefer browser-detected ISP IP (matches whitelist entries).
 */
async function resolveClientIp(req) {
  const browserIps = getBrowserPublicIps(req);
  if (browserIps.length) return browserIps[0];

  const forwardedPublic = getForwardedIps(req).find((ip) => !isLoopbackOrPrivateIp(ip));
  if (forwardedPublic) return forwardedPublic;

  const connectionIp = getClientIp(req);
  if (connectionIp && !isLoopbackOrPrivateIp(connectionIp)) return connectionIp;

  return connectionIp || '';
}

function getReportedLocalIp(req) {
  const local = normalizeIp(req.headers['x-client-local-ip'] || '');
  if (local && isValidIp(local) && local !== '0.0.0.0') return local;
  const connectionIp = getClientIp(req);
  if (
    connectionIp &&
    isLoopbackOrPrivateIp(connectionIp) &&
    !connectionIp.startsWith('127.') &&
    connectionIp !== '::1'
  ) {
    return connectionIp;
  }
  return '';
}

function normalizeIp(ip) {
  let v = String(ip || '').trim();
  if (!v) return '';

  // IPv6 zone id, e.g. fe80::1%eth0
  const zoneIdx = v.indexOf('%');
  if (zoneIdx !== -1) v = v.slice(0, zoneIdx);

  // [2001:db8::1]:443
  const bracket = v.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) v = bracket[1];

  // IPv4-mapped IPv6
  v = v.replace(/^::ffff:/i, '');

  // 203.0.113.10:8080 — strip trailing port for IPv4 only
  const v4Port = v.match(/^((?:\d{1,3}\.){3}\d{1,3}):(\d+)$/);
  if (v4Port) v = v4Port[1];

  return v.trim();
}

function isValidIp(ip) {
  const v = normalizeIp(ip);
  if (!v || v.length > 64) return false;
  // IPv4
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) {
    return v.split('.').every(o => {
      const n = Number(o);
      return n >= 0 && n <= 255;
    });
  }
  // Basic IPv6
  if (/^[0-9a-fA-F:]+$/.test(v) && v.includes(':')) return true;
  return false;
}

function normalizeHostname(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

function isValidHostname(host) {
  const h = normalizeHostname(host);
  if (!h || h.length > 253 || isValidIp(h)) return false;
  if (!/^[a-z0-9.-]+$/.test(h) || h.startsWith('-') || h.endsWith('-')) return false;
  const labels = h.split('.');
  return labels.every((label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label));
}

const hostResolveCache = new Map();
const HOST_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveHostToIps(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return new Set();
  const cached = hostResolveCache.get(host);
  if (cached && Date.now() - cached.at < HOST_CACHE_TTL_MS) return cached.ips;
  const ips = new Set();
  try {
    const [v4, v6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
    if (v4.status === 'fulfilled') v4.value.forEach((ip) => ips.add(normalizeIp(ip)));
    if (v6.status === 'fulfilled') v6.value.forEach((ip) => ips.add(normalizeIp(ip)));
  } catch (e) {
    debug('DNS resolve failed for ' + host, e.message || e);
  }
  hostResolveCache.set(host, { ips, at: Date.now() });
  return ips;
}

function clearHostResolveCache(hostname) {
  if (hostname) hostResolveCache.delete(normalizeHostname(hostname));
  else hostResolveCache.clear();
}

function hashPasscode(code) {
  return CryptoJS.SHA256(String(code || '').trim()).toString();
}

function parseCookie(req, name) {
  const raw = req.headers.cookie || '';
  const parts = raw.split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(p.slice(idx + 1).trim());
  }
  return null;
}

async function hasOfficeIps() {
  const [[ips]] = await pool.execute(
    `SELECT COUNT(*) AS c FROM access_allowed_ips
     WHERE is_active = 1 AND (
       (entry_type = 'ip' AND ip_address != '') OR
       (entry_type = 'host' AND host_name != '')
     )`
  );
  return Number(ips.c) > 0;
}

async function hasActivePasscodes() {
  const [[pcs]] = await pool.execute('SELECT COUNT(*) AS c FROM access_passcodes WHERE is_active = 1');
  return Number(pcs.c) > 0;
}

async function accessControlEnabled() {
  return (await hasOfficeIps()) || (await hasActivePasscodes());
}

async function isOfficeIpOnlyMode() {
  // Any configured office IP → directory is office-network only (no passcode for outsiders).
  // Set DIRECTORY_ALLOW_PASSCODE_OUTSIDE=1 to also allow passcode unlock from other IPs.
  if (process.env.DIRECTORY_ALLOW_PASSCODE_OUTSIDE === '1') return false;
  return await hasOfficeIps();
}

async function isIpAllowed(ip) {
  const v = normalizeIp(ip);
  if (!v || !isValidIp(v)) return false;
  const [ipRows] = await pool.execute(
    `SELECT ip_address FROM access_allowed_ips
     WHERE is_active = 1 AND entry_type = 'ip' AND ip_address != ''`
  );
  for (const row of ipRows) {
    if (normalizeIp(row.ip_address) === v) return true;
  }
  const [hostRows] = await pool.execute(
    `SELECT host_name FROM access_allowed_ips
     WHERE is_active = 1 AND entry_type = 'host' AND host_name != ''`
  );
  for (const row of hostRows) {
    const resolved = await resolveHostToIps(row.host_name);
    if (resolved.has(v)) return true;
  }
  return false;
}

function getAdminFromAuthHeader(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    if (decoded && decoded.id && decoded.role) return decoded;
  } catch { /* ignore */ }
  return null;
}

function getDirectoryAccessToken(req) {
  const header = req.headers['x-directory-access'];
  if (header) return String(header).trim();
  return parseCookie(req, 'directory_access');
}

function hasValidDirectoryToken(req) {
  const token = getDirectoryAccessToken(req);
  if (!token) return false;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded && decoded.scope === 'directory_public';
  } catch {
    return false;
  }
}

async function evaluatePublicAccess(req) {
  const browserIps = getBrowserPublicIps(req);
  const clientIp = browserIps[0] || (await resolveClientIp(req));
  const enabled = await accessControlEnabled();
  const officeIpOnly = await isOfficeIpOnlyMode();
  // Until at least one office IP or passcode exists, stay open
  if (!enabled) {
    return { allowed: true, reason: 'open', clientIp, browserIps, enabled: false, officeIpOnly: false };
  }
  // Office whitelist uses browser ISP IP only (same IP shown on the access gate).
  for (const ip of browserIps) {
    if (await isIpAllowed(ip)) {
      return { allowed: true, reason: 'ip', clientIp: ip, browserIps, enabled: true, officeIpOnly };
    }
  }
  // Logged-in admin browsing the public directory
  if (getAdminFromAuthHeader(req)) {
    return { allowed: true, reason: 'admin', clientIp, enabled: true, officeIpOnly };
  }
  // Office-network only — no passcode fallback for outsiders
  if (officeIpOnly) {
    return {
      allowed: false,
      reason: browserIps.length ? 'office_only' : 'browser_ip_missing',
      clientIp,
      browserIps,
      enabled: true,
      officeIpOnly: true,
      requiresPasscode: false,
      browserIpMissing: browserIps.length === 0,
    };
  }
  // Valid passcode session
  if (hasValidDirectoryToken(req)) {
    return { allowed: true, reason: 'passcode', clientIp, enabled: true, officeIpOnly: false };
  }
  // Everyone else must enter a passcode
  return {
    allowed: false,
    reason: browserIps.length ? 'none' : 'browser_ip_missing',
    clientIp,
    browserIps,
    enabled: true,
    officeIpOnly: false,
    requiresPasscode: true,
    browserIpMissing: browserIps.length === 0,
  };
}

async function publicDirectoryAccess(req, res, next) {
  try {
    const result = await evaluatePublicAccess(req);
    if (result.allowed) return next();
    if (result.officeIpOnly) {
      return res.status(403).json({
        error: result.browserIpMissing
          ? 'Could not verify your network IP. Refresh the page or allow access to api.ipify.org.'
          : 'Directory is only available from the office network',
        officeIpOnly: true,
        requiresPasscode: false,
        clientIp: result.clientIp,
        browserIpMissing: result.browserIpMissing === true,
      });
    }
    return res.status(403).json({
      error: 'Passcode required to view the directory',
      officeIpOnly: false,
      requiresPasscode: true,
      clientIp: result.clientIp,
    });
  } catch (e) {
    debug('Route failed', e);
    return res.status(500).json({ error: e.message });
  }
}

function isPublicDirectoryApi(req) {
  if (req.method !== 'GET') return false;
  const p = req.path;
  return (
    p === '/api/employees' ||
    p === '/api/directory-tree' ||
    p === '/api/filters' ||
    p === '/api/stations' ||
    p === '/api/departments' ||
    p === '/api/branches' ||
    p === '/api/countries' ||
    p === '/api/states' ||
    p === '/api/locations'
  );
}

app.use(async (req, res, next) => {
  try {
    const isPublic = isPublicDirectoryApi(req);
    debug('Access gate: ' + req.method + ' ' + req.path + ' publicApi=' + isPublic);
    if (!isPublic) return next();
    if (getAdminFromAuthHeader(req)) return next();
    return publicDirectoryAccess(req, res, next);
  } catch (e) {
    debug('Access gate failed', e);
    debug('Route failed', e);
    return res.status(500).json({ error: e.message });
  }
});

// Health check (for cPanel debugging)
app.get('/api/health', async (req, res) => {
  debug('ENTERED GET /api/health');
  const cfg = {
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'avaya_list',
    user: process.env.DB_USER || 'root',
  };
  try {
    debug('Health: testing DB connection (SELECT 1)');
    const [rows] = await pool.execute('SELECT 1 AS ok');
    const [[admins]] = await pool.execute('SELECT COUNT(*) AS c FROM admins');
    debug('Health: DB ok, admins=' + admins.c);
    res.json({
      ok: true,
      db: rows[0].ok === 1,
      admins: admins.c,
      ...cfg,
    });
  } catch (e) {
    debug('DB health failed', e);
    res.status(500).json({
      ok: false,
      error: e.message,
      code: e.code || null,
      ...cfg,
    });
  }
});

// ── Auth Middleware ──
async function auth(req, res, next) {
  debug('Authentication middleware entered: ' + req.method + ' ' + req.path);
  const header = req.headers.authorization;
  debug('Authorization header present: ' + Boolean(header));
  if (!header) {
    debug('Authentication: no token provided');
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    debug('JWT verification started');
    const decoded = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    req.admin = decoded;
    debug('JWT verification succeeded (admin id=' + decoded.id + ' role=' + decoded.role + ')');
    next();
  } catch (e) {
    debug('JWT verification failed', e);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function superAdmin(req, res, next) {
  await auth(req, res, () => {
    if (req.admin.role !== 'super_admin') {
      debug('Role check failed (super_admin required, got ' + req.admin.role + ')');
      return res.status(403).json({ error: 'Super admin only' });
    }
    next();
  });
}

const STAFF_ROLES = new Set(['super_admin', 'admin', 'manager']);
const FULL_ADMIN_ROLES = new Set(['super_admin', 'admin']);

function isStaffRole(role) {
  return STAFF_ROLES.has(role);
}

function isFullAdminRole(role) {
  return FULL_ADMIN_ROLES.has(role);
}

async function adminOnly(req, res, next) {
  await auth(req, res, () => {
    if (!isStaffRole(req.admin.role)) {
      debug('Role check failed (staff required, got ' + req.admin.role + ')');
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  });
}

async function fullAdminOnly(req, res, next) {
  await auth(req, res, () => {
    if (!isFullAdminRole(req.admin.role)) {
      debug('Role check failed (full admin required, got ' + req.admin.role + ')');
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

debug('Authentication initialized (auth / superAdmin / adminOnly / fullAdminOnly)');

// ── Helper: Log action ──
async function logAction(adminId, action, entityType, entityId, oldData, newData) {
  try {
    const [r] = await pool.execute(
      'INSERT INTO admin_logs (admin_id, action, entity_type, entity_id, old_data, new_data) VALUES (?, ?, ?, ?, ?, ?)',
      [adminId, action, entityType, entityId, oldData ? JSON.stringify(oldData) : null, newData ? JSON.stringify(newData) : null]
    );
    return r;
  } catch (e) {
    debug('logAction failed', e);
    return null;
  }
}

// ── Login ──
app.post('/api/login', async (req, res) => {
  try {
    debug('ENTERED POST /api/login');
    const { email, password } = req.body;
    debug('Login: email provided: ' + Boolean(email) + ', password provided: ' + Boolean(password));
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    debug('Login: querying admins table');
    const [rows] = await pool.execute('SELECT * FROM admins WHERE email = ? AND is_active = 1', [email]);
    debug('Login: admin found: ' + (rows.length ? 'yes' : 'no'));
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const admin = rows[0];
    const hash = CryptoJS.SHA256(password).toString();
    if (hash !== admin.password_hash) {
      debug('Login: password hash mismatch');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    debug('Login: password verified, signing JWT');
    const token = jwt.sign({ id: admin.id, name: admin.name, email: admin.email, role: admin.role }, JWT_SECRET, { expiresIn: '24h' });
    await logAction(admin.id, 'login', 'admin', admin.id, null, null);
    debug('Login successful (admin id=' + admin.id + ' role=' + admin.role + ')');
    res.json({ success: true, token, admin: adminPayloadFromRow(admin) });
  } catch (e) {
    debug('Login route failed', e);
    res.status(500).json({ error: e.message, code: e.code || null });
  }
});

// ── Get Employees (with filters) - Public ──
app.get('/api/employees', async (req, res) => {
  try {
    debug('ENTERED GET /api/employees');
    const admin = getAdminFromAuthHeader(req);
    const statusFilter = admin ? String(req.query.status_filter || '').trim() : '';
    const includePending = admin && req.query.include_pending === '1';
    let where;
    if (statusFilter === 'pending') {
      where = 'WHERE e.deleted_at IS NULL AND e.delete_requested_by IS NOT NULL';
    } else if (statusFilter === 'avaya_pending') {
      where = `WHERE e.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM employee_number_removals r
        WHERE r.employee_id = e.id
          AND r.confirmed_at IS NULL AND r.cancelled_at IS NULL
      )`;
    } else if (statusFilter === 'deleted') {
      where = 'WHERE e.deleted_at IS NOT NULL';
    } else {
      where = 'WHERE e.deleted_at IS NULL';
      if (!includePending) {
        where += ' AND e.delete_requested_by IS NULL';
      }
    }
    const params = [];
    if (req.query.search) {
      where += ` AND (
        e.name LIKE ? OR e.email LIKE ? OR e.dept LIKE ? OR e.branch LIKE ?
        OR e.works_for_station LIKE ? OR e.state_name LIKE ? OR e.station_name LIKE ?
        OR EXISTS (
          SELECT 1 FROM employee_numbers n
          WHERE n.employee_id = e.id
            AND (n.ext LIKE ? OR n.mobile LIKE ? OR n.label LIKE ? OR n.sd LIKE ? OR n.sd_no LIKE ?)
        )
      )`;
      const s = '%' + req.query.search + '%';
      params.push(s, s, s, s, s, s, s, s, s, s, s, s);
    }
    if (req.query.branch) { where += ' AND e.branch = ?'; params.push(req.query.branch); }
    if (req.query.location_id) { where += ' AND e.location_id = ?'; params.push(req.query.location_id); }
    if (req.query.station_name !== undefined && req.query.station_name !== '') {
      where += ' AND e.station_name = ?';
      params.push(req.query.station_name);
    }
    if (req.query.works_for_station !== undefined && req.query.works_for_station !== '') {
      where += ' AND e.works_for_station = ?';
      params.push(req.query.works_for_station);
    }
    if (req.query.dept) { where += ' AND e.dept = ?'; params.push(req.query.dept); }
    if (req.query.date_filter === 'week') where += ' AND e.created_at >= NOW() - INTERVAL 7 DAY';
    if (req.query.date_filter === 'month') where += ' AND e.created_at >= NOW() - INTERVAL 30 DAY';
    if (req.query.updated_filter === 'week') where += ' AND e.updated_at >= NOW() - INTERVAL 7 DAY';
    if (req.query.updated_filter === 'month') where += ' AND e.updated_at >= NOW() - INTERVAL 30 DAY';

    const [emps] = await pool.execute(
      `SELECT e.*, l.name AS location_name, l.city AS location_city, l.address AS location_address, l.maps_url AS location_maps_url,
              st.name AS state_name_join, st.id AS state_id, c.id AS country_id, c.name AS country_name,
              cre.name AS created_by_name, upd.name AS updated_by_name, dr.name AS delete_requested_by_name,
              del.name AS deleted_by_name
       FROM employees e
       LEFT JOIN locations l ON e.location_id = l.id
       LEFT JOIN states st ON st.id = l.state_id
       LEFT JOIN branches c ON c.id = st.country_id
       LEFT JOIN admins cre ON e.created_by = cre.id
       LEFT JOIN admins upd ON e.updated_by = upd.id
       LEFT JOIN admins dr ON e.delete_requested_by = dr.id
       LEFT JOIN admins del ON e.deleted_by = del.id
       ${where}
       ORDER BY e.name`, params);

    for (const emp of emps) {
      if (emp.state_name_join) emp.state_name = emp.state_name_join;
      if (emp.country_name) emp.branch = emp.country_name;
    }

    if (emps.length) {
      const ids = emps.map(e => e.id);
      const placeholders = ids.map(() => '?').join(',');
      const [nums] = await pool.execute(
        `SELECT * FROM employee_numbers WHERE employee_id IN (${placeholders}) ORDER BY id`,
        ids
      );
      const byEmp = {};
      for (const n of nums) {
        if (!byEmp[n.employee_id]) byEmp[n.employee_id] = [];
        byEmp[n.employee_id].push(n);
      }
      for (const emp of emps) emp.numbers = byEmp[emp.id] || [];
    }
    if (admin && (includePending || statusFilter)) {
      await attachPendingExtensionRemovals(emps);
    }
    debug('Employees query returned rows: ' + emps.length);
    res.json(emps);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Recent created / updated / deleted employees ──
app.get('/api/employees/recent', adminOnly, async (req, res) => {
  try {
    const days = req.query.days === '7' ? 7 : 30;
    const type = req.query.type || 'all'; // all | created | updated | deleted
    const parts = [];
    const params = [];

    if (type === 'all' || type === 'created') {
      parts.push(`SELECT e.id, e.name, e.dept, e.branch, e.created_at, e.updated_at, e.deleted_at,
        'created' AS change_type, e.created_at AS change_at, cre.name AS change_by_name,
        (SELECT GROUP_CONCAT(NULLIF(n.ext, '') ORDER BY n.id SEPARATOR ' / ')
         FROM employee_numbers n WHERE n.employee_id = e.id) AS extensions
        FROM employees e
        LEFT JOIN admins cre ON e.created_by = cre.id
        WHERE e.created_at >= NOW() - INTERVAL ${days} DAY AND e.deleted_at IS NULL`);
    }
    if (type === 'all' || type === 'updated') {
      parts.push(`SELECT e.id, e.name, e.dept, e.branch, e.created_at, e.updated_at, e.deleted_at,
        'updated' AS change_type, e.updated_at AS change_at, upd.name AS change_by_name,
        (SELECT GROUP_CONCAT(NULLIF(n.ext, '') ORDER BY n.id SEPARATOR ' / ')
         FROM employee_numbers n WHERE n.employee_id = e.id) AS extensions
        FROM employees e
        LEFT JOIN admins upd ON e.updated_by = upd.id
        WHERE e.updated_by IS NOT NULL AND e.updated_at >= NOW() - INTERVAL ${days} DAY AND e.deleted_at IS NULL`);
    }
    if (type === 'all' || type === 'deleted') {
      parts.push(`SELECT e.id, e.name, e.dept, e.branch, e.created_at, e.updated_at, e.deleted_at,
        'deleted' AS change_type, e.deleted_at AS change_at, del.name AS change_by_name,
        (SELECT GROUP_CONCAT(NULLIF(n.ext, '') ORDER BY n.id SEPARATOR ' / ')
         FROM employee_numbers n WHERE n.employee_id = e.id) AS extensions
        FROM employees e
        LEFT JOIN admins del ON e.deleted_by = del.id
        WHERE e.deleted_at IS NOT NULL AND e.deleted_at >= NOW() - INTERVAL ${days} DAY`);
    }

    if (!parts.length) return res.json([]);

    const [rows] = await pool.execute(
      `(${parts.join(') UNION ALL (')}) ORDER BY change_at DESC LIMIT 200`,
      params
    );
    for (const r of rows) {
      r.extensions = r.extensions || '-';
    }
    res.json(rows);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Import template (Excel with dropdowns) ──
app.get('/api/employees/import-template', adminOnly, async (req, res) => {
  try {
    debug('ENTERED GET /api/employees/import-template');
    const [deptRows] = await pool.execute(
      'SELECT name FROM departments ORDER BY sort_order, name'
    );
    const [stateRows] = await pool.execute(
      `SELECT s.id, s.name, s.country_id, c.name AS country_name, c.sort_order AS country_sort, s.sort_order
       FROM states s JOIN branches c ON c.id = s.country_id
       ORDER BY c.sort_order, c.name, s.sort_order, s.name`
    );
    const [locRows] = await pool.execute(
      `SELECT l.name, s.name AS state_name, c.name AS country_name
       FROM locations l
       JOIN states s ON s.id = l.state_id
       JOIN branches c ON c.id = s.country_id
       WHERE l.is_active = 1
       ORDER BY c.sort_order, c.name, s.sort_order, s.name, l.sort_order, l.name`
    );

    // Place list: real states (Dammam) + country name when only Main (Qatar)
    const byCountry = {};
    for (const s of stateRows) {
      const key = String(s.country_id);
      if (!byCountry[key]) byCountry[key] = [];
      byCountry[key].push(s);
    }
    const places = [];
    Object.keys(byCountry).forEach((cid) => {
      const states = byCountry[cid];
      const real = states.filter(s => s.name !== 'Main');
      if (real.length) {
        real.forEach(s => places.push(s.name));
      } else {
        const main = states.find(s => s.name === 'Main') || states[0];
        if (main) places.push(main.country_name);
      }
    });
    places.sort((a, b) => a.localeCompare(b));

    const depts = deptRows.map(r => r.name);
    const locations = locRows.map(r =>
      (r.state_name && r.state_name !== 'Main' ? r.state_name + ' · ' : r.country_name + ' · ') + r.name
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Avaya Directory';
    const ws = wb.addWorksheet('Employees', { views: [{ state: 'frozen', ySplit: 1 }] });
    const headers = ['id', 'name', 'email', 'dept', 'works_for_station', 'state', 'location', 'Ext 1', 'Ext 2', 'mobile', 'direct_line', 'speed_dial'];
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    headers.forEach((_, i) => {
      ws.getColumn(i + 1).width = Math.max(12, String(headers[i]).length + 4);
    });
    ws.getColumn(2).width = 22;
    ws.getColumn(3).width = 28;
    ws.getColumn(5).width = 18;
    ws.getColumn(6).width = 18;
    ws.getColumn(7).width = 32;
    [8, 9, 10, 11, 12].forEach((col) => { ws.getColumn(col).numFmt = '@'; });
    for (let r = 2; r <= 501; r++) {
      [8, 9, 10, 11, 12].forEach((col) => {
        const cell = ws.getCell(r, col);
        cell.numFmt = '@';
        cell.value = '';
      });
    }

    const lists = wb.addWorksheet('Lists');
    lists.getCell('A1').value = 'dept';
    lists.getCell('B1').value = 'state';
    lists.getCell('C1').value = 'location';
    lists.getCell('D1').value = 'works_for_station';
    lists.getRow(1).font = { bold: true };
    const stationOpts = [...new Set(places.filter(p => p && p !== 'Main'))];
    const maxLen = Math.max(depts.length, places.length, locations.length, stationOpts.length, 1);
    for (let i = 0; i < maxLen; i++) {
      if (depts[i]) lists.getCell(i + 2, 1).value = depts[i];
      if (places[i]) lists.getCell(i + 2, 2).value = places[i];
      if (locations[i]) lists.getCell(i + 2, 3).value = locations[i];
      if (stationOpts[i]) lists.getCell(i + 2, 4).value = stationOpts[i];
    }
    lists.getColumn(1).width = 28;
    lists.getColumn(2).width = 18;
    lists.getColumn(3).width = 40;
    lists.getColumn(4).width = 20;

    const deptEnd = Math.max(depts.length, 1) + 1;
    const placeEnd = Math.max(places.length, 1) + 1;
    const locEnd = Math.max(locations.length, 1) + 1;
    const wfsEnd = Math.max(stationOpts.length, 1) + 1;
    const rowEnd = 1001;

    ws.dataValidations.add(`D2:D${rowEnd}`, {
      type: 'list', allowBlank: true, formulae: [`Lists!$A$2:$A$${deptEnd}`],
      showErrorMessage: true, errorTitle: 'Department', error: 'Select a department from the list.',
    });
    ws.dataValidations.add(`E2:E${rowEnd}`, {
      type: 'list', allowBlank: true, formulae: [`Lists!$D$2:$D$${wfsEnd}`],
      showErrorMessage: true, errorTitle: 'Works for station', error: 'Select a station or leave blank.',
    });
    ws.dataValidations.add(`F2:F${rowEnd}`, {
      type: 'list', allowBlank: true, formulae: [`Lists!$B$2:$B$${placeEnd}`],
      showErrorMessage: true, errorTitle: 'State', error: 'Select a place from the list.',
    });
    ws.dataValidations.add(`G2:G${rowEnd}`, {
      type: 'list', allowBlank: true, formulae: [`Lists!$C$2:$C$${locEnd}`],
      showErrorMessage: true, errorTitle: 'Location', error: 'Select a location from the list.',
    });

    const guide = wb.addWorksheet('Instructions');
    [
      ['Column', 'Required', 'Notes'],
      ['id', 'No', 'Leave blank for new employees.'],
      ['name', 'Yes', 'Employee full name'],
      ['email', 'No', 'Unique email'],
      ['dept', 'Yes', 'Dropdown'],
      ['works_for_station', 'No', 'For backoffice staff: Dubai, Dammam, Jeddah, Qatar… Leave blank if they only work at their own location.'],
      ['state', 'Yes', 'Place where they sit: Dammam, Dubai, Qatar, India… (country is automatic)'],
      ['location', 'No', 'Company/site. Defaults to Main.'],
      ['Ext 1 / Ext 2', 'No', 'Text columns — labels auto Ext 1 / Ext 2'],
      ['mobile / direct_line / speed_dial', 'No', 'Text columns'],
    ].forEach((row, idx) => {
      guide.addRow(row);
      if (idx === 0) guide.getRow(1).font = { bold: true };
    });
    guide.getColumn(1).width = 28;
    guide.getColumn(2).width = 10;
    guide.getColumn(3).width = 70;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="avaya-employees-import-template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Get Single Employee ──
app.get('/api/employees/:id', auth, async (req, res) => {
  try {
    const isAdmin = req.admin && isStaffRole(req.admin.role);
    let where = 'WHERE e.id = ?';
    const params = [req.params.id];
    if (!isAdmin) {
      where += ' AND e.deleted_at IS NULL AND e.delete_requested_by IS NULL';
    }
    const [emps] = await pool.execute(
      `SELECT e.*, l.name AS location_name, l.city AS location_city, l.address AS location_address, l.maps_url AS location_maps_url,
              st.name AS state_name_join, st.id AS state_id, c.id AS country_id, c.name AS country_name,
              cre.name AS created_by_name, upd.name AS updated_by_name, dr.name AS delete_requested_by_name,
              del.name AS deleted_by_name
       FROM employees e
       LEFT JOIN locations l ON e.location_id = l.id
       LEFT JOIN states st ON st.id = l.state_id
       LEFT JOIN branches c ON c.id = st.country_id
       LEFT JOIN admins cre ON e.created_by = cre.id
       LEFT JOIN admins upd ON e.updated_by = upd.id
       LEFT JOIN admins dr ON e.delete_requested_by = dr.id
       LEFT JOIN admins del ON e.deleted_by = del.id
       ${where}`,
      params
    );
    if (!emps.length) return res.status(404).json({ error: 'Not found' });
    const emp = emps[0];
    if (emp.state_name_join) emp.state_name = emp.state_name_join;
    if (emp.country_name) emp.branch = emp.country_name;
    const [nums] = await pool.execute('SELECT * FROM employee_numbers WHERE employee_id = ? ORDER BY id', [req.params.id]);
    emp.numbers = nums;
    if (isAdmin) {
      await attachPendingExtensionRemovals([emp]);
    }
    res.json(emp);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

async function resolveLocationMeta(locationId) {
  if (!locationId) return null;
  const [rows] = await pool.execute(
    `SELECT l.*, st.id AS state_id, st.name AS state_name, c.id AS country_id, c.name AS branch_name, c.name AS country_name
     FROM locations l
     JOIN states st ON st.id = l.state_id
     JOIN branches c ON c.id = st.country_id
     WHERE l.id = ?`,
    [locationId]
  );
  return rows[0] || null;
}

function normalizeEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  return v || null;
}

/** Resolve a place label (Dammam, Qatar, "KSA · Dammam") to country + state names. */
async function resolvePlaceToCountryState(placeRaw) {
  let place = String(placeRaw || '').trim();
  if (!place) return null;

  const parts = place.match(/^(.+?)\s*[·|/]\s*(.+)$/);
  if (parts) {
    const left = parts[1].trim();
    const right = parts[2].trim();
    // "KSA · Dammam" or "Dammam · Company" — if right is a known state under left country, use that
    if (right && right.toLowerCase() !== 'main') {
      const [st] = await pool.execute(
        `SELECT s.name AS state_name, c.name AS country_name
         FROM states s JOIN branches c ON c.id = s.country_id
         WHERE LOWER(c.name) = LOWER(?) AND LOWER(s.name) = LOWER(?)`,
        [left, right]
      );
      if (st.length) return { countryName: st[0].country_name, stateName: st[0].state_name };
    }
    // left may be country, right Main or unknown → country + right
    const [c] = await pool.execute('SELECT name FROM branches WHERE LOWER(name) = LOWER(?)', [left]);
    if (c.length) return { countryName: c[0].name, stateName: right || 'Main' };
  }

  // Real state name (Dammam, Dubai, …) → its country
  const [states] = await pool.execute(
    `SELECT s.name AS state_name, c.name AS country_name
     FROM states s JOIN branches c ON c.id = s.country_id
     WHERE LOWER(s.name) = LOWER(?) AND s.name <> 'Main'`,
    [place]
  );
  if (states.length) {
    return { countryName: states[0].country_name, stateName: states[0].state_name };
  }

  // Country name (Qatar, India, …) → Main
  const [countries] = await pool.execute(
    'SELECT name FROM branches WHERE LOWER(name) = LOWER(?)',
    [place]
  );
  if (countries.length) {
    return { countryName: countries[0].name, stateName: 'Main' };
  }

  // Unknown place: treat as new country (Main)
  return { countryName: place, stateName: 'Main' };
}

async function resolveOrCreateLocationByNames(countryName, stateName, locationName) {
  const cName = String(countryName || '').trim();
  const sName = String(stateName || '').trim() || 'Main';
  const lName = String(locationName || '').trim() || 'Main';
  if (!cName) return null;

  let [countries] = await pool.execute('SELECT * FROM branches WHERE LOWER(name) = LOWER(?)', [cName]);
  let countryId;
  if (countries.length) {
    countryId = countries[0].id;
  } else {
    const [ins] = await pool.execute('INSERT INTO branches (name) VALUES (?)', [cName]);
    countryId = ins.insertId;
  }

  let [states] = await pool.execute(
    'SELECT * FROM states WHERE country_id = ? AND LOWER(name) = LOWER(?)',
    [countryId, sName]
  );
  let stateId;
  if (states.length) {
    stateId = states[0].id;
  } else {
    const [ins] = await pool.execute('INSERT INTO states (country_id, name) VALUES (?, ?)', [countryId, sName]);
    stateId = ins.insertId;
  }

  let [locs] = await pool.execute(
    `SELECT l.*, st.name AS state_name, c.name AS branch_name, c.name AS country_name, st.id AS state_id, c.id AS country_id
     FROM locations l
     JOIN states st ON st.id = l.state_id
     JOIN branches c ON c.id = st.country_id
     WHERE l.state_id = ? AND LOWER(l.name) = LOWER(?)`,
    [stateId, lName]
  );
  if (locs.length) return locs[0];

  const [insLoc] = await pool.execute(
    'INSERT INTO locations (state_id, name, city) VALUES (?, ?, ?)',
    [stateId, lName, sName === 'Main' ? '' : sName]
  );
  return resolveLocationMeta(insLoc.insertId);
}

async function upsertEmployeeNumbers(empId, numbers) {
  if (!Array.isArray(numbers) || !numbers.length) return;
  await pool.execute('DELETE FROM employee_numbers WHERE employee_id = ?', [empId]);
  let seq = 1;
  for (const n of numbers) {
    const hasAny = n.ext || n.mobile || n.sd || n.sdNo || n.sd_no;
    if (!hasAny) continue;
    await pool.execute(
      'INSERT INTO employee_numbers (employee_id, label, ext, mobile, sd, sd_no) VALUES (?, ?, ?, ?, ?, ?)',
      [empId, 'Ext ' + seq, n.ext || '', n.mobile || '', n.sd || '', n.sdNo || n.sd_no || '']
    );
    seq++;
  }
}

async function renumberEmployeeExtLabels(empId) {
  const [nums] = await pool.execute('SELECT id FROM employee_numbers WHERE employee_id = ? ORDER BY id', [empId]);
  for (let i = 0; i < nums.length; i++) {
    await pool.execute('UPDATE employee_numbers SET label = ? WHERE id = ?', ['Ext ' + (i + 1), nums[i].id]);
  }
}

async function ensureExtensionRemovalTables() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS employee_number_removals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      employee_number_id INT NULL,
      reason VARCHAR(16) NOT NULL DEFAULT 'changed',
      label VARCHAR(64) NOT NULL DEFAULT '',
      ext VARCHAR(64) NOT NULL DEFAULT '',
      mobile VARCHAR(64) NOT NULL DEFAULT '',
      sd VARCHAR(64) NOT NULL DEFAULT '',
      sd_no VARCHAR(64) NOT NULL DEFAULT '',
      new_ext VARCHAR(64) NOT NULL DEFAULT '',
      new_mobile VARCHAR(64) NOT NULL DEFAULT '',
      new_sd VARCHAR(64) NOT NULL DEFAULT '',
      new_sd_no VARCHAR(64) NOT NULL DEFAULT '',
      requested_by INT NOT NULL,
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      confirmed_by INT NULL,
      confirmed_at TIMESTAMP NULL,
      cancelled_at TIMESTAMP NULL,
      INDEX idx_enr_employee (employee_id),
      INDEX idx_enr_pending (confirmed_at, cancelled_at)
    )
  `);
}

function normPhoneField(v) {
  return String(v || '').trim();
}

function hasRemovableValues(row) {
  return !!(
    normPhoneField(row.ext) ||
    normPhoneField(row.mobile) ||
    normPhoneField(row.sd) ||
    normPhoneField(row.sd_no)
  );
}

function extensionFieldsChanged(oldRow, body) {
  const ext = normPhoneField(body.ext);
  const mobile = normPhoneField(body.mobile);
  const sd = normPhoneField(body.sd);
  const sdNo = normPhoneField(body.sdNo || body.sd_no);
  return (
    normPhoneField(oldRow.ext) !== ext ||
    normPhoneField(oldRow.mobile) !== mobile ||
    normPhoneField(oldRow.sd) !== sd ||
    normPhoneField(oldRow.sd_no) !== sdNo
  );
}

async function createExtensionRemovalRecord(employeeId, employeeNumberId, oldRow, body, reason, adminId) {
  const newExt = normPhoneField(body.ext);
  const newMobile = normPhoneField(body.mobile);
  const newSd = normPhoneField(body.sd);
  const newSdNo = normPhoneField(body.sdNo || body.sd_no);
  await pool.execute(
    `INSERT INTO employee_number_removals
     (employee_id, employee_number_id, reason, label, ext, mobile, sd, sd_no,
      new_ext, new_mobile, new_sd, new_sd_no, requested_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      employeeId,
      employeeNumberId || null,
      reason,
      oldRow.label || '',
      normPhoneField(oldRow.ext),
      normPhoneField(oldRow.mobile),
      normPhoneField(oldRow.sd),
      normPhoneField(oldRow.sd_no),
      reason === 'changed' ? newExt : '',
      reason === 'changed' ? newMobile : '',
      reason === 'changed' ? newSd : '',
      reason === 'changed' ? newSdNo : '',
      adminId,
    ]
  );
}

async function attachPendingExtensionRemovals(emps) {
  if (!emps.length) return;
  const ids = emps.map((e) => e.id);
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT r.*, req.name AS requested_by_name, conf.name AS confirmed_by_name
     FROM employee_number_removals r
     LEFT JOIN admins req ON req.id = r.requested_by
     LEFT JOIN admins conf ON conf.id = r.confirmed_by
     WHERE r.employee_id IN (${placeholders})
       AND r.confirmed_at IS NULL AND r.cancelled_at IS NULL
     ORDER BY r.requested_at DESC`,
    ids
  );
  const byEmp = {};
  for (const row of rows) {
    if (!byEmp[row.employee_id]) byEmp[row.employee_id] = [];
    byEmp[row.employee_id].push(row);
  }
  for (const emp of emps) {
    emp.pending_extension_removals = byEmp[emp.id] || [];
  }
}

function parseImportLocationName(branchName, locationRaw) {
  let locationName = String(locationRaw || '').trim();
  if (!locationName) return 'Main';
  const m = locationName.match(/^(.+?)\s*[·|]\s*(.+)$/);
  if (m) {
    const left = m[1].trim();
    const right = m[2].trim();
    if (!branchName || left.toLowerCase() === String(branchName).toLowerCase()) {
      return right || 'Main';
    }
  }
  return locationName;
}

function normalizePhoneValue(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    return String(Math.round(v));
  }
  let s = String(v).trim();
  if (s.startsWith("'")) s = s.slice(1).trim();
  if (/^-?\d+(\.\d+)?e[+\-]?\d+$/i.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return String(Math.round(n));
  }
  return s;
}

function numbersFromImportRow(row) {
  const mobile = normalizePhoneValue(row.mobile || '');
  const sd = normalizePhoneValue(row.sd || row.direct_line || row.directline || '');
  const sdNo = normalizePhoneValue(row.sd_no || row.sdNo || row.speed_dial || row.speeddial || '');
  const numbers = [];
  let seq = 1;
  for (let i = 1; i <= 10; i++) {
    const key = 'ext_' + i;
    let val = normalizePhoneValue(row[key] || '');
    if (!val && i === 1) val = normalizePhoneValue(row.ext || row.extension || '');
    if (!val) continue;
    const n = { label: 'Ext ' + seq, ext: val, mobile: '', sd: '', sdNo: '' };
    if (seq === 1) {
      n.mobile = mobile;
      n.sd = sd;
      n.sdNo = sdNo;
    }
    numbers.push(n);
    seq++;
  }
  if (!numbers.length && (mobile || sd || sdNo)) {
    numbers.push({ label: 'Ext 1', ext: '', mobile, sd, sdNo });
  }
  return numbers;
}

// ── Create Employee ──
app.post('/api/employees', adminOnly, async (req, res) => {
  try {
    const { name, dept, numbers } = req.body;
    const email = normalizeEmail(req.body.email);
    let { branch, station_name, location_id } = req.body;
    const works_for_station = normalizeWorksForStation(req.body.works_for_station);
    if (!name || !dept) return res.status(400).json({ error: 'Name and dept required' });
    await ensureDepartmentName(dept);
    const loc = await resolveLocationMeta(location_id);
    let state_name = '';
    if (loc) {
      branch = loc.country_name || loc.branch_name;
      state_name = loc.state_name || '';
      station_name = loc.name;
      location_id = loc.id;
    } else if (!branch) {
      return res.status(400).json({ error: 'Country/location required' });
    } else {
      location_id = null;
      station_name = (station_name || '').trim();
      state_name = String(req.body.state_name || '').trim();
    }
    const empNums = numbers && numbers.length ? numbers : [{ label: 'Ext 1', ext: req.body.ext || '', mobile: req.body.mobile || '', sd: req.body.sd || '', sdNo: req.body.sdNo || '' }];
    // Force Ext 1, Ext 2… labels
    empNums.forEach((n, i) => { n.label = 'Ext ' + (i + 1); });
    const [r] = await pool.execute(
      'INSERT INTO employees (name, email, dept, branch, state_name, station_name, works_for_station, location_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, email, dept, branch, state_name || '', station_name || '', works_for_station, location_id, req.admin.id]
    );
    const empId = r.insertId;
    await upsertEmployeeNumbers(empId, empNums);
    await logAction(req.admin.id, 'create', 'employee', empId, null, { name, email, dept, branch, station_name, works_for_station, location_id, numbers: empNums });
    const [emps] = await pool.execute('SELECT * FROM employees WHERE id = ?', [empId]);
    const [nums] = await pool.execute('SELECT * FROM employee_numbers WHERE employee_id = ?', [empId]);
    emps[0].numbers = nums;
    res.json({ success: true, employee: emps[0] });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists for another employee' });
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Update Employee ──
app.put('/api/employees/:id', adminOnly, async (req, res) => {
  try {
    const [emps] = await pool.execute('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!emps.length) return res.status(404).json({ error: 'Not found' });
    const old = emps[0];
    let { name, dept, numbers } = req.body;
    if (name !== undefined && String(name).trim() !== String(old.name).trim()) {
      if (!(await adminCanEditEmployeeName(req.admin))) {
        return res.status(403).json({ error: 'Only designated name editors can change employee names' });
      }
    }
    const email = req.body.email !== undefined ? normalizeEmail(req.body.email) : old.email;
    let branch = req.body.branch !== undefined ? req.body.branch : old.branch;
    let station_name = req.body.station_name !== undefined ? String(req.body.station_name || '').trim() : (old.station_name || '');
    let location_id = req.body.location_id !== undefined ? req.body.location_id : old.location_id;
    let state_name = old.state_name || '';
    const works_for_station = req.body.works_for_station !== undefined
      ? normalizeWorksForStation(req.body.works_for_station)
      : normalizeWorksForStation(old.works_for_station);
    const loc = await resolveLocationMeta(location_id);
    if (loc) {
      branch = loc.country_name || loc.branch_name;
      state_name = loc.state_name || '';
      station_name = loc.name;
      location_id = loc.id;
    }
    if (dept) await ensureDepartmentName(dept);
    await pool.execute(
      'UPDATE employees SET name = ?, email = ?, dept = ?, branch = ?, state_name = ?, station_name = ?, works_for_station = ?, location_id = ?, updated_by = ? WHERE id = ?',
      [name || old.name, email, dept || old.dept, branch || old.branch, state_name || '', station_name || '', works_for_station, location_id || null, req.admin.id, req.params.id]
    );
    if (numbers && numbers.length) {
      await upsertEmployeeNumbers(req.params.id, numbers);
    }
    await logAction(req.admin.id, 'update', 'employee', parseInt(req.params.id), old, req.body);
    const [newEmps] = await pool.execute('SELECT * FROM employees WHERE id = ?', [req.params.id]);
    const [nums] = await pool.execute('SELECT * FROM employee_numbers WHERE employee_id = ?', [req.params.id]);
    newEmps[0].numbers = nums;
    res.json({ success: true, employee: newEmps[0] });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists for another employee' });
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Bulk import employees (upsert) ──
app.post('/api/employees/import', adminOnly, async (req, res) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'No rows to import' });

    const summary = { created: 0, updated: 0, skipped: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const rowNum = i + 2; // Excel header is row 1
      try {
        const name = String(row.name || '').trim();
        const dept = String(row.dept || row.department || '').trim();
        let placeName = String(row.state || row.place || '').trim();
        if (placeName.toLowerCase() === 'main') placeName = '';
        const legacyCountry = String(row.country || row.branch || '').trim();
        let locationName = String(row.location || row.station_name || row.company || '').trim();
        // Support "Place · Company" in location cell
        const locParts = locationName.match(/^(.+?)\s*[·|/]\s*(.+)$/);
        if (locParts) {
          const left = locParts[1].trim();
          const right = locParts[2].trim();
          if (!placeName) placeName = left;
          locationName = right;
        }
        // Legacy sheets: country alone as place when state/place empty
        if (!placeName && legacyCountry) {
          placeName = legacyCountry;
        }
        const email = normalizeEmail(row.email);
        const works_for_station = normalizeWorksForStation(
          row.works_for_station || row.works_for || row.ops_station
        );
        const id = row.id ? parseInt(row.id, 10) : null;

        if (!name) {
          summary.skipped++;
          summary.errors.push({ row: rowNum, error: 'Name is required' });
          continue;
        }
        if (!dept) {
          summary.skipped++;
          summary.errors.push({ row: rowNum, error: 'Department is required' });
          continue;
        }
        await ensureDepartmentName(dept);
        if (!placeName) {
          summary.skipped++;
          summary.errors.push({ row: rowNum, error: 'State / Country (place) is required' });
          continue;
        }

        const place = await resolvePlaceToCountryState(placeName);
        if (!place) {
          summary.skipped++;
          summary.errors.push({ row: rowNum, error: 'Could not resolve place' });
          continue;
        }

        const loc = await resolveOrCreateLocationByNames(place.countryName, place.stateName, locationName || 'Main');
        if (!loc) {
          summary.skipped++;
          summary.errors.push({ row: rowNum, error: 'Could not resolve country/state/location' });
          continue;
        }

        const numbers = numbersFromImportRow(row);

        let existing = null;
        if (id && !Number.isNaN(id)) {
          const [byId] = await pool.execute('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', [id]);
          if (byId.length) existing = byId[0];
        }
        if (!existing && email) {
          const [byEmail] = await pool.execute('SELECT * FROM employees WHERE email = ? AND deleted_at IS NULL', [email]);
          if (byEmail.length) existing = byEmail[0];
        }
        if (!existing) {
          const [byName] = await pool.execute(
            `SELECT * FROM employees
             WHERE deleted_at IS NULL AND LOWER(name) = LOWER(?) AND location_id = ?
             LIMIT 1`,
            [name, loc.id]
          );
          if (byName.length) existing = byName[0];
        }

        if (existing) {
          let finalName = name;
          if (String(name).trim() !== String(existing.name).trim() && !(await adminCanEditEmployeeName(req.admin))) {
            finalName = existing.name;
          }
          await pool.execute(
            'UPDATE employees SET name = ?, email = ?, dept = ?, branch = ?, state_name = ?, station_name = ?, works_for_station = ?, location_id = ?, updated_by = ? WHERE id = ?',
            [finalName, email !== null ? email : existing.email, dept, loc.country_name || loc.branch_name, loc.state_name || '', loc.name, works_for_station, loc.id, req.admin.id, existing.id]
          );
          const hasNums = numbers.some(n => n.ext || n.mobile || n.sd || n.sdNo);
          if (hasNums) await upsertEmployeeNumbers(existing.id, numbers);
          summary.updated++;
        } else {
          const [ins] = await pool.execute(
            'INSERT INTO employees (name, email, dept, branch, state_name, station_name, works_for_station, location_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [name, email, dept, loc.country_name || loc.branch_name, loc.state_name || '', loc.name, works_for_station, loc.id, req.admin.id]
          );
          await upsertEmployeeNumbers(ins.insertId, numbers);
          summary.created++;
        }
      } catch (err) {
        summary.skipped++;
        summary.errors.push({
          row: rowNum,
          error: err && err.code === 'ER_DUP_ENTRY' ? 'Duplicate email' : (err.message || 'Import failed'),
        });
      }
    }

    await logAction(req.admin.id, 'import', 'employee', null, null, {
      created: summary.created,
      updated: summary.updated,
      skipped: summary.skipped,
      total: rows.length,
    });

    res.json({ success: true, ...summary });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Delete Request (first click - marks row red) ──
app.post('/api/employees/:id/delete-request', adminOnly, async (req, res) => {
  try {
    const [emps] = await pool.execute('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!emps.length) return res.status(404).json({ error: 'Not found' });
    const emp = emps[0];
    if (emp.delete_requested_by) {
      if (emp.delete_requested_by === req.admin.id) return res.status(400).json({ error: 'You already requested deletion. Another admin must confirm.' });
      return res.status(400).json({ error: 'Delete already requested by another admin' });
    }
    await pool.execute('UPDATE employees SET delete_requested_by = ?, delete_requested_at = NOW() WHERE id = ?', [req.admin.id, req.params.id]);
    await logAction(req.admin.id, 'delete_request', 'employee', parseInt(req.params.id), null, { requested_by: req.admin.id });
    res.json({ success: true, message: 'Delete requested. Row highlighted. Another admin must confirm.' });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Confirm Delete (second click by different admin) ──
app.delete('/api/employees/:id', adminOnly, async (req, res) => {
  try {
    const [emps] = await pool.execute('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!emps.length) return res.status(404).json({ error: 'Not found' });
    const emp = emps[0];
    if (!emp.delete_requested_by) return res.status(400).json({ error: 'Delete was not requested first. Click delete to request.' });
    if (emp.delete_requested_by === req.admin.id) return res.status(400).json({ error: 'You requested this deletion. Another admin must confirm it.' });
    await pool.execute('UPDATE employees SET deleted_at = NOW(), deleted_by = ? WHERE id = ?', [req.admin.id, req.params.id]);
    await logAction(req.admin.id, 'delete_confirm', 'employee', parseInt(req.params.id), emp, { deleted_by: req.admin.id });
    res.json({ success: true, message: 'Employee deleted' });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Cancel Delete Request (any admin) ──
app.post('/api/employees/:id/cancel-delete', adminOnly, async (req, res) => {
  try {
    const [emps] = await pool.execute('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!emps.length) return res.status(404).json({ error: 'Not found' });
    const emp = emps[0];
    if (!emp.delete_requested_by) return res.status(400).json({ error: 'No delete request to cancel' });
    await pool.execute('UPDATE employees SET delete_requested_by = NULL, delete_requested_at = NULL WHERE id = ?', [req.params.id]);
    await logAction(req.admin.id, 'delete_cancel', 'employee', parseInt(req.params.id), { requested_by: emp.delete_requested_by }, { cancelled_by: req.admin.id });
    res.json({ success: true, message: 'Delete request cancelled' });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Add Extension ──
app.post('/api/employees/:id/extensions', adminOnly, async (req, res) => {
  try {
    const [emps] = await pool.execute('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!emps.length) return res.status(404).json({ error: 'Not found' });
    const [existingNums] = await pool.execute('SELECT id FROM employee_numbers WHERE employee_id = ?', [req.params.id]);
    const { ext, mobile, sd, sdNo } = req.body;
    const label = 'Ext ' + (existingNums.length + 1);
    await pool.execute('INSERT INTO employee_numbers (employee_id, label, ext, mobile, sd, sd_no) VALUES (?, ?, ?, ?, ?, ?)', [req.params.id, label, ext || '', mobile || '', sd || '', sdNo || '']);
    await pool.execute('UPDATE employees SET updated_by = ? WHERE id = ?', [req.admin.id, req.params.id]);
    await logAction(req.admin.id, 'update', 'employee', parseInt(req.params.id), null, { added_extension: { ...req.body, label } });
    const [nums] = await pool.execute('SELECT * FROM employee_numbers WHERE employee_id = ? ORDER BY id', [req.params.id]);
    emps[0].numbers = nums;
    res.json({ success: true, employee: emps[0] });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Update Extension ──
app.put('/api/employees/:id/extensions/:extIdx', adminOnly, async (req, res) => {
  try {
    const [emps] = await pool.execute('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!emps.length) return res.status(404).json({ error: 'Not found' });
    const [nums] = await pool.execute('SELECT * FROM employee_numbers WHERE employee_id = ? ORDER BY id', [req.params.id]);
    const idx = parseInt(req.params.extIdx);
    if (idx < 0 || idx >= nums.length) return res.status(400).json({ error: 'Invalid extension index' });
    const old = nums[idx];
    const { ext, mobile, sd, sdNo } = req.body;
    const label = 'Ext ' + (idx + 1);
    const body = { ext, mobile, sd, sdNo };
    if (extensionFieldsChanged(old, body) && hasRemovableValues(old)) {
      await createExtensionRemovalRecord(req.params.id, old.id, old, body, 'changed', req.admin.id);
    }
    await pool.execute(
      'UPDATE employee_numbers SET label = ?, ext = ?, mobile = ?, sd = ?, sd_no = ? WHERE id = ?',
      [label, ext || '', mobile || '', sd || '', sdNo || '', old.id]
    );
    await pool.execute('UPDATE employees SET updated_by = ? WHERE id = ?', [req.admin.id, req.params.id]);
    await logAction(req.admin.id, 'update', 'employee', parseInt(req.params.id), { extension: old }, { updated_extension: { ...req.body, label } });
    const [newNums] = await pool.execute('SELECT * FROM employee_numbers WHERE employee_id = ? ORDER BY id', [req.params.id]);
    emps[0].numbers = newNums;
    res.json({ success: true, employee: emps[0] });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Delete Extension ──
app.delete('/api/employees/:id/extensions/:extIdx', adminOnly, async (req, res) => {
  try {
    const [emps] = await pool.execute('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!emps.length) return res.status(404).json({ error: 'Not found' });
    const [nums] = await pool.execute('SELECT * FROM employee_numbers WHERE employee_id = ? ORDER BY id', [req.params.id]);
    const idx = parseInt(req.params.extIdx);
    if (idx < 0 || idx >= nums.length) return res.status(400).json({ error: 'Invalid extension index' });
    const old = nums[idx];
    if (hasRemovableValues(old)) {
      await createExtensionRemovalRecord(req.params.id, old.id, old, {}, 'removed', req.admin.id);
    }
    await pool.execute('DELETE FROM employee_numbers WHERE id = ?', [old.id]);
    await renumberEmployeeExtLabels(req.params.id);
    await pool.execute('UPDATE employees SET updated_by = ? WHERE id = ?', [req.admin.id, req.params.id]);
    await logAction(req.admin.id, 'update', 'employee', parseInt(req.params.id), null, { removed_extension: nums[idx] });
    const [newNums] = await pool.execute('SELECT * FROM employee_numbers WHERE employee_id = ? ORDER BY id', [req.params.id]);
    emps[0].numbers = newNums;
    res.json({ success: true, employee: emps[0] });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Confirm extension removed from Avaya (second admin) ──
app.post('/api/employees/:id/extension-removals/:removalId/confirm', adminOnly, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM employee_number_removals
       WHERE id = ? AND employee_id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL`,
      [req.params.removalId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pending removal not found' });
    const row = rows[0];
    if (row.requested_by === req.admin.id) {
      return res.status(400).json({ error: 'You logged this change. Another admin must confirm Avaya removal.' });
    }
    await pool.execute(
      'UPDATE employee_number_removals SET confirmed_by = ?, confirmed_at = NOW() WHERE id = ?',
      [req.admin.id, row.id]
    );
    await logAction(req.admin.id, 'extension_removal_confirm', 'employee', parseInt(req.params.id), row, { confirmed_by: req.admin.id });
    res.json({ success: true, message: 'Marked as removed from Avaya' });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Cancel pending extension removal (reverts extension to old values) ──
app.post('/api/employees/:id/extension-removals/:removalId/cancel', adminOnly, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM employee_number_removals
       WHERE id = ? AND employee_id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL`,
      [req.params.removalId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pending removal not found' });
    const row = rows[0];

    if (row.reason === 'changed' && row.employee_number_id) {
      await pool.execute(
        `UPDATE employee_numbers SET label = ?, ext = ?, mobile = ?, sd = ?, sd_no = ? WHERE id = ? AND employee_id = ?`,
        [row.label || '', row.ext || '', row.mobile || '', row.sd || '', row.sd_no || '', row.employee_number_id, req.params.id]
      );
    } else if (row.reason === 'removed') {
      await pool.execute(
        `INSERT INTO employee_numbers (employee_id, label, ext, mobile, sd, sd_no)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.params.id, row.label || 'Ext', row.ext || '', row.mobile || '', row.sd || '', row.sd_no || '']
      );
      await renumberEmployeeExtLabels(req.params.id);
    }

    await pool.execute('UPDATE employee_number_removals SET cancelled_at = NOW() WHERE id = ?', [row.id]);
    await pool.execute('UPDATE employees SET updated_by = ? WHERE id = ?', [req.admin.id, req.params.id]);
    await logAction(req.admin.id, 'extension_removal_cancel', 'employee', parseInt(req.params.id), row, { cancelled_by: req.admin.id, reverted: true });
    res.json({ success: true, message: 'Change reverted — old extension restored' });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Super Admin: Get all admins ──
app.get('/api/admins', superAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, name, email, role, is_active, can_edit_employee_names, created_at, updated_at FROM admins ORDER BY id'
    );
    res.json(rows);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Super Admin: Set who can edit employee names (max 2, plus super_admin always) ──
app.put('/api/admins/name-editors', superAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.adminIds)
      ? [...new Set(req.body.adminIds.map((id) => parseInt(id, 10)).filter((id) => id > 0))]
      : [];
    if (ids.length > 2) {
      return res.status(400).json({ error: 'Maximum 2 name editors allowed (Super Admin always has access)' });
    }
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const [found] = await pool.execute(
        `SELECT id FROM admins WHERE id IN (${placeholders}) AND is_active = 1 AND role != 'super_admin'`,
        ids
      );
      if (found.length !== ids.length) {
        return res.status(400).json({ error: 'One or more selected admins are invalid' });
      }
    }
    await pool.execute(`UPDATE admins SET can_edit_employee_names = 0 WHERE role != 'super_admin'`);
    for (const id of ids) {
      await pool.execute('UPDATE admins SET can_edit_employee_names = 1 WHERE id = ?', [id]);
    }
    await logAction(req.admin.id, 'update_name_editors', 'admin', null, null, { adminIds: ids });
    res.json({ success: true, adminIds: ids });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Super Admin: Create admin ──
app.post('/api/admins', superAdmin, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });
    // New accounts are always admin (not super_admin)
    let role = String(req.body.role || 'admin');
    if (role === 'super_admin') role = 'admin';
    if (!['admin', 'viewer', 'manager'].includes(role)) role = 'admin';
    if (String(email).trim().toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL) {
      return res.status(400).json({ error: 'This email is reserved for the primary super admin' });
    }
    const hash = CryptoJS.SHA256(password).toString();
    const [r] = await pool.execute('INSERT INTO admins (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [name, email, hash, role]);
    await logAction(req.admin.id, 'create_admin', 'admin', r.insertId, null, { name, email, role });
    res.json({ success: true, id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists' });
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Super Admin: Update admin ──
app.put('/api/admins/:id', superAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM admins WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const old = rows[0];
    const primary = isPrimarySuperAdmin(old);
    const { name, email, password, role, is_active } = req.body;
    let sql = 'UPDATE admins SET';
    const params = [];
    if (name) { sql += ' name = ?,'; params.push(name); }

    if (primary) {
      // Primary: may change password (and name); email/role/active locked
      if (email && String(email).trim().toLowerCase() !== PRIMARY_SUPER_ADMIN_EMAIL) {
        return res.status(400).json({ error: 'Primary super admin email cannot be changed' });
      }
      if (role && role !== 'super_admin') {
        return res.status(400).json({ error: 'Primary super admin role cannot be changed' });
      }
      if (is_active !== undefined && Number(is_active) === 0) {
        return res.status(400).json({ error: 'Primary super admin cannot be deactivated' });
      }
    } else {
      if (email) {
        if (String(email).trim().toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL) {
          return res.status(400).json({ error: 'This email is reserved for the primary super admin' });
        }
        sql += ' email = ?,';
        params.push(email);
      }
      if (role) {
        // Do not promote others to super_admin
        const safeRole = role === 'super_admin' ? 'admin' : role;
        const allowed = ['admin', 'viewer', 'manager'];
        sql += ' role = ?,';
        params.push(allowed.includes(safeRole) ? safeRole : 'admin');
      }
      if (is_active !== undefined) { sql += ' is_active = ?,'; params.push(is_active); }
    }

    if (password) { sql += ' password_hash = ?,'; params.push(CryptoJS.SHA256(password).toString()); }
    if (sql === 'UPDATE admins SET') return res.json({ success: true });
    sql = sql.slice(0, -1) + ' WHERE id = ?';
    params.push(parseInt(req.params.id));
    await pool.execute(sql, params);
    await logAction(req.admin.id, 'update_admin', 'admin', parseInt(req.params.id), old, req.body);
    res.json({ success: true });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Super Admin: Delete admin ──
app.delete('/api/admins/:id', superAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM admins WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (parseInt(req.params.id) === req.admin.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    if (isPrimarySuperAdmin(rows[0])) {
      return res.status(400).json({ error: 'Primary super admin cannot be deleted' });
    }
    await pool.execute('UPDATE admins SET is_active = 0 WHERE id = ?', [req.params.id]);
    await logAction(req.admin.id, 'delete_admin', 'admin', parseInt(req.params.id), rows[0], null);
    res.json({ success: true });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Super Admin: Get logs ──
app.get('/api/logs', superAdmin, async (req, res) => {
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.action) { where += ' AND l.action = ?'; params.push(req.query.action); }
    if (req.query.entity_type) { where += ' AND l.entity_type = ?'; params.push(req.query.entity_type); }
    if (req.query.date_filter === 'week') where += ' AND l.created_at >= NOW() - INTERVAL 7 DAY';
    if (req.query.date_filter === 'month') where += ' AND l.created_at >= NOW() - INTERVAL 30 DAY';
    const [rows] = await pool.execute(
      `SELECT l.*, a.name AS admin_name, a.email AS admin_email
       FROM admin_logs l
       LEFT JOIN admins a ON l.admin_id = a.id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT 500`, params);
    res.json(rows);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Departments CRUD ──
app.get('/api/departments', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT d.*,
              (SELECT COUNT(*) FROM employees e WHERE e.deleted_at IS NULL AND e.dept = d.name) AS employee_count
       FROM departments d
       ORDER BY d.sort_order, d.name`
    );
    res.json(rows);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/departments', fullAdminOnly, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Department name required' });
    const [r] = await pool.execute(
      'INSERT INTO departments (name, sort_order) VALUES (?, ?)',
      [name, req.body.sort_order || 0]
    );
    await logAction(req.admin.id, 'create', 'department', r.insertId, null, { name });
    const [rows] = await pool.execute('SELECT * FROM departments WHERE id = ?', [r.insertId]);
    res.json({ success: true, department: rows[0] });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Department already exists' });
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/departments/:id', fullAdminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM departments WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const old = existing[0];
    const name = String(req.body.name !== undefined ? req.body.name : old.name).trim();
    if (!name) return res.status(400).json({ error: 'Department name required' });
    const sortOrder = req.body.sort_order !== undefined ? req.body.sort_order : old.sort_order;
    await pool.execute(
      'UPDATE departments SET name = ?, sort_order = ? WHERE id = ?',
      [name, sortOrder || 0, req.params.id]
    );
    if (name !== old.name) {
      await pool.execute(
        'UPDATE employees SET dept = ? WHERE deleted_at IS NULL AND dept = ?',
        [name, old.name]
      );
    }
    await logAction(req.admin.id, 'update', 'department', parseInt(req.params.id), old, { name, sort_order: sortOrder });
    const [rows] = await pool.execute('SELECT * FROM departments WHERE id = ?', [req.params.id]);
    res.json({ success: true, department: rows[0] });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Department already exists' });
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/departments/:id', fullAdminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM departments WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    if (String(existing[0].name).toLowerCase() === UNCATEGORISED_DEPT.toLowerCase()) {
      return res.status(400).json({ error: 'Cannot delete the Uncategorised department' });
    }
    await ensureDepartmentName(UNCATEGORISED_DEPT);
    const [moved] = await pool.execute(
      'UPDATE employees SET dept = ? WHERE deleted_at IS NULL AND dept = ?',
      [UNCATEGORISED_DEPT, existing[0].name]
    );
    await pool.execute('DELETE FROM departments WHERE id = ?', [req.params.id]);
    await logAction(req.admin.id, 'delete', 'department', parseInt(req.params.id), existing[0], {
      moved_to: UNCATEGORISED_DEPT,
      employees_moved: moved.affectedRows || 0,
    });
    res.json({ success: true, moved: moved.affectedRows || 0, moved_to: UNCATEGORISED_DEPT });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Get countries / states / locations / depts for filters ──
app.get('/api/filters', async (req, res) => {
  try {
    const [countries] = await pool.execute('SELECT id, name, sort_order FROM branches ORDER BY sort_order, name');
    const [states] = await pool.execute(
      `SELECT s.id, s.country_id, s.name, s.sort_order, c.name AS country_name
       FROM states s JOIN branches c ON c.id = s.country_id
       ORDER BY c.sort_order, c.name, s.sort_order, s.name`
    );
    const [locations] = await pool.execute(
      `SELECT l.id, l.state_id, l.name, l.city, l.address, l.maps_url, l.sort_order,
              s.name AS state_name, s.country_id, c.name AS country_name, c.name AS branch_name
       FROM locations l
       JOIN states s ON s.id = l.state_id
       JOIN branches c ON c.id = s.country_id
       WHERE l.is_active = 1
       ORDER BY c.sort_order, c.name, s.sort_order, s.name, l.sort_order, l.name`
    );
    const [depts] = await pool.execute('SELECT name FROM departments ORDER BY sort_order, name');
    res.json({
      countries: countries.map(b => b.name),
      branches: countries.map(b => b.name), // backward compatible
      countryRows: countries,
      branchRows: countries,
      states,
      locations,
      depts: depts.map(r => r.name),
      departmentRows: depts,
    });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Public directory tree: country → states → locations → phones ──
app.get('/api/directory-tree', async (req, res) => {
  try {
    const [countries] = await pool.execute('SELECT id, name, sort_order FROM branches ORDER BY sort_order, name');
    const [states] = await pool.execute(
      'SELECT id, country_id, name, sort_order FROM states ORDER BY sort_order, name'
    );
    const [locations] = await pool.execute(
      `SELECT id, state_id, name, city, address, maps_url, sort_order
       FROM locations WHERE is_active = 1 ORDER BY sort_order, name`
    );
    const [phones] = await pool.execute(
      `SELECT id, location_id, branch, station_name, label, number_type, phone, is_primary, sort_order
       FROM station_numbers WHERE is_primary = 1 ORDER BY sort_order, id`
    );
    const phonesByLoc = {};
    for (const p of phones) {
      if (!p.location_id) continue;
      if (!phonesByLoc[p.location_id]) phonesByLoc[p.location_id] = [];
      phonesByLoc[p.location_id].push(p);
    }
    const locsByState = {};
    for (const l of locations) {
      if (!locsByState[l.state_id]) locsByState[l.state_id] = [];
      locsByState[l.state_id].push({ ...l, phones: phonesByLoc[l.id] || [] });
    }
    const statesByCountry = {};
    for (const s of states) {
      const locs = locsByState[s.id] || [];
      // Hide empty Main when country has other states with companies
      if (!statesByCountry[s.country_id]) statesByCountry[s.country_id] = [];
      statesByCountry[s.country_id].push({ ...s, locations: locs });
    }

    res.json(countries.map(c => {
      let sts = statesByCountry[c.id] || [];
      const withLocs = sts.filter(s => (s.locations || []).length > 0);
      const realStates = withLocs.filter(s => s.name !== 'Main');
      if (realStates.length) {
        sts = withLocs.filter(s => s.name !== 'Main' || (s.locations || []).length);
        // Prefer showing only non-Main when any real state exists
        sts = withLocs.filter(s => s.name !== 'Main');
        if (!sts.length) sts = withLocs;
      } else {
        sts = withLocs;
      }
      return { ...c, states: sts };
    }).filter(c => (c.states || []).some(s => (s.locations || []).length)));
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Countries CRUD (table: branches) ──
app.get('/api/branches', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM branches ORDER BY sort_order, name');
    res.json(rows);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});
app.get('/api/countries', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM branches ORDER BY sort_order, name');
    res.json(rows);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/branches', fullAdminOnly, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Country name required' });
    const sortOrder = req.body.sort_order || 0;
    const [r] = await pool.execute('INSERT INTO branches (name, sort_order) VALUES (?, ?)', [name, sortOrder]);
    // Default Main state for new country
    await pool.execute('INSERT INTO states (country_id, name, sort_order) VALUES (?, ?, 0)', [r.insertId, 'Main']);
    await logAction(req.admin.id, 'create', 'branch', r.insertId, null, { name, sort_order: sortOrder });
    const [rows] = await pool.execute('SELECT * FROM branches WHERE id = ?', [r.insertId]);
    res.json({ success: true, branch: rows[0], country: rows[0] });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Country already exists' });
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/branches/:id', fullAdminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM branches WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const old = existing[0];
    const name = req.body.name !== undefined ? String(req.body.name || '').trim() : old.name;
    const sortOrder = req.body.sort_order !== undefined ? req.body.sort_order : old.sort_order;
    if (!name) return res.status(400).json({ error: 'Country name required' });
    await pool.execute('UPDATE branches SET name = ?, sort_order = ? WHERE id = ?', [name, sortOrder || 0, req.params.id]);
    if (name !== old.name) {
      await pool.execute(
        `UPDATE employees e
         JOIN locations l ON e.location_id = l.id
         JOIN states s ON s.id = l.state_id
         SET e.branch = ? WHERE s.country_id = ?`,
        [name, req.params.id]
      );
      await pool.execute(
        `UPDATE station_numbers sn
         JOIN locations l ON sn.location_id = l.id
         JOIN states s ON s.id = l.state_id
         SET sn.branch = ? WHERE s.country_id = ?`,
        [name, req.params.id]
      );
    }
    await logAction(req.admin.id, 'update', 'branch', parseInt(req.params.id), old, req.body);
    const [rows] = await pool.execute('SELECT * FROM branches WHERE id = ?', [req.params.id]);
    res.json({ success: true, branch: rows[0], country: rows[0] });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Country already exists' });
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/branches/:id', fullAdminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM branches WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const [locs] = await pool.execute(
      `SELECT l.id FROM locations l JOIN states s ON s.id = l.state_id WHERE s.country_id = ?`,
      [req.params.id]
    );
    if (locs.length) {
      const ids = locs.map(l => l.id);
      const ph = ids.map(() => '?').join(',');
      const [empCount] = await pool.execute(
        `SELECT COUNT(*) AS c FROM employees WHERE deleted_at IS NULL AND location_id IN (${ph})`,
        ids
      );
      if (empCount[0].c > 0) {
        return res.status(400).json({ error: 'Cannot delete country with employees. Move or remove employees first.' });
      }
    }
    await pool.execute('DELETE FROM branches WHERE id = ?', [req.params.id]);
    await logAction(req.admin.id, 'delete', 'branch', parseInt(req.params.id), existing[0], null);
    res.json({ success: true });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── States CRUD ──
app.get('/api/states', async (req, res) => {
  try {
    let sql = `SELECT s.*, c.name AS country_name FROM states s JOIN branches c ON c.id = s.country_id`;
    const params = [];
    if (req.query.country_id) {
      sql += ' WHERE s.country_id = ?';
      params.push(req.query.country_id);
    }
    sql += ' ORDER BY c.sort_order, c.name, s.sort_order, s.name';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/states', fullAdminOnly, async (req, res) => {
  try {
    const countryId = parseInt(req.body.country_id, 10);
    const name = String(req.body.name || '').trim();
    if (!countryId || !name) return res.status(400).json({ error: 'Country and state name required' });
    const [c] = await pool.execute('SELECT * FROM branches WHERE id = ?', [countryId]);
    if (!c.length) return res.status(400).json({ error: 'Country not found' });
    const [r] = await pool.execute(
      'INSERT INTO states (country_id, name, sort_order) VALUES (?, ?, ?)',
      [countryId, name, req.body.sort_order || 0]
    );
    await logAction(req.admin.id, 'create', 'state', r.insertId, null, req.body);
    const [rows] = await pool.execute(
      `SELECT s.*, c.name AS country_name FROM states s JOIN branches c ON c.id = s.country_id WHERE s.id = ?`,
      [r.insertId]
    );
    res.json({ success: true, state: rows[0] });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'State already exists in this country' });
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/states/:id', fullAdminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM states WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const old = existing[0];
    const countryId = req.body.country_id || old.country_id;
    const name = req.body.name !== undefined ? String(req.body.name || '').trim() : old.name;
    const sortOrder = req.body.sort_order !== undefined ? req.body.sort_order : old.sort_order;
    if (!name) return res.status(400).json({ error: 'State name required' });
    await pool.execute(
      'UPDATE states SET country_id = ?, name = ?, sort_order = ? WHERE id = ?',
      [countryId, name, sortOrder || 0, req.params.id]
    );
    await pool.execute(
      'UPDATE employees e JOIN locations l ON e.location_id = l.id SET e.state_name = ? WHERE l.state_id = ?',
      [name, req.params.id]
    );
    await logAction(req.admin.id, 'update', 'state', parseInt(req.params.id), old, req.body);
    const [rows] = await pool.execute(
      `SELECT s.*, c.name AS country_name FROM states s JOIN branches c ON c.id = s.country_id WHERE s.id = ?`,
      [req.params.id]
    );
    res.json({ success: true, state: rows[0] });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'State already exists in this country' });
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/states/:id', fullAdminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM states WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const [locs] = await pool.execute('SELECT id FROM locations WHERE state_id = ?', [req.params.id]);
    if (locs.length) {
      const ids = locs.map(l => l.id);
      const ph = ids.map(() => '?').join(',');
      const [empCount] = await pool.execute(
        `SELECT COUNT(*) AS c FROM employees WHERE deleted_at IS NULL AND location_id IN (${ph})`,
        ids
      );
      if (empCount[0].c > 0) {
        return res.status(400).json({ error: 'Cannot delete state with employees. Reassign employees first.' });
      }
    }
    await pool.execute('DELETE FROM states WHERE id = ?', [req.params.id]);
    await logAction(req.admin.id, 'delete', 'state', parseInt(req.params.id), existing[0], null);
    res.json({ success: true });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Locations (companies) CRUD ──
app.get('/api/locations', async (req, res) => {
  try {
    let sql = `SELECT l.*, s.name AS state_name, s.country_id, c.name AS country_name, c.name AS branch_name
               FROM locations l
               JOIN states s ON s.id = l.state_id
               JOIN branches c ON c.id = s.country_id`;
    const params = [];
    const where = [];
    if (req.query.state_id) { where.push('l.state_id = ?'); params.push(req.query.state_id); }
    if (req.query.country_id || req.query.branch_id) {
      where.push('s.country_id = ?');
      params.push(req.query.country_id || req.query.branch_id);
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY c.sort_order, c.name, s.sort_order, s.name, l.sort_order, l.name';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/locations', fullAdminOnly, async (req, res) => {
  try {
    const stateId = parseInt(req.body.state_id, 10);
    const name = String(req.body.name || '').trim();
    if (!stateId || !name) return res.status(400).json({ error: 'State and company name required' });
    const [st] = await pool.execute('SELECT * FROM states WHERE id = ?', [stateId]);
    if (!st.length) return res.status(400).json({ error: 'State not found' });
    const [r] = await pool.execute(
      'INSERT INTO locations (state_id, name, city, address, maps_url, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [stateId, name, req.body.city || '', req.body.address || '', req.body.maps_url || '', req.body.sort_order || 0, req.body.is_active === 0 ? 0 : 1]
    );
    await logAction(req.admin.id, 'create', 'location', r.insertId, null, req.body);
    const loc = await resolveLocationMeta(r.insertId);
    res.json({ success: true, location: loc });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Company already exists in this state' });
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/locations/:id', fullAdminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM locations WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const old = existing[0];
    const stateId = req.body.state_id || old.state_id;
    const name = req.body.name !== undefined ? String(req.body.name || '').trim() : old.name;
    const city = req.body.city !== undefined ? req.body.city : old.city;
    const address = req.body.address !== undefined ? req.body.address : old.address;
    const mapsUrl = req.body.maps_url !== undefined ? req.body.maps_url : old.maps_url;
    const sortOrder = req.body.sort_order !== undefined ? req.body.sort_order : old.sort_order;
    const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : old.is_active;
    if (!name) return res.status(400).json({ error: 'Company name required' });
    await pool.execute(
      'UPDATE locations SET state_id = ?, name = ?, city = ?, address = ?, maps_url = ?, sort_order = ?, is_active = ? WHERE id = ?',
      [stateId, name, city || '', address || '', mapsUrl || '', sortOrder || 0, isActive, req.params.id]
    );
    const meta = await resolveLocationMeta(req.params.id);
    await pool.execute(
      'UPDATE employees SET branch = ?, state_name = ?, station_name = ? WHERE location_id = ?',
      [meta.country_name, meta.state_name || '', name, req.params.id]
    );
    await pool.execute(
      'UPDATE station_numbers SET branch = ?, station_name = ?, address = ?, maps_url = ? WHERE location_id = ?',
      [meta.country_name, name, address || '', mapsUrl || '', req.params.id]
    );
    await logAction(req.admin.id, 'update', 'location', parseInt(req.params.id), old, req.body);
    res.json({ success: true, location: meta });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Company already exists in this state' });
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/locations/:id', fullAdminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM locations WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const [empCount] = await pool.execute(
      'SELECT COUNT(*) AS c FROM employees WHERE deleted_at IS NULL AND location_id = ?',
      [req.params.id]
    );
    if (empCount[0].c > 0) {
      return res.status(400).json({ error: 'Cannot delete location with employees. Reassign employees first.' });
    }
    await pool.execute('DELETE FROM station_numbers WHERE location_id = ?', [req.params.id]);
    await pool.execute('DELETE FROM locations WHERE id = ?', [req.params.id]);
    await logAction(req.admin.id, 'delete', 'location', parseInt(req.params.id), existing[0], null);
    res.json({ success: true });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

function normalizeStationType(t) {
  if (t === 'internet' || t === 'both') return t;
  return 'tel';
}

async function clearOtherPrimaries(locationId, numberType, exceptId) {
  const type = normalizeStationType(numberType);
  if (exceptId) {
    await pool.execute(
      'UPDATE station_numbers SET is_primary = 0 WHERE location_id = ? AND number_type = ? AND id <> ?',
      [locationId, type, exceptId]
    );
  } else {
    await pool.execute(
      'UPDATE station_numbers SET is_primary = 0 WHERE location_id = ? AND number_type = ?',
      [locationId, type]
    );
  }
}

// ── Station numbers: public primaries only ──
app.get('/api/stations', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT s.id, s.location_id, s.branch, s.station_name, s.label, s.number_type, s.phone,
              COALESCE(NULLIF(l.address,''), s.address) AS address,
              COALESCE(NULLIF(l.maps_url,''), s.maps_url) AS maps_url,
              s.is_primary, s.sort_order, l.city
       FROM station_numbers s
       LEFT JOIN locations l ON l.id = s.location_id
       WHERE s.is_primary = 1
       ORDER BY s.branch, s.station_name, s.sort_order, s.id`
    );
    res.json(rows);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Station numbers: all (admin) ──
app.get('/api/stations/all', fullAdminOnly, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT s.*, l.name AS location_name, l.city, st.name AS state_name, st.id AS state_id,
              c.name AS branch_name, c.id AS branch_id, c.id AS country_id,
              COALESCE(NULLIF(l.address,''), s.address) AS address,
              COALESCE(NULLIF(l.maps_url,''), s.maps_url) AS maps_url
       FROM station_numbers s
       LEFT JOIN locations l ON l.id = s.location_id
       LEFT JOIN states st ON st.id = l.state_id
       LEFT JOIN branches c ON c.id = st.country_id
       ORDER BY COALESCE(c.name, s.branch), COALESCE(st.name, ''), COALESCE(l.name, s.station_name), s.is_primary DESC, s.sort_order, s.id`
    );
    res.json(rows);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/stations', fullAdminOnly, async (req, res) => {
  try {
    const { location_id, label, number_type, phone, is_primary, sort_order } = req.body;
    if (!location_id || !phone) return res.status(400).json({ error: 'Location and phone required' });
    const loc = await resolveLocationMeta(location_id);
    if (!loc) return res.status(400).json({ error: 'Location not found' });
    const type = normalizeStationType(number_type);
    const primary = is_primary ? 1 : 0;
    if (primary) await clearOtherPrimaries(loc.id, type, null);
    const [r] = await pool.execute(
      'INSERT INTO station_numbers (location_id, branch, station_name, label, number_type, phone, address, maps_url, is_primary, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [loc.id, loc.branch_name, loc.name, label || '', type, phone, loc.address || '', loc.maps_url || '', primary, sort_order || 0]
    );
    await logAction(req.admin.id, 'create', 'station', r.insertId, null, { location_id: loc.id, phone, number_type: type, is_primary: primary });
    const [rows] = await pool.execute('SELECT * FROM station_numbers WHERE id = ?', [r.insertId]);
    res.json({ success: true, station: rows[0] });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.put('/api/stations/:id', fullAdminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM station_numbers WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const old = existing[0];
    const locationId = req.body.location_id || old.location_id;
    const loc = await resolveLocationMeta(locationId);
    if (!loc) return res.status(400).json({ error: 'Location not found' });
    const label = req.body.label !== undefined ? req.body.label : old.label;
    const type = req.body.number_type !== undefined ? normalizeStationType(req.body.number_type) : old.number_type;
    const phone = req.body.phone || old.phone;
    const primary = req.body.is_primary !== undefined ? (req.body.is_primary ? 1 : 0) : old.is_primary;
    const sortOrder = req.body.sort_order !== undefined ? req.body.sort_order : old.sort_order;
    if (primary) await clearOtherPrimaries(loc.id, type, parseInt(req.params.id));
    await pool.execute(
      'UPDATE station_numbers SET location_id = ?, branch = ?, station_name = ?, label = ?, number_type = ?, phone = ?, address = ?, maps_url = ?, is_primary = ?, sort_order = ? WHERE id = ?',
      [loc.id, loc.branch_name, loc.name, label || '', type, phone, loc.address || '', loc.maps_url || '', primary, sortOrder || 0, req.params.id]
    );
    await logAction(req.admin.id, 'update', 'station', parseInt(req.params.id), old, req.body);
    const [rows] = await pool.execute('SELECT * FROM station_numbers WHERE id = ?', [req.params.id]);
    res.json({ success: true, station: rows[0] });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/stations/:id', fullAdminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM station_numbers WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    await pool.execute('DELETE FROM station_numbers WHERE id = ?', [req.params.id]);
    await logAction(req.admin.id, 'delete', 'station', parseInt(req.params.id), existing[0], null);
    res.json({ success: true });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Public access gate (IP whitelist + passcode) ──
app.get('/api/access/check', async (req, res) => {
  try {
    debug('ENTERED GET /api/access/check');
    const result = await evaluatePublicAccess(req);
    // Log office-IP open at most once per IP per 30 minutes
    if (result.allowed && result.reason === 'ip') {
      const ip = result.clientIp || '';
      const [recent] = await pool.execute(
        `SELECT id FROM access_logs
         WHERE action = 'office_ip' AND ip_address = ?
           AND created_at >= NOW() - INTERVAL 30 MINUTE
         LIMIT 1`,
        [ip]
      );
      if (!recent.length) {
        await logAccessEvent('office_ip', req, { details: 'Opened directory from allowed office IP' });
      }
    }
    res.json(result);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/access/unlock', async (req, res) => {
  try {
    debug('ENTERED POST /api/access/unlock');
    if (await isOfficeIpOnlyMode()) {
      return res.status(403).json({ error: 'Passcode access is disabled. Use the office network.' });
    }
    const passcode = String(req.body.passcode || '').trim();
    if (!passcode) return res.status(400).json({ error: 'Passcode required' });
    const hash = hashPasscode(passcode);
    const [rows] = await pool.execute(
      'SELECT id, label, duration_amount, duration_unit FROM access_passcodes WHERE is_active = 1 AND passcode_hash = ? LIMIT 1',
      [hash]
    );
    if (!rows.length) {
      await logAccessEvent('unlock_fail', req, { details: 'Incorrect passcode' });
      return res.status(401).json({ error: 'Incorrect passcode' });
    }
    const row = rows[0];
    const seconds = durationToSeconds(row.duration_amount, row.duration_unit);
    const token = jwt.sign(
      { scope: 'directory_public', passcodeId: row.id },
      JWT_SECRET,
      { expiresIn: seconds }
    );
    res.setHeader(
      'Set-Cookie',
      `directory_access=${encodeURIComponent(token)}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Lax`
    );
    await logAccessEvent('unlock_ok', req, {
      passcodeId: row.id,
      passcodeLabel: row.label || 'Passcode',
      details: 'Unlocked for ' + durationLabel(row.duration_amount, row.duration_unit),
    });
    res.json({
      success: true,
      token,
      label: row.label || 'Access granted',
      expiresInSeconds: seconds,
      duration: durationLabel(row.duration_amount, row.duration_unit),
    });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/access/logs', adminOnly, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    const action = String(req.query.action || '').trim();
    let sql = `SELECT id, action, ip_address, device_name, passcode_id, passcode_label, details, user_agent, created_at
               FROM access_logs
               WHERE created_at >= NOW() - INTERVAL ${days} DAY`;
    const params = [];
    if (action) {
      sql += ' AND action = ?';
      params.push(action);
    }
    sql += ' ORDER BY created_at DESC LIMIT 500';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

function normalizeAccessEntryBody(body, existing = null) {
  const entryType = String(body.entry_type || existing?.entry_type || 'ip').toLowerCase() === 'host' ? 'host' : 'ip';
  const label = body.label !== undefined ? String(body.label || '').trim() : String(existing?.label || '').trim();
  const isActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : (existing?.is_active ? 1 : 1);
  if (entryType === 'host') {
    const hostName = normalizeHostname(body.host_name || body.hostname || body.host || existing?.host_name || '');
    if (!isValidHostname(hostName)) {
      return { error: 'Valid hostname required (e.g. dubai-office.dyndns.org)' };
    }
    return { entryType, ipAddress: '', hostName, label, isActive };
  }
  const ipAddress = body.ip_address !== undefined || body.ip !== undefined
    ? normalizeIp(body.ip_address || body.ip)
    : normalizeIp(existing?.ip_address || '');
  if (!isValidIp(ipAddress)) {
    return { error: 'Valid IPv4 or IPv6 address required' };
  }
  return { entryType, ipAddress, hostName: '', label, isActive };
}

async function accessEntryDuplicate(entryType, ipAddress, hostName, excludeId = null) {
  if (entryType === 'host') {
    let sql = `SELECT id FROM access_allowed_ips WHERE entry_type = 'host' AND LOWER(host_name) = ?`;
    const params = [hostName];
    if (excludeId) {
      sql += ' AND id != ?';
      params.push(excludeId);
    }
    sql += ' LIMIT 1';
    const [rows] = await pool.execute(sql, params);
    return rows.length > 0;
  }
  let sql = `SELECT id FROM access_allowed_ips WHERE entry_type = 'ip' AND ip_address = ?`;
  const params = [ipAddress];
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  sql += ' LIMIT 1';
  const [rows] = await pool.execute(sql, params);
  return rows.length > 0;
}

async function enrichAccessEntries(rows) {
  const out = [];
  for (const row of rows) {
    const entry = {
      id: row.id,
      entry_type: row.entry_type || 'ip',
      ip_address: row.ip_address || '',
      host_name: row.host_name || '',
      label: row.label || '',
      is_active: row.is_active,
      created_at: row.created_at,
      resolved_ips: [],
    };
    if (entry.entry_type === 'host' && entry.host_name) {
      entry.resolved_ips = [...await resolveHostToIps(entry.host_name)];
    }
    out.push(entry);
  }
  return out;
}

app.get('/api/access/ips', adminOnly, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, entry_type, ip_address, host_name, label, is_active, created_at
       FROM access_allowed_ips ORDER BY id DESC`
    );
    res.json({ ips: await enrichAccessEntries(rows), clientIp: await resolveClientIp(req) });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/access/ips', adminOnly, async (req, res) => {
  try {
    const parsed = normalizeAccessEntryBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { entryType, ipAddress, hostName, label, isActive } = parsed;
    if (await accessEntryDuplicate(entryType, ipAddress, hostName)) {
      return res.status(400).json({ error: entryType === 'host' ? 'This hostname is already listed' : 'This IP is already listed' });
    }
    const [r] = await pool.execute(
      `INSERT INTO access_allowed_ips (entry_type, ip_address, host_name, label, is_active)
       VALUES (?, ?, ?, ?, ?)`,
      [entryType, ipAddress, hostName, label, isActive]
    );
    clearHostResolveCache(hostName);
    await logAction(req.admin.id, 'create', 'access_ip', r.insertId, null, { entry_type: entryType, ip: ipAddress, host_name: hostName, label });
    const [rows] = await pool.execute(
      `SELECT id, entry_type, ip_address, host_name, label, is_active, created_at FROM access_allowed_ips WHERE id = ?`,
      [r.insertId]
    );
    const [entry] = await enrichAccessEntries(rows);
    res.json({ success: true, ip: entry });
  } catch (e) {
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/access/ips/:id', adminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM access_allowed_ips WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const old = existing[0];
    const parsed = normalizeAccessEntryBody(req.body, old);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { entryType, ipAddress, hostName, label, isActive } = parsed;
    if (await accessEntryDuplicate(entryType, ipAddress, hostName, req.params.id)) {
      return res.status(400).json({ error: entryType === 'host' ? 'This hostname is already listed' : 'This IP is already listed' });
    }
    await pool.execute(
      `UPDATE access_allowed_ips
       SET entry_type = ?, ip_address = ?, host_name = ?, label = ?, is_active = ?
       WHERE id = ?`,
      [entryType, ipAddress, hostName, label, isActive, req.params.id]
    );
    clearHostResolveCache(old.host_name);
    clearHostResolveCache(hostName);
    await logAction(req.admin.id, 'update', 'access_ip', parseInt(req.params.id), old, {
      entry_type: entryType,
      ip: ipAddress,
      host_name: hostName,
      label,
      is_active: isActive,
    });
    const [rows] = await pool.execute(
      `SELECT id, entry_type, ip_address, host_name, label, is_active, created_at FROM access_allowed_ips WHERE id = ?`,
      [req.params.id]
    );
    const [entry] = await enrichAccessEntries(rows);
    res.json({ success: true, ip: entry });
  } catch (e) {
    debug('Route failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/access/ips/:id', adminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM access_allowed_ips WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    clearHostResolveCache(existing[0].host_name);
    await pool.execute('DELETE FROM access_allowed_ips WHERE id = ?', [req.params.id]);
    await logAction(req.admin.id, 'delete', 'access_ip', parseInt(req.params.id), existing[0], null);
    res.json({ success: true });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/access/passcodes', adminOnly, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, label, duration_amount, duration_unit, is_active, created_at FROM access_passcodes ORDER BY id DESC'
    );
    res.json(rows.map(r => ({
      ...r,
      duration_label: durationLabel(r.duration_amount, r.duration_unit),
    })));
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/access/passcodes', adminOnly, async (req, res) => {
  try {
    const label = String(req.body.label || '').trim() || 'Passcode';
    const passcode = String(req.body.passcode || '').trim();
    if (passcode.length < 4) return res.status(400).json({ error: 'Passcode must be at least 4 characters' });
    const dur = normalizeDuration(req.body.duration_amount, req.body.duration_unit);
    const [r] = await pool.execute(
      'INSERT INTO access_passcodes (label, passcode_hash, duration_amount, duration_unit, is_active) VALUES (?, ?, ?, ?, ?)',
      [label, hashPasscode(passcode), dur.amount, dur.unit, req.body.is_active === 0 ? 0 : 1]
    );
    await logAction(req.admin.id, 'create', 'access_passcode', r.insertId, null, { label, duration: dur });
    const [rows] = await pool.execute(
      'SELECT id, label, duration_amount, duration_unit, is_active, created_at FROM access_passcodes WHERE id = ?',
      [r.insertId]
    );
    res.json({ success: true, passcode: { ...rows[0], duration_label: durationLabel(rows[0].duration_amount, rows[0].duration_unit) } });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.put('/api/access/passcodes/:id', adminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM access_passcodes WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    const old = existing[0];
    const label = req.body.label !== undefined ? (String(req.body.label || '').trim() || 'Passcode') : old.label;
    const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : old.is_active;
    const dur = (req.body.duration_amount !== undefined || req.body.duration_unit !== undefined)
      ? normalizeDuration(
          req.body.duration_amount !== undefined ? req.body.duration_amount : old.duration_amount,
          req.body.duration_unit !== undefined ? req.body.duration_unit : old.duration_unit
        )
      : normalizeDuration(old.duration_amount, old.duration_unit);
    let hash = old.passcode_hash;
    if (req.body.passcode !== undefined && String(req.body.passcode).trim() !== '') {
      const passcode = String(req.body.passcode).trim();
      if (passcode.length < 4) return res.status(400).json({ error: 'Passcode must be at least 4 characters' });
      hash = hashPasscode(passcode);
    }
    await pool.execute(
      'UPDATE access_passcodes SET label = ?, passcode_hash = ?, duration_amount = ?, duration_unit = ?, is_active = ? WHERE id = ?',
      [label, hash, dur.amount, dur.unit, isActive, req.params.id]
    );
    await logAction(req.admin.id, 'update', 'access_passcode', parseInt(req.params.id), { label: old.label, is_active: old.is_active, duration_amount: old.duration_amount, duration_unit: old.duration_unit }, { label, is_active: isActive, duration: dur, passcode_changed: hash !== old.passcode_hash });
    const [rows] = await pool.execute(
      'SELECT id, label, duration_amount, duration_unit, is_active, created_at FROM access_passcodes WHERE id = ?',
      [req.params.id]
    );
    res.json({ success: true, passcode: { ...rows[0], duration_label: durationLabel(rows[0].duration_amount, rows[0].duration_unit) } });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/access/passcodes/:id', adminOnly, async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM access_passcodes WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Not found' });
    await pool.execute('DELETE FROM access_passcodes WHERE id = ?', [req.params.id]);
    await logAction(req.admin.id, 'delete', 'access_passcode', parseInt(req.params.id), { label: existing[0].label }, null);
    res.json({ success: true });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Verify auth token ──
app.get('/api/verify', auth, async (req, res) => {
  try {
    debug('ENTERED GET /api/verify');
    const [rows] = await pool.execute(
      'SELECT id, name, email, role, can_edit_employee_names FROM admins WHERE id = ? AND is_active = 1',
      [req.admin.id]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid token' });
    res.json({ valid: true, admin: adminPayloadFromRow(rows[0]) });
  } catch (e) { debug('Route failed', e); res.status(500).json({ error: e.message }); }
});

// ── Serve pages ──
// ── Serve pages ──
debug('Static file routes being registered');

app.get('/sw.js', (req, res) => {
  debug('Serving static: sw.js');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/manifest.webmanifest', (req, res) => {
  debug('Serving static: manifest.webmanifest');
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, 'manifest.webmanifest'));
});
app.get('/register-sw.js', (req, res) => {
  debug('Serving static: register-sw.js');
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'register-sw.js'));
});

app.get('/', (req, res) => {
  debug('Serving static: index.html');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/login', (req, res) => {
  debug('Serving static: login.html');
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/login.html', (req, res) => {
  debug('Serving static: login.html');
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/admin', (req, res) => {
  debug('Serving static: admin.html');
  res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/admin.html', (req, res) => {
  debug('Serving static: admin.html');
  res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/superadmin', (req, res) => {
  debug('Serving static: superadmin.html');
  res.sendFile(path.join(__dirname, 'superadmin.html'));
});
app.get('/superadmin.html', (req, res) => {
  debug('Serving static: superadmin.html');
  res.sendFile(path.join(__dirname, 'superadmin.html'));
});
app.use(express.static(__dirname));
debug('Static middleware initialized');
debug('Routes initialized');

app.use((err, req, res, next) => {
  debug('========== UNHANDLED EXPRESS ERROR ==========');
  debug('Request: ' + req.method + ' ' + req.originalUrl);
  debug('Error', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

async function bootSchema() {
  debug('bootSchema: started');
  try {
    debug('bootSchema: ensuring departments table...');
    await ensureDepartmentsTable();
    debug('bootSchema: departments table ready');
  } catch (e) {
    debug('bootSchema: failed to ensure departments table', e);
  }
  try {
    debug('bootSchema: ensuring works_for_station column...');
    await ensureWorksForStationColumn();
    debug('bootSchema: works_for_station column ready');
  } catch (e) {
    debug('bootSchema: failed to ensure works_for_station column', e);
  }
  try {
    debug('bootSchema: ensuring access control tables...');
    await ensureAccessTables();
    debug('bootSchema: access control tables ready');
  } catch (e) {
    debug('bootSchema: failed to ensure access tables', e);
  }
  try {
    debug('bootSchema: ensuring extension removal tables...');
    await ensureExtensionRemovalTables();
    debug('bootSchema: extension removal tables ready');
  } catch (e) {
    debug('bootSchema: failed to ensure extension removal tables', e);
  }
  try {
    debug('bootSchema: ensuring admins.role column supports manager...');
    await ensureAdminRoleColumn();
    debug('bootSchema: admins.role column ready');
  } catch (e) {
    debug('bootSchema: failed to ensure admins.role column', e);
  }
  try {
    debug('bootSchema: ensuring admins.can_edit_employee_names column...');
    await ensureAdminNameEditColumn();
    debug('bootSchema: admins.can_edit_employee_names column ready');
  } catch (e) {
    debug('bootSchema: failed to ensure admins.can_edit_employee_names column', e);
  }
  debug('bootSchema: completed');
}

let http;
try {
  http = require('http');
  debug('http loaded successfully');
} catch (err) {
  debug('http FAILED', err);
  throw err;
}

const server = http.createServer(app);
debug('HTTP server created');

function startStandaloneServer(startPort) {
  const base = Number(startPort) || 3000;
  const maxAttempts = Math.min(Math.max(Number(process.env.PORT_FALLBACK_MAX) || 10, 1), 100);

  function tryListen(port, attempt) {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
        debug('Port ' + port + ' in use, trying ' + (port + 1));
        tryListen(port + 1, attempt + 1);
        return;
      }
      debug('Server failed to listen on port ' + port, err);
      throw err;
    });

    server.listen(port, () => {
      server.removeAllListeners('error');
      process.env.ACTUAL_PORT = String(port);
      debug('SERVER STARTED at http://localhost:' + port);
      bootSchema();
    });
  }

  debug('No Passenger detected - trying ports from ' + base + ' (up to ' + maxAttempts + ' attempts)');
  debug('Server starting to listen');
  tryListen(base, 1);
}

// CloudLinux / Phusion Passenger needs listen('passenger')
if (typeof PhusionPassenger !== 'undefined') {
  debug('Passenger detected - listening on passenger socket');
  debug('Server starting to listen');
  PhusionPassenger.configure({ autoInstall: false });
  server.listen('passenger', () => {
    debug('SERVER STARTED (under Passenger)');
    bootSchema();
  });
} else {
  startStandaloneServer(process.env.PORT || 3000);
}
