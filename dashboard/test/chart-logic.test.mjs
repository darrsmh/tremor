import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fmt,
  epochMs,
  normalizeSample,
  decimateOne,
  breakGaps,
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

test("decimateOne returns input unchanged for empty/bad input", () => {
  assert.deepEqual(decimateOne([], 1000), []);
  const one = { ts: 1, pga_c: 1, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 };
  assert.deepEqual(decimateOne([one], 0), [one]);
  assert.deepEqual(decimateOne([one], 1000), [one]);
});

test("decimateOne keeps exactly one real sample per bucket", () => {
  const base = Date.UTC(2026, 0, 1);
  const rows = [];
  // 5 samples spread across bucket 0 (bucketMs=1000 → all share bucket 0)
  rows.push({ ts: base + 100, pga_c: 0.5, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 });
  rows.push({ ts: base + 300, pga_c: 0.9, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 });
  rows.push({ ts: base + 400, pga_c: 0.02, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 });
  rows.push({ ts: base + 600, pga_c: 0.7, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 });
  rows.push({ ts: base + 900, pga_c: 0.1, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 });

  const out = decimateOne(rows, 1000);
  assert.equal(out.length, 1);
  // bucket 0 center = 500ms → the 400ms row is closest and must be kept as-is
  assert.equal(out[0].ts, base + 400);
  assert.equal(out[0].pga_c, 0.02);
});

test("decimateOne spans multiple buckets in ascending ts order", () => {
  const base = Date.UTC(2026, 0, 1);
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({ ts: base + i * 250, pga_c: i / 100, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0 });
  }
  const out = decimateOne(rows, 1000); // 250ms spacing → 4 samples/bucket
  assert.equal(out.length, 5); // buckets [0,1000)..[4000,5000)
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].ts > out[i - 1].ts, "output sorted ascending by ts");
  }
});

test("decimateOne never invents data — every output row exists in the input", () => {
  const base = Date.UTC(2026, 0, 1);
  const rows = Array.from({ length: 1200 }, (_, i) => ({
    ts: base + i * 10,
    pga_c: Math.sin(i / 50) * 0.1 + 0.1,
    sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0,
  }));
  const out = decimateOne(rows, 500);
  const inSet = new Set(rows.map((r) => r.ts));
  assert.ok(out.length >= 2 && out.length <= rows.length, `out length ${out.length}`);
  for (const r of out) {
    assert.ok(inSet.has(r.ts), `output ts ${r.ts} not an actual input sample`);
  }
});

test("decimateOne is stable and caps to 1 point per bucket", () => {
  const base = Date.UTC(2026, 0, 1);
  const rows = Array.from({ length: 1200 }, (_, i) => ({
    ts: base + i * 10,
    pga_c: Math.sin(i / 50) * 0.1 + 0.1,
    sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0,
  }));
  const a = decimateOne(rows, 500);
  const b = decimateOne(rows, 500);
  assert.deepEqual(a, b);
  assert.ok(a.length <= 1200, `expected <=1200 points, got ${a.length}`);
});

const mkSample = (ts, pga = 0.05) => ({
  ts, pga_c: pga, sigma_f: 0, sigma_a: 0, sigma_m: 0, snr_db: 0, roll: 0, pitch: 0,
});

test("breakGaps leaves a healthy continuous stream untouched", () => {
  const base = Date.UTC(2026, 0, 1);
  const rows = Array.from({ length: 1000 }, (_, i) => mkSample(base + i * 5)); // 200Hz-style
  const out = breakGaps(rows, 2000);
  assert.equal(out.length, rows.length);
});

test("breakGaps inserts exactly one null bridge across a real gap", () => {
  const base = Date.UTC(2026, 0, 1);
  const rows = [mkSample(base, 0.1), mkSample(base + 500, 0.2), mkSample(base + 30000, 0.21)];
  const out = breakGaps(rows, 2000);
  assert.equal(out.length, 4); // 3 rows + 1 bridge
  const bridge = out.find((r) => r.pga_c === null);
  assert.ok(bridge, "expected a null-bridge row");
  assert.ok(bridge.ts > base + 500 && bridge.ts < base + 30000, "bridge sits inside the gap");
  assert.equal(bridge.sigma_f, null);
  assert.equal(bridge.roll, null);
});

test("breakGaps tolerates a modest delivery delay (no break on batch gaps)", () => {
  const base = Date.UTC(2026, 0, 1);
  const rows = [mkSample(base), mkSample(base + 1800)]; // under GAP_MS
  assert.equal(breakGaps(rows, 2000).length, 2);
});

test("breakGaps returns input unchanged for empty or single rows", () => {
  assert.deepEqual(breakGaps([], 2000), []);
  const one = mkSample(Date.UTC(2026, 0, 1));
  assert.deepEqual(breakGaps([one], 2000), [one]);
});