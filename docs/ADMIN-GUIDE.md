# Compass Directory — Admin guide

Day-to-day guide for staff managing employee data and access on **https://directory.compasslog.com**.

---

## Logging in

| Role | URL |
|------|-----|
| Admin / Manager / Viewer | https://directory.compasslog.com/login → **Dashboard** |
| Super Admin | https://directory.compasslog.com/login → **Super Admin** panel |

Use the email and password created for your account. Contact super admin if locked out.

---

## Roles — what you can do

| Role | Employees | Recent changes | Departments | Countries/Locations | Stations | Access control | Manage admins |
|------|-------------|----------------|-------------|---------------------|----------|----------------|---------------|
| **Super Admin** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Admin** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Manager** | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| **Viewer** | View only | View only | View only | View only | View only | View only | ❌ |

---

## Public directory

**URL:** https://directory.compasslog.com

- Staff on the **office network** (IP `106.51.67.206`) can open directly
- **PWA:** users can install to phone home screen (Install button in header)
- **Offline:** last loaded directory is cached when leaving office Wi‑Fi

If someone at the office sees “office network only”:

1. Hard refresh (Ctrl+F5)
2. Firefox: set privacy to **Standard** (Strict blocks IP detection)
3. Disable ad-blocker for the directory site
4. Confirm office IP is still `106.51.67.206` in Access control

---

## Employees tab

### Add employee

1. **Employees** → **Add employee**
2. Fill name, email, department, country, state, location
3. Add extension(s), mobile, direct line, speed dial
4. **Works for station** — only for backoffice staff supporting another site (e.g. Dubai, Dammam). Leave blank otherwise.
5. Save

### Edit employee

- Click employee row → edit
- **Names are locked** after creation — only Super Admin and up to **2 designated name editors** can change names (configured in Super Admin panel)

### Delete employee

- Delete requires **another admin to confirm** (delete-request workflow)
- Pending deletes show in red until confirmed or cancelled

### Extensions (multiple lines)

- Open employee → **Extensions**
- Add/edit/remove extension rows
- **Avaya removal** requests can be confirmed or **reverted** (restores old extension number)

### Import / Export

- **Template** — download Excel template, fill rows, import
- **Export** — current filtered list to Excel or PDF
- Required column: **Name**
- Include **works_for_station** for backoffice staff

---

## Recent data tab

Shows recently changed employees — useful for managers auditing updates.

---

## Departments

Add or rename departments used in employee records and import template.

---

## Countries, states, locations, stations

Organizational hierarchy for the public directory:

```
Country (e.g. UAE)
  └── State (if multiple)
        └── Location / site
              └── Station phone numbers (cards on public site)
```

- **Countries** tab — manage branches
- **Stations** tab — public station contact cards (not employee extensions)

---

## Access control

**Admin → Access control**

### Office IPs

- Production office IP: **`106.51.67.206`**
- Whitelist uses the **browser-detected ISP public IP**
- Click **Refresh IP** when adding from office network
- **Add this IP** to whitelist
- Supports **DynDNS hostnames** for offices with changing IPs (re-resolved every 5 minutes)

### IP updater role (e.g. Jeddah daily IP)

For offices where the **public IP changes every day** and a local person updates it:

1. **Super Admin** creates static **IP** entries (not DynDNS) in Access control — e.g. labels **Jeddah**, **COL Jeddah**, with any placeholder IP.
2. **Super Admin → Admins** → role **IP updater** → check which entries that user may edit.
3. The user logs in and sees **only** those rows → **Edit** → paste today’s IP (or use **Refresh IP** then save).

They **cannot** add entries, delete, or change passcodes.

When office IPs exist, directory is **office-network only** (outsiders cannot use passcode unless configured on server).

### Passcodes

- Time-limited codes for remote access (if passcodes are enabled alongside IPs)
- Set label, code, duration (days/months)
- View access logs for unlock events

---

## Super Admin panel

**URL:** `/superadmin`

### Manage admins

- Create admin, manager, or viewer accounts
- Reset passwords
- Deactivate accounts

### Employee name editors

- Super Admin can always edit names
- Choose up to **2 other admins** who may edit employee names (Yes/No per admin)

### Audit logs

- View admin actions (create/update/delete/import)

---

## Tips

- After bulk import, check **Recent data** for errors
- Use **Works for station** for CEO/backoffice rows that support other regions
- CEO country employees show destination (e.g. `→ Shenzhen`) without duplicate station badge on public site
- Managers can manage **Access control** but not org structure tabs

---

## When to call IT / developer

- Site completely down
- Database errors on `/api/health`
- Need code update deployed (see [DEPLOYMENT-AZURE-WINDOWS.md](./DEPLOYMENT-AZURE-WINDOWS.md))
- Office ISP public IP changed (new IP to whitelist)
- SSL certificate expired
