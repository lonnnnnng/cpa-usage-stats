import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FORMAT_PREFERENCES } from "../src/lib/format.ts";
import { cacheHitRatePercent, classifyRequestProtocol, recordLatencyTone } from "../src/lib/metrics.ts";

test("record latency uses the requested green/orange/danger thresholds", () => {
  assert.equal(recordLatencyTone(9_999), "success");
  assert.equal(recordLatencyTone(10_000), "warning");
  assert.equal(recordLatencyTone(59_999), "warning");
  assert.equal(recordLatencyTone(60_000), "danger");
  assert.equal(recordLatencyTone(null), "muted");
});

test("cache hit rate uses OpenAI subset and Anthropic independent semantics", () => {
  assert.equal(cacheHitRatePercent(1_000, 300, 100, "openai"), 30);
  assert.equal(cacheHitRatePercent(100, 300, 100, "anthropic"), 60);
  assert.equal(cacheHitRatePercent(0, 0, 0), null);
});

test("display settings default to English compact number units", () => {
  assert.equal(DEFAULT_FORMAT_PREFERENCES.numberStyle, "en-compact");
});

test("protocol labels expose provider family without inventing an inbound path", () => {
  assert.equal(classifyRequestProtocol("anthropic"), "anthropic_messages");
  assert.equal(classifyRequestProtocol("openai"), "openai_unknown");
});
