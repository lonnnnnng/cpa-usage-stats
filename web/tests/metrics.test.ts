import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FORMAT_PREFERENCES } from "../src/lib/format.ts";
import { cacheHitRatePercent, recordLatencyTone } from "../src/lib/metrics.ts";

test("record latency uses the requested green/orange/danger thresholds", () => {
  assert.equal(recordLatencyTone(9_999), "success");
  assert.equal(recordLatencyTone(10_000), "warning");
  assert.equal(recordLatencyTone(59_999), "warning");
  assert.equal(recordLatencyTone(60_000), "danger");
  assert.equal(recordLatencyTone(null), "muted");
});

test("cache hit rate includes cache creation tokens in the prompt denominator", () => {
  assert.equal(cacheHitRatePercent(500, 1_500, 1_000), 50);
  assert.equal(cacheHitRatePercent(0, 0, 0), null);
});

test("display settings default to English compact number units", () => {
  assert.equal(DEFAULT_FORMAT_PREFERENCES.numberStyle, "en-compact");
});
