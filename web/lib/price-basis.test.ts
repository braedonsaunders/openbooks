import assert from "node:assert/strict";
import test from "node:test";

import { basisForResolvedRow, parsePriceBasis } from "./price-basis.ts";

const IDS = {
  scheduleId: "11111111-1111-1111-1111-111111111111",
  levelId: "22222222-2222-2222-2222-222222222222",
  assignmentId: "33333333-3333-3333-3333-333333333333",
} as const;

test("a complete customer_level basis parses and normalizes", () => {
  const parsed = parsePriceBasis({
    kind: "customer_level",
    ...IDS,
    unitPrice: "100.0000",
    resolvedAt: "2026-09-24T10:00:00.000Z",
    extra: "ignored",
  });
  assert.ok(parsed !== null && !("error" in parsed));
  assert.equal(parsed.kind, "customer_level");
  assert.equal(parsed.unitPrice, "100");
  assert.equal(parsed.assignmentId, IDS.assignmentId);
});

test("a null basis means hand-priced", () => {
  assert.equal(parsePriceBasis(null), null);
  assert.equal(parsePriceBasis(undefined), null);
});

test("lineage the kind cannot resolve from is refused", () => {
  for (const raw of [
    { kind: "gold", ...IDS, unitPrice: "100", resolvedAt: "2026-09-24T10:00:00.000Z" },
    { kind: "customer_level", scheduleId: IDS.scheduleId, levelId: null, assignmentId: IDS.assignmentId, unitPrice: "100", resolvedAt: "2026-09-24T10:00:00.000Z" },
    { kind: "customer_level", scheduleId: IDS.scheduleId, levelId: IDS.levelId, assignmentId: "not-a-uuid", unitPrice: "100", resolvedAt: "2026-09-24T10:00:00.000Z" },
    { kind: "base_level", scheduleId: null, levelId: IDS.levelId, assignmentId: null, unitPrice: "80", resolvedAt: "2026-09-24T10:00:00.000Z" },
    { kind: "base_level", scheduleId: IDS.scheduleId, levelId: IDS.levelId, assignmentId: null, unitPrice: "not-a-number", resolvedAt: "2026-09-24T10:00:00.000Z" },
    { kind: "simple", scheduleId: null, levelId: null, assignmentId: null, unitPrice: "50", resolvedAt: "yesterday" },
    "customer_level",
    ["customer_level"],
  ]) {
    const parsed = parsePriceBasis(raw);
    assert.ok(parsed !== null && "error" in parsed, `must refuse ${JSON.stringify(raw)}`);
  }
});

test("the drawer echoes a basis only for the price it resolved", () => {
  const basis = {
    kind: "customer_level" as const, scheduleId: IDS.scheduleId, levelId: IDS.levelId,
    assignmentId: IDS.assignmentId, unitPrice: "100", resolvedAt: "2026-09-24T10:00:00.000Z",
  };
  const row = { itemId: "item-1", unitPrice: "100" };
  assert.equal(
    basisForResolvedRow({ row, resolved: { itemId: "item-1", unitPrice: "100", basis } }),
    basis,
  );
  assert.equal(basisForResolvedRow({ row, resolved: undefined }), null);
  assert.equal(
    basisForResolvedRow({ row: { ...row, unitPrice: "90" }, resolved: { itemId: "item-1", unitPrice: "100", basis } }),
    null,
    "a hand-edited price loses its lineage",
  );
  assert.equal(
    basisForResolvedRow({ row, resolved: { itemId: "item-2", unitPrice: "100", basis } }),
    null,
    "a swapped item loses its lineage",
  );
});
