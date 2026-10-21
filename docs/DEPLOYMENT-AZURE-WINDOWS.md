# Compass Directory — Azure Windows deployment & operations

Complete handover guide for managing **Compass Directory** on the **Azure Windows VM** (IIS + Node.js + MySQL).

---

## At a glance

| Item | Value |
|------|-------|
| **Public website** | https://directory.compasslog.com |
| **GitHub repository** | https://github.com/sleevetechs/Avaya-directory |
| **Azure VM public IP (RDP)** | `4.247.132.189` |
| **RDP port** | `3389` |
| **App folder on server** | `C:\apps\Avaya-directory` |
| **Node.js (internal)** | `http://localhost:3000` |
| **IIS (public)** | Ports `80` / `443` → reverse proxy to Node |
| **MySQL database** | `avaya_list` on `localhost:3306` |
| **Office public IP (whitelist)** | `106.51.67.206` |
| **Logs** | `C:\apps\Avaya-directory\debug.log` |

> **Note:** If Azure assigns a new public IP after VM rebuild, update this document and your DNS/firewall rules. Check current IP in **Azure Portal → Virtual machine → Overview → Public IP address**.

---

## Architecture

```
Internet
   │
   ▼
Azure NSG (ports 80, 443, 3389)
   │
   ▼
Windows Server VM
   ├── IIS (HTTPS, URL Rewrite, ARR proxy)
   │      └── web.config → http://localhost:3000
   ├── Node.js Windows Service (Express server.js)
   │      └── reads .env, connects to MySQL
   └── MySQL 8 (localhost only, port 3306)
```

**Request flow:** Browser → IIS → Node (`server.js`) → MySQL → JSON/HTML response.

The app also ships a **PWA** (service worker + IndexedDB) for offline directory cache on phones.

---

## Connecting to the server (RDP)

### From Windows

1. Open **Remote Desktop Connection** (`mstsc`)
2. **Computer:** `4.247.132.189`
3. **User name:** Your Azure VM admin account (from Azure Portal or IT vault)
4. Connect → enter password

### From Mac

Use **Microsoft Remote Desktop** with the same IP and credentials.

### Azure Portal alternative

**Azure Portal → Virtual machines → [your VM] → Connect → RDP** downloads a `.rdp` file with the correct settings.

### Firewall (NSG) rules required

