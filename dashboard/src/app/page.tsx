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

// Largest-Triangle-Three-Buckets downsampling. Keeps points in temporal order
// and preserves spikes while dropping to ~maxPoints, unlike min/max pairs
// (which zigzag within each time slice and rendered as a jagged sawtooth) or
// plain averaging (which smears spikes). Also lightens the SVG path so the
// chart paints smoothly.
function decimateForRender(rows: Sample[], threshold: number): Sample[] {
  const n = rows.length;
  if (threshold <= 0 || threshold >= n) return rows;
  const sampled: Sample[] = [];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  sampled.push(rows[a]);

  const tsOf = (i: number) => rows[i].ts;
  const yOf = (i: number) => rows[i].pga_c;

  for (let i = 0; i < threshold - 2; i++) {
    const avgRangeStart = Math.floor((i + 1) * every) + 1;
    const avgRangeEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    const len = avgRangeEnd - avgRangeStart;
    for (let j = avgRangeStart; j < avgRangeEnd; j++) {
      avgX += tsOf(j);
      avgY += yOf(j);
    }
    avgX /= len;
    avgY /= len;

    const rangeOffs = Math.max(Math.floor(i * every) + 1, 0);
    const rangeTo = Math.max(Math.floor((i + 1) * every) + 1, 0);
    const ax = tsOf(a);
    const ay = yOf(a);
    let maxArea = -1;
    let maxAreaPoint = a;
    for (let j = rangeOffs; j < rangeTo; j++) {
      const area = Math.abs((ax - avgX) * (yOf(j) - ay) - (ax - tsOf(j)) * (avgY - ay)) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        maxAreaPoint = j;
      }
    }
    sampled.push(rows[maxAreaPoint]);
    a = maxAreaPoint;
  }

  sampled.push(rows[n - 1]);
  return sampled;
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
      // Append realtime rows in all window modes — the periodic poll will
      // replace with properly decimated data; raw rows between polls are
      // negligible and keep the graph visibly streaming.
      setHistory((prev) => {
        const next = [...prev, ...batch];
        return next.length > 6000 ? next.slice(-6000) : next;
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
        if (clean.length > 0) setHistory(clean);
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

  // Render-decimate to ≤1200 points (defends paint cost) and memoize; the
  // X-axis uses numeric ts (recharts `scale="time"`) so there's no per-point
  // toLocaleTimeString work on every render.
  const chartData = useMemo(
    () => decimateForRender(history, 1200),
    [history]
  );

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
                domain={["dataMin", "dataMax"]}
                tick={false}
              />
              <YAxis tick={{ fontSize: 11, fill: "#666" }} />
              <Tooltip
                contentStyle={{ background: "#1a1a2a", border: "1px solid #333", borderRadius: 4 }}
                labelStyle={{ color: "#888" }}
                labelFormatter={(v) => fmtTimeTick(v)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="pga_c" stroke="#ef4444" dot={false} isAnimationActive={false} name="PGA" />
              <Line type="monotone" dataKey="sigma_f" stroke="#3b82f6" dot={false} isAnimationActive={false} name="Sigma (fused)" />
              <Line type="monotone" dataKey="sigma_a" stroke="#22c55e" dot={false} isAnimationActive={false} name="Sigma (ADXL)" />
              <Line type="monotone" dataKey="sigma_m" stroke="#f59e0b" dot={false} isAnimationActive={false} name="Sigma (MPU)" />
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
                domain={["dataMin", "dataMax"]}
                tick={false}
              />
              <YAxis tick={{ fontSize: 11, fill: "#666" }} />
              <Tooltip
                contentStyle={{ background: "#1a1a2a", border: "1px solid #333", borderRadius: 4 }}
                labelStyle={{ color: "#888" }}
                labelFormatter={(v) => fmtTimeTick(v)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="roll" stroke="#a855f7" dot={false} isAnimationActive={false} name="Roll" />
              <Line type="monotone" dataKey="pitch" stroke="#06b6d4" dot={false} isAnimationActive={false} name="Pitch" />
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
