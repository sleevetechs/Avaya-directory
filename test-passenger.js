const http = require('http');
const mysql = require('mysql2/promise');

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/health' || req.url.startsWith('/api/health?')) {
    const cfg = {
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'avaya_list',
    };
    try {
      const pool = mysql.createPool(cfg);
      const [rows] = await pool.execute('SELECT 1 AS ok');
      const [[admins]] = await pool.execute('SELECT COUNT(*) AS c FROM admins');
      await pool.end();
      res.end(JSON.stringify({ ok: true, db: rows[0].ok === 1, admins: admins.c, host: cfg.host, user: cfg.user, database: cfg.database }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: e.message, code: e.code || null, host: cfg.host, user: cfg.user, database: cfg.database }));
    }
    return;
  }
  res.end(JSON.stringify({ ok: true, path: req.url, msg: 'passenger test ok' }));
});

if (typeof PhusionPassenger !== 'undefined') {
  PhusionPassenger.configure({ autoInstall: false });
  server.listen('passenger');
} else {
  server.listen(process.env.PORT || 3000);
}
