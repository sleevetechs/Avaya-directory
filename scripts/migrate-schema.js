const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(function loadEnvFiles() {
  for (const name of ['.env.server', '.env']) {
    const envPath = path.join(__dirname, '..', name);
    if (!fs.existsSync(envPath)) continue;
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
  }
})();

const UNCATEGORISED_DEPT = 'Uncategorised';

async function main() {
  const config = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'avaya_list',
    multipleStatements: true,
  };

  console.log('Connecting to', config.host + ':' + config.port, 'database', config.database, 'as', config.user);
  const conn = await mysql.createConnection(config);

  console.log('→ departments table');
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS departments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_department_name (name)
    )
  `);
  await conn.execute(`
    INSERT IGNORE INTO departments (name)
    SELECT DISTINCT TRIM(dept) FROM employees
    WHERE deleted_at IS NULL AND dept IS NOT NULL AND TRIM(dept) <> ''
  `);
  await conn.execute('INSERT IGNORE INTO departments (name) VALUES (?)', [UNCATEGORISED_DEPT]);

  console.log('→ works_for_station column');
  try {
    await conn.execute(`
      ALTER TABLE employees
      ADD COLUMN works_for_station VARCHAR(100) NOT NULL DEFAULT ''
      AFTER station_name
    `);
    console.log('  added works_for_station');
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') console.log('  already exists');
    else throw e;
  }

  console.log('→ access control tables');
  await conn.execute(`
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
    await conn.execute(`ALTER TABLE access_allowed_ips ADD COLUMN entry_type VARCHAR(8) NOT NULL DEFAULT 'ip'`);
  } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  try {
    await conn.execute(`ALTER TABLE access_allowed_ips ADD COLUMN host_name VARCHAR(255) NOT NULL DEFAULT ''`);
  } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  try {
    await conn.execute(`ALTER TABLE access_allowed_ips MODIFY ip_address VARCHAR(64) NOT NULL DEFAULT ''`);
  } catch (e) { /* ignore */ }
  try {
    await conn.execute(`ALTER TABLE access_allowed_ips DROP INDEX uq_access_ip`);
  } catch (e) { /* ignore */ }
  await conn.execute(`
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
  try {
    await conn.execute(`ALTER TABLE access_passcodes ADD COLUMN duration_amount INT NOT NULL DEFAULT 7`);
  } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  try {
    await conn.execute(`ALTER TABLE access_passcodes ADD COLUMN duration_unit VARCHAR(16) NOT NULL DEFAULT 'days'`);
  } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS access_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      action VARCHAR(50) NOT NULL,
      ip_address VARCHAR(64) NOT NULL DEFAULT '',
      device_name VARCHAR(255) NOT NULL DEFAULT '',
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
    await conn.execute(`ALTER TABLE access_logs ADD COLUMN device_name VARCHAR(255) NOT NULL DEFAULT ''`);
  } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }

  const [[{ empCount }]] = await conn.query('SELECT COUNT(*) AS empCount FROM employees WHERE deleted_at IS NULL');
  const [[{ adminCount }]] = await conn.query('SELECT COUNT(*) AS adminCount FROM admins');
  const [cols] = await conn.query("SHOW COLUMNS FROM employees LIKE 'works_for_station'");

  console.log('');
  console.log('Migration OK');
  console.log('Employees:', empCount, '| Admins:', adminCount, '| works_for_station:', cols.length ? 'yes' : 'no');
  await conn.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
