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
import {
  type Sample,
  fmt,
  epochMs,
  ago,
  fmtTimeTick,
  normalizeSample,
  decimateOne,
  breakGaps,
} from "@/lib/chart-logic";

// The graph always shows this fixed rolling window (seconds). One minute gives
// a dense live trace (~12k raw samples at 200 Hz) while still fitting the
// decimated render budget, and avoids the plateau/stale look of longer views.
const WINDOW_SEC = 60;

// A render point must fall this far past its predecessor before we treat it
// as a real data gap. Decimated points sit ~bucketMs (50ms here) apart, so
// normal streaming -- even slow WiFi/Realtime delivery -- never trips this.
// 8s keeps the graph continuous through short WiFi/ring-buffer hiccups and only
// breaks for genuine long outages (reboot, NTP re-arm, radio down), so a brief
// stall doesn't chop the line into chunks.
const GAP_MS = 8000;

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
  last_alert_snr?: number;
}

interface Alert {
  pga: number;
  ts_ms: number;
  snr_db: number;
  sigma_fused: number;
  created_at?: string;
}

export default function Dashboard() {
  const [live, setLive] = useState<Live>({});
  const [history, setHistory] = useState<Sample[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);

  // Incoming Realtime sample rows are buffered and flushed a few times per
  // second so the charts don't re-render on every single insert (~200/sec).
  const pendingRef = useRef<Sample[]>([]);
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
    // 200ms (~5fps scroll). A tick only moves the X-domain; the decimated
    // series is stable, so this stays cheap even at this rate. 100ms caused
    // the chart to redraw its (now denser) paths needlessly often.
    const heartbeat = setInterval(() => setNowTick(Date.now()), 200);
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
        // longer views, visibly emptying the left side of the chart between
        // polls. Keep enough rows to cover the window with headroom; the
        // render path decimates to a point budget anyway.
        const cap = Math.min(Math.max(WINDOW_SEC * 400, 6000), 20000);
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

  // History window: the live tail is fine-grained 200 Hz data served raw via
  // Realtime; the periodic poll re-seeds full-resolution rows so a reload or a
  // Realtime hiccup never leaves the chart sparse.
  useEffect(() => {
    let mounted = true;

    const refresh = async () => {
      try {
        const h = await fetch(`/api/live/history?count=6000&window=${WINDOW_SEC}`, {
          cache: "no-store",
        }).then((r) => r.json());
        if (!mounted || !Array.isArray(h)) return;
        const clean = h
          .map((r) => normalizeSample(r as Record<string, unknown>))
          .filter((x): x is Sample => x !== null);
        // NEVER erase the graph on an empty poll. A window query legitimately
        // returns [] when the radio has been silent longer than the window;
        // wiping here replaced good data with a blank "Waiting for data..."
        // chart on every poll (the frozen-graph bug). Instead, only adopt
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
            const cap = Math.min(Math.max(WINDOW_SEC * 400, 6000), 20000);
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

    // Re-seed roughly every 30s — a 1-minute view refreshed at that cadence
    // still looks live while skipping DDoS-y hammering of the fetch.
    const slowPoll = setInterval(refresh, 30000);

    return () => {
      mounted = false;
      clearInterval(slowPoll);
    };
  }, []);

  // Data-clock now: the newest sample DEVICE timestamp extrapolated forward
  // by real elapsed time (a Date.now() difference, so any PC clock offset
  // cancels out). The device clock runs tens of seconds behind server real
  // time (measured: server receive time minus device ts was 20-55s), so
  // anchoring the window to Date.now() pushed the newest samples outside the
  // viewport and only a portion of the graph showed. Anchoring to the data
  // timeline keeps the window full while data streams and keeps scrolling
  // smoothly between batches.
  //
  // The extrapolation is CLAMPED (extrapLimitMs): Date.now() keeps growing
  // during a stall or a backgrounded tab, so without a cap the axis would race
  // ahead of the data and then yank backwards the moment samples resume. With
  // the cap, the axis coasts up to extrapLimit past the newest sample and then
  // holds a stable view (old data + flat stale tail) until fresh samples jump
  // it forward again. lastDataRef.ts is only ever updated to a NEWER sample
  // (forward-only), so dataNow never moves backwards.
  const extrapLimitMs = Math.max(WINDOW_SEC * 1000, 30000);
  const dataNow = lastDataRef.current
    ? lastDataRef.current.ts + Math.min(Math.max(nowTick - lastDataRef.current.at, 0), extrapLimitMs)
    : nowTick;

  // X window: [dataNow - window, dataNow] on the device own timeline.
  const xDomain = useMemo<[number, number]>(
    () => [dataNow - WINDOW_SEC * 1000, dataNow],
    [dataNow]
  );

  // Keep only samples inside the visible data-clock window (so the Y-axis
  // scales to what is actually visible), then decimate to ONE real sample per
  // ~50ms bucket (~1200 plotted points). Both passes are a single cheap O(n)
  // sweep with NO point reshuffling between ticks. Delayed batches render at
  // their true acquisition timestamps, so a send-gap fills in honestly.
  //
  // breakGaps then cuts the polyline wherever the device actually STOPPED
  // acquiring (GAP_MS apart) — a long outage, reboot, or NTP re-arm no longer
  // draws a diagonal/ramp across the silent period; it renders as a true break.
  //
  // Finally a synthetic row is stamped at dataNow carrying the newest visible
  // sample's values, so the line holds FLAT (rather than stopping) during a
  // quiet period — clearly showing the last recorded level with no ramp. When
  // samples resume after a real gap, the break is preserved and the line
  // continues from the new data instead of bridging the silence.
  const chartData = useMemo(() => {
    const windowStart = dataNow - WINDOW_SEC * 1000;
    const bucketMs = (WINDOW_SEC * 1000) / 1200;
    const filtered = history.filter((d) => d.ts >= windowStart && d.ts <= dataNow);
    const broken = breakGaps(decimateOne(filtered, bucketMs), GAP_MS);
    const last = filtered[filtered.length - 1] ?? history[history.length - 1];
    return last ? [...broken, { ...last, ts: dataNow }] : broken;
  }, [history, dataNow]);

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

  // Pre-anchor boot state: before the very first sample anchors the data clock
  // (via the initial history poll or the first realtime batch) there is nothing
  // to draw, and rendering an empty chart against the browser-clock fallback
  // just looks broken. Show a stable placeholder instead.
  const awaitingFirst = !lastDataRef.current;

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
              <Line type="linear" dataKey="pga_c" stroke="#ef4444" dot={false} isAnimationActive={false} connectNulls={false} name="PGA" />
              <Line type="linear" dataKey="sigma_f" stroke="#3b82f6" dot={false} isAnimationActive={false} connectNulls={false} name="Sigma (fused)" />
              <Line type="linear" dataKey="sigma_a" stroke="#22c55e" dot={false} isAnimationActive={false} connectNulls={false} name="Sigma (ADXL)" />
              <Line type="linear" dataKey="sigma_m" stroke="#f59e0b" dot={false} isAnimationActive={false} connectNulls={false} name="Sigma (MPU)" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="no-data">
            {awaitingFirst ? "Waiting for first samples..." : "Waiting for data..."}
          </div>
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
              <Line type="linear" dataKey="roll" stroke="#a855f7" dot={false} isAnimationActive={false} connectNulls={false} name="Roll" />
              <Line type="linear" dataKey="pitch" stroke="#06b6d4" dot={false} isAnimationActive={false} connectNulls={false} name="Pitch" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="no-data">
            {awaitingFirst ? "Waiting for first samples..." : "Waiting for data..."}
          </div>
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
