const mysql = require('mysql2/promise');

(async () => {
  for (const port of [3306, 3307]) {
    try {
      const c = await mysql.createConnection({
        host: '127.0.0.1',
        port,
        user: 'root',
        password: '',
        database: 'avaya_list',
      });
      const [[admins]] = await c.query('SELECT COUNT(*) AS c FROM admins');
      const [[emps]] = await c.query('SELECT COUNT(*) AS c FROM employees WHERE deleted_at IS NULL');
      const [cols] = await c.query("SHOW COLUMNS FROM employees LIKE 'works_for_station'");
      console.log(JSON.stringify({ port, admins: admins.c, employees: emps.c, works_for_station: cols.length > 0 }));
      await c.end();
    } catch (e) {
      console.log(JSON.stringify({ port, error: e.code || e.message }));
    }
  }
})();
