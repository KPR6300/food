CREATE DATABASE IF NOT EXISTS bhargavi_cloud
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE bhargavi_cloud;

CREATE TABLE IF NOT EXISTS app_metadata (
  meta_key VARCHAR(100) NOT NULL PRIMARY KEY,
  meta_value TEXT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  order_code CHAR(10) NOT NULL PRIMARY KEY,
  customer_phone VARCHAR(15) NOT NULL,
  status VARCHAR(32) NOT NULL,
  payment_status VARCHAR(32) NULL,
  created_at VARCHAR(30) NOT NULL,
  order_data JSON NOT NULL,
  INDEX idx_orders_customer_phone (customer_phone),
  INDEX idx_orders_created_at (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS menu_availability (
  item_id VARCHAR(64) NOT NULL PRIMARY KEY,
  available BOOLEAN NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  endpoint VARCHAR(2048) NOT NULL,
  p256dh VARCHAR(200) NOT NULL,
  auth VARCHAR(100) NOT NULL
) ENGINE=InnoDB;
