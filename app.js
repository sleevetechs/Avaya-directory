// ── Country colors: logo forest (#005826) → lime (#DEE516), 12 steps ──
const GREEN_PALETTE = [
  { bg: '#005826', text: '#ffffff', light: true },
  { bg: '#146525', text: '#ffffff', light: true },
  { bg: '#287223', text: '#ffffff', light: true },
  { bg: '#3d7e22', text: '#ffffff', light: true },
  { bg: '#518b20', text: '#ffffff', light: true },
  { bg: '#65981f', text: '#ffffff', light: true },
  { bg: '#79a51d', text: '#0f3315', light: false },
  { bg: '#8db21c', text: '#0f3315', light: false },
  { bg: '#a1bf1a', text: '#0f3315', light: false },
  { bg: '#b6cb19', text: '#0f3315', light: false },
  { bg: '#cad817', text: '#0f3315', light: false },
  { bg: '#dee516', text: '#0f3315', light: false },
];

const countryColorIndex = new Map();

/** Give every country its own shade, in the order countries appear. */
function getBranchColor(branch) {
  const name = String(branch || '').trim();
  if (!name) return GREEN_PALETTE[0];
  if (!countryColorIndex.has(name)) {
    const order = (typeof DIRECTORY_TREE !== 'undefined' ? DIRECTORY_TREE : []).map(c => c.name);
    order.forEach((n, i) => { if (n && !countryColorIndex.has(n)) countryColorIndex.set(n, i); });
    if (!countryColorIndex.has(name)) countryColorIndex.set(name, countryColorIndex.size);
  }
  return GREEN_PALETTE[countryColorIndex.get(name) % GREEN_PALETTE.length];
}

/** Badge / station title parts: state only when country has multiple states (then omit country). */
function placeLabelParts(countryName, stateName, locationName) {
  const multi = countryNeedsStatePicker(countryName);
  const state = stateName && stateName !== 'Main' ? stateName : '';
  const loc = locationName && locationName !== 'Main' ? locationName : '';
  if (multi) return [state, loc].filter(Boolean);
  return [countryName, loc].filter(Boolean);
}

function getNumbers(emp) {
  if (emp.numbers) {
    emp.numbers.forEach(n => { if (n.sd_no !== undefined) n.sdNo = n.sd_no; });
    return emp.numbers;
  }
  return [{ label: "", ext: emp.ext || "", mobile: emp.mobile || "", sd: emp.sd || "", sdNo: emp.sdNo || emp.sd_no || "" }];
}

function getAllExts(emp) {
  return getNumbers(emp).map(n => n.ext).filter(Boolean).join(" / ");
}

