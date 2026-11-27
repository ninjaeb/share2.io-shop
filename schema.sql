-- Share2.io Shop — registrations & orders table
-- Run this once in phpMyAdmin (or `mysql < schema.sql`) against the database
-- you create for this app. Safe to re-run: CREATE TABLE IF NOT EXISTS.
--
-- If you already ran an earlier version of this file, the new billing_cycle
-- column below won't be added automatically to an existing table — run this
-- one line once to add it (skip it if you get a "duplicate column" error,
-- that just means it's already there):
--   ALTER TABLE registrations ADD COLUMN billing_cycle ENUM('monthly','yearly') NULL AFTER plan;

-- Existing database: run this once so Max orders can be saved ('free' stays
-- in the list only so that older records remain valid):
--   ALTER TABLE registrations MODIFY plan ENUM('free','pro','max','team') NULL;

CREATE TABLE IF NOT EXISTS registrations (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ref           VARCHAR(64)  NOT NULL UNIQUE,        -- our own reference (signup_..., or Razorpay order/subscription id)
  kind          ENUM('free_signup','order','subscription') NOT NULL,
  status        ENUM('pending','paid','signed_up','failed') NOT NULL DEFAULT 'pending',

  plan          ENUM('free','pro','max','team') NULL,
  billing_cycle ENUM('monthly','yearly') NULL,        -- only meaningful when plan is pro/max/team
  card_type     ENUM('template','custom','setup','none') NULL,
  qty           SMALLINT UNSIGNED NULL,
  amount_sen    INT UNSIGNED NULL,                   -- total charged, in sen; 0 or NULL for free signups

  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(190) NOT NULL,
  phone         VARCHAR(40)  NOT NULL,
  print_name    VARCHAR(120) NULL,
  job_title     VARCHAR(120) NULL,
  company       VARCHAR(160) NULL,

  addr1         VARCHAR(190) NULL,
  addr2         VARCHAR(190) NULL,
  city          VARCHAR(100) NULL,
  postcode      VARCHAR(10)  NULL,
  state         VARCHAR(60)  NULL,

  design        VARCHAR(60)  NULL,                   -- e.g. "Aurum"
  design_color  VARCHAR(20)  NULL,                    -- "gold" | "silver"
  notes         TEXT NULL,

  razorpay_order_id        VARCHAR(64) NULL,
  razorpay_subscription_id VARCHAR(64) NULL,
  razorpay_payment_id      VARCHAR(64) NULL,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_email (email),
  INDEX idx_status (status),
  INDEX idx_kind (kind),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
