"use client";

import { useEffect, useState, useRef } from "react";
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

// Supabase Realtime serializes BIGINT columns (like `ts`) as JSON strings to
// avoid precision loss > 2^53. Normalize them back to numbers so the chart
// X-axis, `new Date(ts)`, and the online check all receive numeric ms.
function normalizeSample(row: Record<string, unknown>): Sample {
  const toNum = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  return {
    node_id: (row.node_id as string) ?? undefined,
    ts: toNum(row.ts),
    pga_c: toNum(row.pga_c),
    sigma_f: toNum(row.sigma_f),
    sigma_a: toNum(row.sigma_a),
    sigma_m: toNum(row.sigma_m),
    snr_db: toNum(row.snr_db),
    roll: toNum(row.roll),
    pitch: toNum(row.pitch),
  };
}

export default function Dashboard() {
  const [live, setLive] = useState<Live>({});
  const [history, setHistory] = useState<Sample[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);

  // Incoming Realtime sample rows are buffered and flushed a few times per
  // second so the charts don't re-render on every single insert (~200/sec).
  const pendingRef = useRef<Sample[]>([]);

  useEffect(() => {
    let mounted = true;

    const loadInitial = async () => {
      try {
        const [h, a, l] = await Promise.all([
          fetch("/api/live/history?count=6000", { cache: "no-store" }).then((r) => r.json()),
          fetch("/api/alerts", { cache: "no-store" }).then((r) => r.json()),
          fetch("/api/live", { cache: "no-store" }).then((r) => r.json()),
        ]);
        if (!mounted) return;
        if (Array.isArray(h)) setHistory(h.map((r) => normalizeSample(r)));
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
          pendingRef.current.push(normalizeSample(payload.new as Record<string, unknown>));
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

    // Flush buffered samples ~5x/sec. Each flush is ONE setState, so the
    // graph redraws smoothly without re-rendering per inserted row.
    const flush = setInterval(() => {
      const batch = pendingRef.current;
      if (!batch.length) return;
      pendingRef.current = [];
      const latest = batch[batch.length - 1];
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
    }, 200);

    // Reconnect fell off the Realtime stream: a slow poll keeps the dashboard
    // honest without the churn of a fast poll.
    const slowPoll = setInterval(() => {
      fetch("/api/live/history?count=6000", { cache: "no-store" })
        .then((r) => r.json())
        .then((h) => mounted && Array.isArray(h) && setHistory(h.map((r) => normalizeSample(r))))
        .catch(() => {});
    }, 20000);

    return () => {
      mounted = false;
      supabase.removeChannel(sampleChannel);
      supabase.removeChannel(alertChannel);
      clearInterval(flush);
      clearInterval(slowPoll);
    };
  }, []);

  const chartData = history.map((s) => ({
    ...s,
    time: new Date(s.ts).toLocaleTimeString("en-US", {
      timeZone: "Asia/Manila",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  }));

  // Online if the latest live timestamp is recent, else fall back to the
  // newest history sample. Averaged against server ingestion time so a stale
  // /api/live row doesn't falsely show OFFLINE while data is flowing.
  let online = false;
  const lastLiveTs = live.ts ?? history[history.length - 1]?.ts;
  if (lastLiveTs && lastLiveTs > 1000000000000) {
    online = Date.now() - lastLiveTs < 30000;
  } else if (live.updated_at) {
    online = Date.now() - new Date(live.updated_at).getTime() < 30000;
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
        {live.ts
          ? new Date(Number(live.ts)).toLocaleTimeString("en-US", {
              timeZone: "Asia/Manila",
              hour12: false,
            })
          : "never"}{" "}
        (PH)
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
              <XAxis dataKey="time" tick={{ fontSize: 11, fill: "#666" }} />
              <YAxis tick={{ fontSize: 11, fill: "#666" }} />
              <Tooltip
                contentStyle={{ background: "#1a1a2a", border: "1px solid #333", borderRadius: 4 }}
                labelStyle={{ color: "#888" }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="pga_c" stroke="#ef4444" dot={false} name="PGA" />
              <Line type="monotone" dataKey="sigma_f" stroke="#3b82f6" dot={false} name="Sigma (fused)" />
              <Line type="monotone" dataKey="sigma_a" stroke="#22c55e" dot={false} name="Sigma (ADXL)" />
              <Line type="monotone" dataKey="sigma_m" stroke="#f59e0b" dot={false} name="Sigma (MPU)" />
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
              <XAxis dataKey="time" tick={{ fontSize: 11, fill: "#666" }} />
              <YAxis tick={{ fontSize: 11, fill: "#666" }} />
              <Tooltip
                contentStyle={{ background: "#1a1a2a", border: "1px solid #333", borderRadius: 4 }}
                labelStyle={{ color: "#888" }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="roll" stroke="#a855f7" dot={false} name="Roll" />
              <Line type="monotone" dataKey="pitch" stroke="#06b6d4" dot={false} name="Pitch" />
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
