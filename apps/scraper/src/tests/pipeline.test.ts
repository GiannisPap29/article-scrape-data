import assert from "node:assert/strict";
import { test } from "node:test";
import { computeNextRetryAt } from "../scraper/pipeline.js";

test("retry backoff doubles from 15 minutes and caps at 12 hours", () => {
  const minutesFromNow = (attempts: number) => Math.round((Date.parse(computeNextRetryAt(attempts)) - Date.now()) / 60_000);
  assert.equal(minutesFromNow(1), 15);
  assert.equal(minutesFromNow(2), 30);
  assert.equal(minutesFromNow(3), 60);
  assert.equal(minutesFromNow(10), 12 * 60);
});
