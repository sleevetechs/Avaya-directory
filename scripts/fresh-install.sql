-- ============================================================
-- Compass Directory — FRESH INSTALL (MySQL Workbench)
-- Run this entire script in one go (lightning bolt icon).
-- Database name: avaya_list
-- Admin login after install: super-admin@compasslog.com / 1234
-- ============================================================

CREATE DATABASE IF NOT EXISTS avaya_list
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

USE avaya_list;

-- ── Admins ──
CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'admin',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admin_email (email)
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id INT NULL,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL DEFAULT '',
  entity_id INT NULL,
  old_data JSON NULL,
  new_data JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_logs_created (created_at)
);

-- ── Org structure ──
CREATE TABLE IF NOT EXISTS branches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_branch_name (name)
);

CREATE TABLE IF NOT EXISTS states (
  id INT AUTO_INCREMENT PRIMARY KEY,
  country_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_states_country (country_id)
);

CREATE TABLE IF NOT EXISTS locations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  state_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  city VARCHAR(255) NOT NULL DEFAULT '',
  address TEXT NULL,
  maps_url VARCHAR(500) NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_locations_state (state_id)
);

CREATE TABLE IF NOT EXISTS station_numbers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  location_id INT NULL,
  branch VARCHAR(255) NOT NULL DEFAULT '',
  station_name VARCHAR(255) NOT NULL DEFAULT '',
  label VARCHAR(255) NOT NULL DEFAULT '',
  number_type VARCHAR(64) NOT NULL DEFAULT 'phone',
  phone VARCHAR(64) NOT NULL DEFAULT '',
  address TEXT NULL,
  maps_url VARCHAR(500) NOT NULL DEFAULT '',
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_station_numbers_location (location_id)
);

-- ── Employees ──
CREATE TABLE IF NOT EXISTS employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL DEFAULT '',
  dept VARCHAR(255) NOT NULL DEFAULT '',
  branch VARCHAR(255) NOT NULL DEFAULT '',
  state_name VARCHAR(255) NOT NULL DEFAULT '',
  station_name VARCHAR(255) NOT NULL DEFAULT '',
  works_for_station VARCHAR(100) NOT NULL DEFAULT '',
  location_id INT NULL,
  created_by INT NULL,
  updated_by INT NULL,
  delete_requested_by INT NULL,
  deleted_by INT NULL,
  delete_requested_at TIMESTAMP NULL,
  deleted_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_employees_dept (dept),
  INDEX idx_employees_branch (branch),
  INDEX idx_employees_location (location_id)
);

CREATE TABLE IF NOT EXISTS employee_numbers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  label VARCHAR(64) NOT NULL DEFAULT '',
  ext VARCHAR(64) NOT NULL DEFAULT '',
  mobile VARCHAR(64) NOT NULL DEFAULT '',
  sd VARCHAR(64) NOT NULL DEFAULT '',
  sd_no VARCHAR(64) NOT NULL DEFAULT '',
  INDEX idx_employee_numbers_emp (employee_id)
);

CREATE TABLE IF NOT EXISTS departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_department_name (name)
);

-- ── Directory access control ──
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

-- ── Seed data ──
INSERT IGNORE INTO admins (id, name, email, password_hash, role, is_active)
VALUES (
  1,
  'Super Admin',
  'super-admin@compasslog.com',
  '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',
  'super_admin',
  1
);

INSERT IGNORE INTO departments (name) VALUES ('Uncategorised');

-- ── Done — verify ──
SELECT 'Database avaya_list is ready!' AS status;
SHOW TABLES;
SELECT id, name, email, role FROM admins;
SELECT COUNT(*) AS employee_count FROM employees;
