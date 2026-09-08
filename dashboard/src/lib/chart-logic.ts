// Pure chart/sample utilities extracted from the dashboard component so the
// chart-integrity logic (timestamp sanitization, stable render decimation) can
// be unit-tested without React or a browser.

export interface Sample {
  node_id?: string;
  ts: number;
  pga_c: number;
  sigma_f: number;
  sigma_a: number;
  sigma_m: number;
  snr_db: number;
  roll: number;
  pitch: number;
}

export function fmt(n: unknown, d = 5) {
  if (n === null || n === undefined || n === "") return "--";
  const num = typeof n === "string" ? parseFloat(n) : Number(n);
  if (Number.isNaN(num)) return "--";
  return num.toFixed(d);
}

export function epochMs(n: unknown): number {
  const t = typeof n === "string" ? Date.parse(n) : Number(n);
  if (!Number.isFinite(t)) return NaN;
  // Sanity-check: only accept plausible epoch-ms timestamps (2000-02-01 .. 2037-12-31).
  // This rejects device uptime in ms (small values) that would otherwise display
  // as "~490,000 hours ago".
  const lo = Date.UTC(2000, 1, 1);
  const hi = Date.UTC(2038, 0, 1);
  return t > lo && t < hi ? t : NaN;
}

export function ago(ms: number) {
  if (!Number.isFinite(ms)) return "--";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 0) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// X-axis tick / tooltip label: epoch-ms → HH:MM:SS (Philippine time).
export function fmtTimeTick(v: unknown) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1000000000000) return "";
  return new Date(n).toLocaleTimeString("en-US", {
    timeZone: "Asia/Manila",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Supabase Realtime serializes BIGINT columns (like `ts`) as JSON strings to
// avoid precision loss > 2^53. Normalize them back to numbers so the chart
// X-axis, `new Date(ts)`, and the online check all receive numeric ms.
// Also reject implausible ts values (a ~1.78e15 row was observed in history —
// garbage that pushed the X-axis to "year 56600" and broke the chart).
export function normalizeSample(row: Record<string, unknown>): Sample | null {
  const toNum = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const ts = toNum(row.ts);
  if (!Number.isFinite(ts) || ts < 1000000000000 || ts > 2000000000000) {
    return null; // outside 2001..2033 epoch-ms — boot uptime / garbage, drop it
  }
  return {
    node_id: (row.node_id as string) ?? undefined,
    ts,
    pga_c: toNum(row.pga_c),
    sigma_f: toNum(row.sigma_f),
    sigma_a: toNum(row.sigma_a),
    sigma_m: toNum(row.sigma_m),
    snr_db: toNum(row.snr_db),
    roll: toNum(row.roll),
    pitch: toNum(row.pitch),
  };
}

// Stable render decimation: ONE real sample per time-aligned bucket. Rows are
// grouped by floor(ts / bucketMs) and the row whose ts is nearest the bucket
// center is kept, so every plotted point is a genuine detected value. Bucket
// edges are pinned to ABSOLUTE epoch time -- not to row indexes -- so the
// chosen points do NOT reshuffle as the window slides or old rows age out.
//
// (The previous min+max-per-bucket pass kept two extreme rows per bucket -- a
// low then a high, ~every bucket -- which rendered as a spiky "comb" even when
// the underlying signal was flat.)
export function decimateOne(rows: Sample[], bucketMs: number): Sample[] {
  if (!(bucketMs > 0) || rows.length < 2) return rows;

  const picked = new Map<number, Sample>();
  for (const r of rows) {
    const b = Math.floor(r.ts / bucketMs);
    const center = (b + 0.5) * bucketMs;
    const cur = picked.get(b);
    if (!cur || Math.abs(r.ts - center) < Math.abs(cur.ts - center)) {
      picked.set(b, r);
    }
  }
  return [...picked.values()].sort((a, b) => a.ts - b.ts);
}

// Split the (decimated) series at genuine ACQUISITION gaps. Between the last
// sample before a stall/reboot and the first sample after it there is no data,
// so drawing a straight line back and forth would fabricate a ramp across
// silence. Inserting one null bridge mid-gap makes recharts (connectNulls=false)
// break the polyline instead: within a live 200 Hz stream the rendered points
// sit ~bucketMs apart, far below gapMs, so normal streaming (even slow WiFi
// delivery) is never cut -- only real missing-data periods are.
export function breakGaps(rows: Sample[], gapMs: number): Sample[] {
  if (!(gapMs > 0) || rows.length < 2) return rows;

  const nil = null as unknown as number; // runtime null so recharts breaks the line
  const out: Sample[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && rows[i].ts - rows[i - 1].ts > gapMs) {
      out.push({
        ts: Math.round((rows[i - 1].ts + rows[i].ts) / 2),
        pga_c: nil,
        sigma_f: nil,
        sigma_a: nil,
        sigma_m: nil,
        snr_db: nil,
        roll: nil,
        pitch: nil,
      });
    }
    out.push(rows[i]);
  }
  return out;
}