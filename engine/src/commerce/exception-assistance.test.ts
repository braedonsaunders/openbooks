import assert from "node:assert/strict";
import test from "node:test";
import {
  exceptionGroupKey,
  normalizeExceptionSku,
  skuMatchScore,
  titleMatchScore,
} from "./exception-assistance.ts";

test("normalizeExceptionSku folds case and separators deterministically", () => {
  assert.equal(normalizeExceptionSku("  tee-RED_m "), "TEEREDM");
  assert.equal(normalizeExceptionSku("MUG WHITE"), "MUGWHITE");
  assert.equal(normalizeExceptionSku(""), null);
  assert.equal(normalizeExceptionSku(null), null);
});

test("skuMatchScore ranks exact above normalized above partial", () => {
  const exact = skuMatchScore("TEE-RED-M", "tee-red-m");
  const normalized = skuMatchScore("TEE-RED-M", "TEEREDM");
  const partial = skuMatchScore("TEE-RED-M", "TEE-RED-L");
  const unrelated = skuMatchScore("TEE-RED-M", "MUG-WHITE");
  assert.equal(exact.score, 100);
  assert.equal(normalized.score, 90);
  assert.ok(partial.score > unrelated.score);
  assert.ok(partial.score < 90);
  assert.deepEqual(skuMatchScore("TEE-RED-M", "tee-red-m"), exact);
  assert.ok(exact.signals.length > 0);
});

test("titleMatchScore ranks shared words above disjoint titles", () => {
  const close = titleMatchScore("Red Tee — M", "Red Tee Large");
  const far = titleMatchScore("Red Tee — M", "White Ceramic Mug");
  assert.ok(close.score > far.score);
  assert.equal(far.score, 0);
  assert.deepEqual(titleMatchScore("Red Tee — M", "Red Tee Large"), close);
});

test("exceptionGroupKey pins similar orders to one stable key", () => {
  assert.equal(
    exceptionGroupKey("unmapped_item", { sku: " nope-404 " }),
    "unmapped_item:sku:NOPE-404",
  );
  assert.equal(
    exceptionGroupKey("unmapped_account", { gateway: "Walley Pay" }),
    "unmapped_account:gateway:walley pay",
  );
  assert.equal(
    exceptionGroupKey("tax_mismatch", { jurisdiction: " ny " }),
    "tax_mismatch:jurisdiction:NY",
  );
  assert.equal(exceptionGroupKey("closed_period", {}), "closed_period");
});