function cleanNum(val) {
  return String(val || '').replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

let EMPLOYEES = [];
let filtered = [];
let DIRECTORY_TREE = [];
let selectedCountry = '';
let selectedStateId = null;
let selectedLocationId = null;

function countryNode(name) {
  return DIRECTORY_TREE.find(x => x.name === name) || null;
}

function statesForCountry(countryName) {
  const c = countryNode(countryName);
  return c ? (c.states || []) : [];
}

/** True when UI should show state cards (multiple real states). */
function countryNeedsStatePicker(countryName) {
  const states = statesForCountry(countryName).filter(s => (s.locations || []).length);
  if (states.length <= 1) return false;
  return states.some(s => s.name !== 'Main');
}

function locationsForState(state) {
  return state ? (state.locations || []) : [];
}

function allLocationsForCountry(countryName) {
  return statesForCountry(countryName).flatMap(s => s.locations || []);
}

function activeState() {
  if (!selectedCountry) return null;
  const states = statesForCountry(selectedCountry).filter(s => (s.locations || []).length);
  if (!states.length) return null;
  if (selectedStateId) return states.find(s => s.id === selectedStateId) || null;
  if (!countryNeedsStatePicker(selectedCountry) && states.length === 1) return states[0];
  return null;
}

function activeLocation() {
  const state = activeState();
  if (!state) return null;
  const locs = locationsForState(state);
  if (!locs.length) return null;
  if (selectedLocationId) return locs.find(l => l.id === selectedLocationId) || null;
  if (locs.length === 1) return locs[0];
  return null;
}

let directoryUiReady = false;
let accessWatchTimer = null;
let directorySyncTimer = null;
let directoryFetchInFlight = null;
let lastDirectorySyncAt = 0;
let directoryDataSource = 'none'; // live | cache | none

const DIRECTORY_IDB_NAME = 'compass-directory-pwa';
const DIRECTORY_IDB_VERSION = 1;
const DIRECTORY_IDB_STORE = 'directory';
const DIRECTORY_CACHE_KEY = 'snapshot';

function openDirectoryIdb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(DIRECTORY_IDB_NAME, DIRECTORY_IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DIRECTORY_IDB_STORE)) {
        db.createObjectStore(DIRECTORY_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

async function saveDirectoryCache(employees, tree) {
  const payload = {
    employees: Array.isArray(employees) ? employees : [],
    tree: Array.isArray(tree) ? tree : [],
    updatedAt: Date.now(),
  };
  try {
    const db = await openDirectoryIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DIRECTORY_IDB_STORE, 'readwrite');
      tx.objectStore(DIRECTORY_IDB_STORE).put(payload, DIRECTORY_CACHE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    lastDirectorySyncAt = payload.updatedAt;
    try {
      localStorage.setItem('directory_cache_meta', JSON.stringify({ updatedAt: payload.updatedAt, count: payload.employees.length }));
    } catch (_) { /* ignore quota */ }
    return payload;
  } catch (err) {
    console.warn('[pwa] save cache failed', err);
    // Fallback localStorage for small datasets
    try {
      localStorage.setItem('directory_cache_fallback', JSON.stringify(payload));
      lastDirectorySyncAt = payload.updatedAt;
      return payload;
    } catch (_) {
      return null;
    }
  }
}

async function loadDirectoryCache() {
  try {
    const db = await openDirectoryIdb();
    const payload = await new Promise((resolve, reject) => {
      const tx = db.transaction(DIRECTORY_IDB_STORE, 'readonly');
      const req = tx.objectStore(DIRECTORY_IDB_STORE).get(DIRECTORY_CACHE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (payload && Array.isArray(payload.employees)) return payload;
  } catch (err) {
    console.warn('[pwa] idb cache read failed', err);
  }
  try {
    const raw = localStorage.getItem('directory_cache_fallback');
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (payload && Array.isArray(payload.employees)) return payload;
  } catch (_) { /* ignore */ }
  return null;
}

async function hasDirectoryCache() {
  const cached = await loadDirectoryCache();
  return !!(cached && Array.isArray(cached.employees) && cached.employees.length >= 0 && cached.updatedAt);
}

function formatCacheTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function setSyncBanner(mode, updatedAt) {
  const wrap = document.getElementById('syncBanner');
  const inner = document.getElementById('syncBannerInner');
  if (!wrap || !inner) return;
  if (!mode || mode === 'live') {
    wrap.classList.add('hidden');
    inner.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  const when = formatCacheTime(updatedAt || lastDirectorySyncAt);
  if (mode === 'offline') {
    inner.className = 'mt-3 rounded-xl px-3.5 py-2.5 text-xs font-medium flex items-center justify-between gap-3 border bg-amber-50 border-amber-200 text-amber-900';
    inner.innerHTML = `<span>Offline — showing saved directory${when ? ' (updated ' + when + ')' : ''}.</span>
      <button type="button" onclick="refreshDirectoryFromNetwork({ force: true })" class="shrink-0 underline font-semibold cursor-pointer">Retry</button>`;
  } else if (mode === 'updating') {
    inner.className = 'mt-3 rounded-xl px-3.5 py-2.5 text-xs font-medium flex items-center justify-between gap-3 border bg-sky-50 border-sky-200 text-sky-900';
    inner.innerHTML = `<span>Updating directory from server…</span>`;
  } else if (mode === 'cached') {
    inner.className = 'mt-3 rounded-xl px-3.5 py-2.5 text-xs font-medium flex items-center justify-between gap-3 border bg-slate-50 border-slate-200 text-slate-700';
    inner.innerHTML = `<span>Showing saved list${when ? ' from ' + when : ''}. Will refresh when online.</span>
      <button type="button" onclick="refreshDirectoryFromNetwork({ force: true })" class="shrink-0 underline font-semibold cursor-pointer">Refresh</button>`;
  }
}

function applyDirectoryData(employees, tree, source) {
  EMPLOYEES = Array.isArray(employees) ? employees : [];
  DIRECTORY_TREE = Array.isArray(tree) ? tree : [];
  directoryDataSource = source || 'live';
  countryColorIndex.clear();
  filtered = [...EMPLOYEES];
  ensureDirectoryUiBound();
  populateFilters();
  renderStationStrip();
  updateSelectedStation();
  applyFilters();
  const badge = document.getElementById('totalBadge');
  if (badge) badge.textContent = `${EMPLOYEES.length} employees`;
}

function ensureDirectoryUiBound() {
  if (directoryUiReady) return;
  directoryUiReady = true;
  const search = document.getElementById('searchInput');
  const branch = document.getElementById('branchFilter');
  const dept = document.getElementById('deptFilter');
  const works = document.getElementById('worksForFilter');
  if (search) search.addEventListener('input', applyFilters);
  if (branch) branch.addEventListener('change', () => {
    selectCountry(document.getElementById('branchFilter').value || '');
  });
  if (dept) dept.addEventListener('change', applyFilters);
  if (works) works.addEventListener('change', applyFilters);
}

async function init() {
  await detectBrowserIps();
  const allowed = await ensureDirectoryAccess();
  if (!allowed) return;
  await loadDirectoryData();
  startDirectoryAutoSync();
}

async function loadDirectoryData(options = {}) {
  const silent = !!options.silent;
  const background = !!options.background;
  if (getDirectoryAccessToken() && isDirectorySessionExpired()) {
    if (background || silent) {
      const cached = await loadDirectoryCache();
      if (cached) {
        lastDirectorySyncAt = cached.updatedAt || 0;
        applyDirectoryData(cached.employees, cached.tree, 'cache');
        setSyncBanner(navigator.onLine ? 'cached' : 'offline', cached.updatedAt);
        return true;
      }
    }
    lockDirectoryForPasscode();
    return false;
  }

  // Prefer live network; fall back to IndexedDB/local cache
  const online = typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
  if (!online) {
    const cached = await loadDirectoryCache();
    if (cached) {
      lastDirectorySyncAt = cached.updatedAt || 0;
      applyDirectoryData(cached.employees, cached.tree, 'cache');
      setSyncBanner('offline', cached.updatedAt);
      return true;
    }
    if (!silent) {
      applyDirectoryData([], [], 'none');
      setSyncBanner('offline', 0);
    }
    return false;
  }

  if (!silent && directoryDataSource === 'cache') setSyncBanner('updating', lastDirectorySyncAt);

  try {
    const headers = directoryFetchHeaders();
    const [empRes, treeRes] = await Promise.all([
      fetch('/api/employees', { headers, cache: 'no-store' }),
      fetch('/api/directory-tree', { headers, cache: 'no-store' }),
    ]);
    if (empRes.status === 403 || treeRes.status === 403) {
      // Background sync must not wipe a good local copy
      if (background || silent) {
        const cached = await loadDirectoryCache();
        if (cached) {
          lastDirectorySyncAt = cached.updatedAt || 0;
          applyDirectoryData(cached.employees, cached.tree, 'cache');
          setSyncBanner('cached', cached.updatedAt);
          return true;
        }
      }
      lockDirectoryForPasscode((await empRes.json().catch(() => ({}))).clientIp);
      return false;
    }
    if (empRes.status === 503 || treeRes.status === 503) {
      throw new Error('Offline response from service worker');
    }
    if (!empRes.ok || !treeRes.ok) {
      throw new Error('Directory API error');
    }
    const employees = await empRes.json();
    const tree = await treeRes.json();
    if (!Array.isArray(employees) || !Array.isArray(tree)) {
      throw new Error('Invalid directory payload');
    }
    applyDirectoryData(employees, tree, 'live');
    await saveDirectoryCache(employees, tree);
    setSyncBanner('live');
    return true;
  } catch (err) {
    console.warn('[pwa] live directory fetch failed', err);
    const cached = await loadDirectoryCache();
    if (cached) {
      lastDirectorySyncAt = cached.updatedAt || 0;
      applyDirectoryData(cached.employees, cached.tree, 'cache');
      setSyncBanner(online ? 'cached' : 'offline', cached.updatedAt);
      return true;
    }
    if (!silent && !background) {
      applyDirectoryData([], [], 'none');
      setSyncBanner('offline', 0);
    }
    return false;
  }
}

async function refreshDirectoryFromNetwork(options = {}) {
  if (directoryFetchInFlight) return directoryFetchInFlight;
  const force = !!options.force;
  if (!force && typeof navigator.onLine === 'boolean' && !navigator.onLine) return false;
  directoryFetchInFlight = loadDirectoryData({
    silent: !force,
    background: options.background !== undefined ? !!options.background : false,
  }).finally(() => { directoryFetchInFlight = null; });
  return directoryFetchInFlight;
}

function startDirectoryAutoSync() {
  if (directorySyncTimer) return;
  window.addEventListener('online', () => {
    setSyncBanner('updating', lastDirectorySyncAt);
    refreshDirectoryFromNetwork({ force: true, background: true });
  });
  window.addEventListener('offline', async () => {
    const cached = await loadDirectoryCache();
    if (cached) setSyncBanner('offline', cached.updatedAt);
    else setSyncBanner('offline', 0);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      refreshDirectoryFromNetwork({ force: false, background: true });
    }
  });
  // Periodic refresh while tab is open and online
  directorySyncTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      refreshDirectoryFromNetwork({ force: false, background: true });
    }
  }, 60 * 1000);
}

function getDirectoryAccessToken() {
  return localStorage.getItem('directory_access_token') || '';
}

function getTokenExpiryMs(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return 0;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function getStoredAccessExpiryMs() {
  const stored = parseInt(localStorage.getItem('directory_access_expires_at') || '0', 10);
  if (stored) return stored;
  const token = getDirectoryAccessToken();
  return token ? getTokenExpiryMs(token) : 0;
}

function isDirectorySessionExpired() {
  const token = getDirectoryAccessToken();
  if (!token) return false;
  const exp = getStoredAccessExpiryMs();
  if (!exp) return false;
  return Date.now() >= exp;
}

function clearDirectorySession() {
  localStorage.removeItem('directory_access_token');
  localStorage.removeItem('directory_access_expires_at');
  stopAccessWatch();
}

function stopAccessWatch() {
  if (accessWatchTimer) {
    clearInterval(accessWatchTimer);
    accessWatchTimer = null;
  }
}

function startAccessWatch() {
  stopAccessWatch();
  if (!getDirectoryAccessToken()) return;
  accessWatchTimer = setInterval(() => {
    if (!getDirectoryAccessToken()) {
      stopAccessWatch();
      return;
    }
    if (isDirectorySessionExpired()) {
      lockDirectoryForPasscode(document.getElementById('accessGateIp')?.textContent);
    }
  }, 1000);
}

function lockDirectoryForPasscode(clientIp) {
  clearDirectorySession();
  EMPLOYEES = [];
  DIRECTORY_TREE = [];
  filtered = [];
  selectedCountry = '';
  selectedStateId = null;
  selectedLocationId = null;
  const grid = document.getElementById('employeeGrid');
  if (grid) grid.innerHTML = '';
  const strip = document.getElementById('stationStrip');
  if (strip) strip.innerHTML = '';
  const stationBox = document.getElementById('selectedStationBox');
  if (stationBox) stationBox.classList.add('hidden');
  const badge = document.getElementById('totalBadge');
  if (badge) badge.textContent = '';
  showAccessGate(clientIp, { officeIpOnly: false });
  const btn = document.getElementById('accessGateBtn');
  if (btn) btn.disabled = false;
  const input = document.getElementById('accessGateInput');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 50);
  }
}

function directoryFetchHeaders() {
  const headers = {};
  const dirToken = getDirectoryAccessToken();
  if (dirToken) headers['X-Directory-Access'] = dirToken;
  const adminToken = localStorage.getItem('token') || sessionStorage.getItem('token');
  if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;
  // Auto-detected in this visitor's browser only (never the server IP)
  if (browserPublicIp) headers['X-Client-Public-Ip'] = browserPublicIp;
  if (browserLocalIp) headers['X-Client-Local-Ip'] = browserLocalIp;
  return headers;
}

let browserPublicIp = sessionStorage.getItem('browserPublicIp') || '';
let browserLocalIp = sessionStorage.getItem('browserLocalIp') || '';

function isLanIpv4(ip) {
  return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(String(ip || ''));
}

async function detectBrowserLocalIp() {
  if (browserLocalIp && isLanIpv4(browserLocalIp)) return browserLocalIp;
  const found = new Set();
  const tryPc = async (iceServers) => {
    try {
      const pc = new RTCPeerConnection({ iceServers });
      pc.createDataChannel('');
      await new Promise((resolve) => {
        const done = () => { try { pc.close(); } catch (_) {} resolve(); };
        const timer = setTimeout(done, 2000);
        pc.onicecandidate = (e) => {
          if (!e || !e.candidate) {
            clearTimeout(timer);
            done();
            return;
          }
          const c = e.candidate;
          if (c.address && /^\d+\.\d+\.\d+\.\d+$/.test(c.address)) found.add(c.address);
          const m = String(c.candidate || '').match(/([0-9]{1,3}(?:\.[0-9]{1,3}){3})/);
          if (m) found.add(m[1]);
        };
        pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(done);
      });
    } catch (_) { /* ignore */ }
  };
  await tryPc([]);
  if (![...found].some(isLanIpv4)) {
    await tryPc([{ urls: 'stun:stun.l.google.com:19302' }]);
  }
  const list = [...found].filter((ip) => ip && !ip.startsWith('127.') && ip !== '0.0.0.0');
  const lan = list.find(isLanIpv4) || '';
  if (lan) {
    browserLocalIp = lan;
    sessionStorage.setItem('browserLocalIp', lan);
  }
  return browserLocalIp;
}

async function detectBrowserPublicIp() {
  const urls = [
    'https://api.ipify.org?format=json',
    'https://api64.ipify.org?format=json',
  ];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now(), {
        signal: ctrl.signal,
        cache: 'no-store',
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json();
      const ip = String(data.ip || '').trim();
      if (ip) {
        browserPublicIp = ip;
        sessionStorage.setItem('browserPublicIp', ip);
        return ip;
      }
    } catch (_) { /* try next */ }
  }
  return browserPublicIp || sessionStorage.getItem('browserPublicIp') || '';
}

