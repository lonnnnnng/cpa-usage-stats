import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatBucket,
  formatDateTime,
  formatDateTimeFull,
  formatDisplayDateKey,
  parseBackendTimestamp,
} from "../src/lib/utils.ts";

test("converts RFC3339 UTC records to UTC+8", () => {
  assert.equal(formatDateTime("2026-10-24T06:12:34.000Z"), "10-24 14:12:34");
  assert.equal(formatDateTimeFull("2026-10-24T06:12:34.000Z"), "2026-10-24 14:12:34");
});

test("treats legacy zone-less storage timestamps as UTC", () => {
  assert.equal(formatDateTime("2026-10-24 23:30:00.000"), "10-25 07:30:00");
});

test("does not add UTC+8 twice to offset timestamps", () => {
  assert.equal(formatDateTime("2026-10-24T14:12:34+08:00"), "10-24 14:12:34");
});

test("converts hourly and daily trend buckets", () => {
  assert.equal(formatBucket("2026-10-24 23", true), "07:00");
  assert.equal(formatBucket("2026-10-24", false), "10-24");
});

test("rejects invalid timestamps and preserves the display calendar date", () => {
  assert.equal(formatDateTime("not-a-time"), "-");
  const date = parseBackendTimestamp("2026-10-24T23:30:00Z");
  assert.ok(date);
  assert.equal(formatDisplayDateKey(date), "2026-10-25");
});
