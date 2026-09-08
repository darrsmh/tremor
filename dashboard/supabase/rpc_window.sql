-- =============================================================
-- Windowed history RPC — single-query min/max decimation
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
-- Replaces the slow client-side 1000-row pagination loop so
-- /api/live/history?window=30|120|300 returns decimated rows fast.
-- =============================================================

CREATE OR REPLACE FUNCTION get_samples_window(
  node_id_param  TEXT,
  window_seconds INTEGER,
  target_points  INTEGER
) RETURNS TABLE(
  node_id TEXT,
  ts      BIGINT,
  pga_c   DOUBLE PRECISION,
  sigma_f DOUBLE PRECISION,
  sigma_a DOUBLE PRECISION,
  sigma_m DOUBLE PRECISION,
  snr_db  DOUBLE PRECISION,
  roll    DOUBLE PRECISION,
  pitch   DOUBLE PRECISION
)
LANGUAGE plpgsql
AS $$
DECLARE
  from_ts       TIMESTAMPTZ := now() - make_interval(secs => window_seconds);
  buckets_count DOUBLE PRECISION;
BEGIN
  -- Two points per bucket (min-pga row + max-pga row) so PGA spikes survive.
  buckets_count := GREATEST(floor(target_points / 2), 1);

  RETURN QUERY
  WITH filtered AS (
    SELECT s.node_id, s.ts, s.pga_c, s.sigma_f, s.sigma_a, s.sigma_m,
           s.snr_db, s.roll, s.pitch
    FROM samples s
    WHERE s.node_id = node_id_param
      AND s.created_at >= from_ts
    ORDER BY s.id
  ),
  counts AS (
    SELECT count(*) AS n FROM filtered
  ),
  numbered AS (
    SELECT f.*,
           floor((row_number() OVER (ORDER BY f.id) - 1)
                 / GREATEST(counts.n / buckets_count, 1)) AS bucket
    FROM filtered f CROSS JOIN counts
  ),
  lo AS (
    SELECT DISTINCT ON (bucket)
           bucket, node_id, ts, pga_c, sigma_f, sigma_a, sigma_m, snr_db, roll, pitch
    FROM numbered
    ORDER BY bucket, pga_c ASC, ts ASC
  ),
  hi AS (
    SELECT DISTINCT ON (bucket)
           bucket, node_id, ts, pga_c, sigma_f, sigma_a, sigma_m, snr_db, roll, pitch
    FROM numbered
    ORDER BY bucket, pga_c DESC, ts DESC
  )
  SELECT node_id, ts, pga_c, sigma_f, sigma_a, sigma_m, snr_db, roll, pitch FROM lo
  UNION ALL
  SELECT node_id, ts, pga_c, sigma_f, sigma_a, sigma_m, snr_db, roll, pitch FROM hi
  ORDER BY ts ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_samples_window(TEXT, INTEGER, INTEGER) TO service_role;

-- Browser never calls this directly (it goes through the edge API), but grant
-- anon too in case you want to test from a client:
GRANT EXECUTE ON FUNCTION get_samples_window(TEXT, INTEGER, INTEGER) TO anon;

-- =============================================================
-- ALSO VERIFY (if not already applied from migration.sql):
--   ALTER PUBLICATION supabase_realtime ADD TABLE samples;
--   ALTER PUBLICATION supabase_realtime ADD TABLE alerts;
-- Check Database → Replication → samples should be checked.
-- =============================================================
SELECT 'run complete' AS status;