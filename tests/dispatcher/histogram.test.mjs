import test from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyHistogram,
  recordLatency,
  mergeHistograms,
  calculatePercentiles,
  parseHistogram,
} from "../../src/lib/dispatcher/histogram.js";

test("histogram records values into logarithmic bins correctly", () => {
  const h = createEmptyHistogram();
  assert.equal(h.length, 16);

  recordLatency(h, 5); // bin 0 (<= 10)
  recordLatency(h, 15); // bin 1 (<= 25)
  recordLatency(h, 200); // bin 4 (<= 250)
  recordLatency(h, 1500); // bin 7 (<= 2000)
  recordLatency(h, 450000); // overflow bin 15 (> 300000)

  assert.equal(h[0], 1);
  assert.equal(h[1], 1);
  assert.equal(h[4], 1);
  assert.equal(h[7], 1);
  assert.equal(h[15], 1);
});

test("histogram computes accurate percentiles without distortion", () => {
  const h = createEmptyHistogram();

  // 90 items at 80ms (bucket <= 100ms)
  for (let i = 0; i < 90; i++) {
    recordLatency(h, 80);
  }
  // 10 items at 3,500ms (bucket <= 4000ms)
  for (let i = 0; i < 10; i++) {
    recordLatency(h, 3500);
  }

  const p = calculatePercentiles(h, [50, 90, 95, 99]);
  assert.equal(p.p50, 100);
  assert.equal(p.p90, 100);
  assert.equal(p.p95, 4000);
  assert.equal(p.p99, 4000);
  assert.equal(p.max, 4000);
});

test("histogram merging is algebraic and associative", () => {
  const h1 = createEmptyHistogram();
  const h2 = createEmptyHistogram();

  recordLatency(h1, 50);
  recordLatency(h2, 500);

  const merged = mergeHistograms(createEmptyHistogram(), h1);
  mergeHistograms(merged, h2);

  assert.equal(merged[2], 1); // <= 50ms
  assert.equal(merged[5], 1); // <= 500ms
  assert.equal(calculatePercentiles(merged, [50]).p50, 50);
  assert.equal(calculatePercentiles(merged, [100]).p100, 500);
});

test("parseHistogram handles JSON and raw arrays safely", () => {
  const raw = [1, 2, 3];
  const parsed = parseHistogram(raw);
  assert.equal(parsed.length, 16);
  assert.equal(parsed[0], 1);
  assert.equal(parsed[1], 2);
  assert.equal(parsed[2], 3);

  const jsonStr = JSON.stringify(parsed);
  const parsedJson = parseHistogram(jsonStr);
  assert.deepEqual(parsedJson, parsed);

  assert.deepEqual(parseHistogram("invalid json"), createEmptyHistogram());
});
