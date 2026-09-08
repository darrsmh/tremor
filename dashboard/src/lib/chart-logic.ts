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

// Stable render decimation: time-aligned min/max buckets. Rows are grouped by
// floor(ts / bucketMs) and the min-PGA and max-PGA rows of each bucket are
// kept (<= 2 rows per bucket, so ~600 buckets => <=~1200 plotted points).
// Bucket edges are pinned to ABSOLUTE epoch time -- not to row indexes -- so
// the chosen points do NOT reshuffle as the window slides or old rows age
// out. min+max preserves PGA spikes, matching what the server-side
// get_samples_window RPC already returns for long windows.
export function decimateForRender(rows: Sample[], bucketMs: number): Sample[] {
  const n = rows.length;
  if (!(bucketMs > 0) || n === 0) return rows;

  const lo = new Map<number, Sample>();
  const hi = new Map<number, Sample>();
  for (const r of rows) {
    const b = Math.floor(r.ts / bucketMs);
    const curLo = lo.get(b);
    if (!curLo || r.pga_c < curLo.pga_c || (r.pga_c === curLo.pga_c && r.ts < curLo.ts)) {
      lo.set(b, r);
    }
    const curHi = hi.get(b);
    if (!curHi || r.pga_c > curHi.pga_c || (r.pga_c === curHi.pga_c && r.ts > curHi.ts)) {
      hi.set(b, r);
    }
  }

  const out: Sample[] = [];
  const keys = [...lo.keys()].sort((a, b) => a - b);
  for (const b of keys) {
    const l = lo.get(b);
    const h = hi.get(b);
    if (!l || !h) continue;
    if (l === h) {
      out.push(l);
    } else if (l.ts < h.ts) {
      out.push(l, h);
    } else {
      out.push(h, l);
    }
  }
  return out;
}

// Trace gaps in the serialized (decimated) series by inserting a null bridge
// row mid-gap. Recharts (connectNulls=false) breaks the polyline at null
// points, so a WiFi stall / device reboot / send gap renders as a TRUE gap
// instead of a straight line interpolated across missing data. The bridge row
// carries ts (for stable X placement) but all metrics set to null.
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

export function computeGapMs(bucketMs: number): number {
  return Math.max(bucketMs * 3, 1000);
}