async function detectBrowserIps() {
  await Promise.all([detectBrowserPublicIp(), detectBrowserLocalIp()]);
}

function pickDisplayIp(serverIp, browserIp) {
  // Show the visitor's own public IP when the browser detects it (ipify in their PC/phone)
  if (browserIp && browserIp !== '…') return browserIp;
  if (serverIp && serverIp !== '…' && !/^127\.|^::1|^192\.168\.|^10\./.test(serverIp)) return serverIp;
  return browserIp || serverIp || '…';
}

function showAccessGate(clientIp, options = {}) {
  const officeIpOnly = options.officeIpOnly === true;
  const gate = document.getElementById('accessGate');
  const shell = document.getElementById('appShell');
  const form = document.getElementById('accessGateForm');
  const officeOnly = document.getElementById('accessGateOfficeOnly');
  const subtitle = document.getElementById('accessGateSubtitle');
  const err = document.getElementById('accessGateError');
  if (shell) shell.classList.add('hidden');
  if (gate) gate.classList.remove('hidden');
  if (form) form.classList.toggle('hidden', officeIpOnly);
  if (officeOnly) officeOnly.classList.toggle('hidden', !officeIpOnly);
  if (subtitle) {
    subtitle.textContent = officeIpOnly
      ? 'Your connection is not from an allowed office IP address.'
      : 'You are outside the office network. Enter the passcode to continue.';
    subtitle.classList.toggle('hidden', officeIpOnly);
  }
  if (err) err.classList.add('hidden');
  const shown = pickDisplayIp(clientIp, browserPublicIp);
  if (shown && shown !== '…') document.getElementById('accessGateIp').textContent = shown;
}

