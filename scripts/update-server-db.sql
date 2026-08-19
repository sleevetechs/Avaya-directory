-- Compass Directory — server DB update (safe to re-run)
-- Usage: mysql -u root -p avaya_list < scripts/update-server-db.sql

USE avaya_list;

CREATE TABLE IF NOT EXISTS departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_department_name (name)
);

INSERT IGNORE INTO departments (name)
SELECT DISTINCT TRIM(dept) FROM employees
WHERE deleted_at IS NULL AND dept IS NOT NULL AND TRIM(dept) <> '';

INSERT IGNORE INTO departments (name) VALUES ('Uncategorised');

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employees'
    AND COLUMN_NAME = 'works_for_station'
);
SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE employees ADD COLUMN works_for_station VARCHAR(100) NOT NULL DEFAULT '''' AFTER station_name',
  'SELECT ''works_for_station already exists'' AS status'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS access_allowed_ips (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ip_address VARCHAR(64) NOT NULL,
  label VARCHAR(255) NOT NULL DEFAULT '',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_access_ip (ip_address)
);

CREATE TABLE IF NOT EXISTS access_passcodes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(255) NOT NULL DEFAULT '',
  passcode_hash VARCHAR(255) NOT NULL,
  duration_amount INT NOT NULL DEFAULT 7,
  duration_unit VARCHAR(16) NOT NULL DEFAULT 'days',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'access_passcodes'
    AND COLUMN_NAME = 'duration_amount'
);
SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE access_passcodes ADD COLUMN duration_amount INT NOT NULL DEFAULT 7',
  'SELECT ''duration_amount already exists'' AS status'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'access_passcodes'
    AND COLUMN_NAME = 'duration_unit'
);
SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE access_passcodes ADD COLUMN duration_unit VARCHAR(16) NOT NULL DEFAULT ''days''',
  'SELECT ''duration_unit already exists'' AS status'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

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
);

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'access_logs'
    AND COLUMN_NAME = 'device_name'
);
SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE access_logs ADD COLUMN device_name VARCHAR(255) NOT NULL DEFAULT '''' AFTER ip_address',
  'SELECT ''device_name already exists'' AS status'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT 'Migration complete' AS status;
SELECT COUNT(*) AS employees FROM employees WHERE deleted_at IS NULL;
SELECT COUNT(*) AS admins FROM admins;
SHOW COLUMNS FROM employees LIKE 'works_for_station';
