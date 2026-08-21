const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(function loadEnvFile(name) {
  const envPath = path.join(__dirname, '..', name);
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
})('.env');

async function main() {
  const config = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'avaya_list',
    multipleStatements: true,
  };

  console.log('Connecting to', config.host + ':' + config.port, 'database', config.database);
  const conn = await mysql.createConnection(config);

  console.log('→ Running scripts/update-server-db.sql');
  const sql = fs.readFileSync(path.join(__dirname, 'update-server-db.sql'), 'utf8');
  await conn.query(sql);

  console.log('→ employee_number_removals table');
  await conn.execute(`
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

  const [[roleCol]] = await conn.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admins' AND COLUMN_NAME = 'role'`
  );
  const [[{ pendingRemovals }]] = await conn.query(
    'SELECT COUNT(*) AS pendingRemovals FROM employee_number_removals WHERE confirmed_at IS NULL AND cancelled_at IS NULL'
  );
  const [[{ admins }]] = await conn.query('SELECT COUNT(*) AS admins FROM admins');
  const [removalTable] = await conn.query("SHOW TABLES LIKE 'employee_number_removals'");

  console.log('');
  console.log('Local migration OK');
  console.log('  admins.role:', roleCol?.t || 'missing');
  console.log('  employee_number_removals:', removalTable.length ? 'yes' : 'no');
  console.log('  admins:', admins, '| pending Avaya removals:', pendingRemovals);
  await conn.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