function hideAccessGate() {
  const gate = document.getElementById('accessGate');
  const shell = document.getElementById('appShell');
  if (gate) gate.classList.add('hidden');
  if (shell) shell.classList.remove('hidden');
}

async function ensureDirectoryAccess() {
  try {
    if (getDirectoryAccessToken() && isDirectorySessionExpired()) {
      clearDirectorySession();
    }
    await detectBrowserIps();
    const res = await fetch('/api/access/check', { headers: directoryFetchHeaders(), cache: 'no-store' });
    let data = {};
    try { data = await res.json(); } catch (_) { data = {}; }
    if (res.status === 503 || data.offline) {
      // Offline via SW / network — allow cached directory
      if (await hasDirectoryCache()) {
        hideAccessGate();
        stopAccessWatch();
        return true;
      }
      showAccessGate(browserPublicIp || '…', { officeIpOnly: false });
      const err = document.getElementById('accessGateError');
      if (err) {
        err.textContent = 'You are offline. Connect once to unlock, or reopen after a previous successful visit.';
        err.classList.remove('hidden');
      }
      stopAccessWatch();
      return false;
    }
    const shownIp = pickDisplayIp(data.clientIp, browserPublicIp);
    document.getElementById('accessGateIp').textContent = shownIp;
    if (data.allowed) {
      hideAccessGate();
      if (data.reason === 'passcode' && getDirectoryAccessToken()) startAccessWatch();
      else stopAccessWatch();
      return true;
    }
    showAccessGate(shownIp, { officeIpOnly: data.officeIpOnly === true });
    stopAccessWatch();
    return false;
  } catch {
    // Network hard-fail: use local cache if available
    if (await hasDirectoryCache()) {
      hideAccessGate();
      stopAccessWatch();
      return true;
    }
    showAccessGate(browserPublicIp || '…', { officeIpOnly: false });
    const err = document.getElementById('accessGateError');
    if (err) {
      err.textContent = 'Cannot reach server. Connect to the internet to unlock the directory.';
      err.classList.remove('hidden');
    }
    stopAccessWatch();
    return false;
  }
}

async function submitAccessPasscode(e) {
  e.preventDefault();
  const input = document.getElementById('accessGateInput');
  const err = document.getElementById('accessGateError');
  const btn = document.getElementById('accessGateBtn');
  err.classList.add('hidden');
  btn.disabled = true;
  try {
    await detectBrowserIps();
    const res = await fetch('/api/access/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryFetchHeaders() },
      body: JSON.stringify({ passcode: input.value }),
    });
    const data = await res.json();
    if (!res.ok) {
      err.textContent = data.error || 'Incorrect passcode';
      err.classList.remove('hidden');
      btn.disabled = false;
      return;
    }
    if (data.token) {
      localStorage.setItem('directory_access_token', data.token);
      const sec = Number(data.expiresInSeconds) || 0;
      const expMs = sec > 0 ? (Date.now() + sec * 1000) : getTokenExpiryMs(data.token);
      if (expMs) localStorage.setItem('directory_access_expires_at', String(expMs));
      startAccessWatch();
    }
    hideAccessGate();
    await loadDirectoryData();
    startDirectoryAutoSync();
    btn.disabled = false;
  } catch {
    err.textContent = 'Network error';
    err.classList.remove('hidden');
    btn.disabled = false;
  }
}

