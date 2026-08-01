import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalJson,
  NonJsonValueError,
  toCanonicalJsonValue,
} from "./canonical-json.ts";

test("canonical JSON survives jsonb-style object key reordering", () => {
  const published = {
    format: "openbooks.close-binder.v1",
    run: { status: "published", id: "run-1" },
    tasks: [{ sortOrder: 2, key: "publish" }, { sortOrder: 1, key: "review" }],
  };
  const downloaded = {
    tasks: [{ key: "publish", sortOrder: 2 }, { key: "review", sortOrder: 1 }],
    run: { id: "run-1", status: "published" },
    format: "openbooks.close-binder.v1",
  };
  const hash = (value: unknown) =>
    createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
  assert.equal(hash(published), hash(downloaded));
});

test("canonical JSON preserves arrays and normalizes dates and bigint", () => {
  assert.deepEqual(
    toCanonicalJsonValue({
      values: [2n, 1n],
      at: new Date("2026-07-31T12:00:00.000Z"),
      omitted: undefined,
    }),
    {
      at: "2026-07-31T12:00:00.000Z",
      values: ["2", "1"],
    },
  );
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("canonical JSON rejects unsafe values", () => {
  assert.throws(() => canonicalJson({ amount: Number.NaN }), NonJsonValueError);
  assert.throws(() => canonicalJson({ handler: () => undefined }), NonJsonValueError);
});