| Port | Purpose |
|------|---------|
| **3389** | RDP (admin access) |
| **80** | HTTP (redirect / Let's Encrypt) |
| **443** | HTTPS (public website) |
| **3306** | MySQL — **do not** expose to internet; localhost only |

---

## Software installed on the VM

| Component | Purpose |
|-----------|---------|
| **Windows Server** 2019/2022 | Host OS |
| **Node.js LTS** (v20 or v22) | Runs `server.js` |
| **MySQL 8** | Database `avaya_list` |
| **IIS** | Public web server + reverse proxy |
| **URL Rewrite** (IIS extension) | Proxy rules |
| **Application Request Routing (ARR)** | Reverse proxy to Node — **Enable proxy** must be on |
| **Git** | Pull updates from GitHub |
| **win-acme** (or similar) | Let's Encrypt SSL for `directory.compasslog.com` |
| **NSSM** (or PM2) | Keeps Node running as a Windows service |

---

## Environment variables

On the server, create/maintain:

**`C:\apps\Avaya-directory\.env`**

This file is **not in Git** (see `.gitignore`). Copy from your IT password vault or from the previous admin.

```env
PORT=3000
NODE_ENV=production

DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=<see IT password vault — not in GitHub>
DB_NAME=avaya_list

JWT_SECRET=<long random string — see IT password vault>
```

Optional:

| Variable | Purpose |
|----------|---------|
| `DIRECTORY_ALLOW_PASSCODE_OUTSIDE=1` | Allow passcode access even when office IPs are configured |
| `DB_SSL=1` | TLS to remote MySQL (not needed for local MySQL) |

**Never commit `.env` or real passwords to GitHub.**

---

## IIS configuration

### Site

- **Binding:** `directory.compasslog.com` on HTTPS (443)
- **Physical path:** `C:\apps\Avaya-directory` (contains `web.config`)

### web.config (in repo)

IIS proxies all requests to Node and forwards the visitor IP:

```xml
<action type="Rewrite" url="http://localhost:3000/{R:1}" />
```

Server variables set: `HTTP_X_FORWARDED_FOR`, `HTTP_X_REAL_IP`.

### One-time IIS setup (if rebuilding server)

1. Install **URL Rewrite** and **ARR**
2. IIS Manager → server name → **Application Request Routing Cache** → **Server Proxy Settings** → ✅ **Enable proxy** → Apply
3. IIS Manager → your site → **URL Rewrite** → **View Server Variables** → Allow:
   - `HTTP_X_FORWARDED_FOR`
   - `HTTP_X_REAL_IP`
4. Run `iisreset`

---

## Node.js Windows Service

Node must stay running on port **3000**. Typical setup with **NSSM**:

```cmd
nssm install CompassDirectory "C:\Program Files\nodejs\node.exe" "C:\apps\Avaya-directory\server.js"
nssm set CompassDirectory AppDirectory "C:\apps\Avaya-directory"
nssm set CompassDirectory AppEnvironmentExtra NODE_ENV=production
nssm start CompassDirectory
```

**Service name may differ** on your server — check **services.msc** for the Compass/Avaya/Node entry.

### Restart Node after code updates

```cmd
nssm restart CompassDirectory
```

Or via **Services** (`services.msc`) → find the service → **Restart**.

---

## Deploying code updates (routine)

This is the most common task when GitHub has new changes.

### Step 1 — RDP into the server

Connect to `4.247.132.189:3389`.

### Step 2 — Pull latest code

```powershell
cd C:\apps\Avaya-directory
git status
git pull origin main
```

If `git pull` fails with local changes, stash or discard (only if you know nothing important is uncommitted):

```powershell
git stash
git pull origin main
```

### Step 3 — Install dependencies (if `package.json` changed)

```powershell
npm ci --omit=dev
```

Skip this step if only HTML/JS/CSS changed and `package-lock.json` is unchanged.

### Step 4 — Restart Node

```cmd
nssm restart CompassDirectory
```

(Or restart your Node Windows service.)

### Step 5 — Restart IIS (only if `web.config` changed)

```cmd
iisreset
```

### Step 6 — Verify

1. Open https://directory.compasslog.com/api/health  
   Expected: `{"ok":true,"db":true,...}`
2. Open https://directory.compasslog.com — directory loads
3. Check `C:\apps\Avaya-directory\debug.log` for errors

### Step 7 — Tell users

Ask staff to **hard refresh** (Ctrl+F5) or reopen the PWA after major front-end changes.

---

## Database updates

### Automatic (preferred)

On every Node start, **`bootSchema()`** in `server.js` creates missing tables/columns (departments, access control, `works_for_station`, manager role, name-edit flags, etc.). Usually **no manual SQL** is needed after `git pull` + restart.

### Manual migration (if needed)

**Option A — npm script (on server):**

```powershell
cd C:\apps\Avaya-directory
npm run migrate-db
```

Uses `.env` on the server for DB credentials.

**Option B — SQL file:**

```cmd
cd C:\apps\Avaya-directory
mysql -u root -p avaya_list < scripts\update-server-db.sql
```

**Option C — MySQL Workbench / CLI:**

```sql
USE avaya_list;
-- paste contents of scripts/update-server-db.sql
```

Duplicate column errors are safe to ignore — they mean the column already exists.

### Backup before major changes

```cmd
mysqldump -u root -p avaya_list > C:\backups\avaya_list_%date%.sql
```

Schedule regular backups via Windows Task Scheduler.

---

## Directory access control (office IP)

Production uses **office-network-only** mode:

- **Allowed office IP:** `106.51.67.206` (Bangalore / office ISP public IP)
- Configured in **Admin → Access control → Allowed office IPs**
- When at least one office IP exists, the public directory is **office-only** (no passcode for outsiders unless `DIRECTORY_ALLOW_PASSCODE_OUTSIDE=1`)

### How IP detection works

1. Browser tries to detect ISP public IP (via ipify, or same-origin fallback `/api/access/my-ip`)
2. Server matches that IP against the whitelist
3. Port numbers are stripped (`106.51.67.206:443` → `106.51.67.206`)

### Common access issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Office user blocked, Firefox | **Strict** privacy blocks IP lookup | Fixed in app via same-origin fallback; user can hard refresh. Or Firefox → Standard privacy |
| Office user blocked, Chrome | Ad-blocker blocks ipify | Disable for directory site or hard refresh |
| IP shows with `:port` | Old build | Deploy latest code |
| Works on one PC, not another | Admin logged in / cached PWA on one machine | Not a server bug — check browser cache & login state |
| IP not on list | Office ISP changed | Admin → Access control → Refresh IP → Add |

### Adding a new office IP

1. Log in as admin → **Access control**
2. Click **Refresh IP** (from office network)
3. **Add this IP** → Save
4. Or add manually if you know the public IP

---

## SSL / HTTPS

- Certificate: **Let's Encrypt** via win-acme (typical)
- Renewal: win-acme scheduled task — verify it runs (check every few months)
- PWA install **requires HTTPS** on mobile

---

## Monitoring & logs

| What | Where |
|------|-------|
| App debug log | `C:\apps\Avaya-directory\debug.log` |
| IIS logs | `C:\inetpub\logs\LogFiles\` |
| MySQL | Windows Service → MySQL80 (or similar) |
| Node service | `services.msc` |

### Health check

```
GET https://directory.compasslog.com/api/health
```

Returns JSON with `"ok": true` and `"db": true` when healthy.

### Useful log grep (PowerShell)

```powershell
Get-Content C:\apps\Avaya-directory\debug.log -Tail 100
Select-String -Path C:\apps\Avaya-directory\debug.log -Pattern "ERROR|failed|500"
```

---

## User roles (admin panel)

| Role | Login URL | Access |
|------|-----------|--------|
| **super_admin** | `/superadmin` | Everything + manage admins + audit logs |
| **admin** | `/admin` | Full employee/location/access management |
| **manager** | `/admin` | Employees, Recent data, Access control only |
| **viewer** | `/admin` | Read-only |

Default bootstrap account (change password immediately if still default):

- Email: `super-admin@compasslog.com`
- Password: set during `npm run init-db` (default was `1234` on fresh installs — **verify on production**)

---

## Initial server setup (full reinstall)

Use this only when building a **new** VM from scratch.

1. Create Azure Windows VM (B2s or larger, 2+ GB RAM)
2. Open NSG: 3389, 80, 443
3. RDP in → install Node.js LTS, MySQL, Git, IIS + URL Rewrite + ARR
4. Clone repo:
   ```powershell
   mkdir C:\apps
   cd C:\apps
   git clone https://github.com/sleevetechs/Avaya-directory.git Avaya-directory
   cd Avaya-directory
   npm ci --omit=dev
   ```
5. Create `.env` (see [Environment variables](#environment-variables))
6. Initialize DB (fresh only): `npm run init-db`
7. Configure IIS site + SSL + `web.config`
8. Install Node as Windows service (NSSM)
9. Point DNS `directory.compasslog.com` → VM public IP
10. Test `/api/health` and admin login
11. Configure office IP in Access control

---

## Troubleshooting

| Problem | What to check |
|---------|----------------|
| Site down / 502 | Node service running? `http://localhost:3000/api/health` on server |
| 500 on API | `debug.log`, MySQL service, `.env` credentials |
| DB connection error | MySQL running, `DB_*` in `.env`, user privileges |
| Directory blocked at office | Access control IPs, browser privacy/ad-block, deploy latest code |
| Changes not visible | Restart Node, `iisreset` if needed, user hard refresh |
| PWA not updating | Service worker — hard refresh or clear site data |
| Wrong IP in admin | IIS server variables allowed? `web.config` deployed? |

### Restart everything (last resort)

```cmd
net stop MySQL80
net start MySQL80
nssm restart CompassDirectory
iisreset
```

---

## Security checklist

- [ ] Strong `JWT_SECRET` in `.env`
- [ ] Super admin password changed from default
- [ ] MySQL **not** exposed to internet (3306 blocked in NSG)
- [ ] RDP restricted to trusted IPs if possible (Azure NSG rule)
- [ ] Windows Update enabled
- [ ] `.env` backed up securely (not in Git)
- [ ] Regular MySQL backups
- [ ] HTTPS valid and auto-renewing

---

## Contacts & ownership

| Role | Notes |
|------|-------|
| **Repository** | SleeveTechs — https://github.com/sleevetechs/Avaya-directory |
| **Business owner** | Compass Logistics IT |
| **Domain** | directory.compasslog.com |

When handing over to a new person, give them:

1. This document
2. [ADMIN-GUIDE.md](./ADMIN-GUIDE.md)
3. RDP credentials (Azure / IT vault)
4. Server `.env` backup or password vault entries
5. GitHub access (if they will push code)

---

## Related files in the repo

| Path | Purpose |
|------|---------|
| `server.js` | Main app + API + bootSchema |
| `web.config` | IIS reverse proxy |
| `scripts/update-server-db.sql` | Manual DB migration |
| `scripts/migrate-schema.js` | `npm run migrate-db` |
| `scripts/run-local-migration.js` | Local dev migration helper |
| `README.md` | Developer documentation |