function stationTypeLabel(t) {
  if (t === 'internet') return 'Internet';
  if (t === 'both') return 'Tel + Internet';
  return 'Tel';
}

function selectCountry(country) {
  selectedCountry = country || '';
  selectedStateId = null;
  selectedLocationId = null;
  document.getElementById('branchFilter').value = selectedCountry;

  const states = statesForCountry(selectedCountry).filter(s => (s.locations || []).length);
  if (!countryNeedsStatePicker(selectedCountry) && states.length === 1) {
    selectedStateId = states[0].id;
    const locs = locationsForState(states[0]);
    if (locs.length === 1) selectedLocationId = locs[0].id;
  }
  applyFilters();
}

function selectState(stateId) {
  selectedStateId = stateId;
  selectedLocationId = null;
  const state = activeState();
  const locs = locationsForState(state);
  if (locs.length === 1) selectedLocationId = locs[0].id;
  applyFilters();
}

function selectLocation(locationId) {
  selectedLocationId = locationId;
  applyFilters();
}

function renderStationStrip() {
  const wrap = document.getElementById('stationStripWrap');
  const strip = document.getElementById('stationStrip');
  if (!wrap || !strip) return;
  strip.innerHTML = '';
  const withSites = DIRECTORY_TREE.filter(c => (c.states || []).some(s => (s.locations || []).length));
  if (!withSites.length) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  withSites.forEach(c => {
    const color = getBranchColor(c.name);
    const isActive = selectedCountry === c.name;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold border transition-all cursor-pointer' +
      (isActive ? ' ring-2 ring-brand-600/30 border-brand-600' : ' border-transparent hover:ring-1 hover:ring-black/10');
    if (isActive) {
      chip.style.backgroundColor = '#296F35';
      chip.style.color = '#ffffff';
    } else {
      chip.style.backgroundColor = color.bg;
      chip.style.color = color.text;
    }
    const locCount = allLocationsForCountry(c.name);
    const multiState = countryNeedsStatePicker(c.name);
    const hint = !multiState && locCount > 1 ? `${locCount} sites` : '';
    chip.innerHTML = `<span class="font-semibold">${c.name}</span>${hint ? `<span class="opacity-80">${hint}</span>` : ''}`;
    chip.onclick = () => selectCountry(c.name);
    strip.appendChild(chip);
  });
}

function cardButtonHtml(opts) {
  const { id, title, subtitle, phone, active, onClick } = opts;
  return `<button type="button" onclick="${onClick}"
    class="text-left rounded-2xl border p-4 transition-all cursor-pointer ${
      active
        ? 'bg-brand-600 text-white border-brand-600 shadow-md ring-2 ring-brand-600/30'
        : 'bg-white text-slate-800 border-brand-200 hover:border-brand-400 hover:shadow-sm'
    }">
    <p class="font-bold text-sm">${title}</p>
    ${subtitle ? `<p class="text-xs mt-1 ${active ? 'text-white/80' : 'text-slate-400'}">${subtitle}</p>` : ''}
    ${phone ? `<p class="font-mono text-xs mt-2 ${active ? 'text-white/90' : 'text-brand-700'}">${cleanNum(phone)}</p>` : ''}
  </button>`;
}

function updateSelectedStation() {
  const box = document.getElementById('selectedStationBox');
  const content = document.getElementById('selectedStationContent');
  if (!box || !content) return;

  if (!selectedCountry) {
    box.classList.add('hidden');
    content.innerHTML = '';
    return;
  }

  const needStates = countryNeedsStatePicker(selectedCountry);
  const states = statesForCountry(selectedCountry).filter(s => (s.locations || []).length);
  if (!states.length) {
    box.classList.add('hidden');
    content.innerHTML = '';
    return;
  }

  box.classList.remove('hidden');
  let html = '';

  if (needStates) {
    html += `
      <p class="text-xs text-slate-500 mb-3">Choose a state in <span class="font-semibold text-slate-700">${selectedCountry}</span>:</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        ${states.map(s => cardButtonHtml({
          id: s.id,
          title: s.name,
          subtitle: `${(s.locations || []).length} site${(s.locations || []).length === 1 ? '' : 's'}`,
          phone: '',
          active: selectedStateId === s.id,
          onClick: `selectState(${s.id})`,
        })).join('')}
      </div>`;
    if (!selectedStateId) {
      html += `<p class="text-sm text-slate-500">Select a state to see companies.</p>`;
      content.innerHTML = html;
      return;
    }
  }

  const state = activeState();
  const locs = locationsForState(state);
  const multiLoc = locs.length > 1;
  const active = activeLocation();

  if (multiLoc) {
    html += `
      <p class="text-xs text-slate-500 mb-3">Choose a company${state && state.name !== 'Main' ? ` in <span class="font-semibold text-slate-700">${state.name}</span>` : ''}:</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        ${locs.map(l => {
          const phone = (l.phones && l.phones[0]) ? l.phones[0].phone : '';
          return cardButtonHtml({
            id: l.id,
            title: l.name,
            subtitle: l.city || '',
            phone,
            active: selectedLocationId === l.id,
            onClick: `selectLocation(${l.id})`,
          });
        }).join('')}
      </div>`;
  }

  if (!active) {
    html += `<p class="text-sm text-slate-500">Select a company above to see address, phones, and staff.</p>`;
    content.innerHTML = html;
    return;
  }

  const phones = active.phones || [];
  const titleParts = placeLabelParts(selectedCountry, state && state.name, active.name);
  html += `
    <div class="w-full space-y-3 rounded-2xl border border-brand-200 bg-white/80 p-4">
      <div class="flex flex-wrap items-center gap-3">
        <span class="font-bold text-brand-800 text-sm">${titleParts.join(' — ')}</span>
        ${phones.map(s => `
          <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-brand-50 border border-brand-200 text-sm">
            <span class="text-[10px] font-bold uppercase tracking-wider text-brand-600">${stationTypeLabel(s.number_type)}</span>
            ${s.label ? `<span class="text-slate-400 text-xs">${s.label}</span>` : ''}
            <a href="tel:${String(s.phone).replace(/[\s.]/g,'')}" class="font-mono font-bold text-brand-700 hover:underline">${cleanNum(s.phone)}</a>
          </span>`).join('')}
      </div>
      ${(active.address || active.maps_url) ? `
      <div class="flex flex-wrap items-start gap-3 text-sm">
        ${active.address ? `<p class="text-slate-600 flex-1 min-w-[200px]"><span class="text-[10px] font-bold uppercase tracking-wider text-brand-600 block mb-0.5">Address</span>${active.address}</p>` : ''}
        ${active.maps_url ? `<a href="${active.maps_url}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-brand-200 text-brand-700 font-semibold hover:bg-brand-50 shrink-0">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
          Open in Google Maps
        </a>` : ''}
      </div>` : ''}
    </div>`;
  content.innerHTML = html;
}

