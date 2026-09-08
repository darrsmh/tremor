"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { createSupabaseBrowser } from "@/lib/supabase-client";

interface Live {
  node_id?: string;
  ts?: number;
  updated_at?: string;
  pga_c?: number;
  sigma_f?: number;
  sigma_a?: number;
  sigma_m?: number;
  snr_db?: number;
  roll?: number;
  pitch?: number;
  last_alert_pga?: number;
  last_alert_ts?: number;
}

interface Sample {
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

interface Alert {
  pga: number;
  ts_ms: number;
  snr_db: number;
  sigma_fused: number;
  created_at?: string;
}

function fmt(n: unknown, d = 5) {
  const num = typeof n === "string" ? parseFloat(n) : Number(n);
  if (num === undefined || num === null || Number.isNaN(num)) return "--";
  return num.toFixed(d);
}

function epochMs(n: unknown): number {
  const t = typeof n === "string" ? Date.parse(n) : Number(n);
  if (!Number.isFinite(t)) return NaN;
  // Sanity-check: only accept plausible epoch-ms timestamps (2000-02-01 .. 2037-12-31).
  // This rejects device uptime in ms (small values) that would otherwise display
  // as "~490,000 hours ago".
  const lo = Date.UTC(2000, 1, 1);
  const hi = Date.UTC(2038, 0, 1);
  return t > lo && t < hi ? t : NaN;
}

function ago(ms: number) {
  if (!Number.isFinite(ms)) return "--";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 0) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// X-axis tick / tooltip label: epoch-ms → HH:MM:SS (Philippine time).
function fmtTimeTick(v: unknown) {
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
function normalizeSample(row: Record<string, unknown>): Sample | null {
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
// out. (The previous LTTB pass re-picked a different subset on every tick,
// which visibly reshaped the whole polyline twice per second -- the
// choppiness/flicker.) min+max preserves PGA spikes, matching what the
// server-side get_samples_window RPC already returns for long windows.
function decimateForRender(rows: Sample[], bucketMs: number): Sample[] {
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

export default function Dashboard() {
  const [live, setLive] = useState<Live>({});
  const [history, setHistory] = useState<Sample[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [windowSec, setWindowSec] = useState(30);

  // Incoming Realtime sample rows are buffered and flushed a few times per
  // second so the charts don't re-render on every single insert (~200/sec).
  const pendingRef = useRef<Sample[]>([]);
  const windowSecRef = useRef(30);
  // Newest-sample anchor for the data-clock X axis (see dataNow below):
  // { device ts of the newest sample, Date.now() when it was observed }.
  const lastDataRef = useRef<{ ts: number; at: number } | null>(null);

  // Wall-clock heartbeat for the chart X-axis. The old axis used
  // domain={["dataMin","dataMax"]}, so the graph only advanced when new rows
  // arrived: every upload delay (WiFi/TLS stall on the ESP32 -- expected on
  // intermittent links) froze the chart flat until the next batch landed.
  // Anchoring the axis to Date.now() makes the graph scroll continuously like
  // a strip-chart recorder no matter when data actually arrives.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    // 100ms (~10fps scroll). A tick only moves the X-domain; the decimated
    // series is stable, so this stays cheap even at this rate.
    const heartbeat = setInterval(() => setNowTick(Date.now()), 100);
    return () => clearInterval(heartbeat);
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadInitial = async () => {
      try {
        const [a, l] = await Promise.all([
          fetch("/api/alerts", { cache: "no-store" }).then((r) => r.json()),
          fetch("/api/live", { cache: "no-store" }).then((r) => r.json()),
        ]);
        if (!mounted) return;
        if (Array.isArray(a)) setAlerts(a);
        if (l && typeof l === "object") setLive(l);
      } catch {}
    };
    loadInitial();

    const supabase = createSupabaseBrowser();

    const sampleChannel = supabase
      .channel("samples-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "samples" },
        (payload) => {
          const s = normalizeSample(payload.new as Record<string, unknown>);
          if (s) pendingRef.current.push(s);
        }
      )
      .subscribe();

    const alertChannel = supabase
      .channel("alerts-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "alerts" },
        (payload) => {
          const row = payload.new as Alert;
          setAlerts((prev) => [row, ...prev].slice(0, 50));
          setLive((prev) => ({
            ...prev,
            last_alert_pga: row.pga,
            last_alert_ts: row.ts_ms,
            last_alert_snr: row.snr_db,
          }));
        }
      )
      .subscribe();

    // Flush buffered samples ~4x/sec. Each flush is ONE setState, so the
    // graph redraws smoothly without re-rendering per inserted row.
    const flush = setInterval(() => {
      const batch = pendingRef.current;
      if (!batch.length) return;
      pendingRef.current = [];
      const latest = batch[batch.length - 1];
      // Track the newest sample for the data-clock X axis (see dataNow).
      if (latest.ts > (lastDataRef.current?.ts ?? Number.NEGATIVE_INFINITY)) {
        lastDataRef.current = { ts: latest.ts, at: Date.now() };
      }
      // Append realtime rows in all window modes — the periodic poll will
      // replace with properly decimated data; raw rows between polls are
      // negligible and keep the graph visibly streaming.
      setHistory((prev) => {
        // Window-aware cap: raw rows stream in at ~200 Hz, so a fixed
        // 6000-row cap would evict the older decimated snapshot rows in the
        // 2m/5m views, visibly emptying the left side of the chart between
        // polls. Keep enough rows to cover the window with headroom; the
        // render path decimates to <=1200 points anyway.
        const cap = Math.min(Math.max(windowSecRef.current * 400, 6000), 20000);
        const next = [...prev, ...batch];
        return next.length > cap ? next.slice(-cap) : next;
      });
      setLive((prev) => ({
        ...prev,
        node_id: latest.node_id,
        ts: latest.ts,
        pga_c: latest.pga_c,
        sigma_f: latest.sigma_f,
        sigma_a: latest.sigma_a,
        sigma_m: latest.sigma_m,
        snr_db: latest.snr_db,
        roll: latest.roll,
        pitch: latest.pitch,
      }));
    }, 250);

    return () => {
      mounted = false;
      supabase.removeChannel(sampleChannel);
      supabase.removeChannel(alertChannel);
      clearInterval(flush);
    };
  }, []);

  // History window: full 30s @ 200Hz is the fine-grained live tail; longer
  // windows are min-max decimated server-side so the chart stays at ~6000 pts.
  useEffect(() => {
    windowSecRef.current = windowSec;
    let mounted = true;

    const refresh = async () => {
      try {
        const h = await fetch(`/api/live/history?count=6000&window=${windowSec}`, {
          cache: "no-store",
        }).then((r) => r.json());
        if (!mounted || !Array.isArray(h)) return;
        const clean = h
          .map((r) => normalizeSample(r as Record<string, unknown>))
          .filter((x): x is Sample => x !== null);
        // NEVER erase the graph on an empty poll. A window query legitimately
        // returns [] when the radio has been silent longer than the window;
        // wiping here replaced good data with a blank "Waiting for data..."
        // chart on every 20s poll (the frozen-graph bug). Instead, only adopt
        // a server snapshot when it actually contains rows, and let the
        // realtime flush keep appending raw rows the rest of the time.
        if (clean.length > 0) {
          // Track the newest sample for the data-clock X axis (see dataNow).
          const newestClean = clean.reduce((m, x) => (x.ts > m ? x.ts : m), Number.NEGATIVE_INFINITY);
          if (newestClean > (lastDataRef.current?.ts ?? Number.NEGATIVE_INFINITY)) {
            lastDataRef.current = { ts: newestClean, at: Date.now() };
          }
          // Union-merge instead of overwrite: rows that arrived via Realtime
          // while this poll was in flight would otherwise be chopped off the
          // tail, making the graph jump backwards on every slow poll.
          setHistory((prev) => {
            const cap = Math.min(Math.max(windowSec * 400, 6000), 20000);
            const byTs = new Map<number, Sample>();
            for (const p of prev) byTs.set(p.ts, p);
            for (const c of clean) byTs.set(c.ts, c);
            const merged = [...byTs.values()].sort((a, b) => a.ts - b.ts);
            return merged.length > cap ? merged.slice(-cap) : merged;
          });
        }
      } catch {}
    };
    refresh();

    // Longer windows refresh less often — a 5-minute view updated every
    // ~60s still looks live, and skips hammering the decimation fetch.
    const pollMs = Math.min(Math.max(windowSec * 1000 / 2, 20000), 60000);
    const slowPoll = setInterval(refresh, pollMs);

    return () => {
      mounted = false;
      clearInterval(slowPoll);
    };
  }, [windowSec]);

  // Data-clock now: the newest sample DEVICE timestamp extrapolated forward
  // by real elapsed time (a Date.now() difference, so any PC clock offset
  // cancels out). The device clock runs tens of seconds behind server real
  // time (measured: server receive time minus device ts was 20-55s), so
  // anchoring the window to Date.now() pushed the newest samples outside the
  // viewport and only a portion of the graph showed. Anchoring to the data
  // timeline keeps the window full while data streams and keeps scrolling
  // smoothly between batches; a gap longer than the window empties the chart
  // (truthful) until data resumes and it re-anchors.
  const dataNow = lastDataRef.current
    ? lastDataRef.current.ts + Math.max(nowTick - lastDataRef.current.at, 0)
    : nowTick;

  // X window: [dataNow - window, dataNow] on the device own timeline.
  const xDomain = useMemo<[number, number]>(
    () => [dataNow - windowSec * 1000, dataNow],
    [dataNow, windowSec]
  );

  // Keep only samples inside the visible data-clock window (so the Y-axis
  // scales to what is actually visible), then decimate into stable,
  // time-aligned min/max buckets => <=~1200 plotted points. Both passes are a
  // single cheap O(n) sweep with NO point reshuffling between ticks.
  // Delayed batches render at their true acquisition timestamps, so a
  // send-gap fills in honestly instead of being bridged with fabricated data.
  const chartData = useMemo(() => {
    const windowStart = dataNow - windowSec * 1000;
    return decimateForRender(
      history.filter((d) => d.ts >= windowStart && d.ts <= dataNow),
      (windowSec * 1000) / 600
    );
  }, [history, dataNow, windowSec]);

  // Online if the latest live timestamp is recent, else fall back to the
  // newest history sample. Averaged against server ingestion time so a stale
  // /api/live row doesn't falsely show OFFLINE while data is flowing.
  let online = false;
  if (live.updated_at) {
    // Prefer updated_at (server-receive time, always accurate) over device ts
    // which can lag behind real time when NTP drifts.
    online = Date.now() - new Date(live.updated_at).getTime() < 60000;
  } else {
    const lastLiveTs = live.ts ?? history[history.length - 1]?.ts;
    if (lastLiveTs && lastLiveTs > 1000000000000) {
      online = Date.now() - lastLiveTs < 60000;
    }
  }

  return (
    <div className="dashboard">
      <h1>
        Seismic Monitor
        <span className={online ? "online-badge" : "offline-badge"}>
          {online ? "LIVE" : "OFFLINE"}
        </span>
      </h1>
      <div className="subtitle">
        Node {live.node_id ?? "--"} | Last update{" "}
        {(() => {
          const t = epochMs(live.ts) || (live.updated_at ? epochMs(live.updated_at) : NaN);
          return Number.isFinite(t)
            ? new Date(t).toLocaleTimeString("en-US", {
                timeZone: "Asia/Manila",
                hour12: false,
              })
            : "never";
        })()}{" "}
        (PH)
      </div>

      <div className="window-row">
        <span className="window-label">History</span>
        {[
          [30, "30s"],
          [120, "2m"],
          [300, "5m"],
        ].map(([sec, label]) => (
          <button
            key={sec}
            className={`window-btn${windowSec === sec ? " active" : ""}`}
            onClick={() => setWindowSec(sec as number)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="status-row">
        <div className="status-card">
          <div className="label">PGA</div>
          <div className="value">
            {fmt(live.pga_c, 5)}
            <span className="unit">g</span>
          </div>
        </div>
        <div className="status-card">
          <div className="label">Sigma (fused)</div>
          <div className="value">
            {fmt(live.sigma_f, 6)}
            <span className="unit">g</span>
          </div>
        </div>
        <div className="status-card">
          <div className="label">Sigma (ADXL)</div>
          <div className="value">
            {fmt(live.sigma_a, 6)}
            <span className="unit">g</span>
          </div>
        </div>
        <div className="status-card">
          <div className="label">Sigma (MPU)</div>
          <div className="value">
            {fmt(live.sigma_m, 6)}
            <span className="unit">g</span>
          </div>
        </div>
        <div className={`status-card ${(live.snr_db ?? 0) > 20 ? "ok" : ""}`}>
          <div className="label">SNR</div>
          <div className="value">
            {fmt(live.snr_db, 1)}
            <span className="unit">dB</span>
          </div>
        </div>
        <div className="status-card">
          <div className="label">Roll</div>
          <div className="value">
            {fmt(live.roll, 2)}
            <span className="unit">deg</span>
          </div>
        </div>
        <div className="status-card">
          <div className="label">Pitch</div>
          <div className="value">
            {fmt(live.pitch, 2)}
            <span className="unit">deg</span>
          </div>
        </div>
      </div>

      <div className="chart-section">
        <h2>PGA History</h2>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={xDomain}
                tick={false}
              />
              <YAxis tick={{ fontSize: 11, fill: "#666" }} />
              <Tooltip
                contentStyle={{ background: "#1a1a2a", border: "1px solid #333", borderRadius: 4 }}
                labelStyle={{ color: "#888" }}
                labelFormatter={(v) => fmtTimeTick(v)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="linear" dataKey="pga_c" stroke="#ef4444" dot={false} isAnimationActive={false} name="PGA" />
              <Line type="linear" dataKey="sigma_f" stroke="#3b82f6" dot={false} isAnimationActive={false} name="Sigma (fused)" />
              <Line type="linear" dataKey="sigma_a" stroke="#22c55e" dot={false} isAnimationActive={false} name="Sigma (ADXL)" />
              <Line type="linear" dataKey="sigma_m" stroke="#f59e0b" dot={false} isAnimationActive={false} name="Sigma (MPU)" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="no-data">Waiting for data...</div>
        )}
      </div>

      <div className="chart-section">
        <h2>Roll / Pitch</h2>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={xDomain}
                tick={false}
              />
              <YAxis tick={{ fontSize: 11, fill: "#666" }} />
              <Tooltip
                contentStyle={{ background: "#1a1a2a", border: "1px solid #333", borderRadius: 4 }}
                labelStyle={{ color: "#888" }}
                labelFormatter={(v) => fmtTimeTick(v)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="linear" dataKey="roll" stroke="#a855f7" dot={false} isAnimationActive={false} name="Roll" />
              <Line type="linear" dataKey="pitch" stroke="#06b6d4" dot={false} isAnimationActive={false} name="Pitch" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="no-data">Waiting for data...</div>
        )}
      </div>

      <div className="alerts-list">
        <h2>Recent Alerts</h2>
        {alerts.length === 0 && <div className="no-data">No alerts yet</div>}
        {alerts.map((a, i) => (
          <div className="alert-item" key={i}>
            <span>
              PGA: <span className="pga">{a.pga?.toFixed(5)}g</span>
              {" "} | SNR: {a.snr_db?.toFixed(1)} dB
            </span>
            <span className="time">{ago(epochMs(a.ts_ms) || epochMs(a.created_at))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
