import { createSupabaseServer } from "./supabase-server";

const SAMPLE_COLUMNS =
  "node_id, ts, pga_c, sigma_f, sigma_a, sigma_m, snr_db, roll, pitch";

function sb() {
  return createSupabaseServer();
}

// ── Live state ────────────────────────────────────────────────

export async function updateLive(data: Record<string, unknown>) {
  const { node_id, ...fields } = data;
  const { error } = await sb()
    .from("live_state")
    .upsert(
      { node_id: node_id ?? "ADXL345-01", ...fields, updated_at: new Date().toISOString() },
      { onConflict: "node_id" }
    );
  if (error) console.error("[db] live_state upsert failed:", error.message);
}

export async function getLive() {
  const { data, error } = await sb()
    .from("live_state")
    .select("*")
    .eq("node_id", "ADXL345-01");
  if (error) console.error("[db] live_state query failed:", error.message);
  return (data?.[0] ?? {}) as Record<string, unknown>;
}

// ── Samples ───────────────────────────────────────────────────

export async function pushSamples(samples: object[]) {
  if (!samples.length) return;
  const rows = samples.map((s) => {
    const r = s as Record<string, unknown>;
    return {
      node_id: "ADXL345-01",
      ts: r.ts,
      pga_c: r.pga_c,
      sigma_f: r.sigma_f,
      sigma_a: r.sigma_a,
      sigma_m: r.sigma_m,
      snr_db: r.snr_db,
      roll: r.roll,
      pitch: r.pitch,
    };
  });
  const { error } = await sb().from("samples").insert(rows);
  // Surface insert failures. A silent failure here (e.g. trim-trigger
  // statement timeouts) made the API return 200 while every batch was
  // dropped, freezing the dashboard graph/values while live_state kept
  // updating and the ESP32 kept advancing its ring-buffer tail.
  if (error) throw new Error(`samples insert failed: ${error.message}`);
}

export async function getSamples(count = 200) {
  const { data, error } = await sb()
    .from("samples")
    .select(SAMPLE_COLUMNS)
    .order("ts", { ascending: false })
    .limit(Math.min(count, 6000));
  if (error) console.error("[db] samples query failed:", error.message);
  return (data ?? []).reverse();
}

// Anchor windowed queries on server-side insertion time (created_at), NOT the
// device ts. Device ts can be boot-relative, NTP-skewed, or reset on reboot —
// a ts-window then silently returns pre-reboot rows or nothing even while the
// device is streaming (frozen graph). created_at is set by the DB to now() on
// every insert, so the last N seconds always reflect what actually arrived.
//
// Decimation runs in Postgres (get_samples_window RPC, supabase/rpc_window.sql):
// returns min-pga + max-pga rows per bucket so PGA spikes survive aggregation,
// in ONE query. The old client-side 1000-row pagination loop made the 2m/5m
// windows do up to 60 sequential Supabase calls per request (~5-10s of latency).
export async function getSamplesWindowed(count = 6000, windowSeconds = 30) {
  const target = Math.min(count, 6000);
  const { data, error } = await sb().rpc("get_samples_window", {
    node_id_param: "ADXL345-01",
    window_seconds: windowSeconds,
    target_points: target,
  });
  if (error) {
    console.error("get_samples_window RPC error:", error);
    return [];
  }
  return (data ?? []) as Record<string, unknown>[];
}

// ── Alerts ────────────────────────────────────────────────────

export async function pushAlert(alert: object) {
  const r = alert as Record<string, unknown>;
  const { error } = await sb().from("alerts").insert({
    node_id: r.node_id,
    event_type: r.event_type,
    pga: r.pga,
    pga_mgal: r.pga_mgal,
    ts_ms: r.ts_ms,
    snr_db: r.snr_db,
    sigma_fused: r.sigma_fused,
    sigma_adxl: r.sigma_adxl,
    sigma_mpu: r.sigma_mpu,
    ax_corr: r.ax_corr,
    ay_corr: r.ay_corr,
    az_corr: r.az_corr,
    noise_reduction_eta: r.noise_reduction_eta,
    noise_reduction_pct: r.noise_reduction_pct,
  });
  if (error) throw new Error(`alerts insert failed: ${error.message}`);
}

export async function getAlerts(count = 20) {
  const { data } = await sb()
    .from("alerts")
    .select("*")
    // nullsFirst: false — Postgres puts NULLS FIRST on a DESC order, which
    // surfaced empty alert rows (all fields NULL) at the top of the list.
    .order("ts_ms", { ascending: false, nullsFirst: false })
    .limit(count);
  return data ?? [];
}

// ── Heartbeats ────────────────────────────────────────────────

export async function setHeartbeat(nodeId: string, data: Record<string, unknown>) {
  const { error } = await sb()
    .from("heartbeats")
    .upsert(
      { node_id: nodeId, ...data, updated_at: new Date().toISOString() },
      { onConflict: "node_id" }
    );
  if (error) console.error("[db] heartbeats upsert failed:", error.message);
}

export async function getHeartbeat(nodeId: string) {
  const { data } = await sb()
    .from("heartbeats")
    .select("*")
    .eq("node_id", nodeId);
  return data?.[0] ?? {};
}