function populateFilters() {
  const countries = [...new Set([
    ...DIRECTORY_TREE.map(b => b.name),
    ...EMPLOYEES.map(e => e.branch),
  ])].filter(Boolean).sort();
  const depts = [...new Set(EMPLOYEES.map(e => e.dept))].filter(Boolean).sort();
  const worksFor = [...new Set(EMPLOYEES.map(e => e.works_for_station).filter(Boolean))].sort();

  const bf = document.getElementById('branchFilter');
  bf.innerHTML = '<option value="">All Countries</option>';
  countries.forEach(b => { const o = document.createElement('option'); o.value = b; o.textContent = b; bf.appendChild(o); });

  const df = document.getElementById('deptFilter');
  df.innerHTML = '<option value="">All Departments</option>';
  depts.forEach(d => { const o = document.createElement('option'); o.value = d; o.textContent = d; df.appendChild(o); });

  const wf = document.getElementById('worksForFilter');
  if (wf) {
    const cur = wf.value;
    wf.innerHTML = '<option value="">Works for: Any</option>';
    worksFor.forEach(w => { const o = document.createElement('option'); o.value = w; o.textContent = w; wf.appendChild(o); });
    if (cur && [...wf.options].some(o => o.value === cur)) wf.value = cur;
  }
}

function applyFilters() {
  const q = document.getElementById('searchInput').value.toLowerCase().trim();
  const country = document.getElementById('branchFilter').value || selectedCountry;
  selectedCountry = country;
  const dept = document.getElementById('deptFilter').value;
  const worksFor = document.getElementById('worksForFilter')?.value || '';
  const state = activeState();
  const active = activeLocation();
  const needStates = countryNeedsStatePicker(country);
  const locsInState = state ? locationsForState(state) : [];
  const multiLoc = locsInState.length > 1;

  filtered = EMPLOYEES.filter(e => {
    const matchCountry = !country || e.branch === country;
    const matchDept = !dept || e.dept === dept;
    const matchWorksFor = !worksFor || e.works_for_station === worksFor;
    if (!matchCountry || !matchDept || !matchWorksFor) return false;
    if (selectedStateId) {
      if (e.state_id != null && Number(e.state_id) !== Number(selectedStateId)) return false;
      if (e.state_id == null && state && e.state_name && e.state_name !== state.name) return false;
    }
    if (selectedLocationId && e.location_id != null && Number(e.location_id) !== Number(selectedLocationId)) return false;
    if (!q) return true;
    const baseMatch = [e.name, e.email, e.dept, e.branch, e.state_name, e.station_name, e.location_name, e.works_for_station].some(f => f && String(f).toLowerCase().includes(q));
    if (baseMatch) return true;
    return getNumbers(e).some(n =>
      [n.ext, n.mobile, n.sd, n.sdNo, n.label].some(f => f && String(f).toLowerCase().includes(q))
    );
  });

  renderGrid(filtered);
  renderStationStrip();
  updateSelectedStation();

  const count = document.getElementById('resultCount');
  count.textContent = filtered.length < EMPLOYEES.length
    ? `Showing ${filtered.length} of ${EMPLOYEES.length} employees`
    : `Showing all ${EMPLOYEES.length} employees`;
}

function clearFilters() {
  document.getElementById('searchInput').value = '';
  document.getElementById('branchFilter').value = '';
  document.getElementById('deptFilter').value = '';
  const wf = document.getElementById('worksForFilter');
  if (wf) wf.value = '';
  selectedCountry = '';
  selectedStateId = null;
  selectedLocationId = null;
  applyFilters();
}

