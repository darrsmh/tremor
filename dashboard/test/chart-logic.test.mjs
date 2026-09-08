import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fmt,
  epochMs,
  normalizeSample,
  decimateForRender,
  breakGaps,
  computeGapMs,
} from "../src/lib/chart-logic.ts";

const ts = (m) => Date.UTC(2026, 0, 1) + m * 1000;

test("fmt handles numbers, numeric strings, and garbage", () => {
  assert.equal(fmt(0.123456), "0.12346");
  assert.equal(fmt("0.5", 2), "0.50");
  assert.equal(fmt(null), "--");
  assert.equal(fmt(undefined), "--");
  assert.equal(fmt("not-a-number"), "--");
  assert.equal(fmt(NaN), "--");
});

test("epochMs accepts plausible epochs, rejects uptime and garbage", () => {
  // 2001..2033 window in ms
  assert.equal(epochMs(Date.UTC(2010, 5, 1)), Date.UTC(2010, 5, 1));
  // device boot uptime (~minutes in ms) must be rejected
  assert.ok(Number.isNaN(epochMs(60000)));
  // far-future garbage (1.78e15 ~ year 56600) must be rejected
  assert.ok(Number.isNaN(epochMs(1.78e15)));
  // ISO string parse
  assert.ok(Number.isFinite(epochMs("2026-01-01T00:00:00.000Z")));
  // non-numeric
  assert.ok(Number.isNaN(epochMs("hello")));
  assert.ok(Number.isNaN(epochMs(undefined)));
});

test("normalizeSample converts BIGINT ts strings back to numbers", () => {
  const s = normalizeSample({
    ts: String(Date.UTC(2026, 0, 1)),
    pga_c: "0.00123",
    sigma_f: "0.0009",
    sigma_a: "0.001",
    sigma_m: "0.0012",
    snr_db: "13.7",
    roll: "1.25",
    pitch: "-0.4",
  });
  assert.ok(s !== null);
  assert.equal(s.ts, Date.UTC(2026, 0, 1));
  assert.equal(s.pga_c, 0.00123);
  assert.equal(s.snr_db, 13.7);
  assert.equal(s.roll, 1.25);
  assert.equal(s.pitch, -0.4);
});

test("normalizeSample drops boot-uptime and garbage timestamps", () => {
  assert.equal(normalizeSample({ ts: 12345 }), null);
  assert.equal(normalizeSample({ ts: 1.78e15 }), null);
  assert.equal(normalizeSample({ ts: "not-a-number" }), null);
  assert.equal(normalizeSample({ ts: null }), null);
  assert.equal(normalizeSample({ ts: undefined }), null);
});

test("normalizeSample maps null/empty metric fields to NaN", () => {
  const s = normalizeSample({ ts: Date.UTC(2026, 0, 1), pga_c: "", sigma_f: null });
  assert.ok(s !== null);
  assert.ok(Number.isNaN(s.pga_c));
  assert.ok(Number.isNaN(s.sigma_f));
});

test("decimateForRender returns input unchanged for empty/bad input", () => {
  assert.deepEqual(decimateForRender([], 1000), []);
  const one = { ts: 1, pga_c: 1, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 };
  assert.deepEqual(decimateForRender([one], 0), [one]);
});

test("decimateForRender keeps min and max PGA per bucket, preserves spikes", () => {
  const rows = [];
  const base = Date.UTC(2026, 0, 1);
  // 5 samples in bucket 0 (bucketMs=1000 → one bucket)
  rows.push({ ts: base, pga_c: 0.5, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 });
  rows.push({ ts: base + 200, pga_c: 0.9, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 });
  rows.push({ ts: base + 400, pga_c: 0.02, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 });
  rows.push({ ts: base + 600, pga_c: 0.7, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 });
  rows.push({ ts: base + 800, pga_c: 0.1, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 });

  const out = decimateForRender(rows, 1000);
  assert.equal(out.length, 2);
  assert.equal(out[0].pga_c, 0.9); // max (ts earlier) first — spike survives
  assert.equal(out[1].pga_c, 0.02); // min (ts later)
});

test("decimateForRender is stable across repeated calls (no reshuffle)", () => {
  const base = Date.UTC(2026, 0, 1);
  const mk = (i) => ({
    ts: base + i * 100,
    pga_c: 0.1 + ((i * 37) % 10) / 100,
    sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0,
  });
  const rows = Array.from({ length: 1200 }, (_, i) => mk(i));
  const a = decimateForRender(rows, 500);
  const b = decimateForRender(rows, 500);
  assert.deepEqual(a, b);
});

test("decimateForRender caps points to ~2 per bucket", () => {
  const base = Date.UTC(2026, 0, 1);
  const rows = Array.from({ length: 1200 }, (_, i) => ({
    ts: base + i * 10,
    pga_c: Math.sin(i / 50) * 0.1 + 0.1,
    sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0,
  }));
  const buckets = 600; // bucketMs = (window/600) typical
  const out = decimateForRender(rows, 500);
  assert.ok(out.length <= 1200, `expected <=1200, got ${out.length}`);
});

const mkSample = (ts, pga = 0.05) => ({
  ts, pga_c: pga, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0,
});

test("breakGaps leaves a healthy continuous stream untouched", () => {
  const base = Date.UTC(2026, 0, 1);
  const rows = Array.from({ length: 100 }, (_, i) => mkSample(base + i * 5));
  const out = breakGaps(rows, 1000);
  assert.equal(out.length, rows.length);
});

test("breakGaps inserts one null bridge across a large gap", () => {
  const base = Date.UTC(2026, 0, 1);
  const rows = [mkSample(base, 0.1), mkSample(base + 2000, 0.2), mkSample(base + 2005, 0.21)];
  const out = breakGaps(rows, 1000);
  assert.equal(out.length, 4); // 3 rows + 1 bridge
  const bridge = out.find((r) => r.pga_c === null);
  assert.ok(bridge, "expected a null-bridge row");
  assert.ok(bridge.ts > base && bridge.ts < base + 2000, "bridge sits inside the gap");
  assert.equal(bridge.sigma_f, null);
  assert.equal(bridge.roll, null);
});

test("breakGaps does not bridge historic uptime-vs-epoch or boot-jump transitions blindly", () => {
  const base = Date.UTC(2026, 0, 1);
  const rows = [mkSample(base, 1), mkSample(base + 100000, 2)]; // 100s gap
  assert.equal(breakGaps(rows, 1000).length, 3);
});

test("breakGaps returns input unchanged for empty or single rows", () => {
  assert.deepEqual(breakGaps([], 100), []);
  const one = mkSample(Date.UTC(2026, 0, 1));
  assert.deepEqual(breakGaps([one], 100), [one]);
});

test("computeGapMs never drops below 1s and scales with bucket width", () => {
  assert.equal(computeGapMs(50), 1000); // 30s window → 50ms buckets
  assert.equal(computeGapMs(200), 1000); // 2m window
  assert.equal(computeGapMs(500), 1500); // 5m window
});