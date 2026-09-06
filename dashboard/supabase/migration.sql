-- =============================================================
-- Seismic Dashboard — Supabase Schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor)
-- =============================================================

-- 1. Samples table (high-frequency sensor data, up to 80 rows per POST)
CREATE TABLE IF NOT EXISTS samples (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id   TEXT NOT NULL DEFAULT 'ADXL345-01',
  ts        BIGINT NOT NULL,
  pga_c     DOUBLE PRECISION,
  sigma_f   DOUBLE PRECISION,
  sigma_a   DOUBLE PRECISION,
  sigma_m   DOUBLE PRECISION,
  snr_db    DOUBLE PRECISION,
  roll      DOUBLE PRECISION,
  pitch     DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples (ts DESC);

-- Window queries filter by server insertion time (device ts can be skew/reboot
-- relative and must never drive the dashboard window).
CREATE INDEX IF NOT EXISTS idx_samples_created_at ON samples (created_at);

-- Trim old samples automatically — keep only the latest 2000 rows
-- via a trigger (Supabase doesn't support automatic row limits natively).

-- 2. Alerts table
CREATE TABLE IF NOT EXISTS alerts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id         TEXT,
  event_type      TEXT,
  pga             DOUBLE PRECISION,
  pga_mgal        BIGINT,
  ts_ms           BIGINT,
  snr_db          DOUBLE PRECISION,
  sigma_fused     DOUBLE PRECISION,
  sigma_adxl      DOUBLE PRECISION,
  sigma_mpu       DOUBLE PRECISION,
  ax_corr         DOUBLE PRECISION,
  ay_corr         DOUBLE PRECISION,
  az_corr         DOUBLE PRECISION,
  noise_reduction_eta   DOUBLE PRECISION,
  noise_reduction_pct   DOUBLE PRECISION,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts (ts_ms DESC);

-- 3. Live state (one row per node — upserted on every ingest)
CREATE TABLE IF NOT EXISTS live_state (
  node_id         TEXT PRIMARY KEY,
  ts              BIGINT,
  pga_c           DOUBLE PRECISION,
  sigma_f         DOUBLE PRECISION,
  sigma_a         DOUBLE PRECISION,
  sigma_m         DOUBLE PRECISION,
  snr_db          DOUBLE PRECISION,
  roll            DOUBLE PRECISION,
  pitch           DOUBLE PRECISION,
  last_alert_pga  DOUBLE PRECISION,
  last_alert_ts   BIGINT,
  last_alert_snr  DOUBLE PRECISION,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 4. Heartbeats (one row per node — upserted)
CREATE TABLE IF NOT EXISTS heartbeats (
  node_id   TEXT PRIMARY KEY,
  ts        BIGINT,
  status    TEXT,
  rssi      INTEGER,
  heap      INTEGER,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================================
-- Realtime: enable for samples and alerts tables
-- Run in Supabase Dashboard → Database → Replication
-- Or via SQL:
-- =============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE samples;
ALTER PUBLICATION supabase_realtime ADD TABLE alerts;

-- =============================================================
-- Auto-trim: keep only the latest 200000 samples
-- (200 Hz → ~16 minutes of continuous history, plenty for the
-- 30s/2m/5m dashboard windows with headroom before the 6000-point fetch cap).
-- Trim by insertion order (id DESC), NOT sensor ts: a node that loses NTP
-- sync can report boot-relative ts (tiny values) and would otherwise have
-- every new row treated as "oldest" and deleted on insert.
-- =============================================================
CREATE OR REPLACE FUNCTION trim_samples() RETURNS trigger AS $$
BEGIN
  DELETE FROM samples
  WHERE id NOT IN (
    SELECT id FROM samples ORDER BY id DESC LIMIT 200000
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_trim_samples
  AFTER INSERT ON samples
  FOR EACH STATEMENT
  EXECUTE FUNCTION trim_samples();

-- =============================================================
-- Row Level Security
-- Server (service_role) writes via the API routes.
-- Anonymous clients may SELECT so Realtime pushes reach the browser.
-- =============================================================

ALTER TABLE samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE heartbeats ENABLE ROW LEVEL SECURITY;

-- Allow anon SELECT on samples (for Realtime subscription)
CREATE POLICY "anon select samples"
  ON samples FOR SELECT TO anon USING (true);

-- Allow anon SELECT on alerts (for Realtime subscription)
CREATE POLICY "anon select alerts"
  ON alerts FOR SELECT TO anon USING (true);

-- Allow service_role full access on all tables (overrides RLS)
CREATE POLICY "service select samples"  ON samples     FOR SELECT TO service_role USING (true);
CREATE POLICY "service insert samples"  ON samples     FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service delete samples"  ON samples     FOR DELETE TO service_role USING (true);
CREATE POLICY "service select alerts"   ON alerts      FOR SELECT TO service_role USING (true);
CREATE POLICY "service insert alerts"   ON alerts      FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service select live"     ON live_state  FOR SELECT TO service_role USING (true);
CREATE POLICY "service insert live"     ON live_state  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service update live"     ON live_state  FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service select hb"       ON heartbeats  FOR SELECT TO service_role USING (true);
CREATE POLICY "service insert hb"       ON heartbeats  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "service update hb"       ON heartbeats  FOR UPDATE TO service_role USING (true) WITH CHECK (true);