function renderGrid(data) {
  const grid  = document.getElementById('employeeGrid');
  const empty = document.getElementById('emptyState');
  grid.innerHTML = '';

  if (!data.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  data.forEach(emp => {
    const c       = getBranchColor(emp.branch);
    const numbers = getNumbers(emp);
    const isMulti = numbers.length > 1;
    const initials = emp.name.split(/[\s,]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('');
    const locLabel = emp.location_name && emp.location_name !== 'Main' ? emp.location_name : (emp.station_name && emp.station_name !== 'Main' ? emp.station_name : '');
    const badgeParts = placeLabelParts(emp.branch, emp.state_name, locLabel);

    const card = document.createElement('div');
    card.className = 'bg-white rounded-2xl border border-slate-200/80 p-5 card-hover shadow-sm' + (isMulti ? ' border-l-[3px] border-l-brand-500' : '');
    card.onclick = () => openModal(emp);

    const previewNums = numbers.slice(0, 2).map(n => `
      <div class="flex items-start gap-2 text-xs">
        <div class="flex-1 space-y-1">
          ${n.label ? `<p class="text-slate-400 font-semibold uppercase tracking-wider" style="font-size:10px">${n.label}</p>` : ''}
          ${n.ext    ? `<p class="font-mono font-semibold text-slate-800 text-sm">${cleanNum(n.ext)}</p>` : ''}
          ${n.mobile ? `<p class="text-slate-500 text-xs">${cleanNum(n.mobile)}</p>` : ''}
          ${n.sd     ? `<div class="flex gap-2 items-baseline"><p class="text-slate-400">DL <span class="font-mono text-slate-700">${cleanNum(n.sd)}</span></p>${n.sdNo ? `<p class="text-slate-400">SD <span class="font-mono text-slate-700">${cleanNum(n.sdNo)}</span></p>` : ''}</div>` : ''}
          ${!n.sd && n.sdNo ? `<p class="text-slate-400">SD <span class="font-mono text-slate-700">${cleanNum(n.sdNo)}</span></p>` : ''}
        </div>
      </div>`).join('');

    const moreTag = numbers.length > 2
      ? `<p class="text-xs text-brand-600 font-semibold mt-2">+${numbers.length - 2} more extension${numbers.length-2>1?'s':''} →</p>` : '';

    card.innerHTML = `
      <div class="flex items-start gap-3.5 mb-3">
        <div class="w-10 h-10 rounded-xl ${c.bg} ${c.text} flex items-center justify-center text-sm font-bold flex-shrink-0 relative shadow-sm">
          ${initials}
          ${isMulti ? `<span class="absolute -top-1.5 -right-1.5 w-5 h-5 bg-brand-500 text-white rounded-full flex items-center justify-center text-[10px] font-bold leading-none ring-2 ring-white">${numbers.length}</span>` : ''}
        </div>
        <div class="min-w-0 flex-1">
          <p class="font-semibold text-slate-800 text-sm leading-tight truncate">${emp.name}</p>
          <p class="text-xs text-slate-500 mt-0.5 truncate">${emp.dept}${emp.works_for_station ? ` · <span class="text-amber-700 font-medium">→ ${emp.works_for_station}</span>` : ''}</p>
        </div>
      </div>
      <div class="space-y-1">${previewNums}${moreTag}</div>
      <div class="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between gap-2 flex-wrap">
        <span class="badge" style="background-color:${c.bg};color:${c.text}">${badgeParts.join(' · ')}</span>
        ${emp.works_for_station ? `<span class="badge bg-amber-50 text-amber-800 border border-amber-200">Works for ${emp.works_for_station}</span>` : ''}
      </div>`;
    grid.appendChild(card);
  });
}

function openModal(emp) {
  const c       = getBranchColor(emp.branch);
  const numbers = getNumbers(emp);
  const isMulti = numbers.length > 1;
  const initials = emp.name.split(/[\s,]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('');
  const locLabel = emp.location_name && emp.location_name !== 'Main' ? emp.location_name : (emp.station_name && emp.station_name !== 'Main' ? emp.station_name : '');
  const badgeParts = placeLabelParts(emp.branch, emp.state_name, locLabel);

  const numsHtml = numbers.map((n, i) => `
    <div class="${isMulti ? 'bg-slate-50 rounded-xl p-4 border border-slate-200/60' : ''}">
      ${isMulti ? `<p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2.5">${n.label || 'Line ' + (i+1)}</p>` : ''}
      <div class="space-y-2.5">
        ${n.ext ? `<div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0"><svg class="w-4 h-4 text-brand-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.948V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg></div>
          <div><p class="text-xs text-slate-400 font-medium">Extension</p><p class="font-mono font-semibold text-slate-800">${cleanNum(n.ext)}</p></div>
        </div>` : ''}
        ${n.mobile ? `<div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0"><svg class="w-4 h-4 text-brand-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg></div>
          <div><p class="text-xs text-slate-400 font-medium">Mobile</p><a href="tel:${n.mobile.replace(/[\s.]/g,'')}" class="font-semibold text-brand-600 hover:underline">${cleanNum(n.mobile)}</a></div>
        </div>` : ''}
        ${n.sd ? `<div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0"><svg class="w-4 h-4 text-brand-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"/></svg></div>
          <div><p class="text-xs text-slate-400 font-medium">Direct Line</p><p class="font-mono font-semibold text-slate-800">${cleanNum(n.sd)}</p></div>
        </div>` : ''}
        ${n.sdNo ? `<div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0"><svg class="w-4 h-4 text-brand-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 9h.01M9 9h.01M9 15h6"/></svg></div>
          <div><p class="text-xs text-slate-400 font-medium">Speed Dial</p><p class="font-mono font-semibold text-slate-800">${cleanNum(n.sdNo)}</p></div>
        </div>` : ''}
        ${!n.ext && !n.mobile && !n.sd && !n.sdNo ? `<p class="text-sm text-slate-400">No contact details</p>` : ''}
      </div>
    </div>`).join('');

  document.getElementById('modalContent').innerHTML = `
    <div class="p-6 max-h-[85vh] overflow-y-auto">
      <div class="flex items-start gap-4 mb-6">
        <div class="w-14 h-14 rounded-2xl flex items-center justify-center text-xl font-bold flex-shrink-0 shadow-sm" style="background-color:${c.bg};color:${c.text}">${initials}</div>
        <div class="min-w-0 flex-1">
          <h2 class="text-lg font-bold text-slate-800 leading-tight">${emp.name}</h2>
          <p class="text-slate-500 text-sm mt-0.5">${emp.dept}</p>
          <div class="flex flex-wrap gap-2 mt-2">
            <span class="badge" style="background-color:${c.bg};color:${c.text}">${badgeParts.join(' · ')}</span>
            ${emp.works_for_station ? `<span class="badge bg-amber-50 text-amber-800 border border-amber-200">Works for ${emp.works_for_station}</span>` : ''}
            ${isMulti ? `<span class="badge bg-brand-50 text-brand-700 border border-brand-200">${numbers.length} extensions</span>` : ''}
          </div>
        </div>
        <button onclick="closeModal()" class="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center flex-shrink-0 cursor-pointer transition-colors">
          <svg class="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="${isMulti ? 'space-y-3' : 'space-y-2'}">
        ${emp.email ? `
        <div class="${isMulti ? 'bg-slate-50 rounded-xl p-4 border border-slate-200/60' : ''}">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0">
              <svg class="w-4 h-4 text-brand-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
            </div>
            <div class="min-w-0">
              <p class="text-xs text-slate-400 font-medium">Email</p>
              <a href="mailto:${emp.email}" class="font-semibold text-brand-600 hover:underline break-all">${emp.email}</a>
            </div>
          </div>
        </div>` : ''}
        ${numsHtml}
      </div>
    </div>`;
  document.getElementById('modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

// ── PWA install ──
let deferredPwaPrompt = null;

function isIosSafari() {
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua);
  const isChrome = /CriOS|Chrome/.test(ua);
  return iOS && webkit && !isChrome;
}

function isStandalonePwa() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true ||
    document.referrer.includes('android-app://');
}

function updateInstallButtons() {
  const installBtn = document.getElementById('installAppBtn');
  const helpBtn = document.getElementById('installHelpBtn');
  if (!installBtn || !helpBtn) return;
  if (isStandalonePwa()) {
    installBtn.classList.add('hidden');
    installBtn.classList.remove('inline-flex');
    helpBtn.classList.add('hidden');
    return;
  }
  if (deferredPwaPrompt) {
    installBtn.classList.remove('hidden');
    installBtn.classList.add('inline-flex');
    helpBtn.classList.add('hidden');
  } else {
    installBtn.classList.add('hidden');
    installBtn.classList.remove('inline-flex');
    helpBtn.classList.remove('hidden');
  }
}

async function installPwaApp() {
  if (!deferredPwaPrompt) {
    showInstallHelp();
    return;
  }
  deferredPwaPrompt.prompt();
  const choice = await deferredPwaPrompt.userChoice.catch(() => null);
  deferredPwaPrompt = null;
  updateInstallButtons();
  if (choice && choice.outcome === 'accepted') closeInstallHelp();
}

function showInstallHelp() {
  const modal = document.getElementById('installHelpModal');
  const body = document.getElementById('installHelpBody');
  const action = document.getElementById('installHelpAction');
  if (!modal || !body) return;

  const secure = window.isSecureContext;
  const host = location.hostname;
  const isLocalHost = host === 'localhost' || host === '127.0.0.1';
  const isLanHttp = location.protocol === 'http:' && !isLocalHost;

  let html = '';
  if (isStandalonePwa()) {
    html = `<p>Already installed. Open it from your home screen / app list.</p>`;
    if (action) action.classList.add('hidden');
  } else if (deferredPwaPrompt) {
    html = `<p>Tap <strong>Install now</strong> to add Compass Directory to your device.</p>`;
    if (action) action.classList.remove('hidden');
  } else if (isIosSafari()) {
    html = `
      <p><strong>iPhone / iPad (Safari)</strong></p>
      <ol class="list-decimal pl-5 space-y-1.5">
        <li>Tap the <strong>Share</strong> button</li>
        <li>Scroll and tap <strong>Add to Home Screen</strong></li>
        <li>Tap <strong>Add</strong></li>
      </ol>
      <p class="text-xs text-slate-400">Safari does not show an automatic Install popup.</p>`;
    if (action) action.classList.add('hidden');
  } else if (isLanHttp || (!secure && !isLocalHost)) {
    html = `
      <p><strong>Install is blocked on this address.</strong></p>
      <p>Android Chrome only allows installing apps from <strong>HTTPS</strong> sites (or laptop <code>localhost</code>).</p>
      <p>You opened: <code class="text-xs bg-slate-100 px-1.5 py-0.5 rounded">${location.origin}</code></p>
      <p class="font-medium text-slate-800">What to do:</p>
      <ol class="list-decimal pl-5 space-y-1.5">
        <li>Upload the PWA files to <strong>https://directory.compasslog.com</strong></li>
        <li>Open that HTTPS link on your phone (Chrome)</li>
        <li>Then tap <strong>Install</strong> / menu → <strong>Install app</strong></li>
      </ol>`;
    if (action) action.classList.add('hidden');
  } else {
    html = `
      <p><strong>Android Chrome</strong></p>
      <ol class="list-decimal pl-5 space-y-1.5">
        <li>Open Chrome menu (⋮)</li>
        <li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong></li>
      </ol>
      <p class="text-xs text-slate-400 mt-2">On laptop Chrome/Edge, look for the install icon in the address bar.</p>
      <p class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">For your phone, use the live HTTPS site. Opening the PC’s local IP over HTTP will not show Install.</p>`;
    if (action) action.classList.add('hidden');
  }

  body.innerHTML = html;
  modal.classList.remove('hidden');
}

function closeInstallHelp() {
  const modal = document.getElementById('installHelpModal');
  if (modal) modal.classList.add('hidden');
}

function setupPwaInstallUi() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPwaPrompt = e;
    updateInstallButtons();
  });
  window.addEventListener('appinstalled', () => {
    deferredPwaPrompt = null;
    updateInstallButtons();
    closeInstallHelp();
  });
  updateInstallButtons();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal();
    closeInstallHelp();
  }
});
document.addEventListener('DOMContentLoaded', () => {
  setupPwaInstallUi();
  init();
});

