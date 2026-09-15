/**
 * The engine document-kind universe lives in exactly one place
 * (engine/src/close.ts DOCUMENT_CLOSE_MODULES) and every engine consumer
 * derives from it. Two drifts proved the need: the bench repro showed
 * find_documents rejecting 'customer_payment' and 'pay_run' although
 * documents.kind holds both, and the flows POSTING_DOC_KINDS mirror omitted
 * pay_run and project_charge although the kernel posts both.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DOCUMENT_KINDS } from "./close.ts";
import { RULES } from "./posting.ts";
import {
  DOCUMENT_FLOW_KINDS,
  NON_POSTING_DOC_KINDS,
  POSTING_DOC_KINDS,
} from "./flows/subject-profiles.ts";

test("the engine kind universe holds customer_payment and pay_run", () => {
  const universe = DOCUMENT_KINDS as readonly string[];
  assert.ok(universe.includes("customer_payment"), "settlement kinds are queryable kinds");
  assert.ok(universe.includes("pay_run"), "payroll kinds are queryable kinds");
});

test("flow posting kinds are exactly the kernel posting rules", () => {
  assert.deepEqual(
    new Set(POSTING_DOC_KINDS),
    new Set(Object.keys(RULES)),
    "a kernel posting rule without a flow profile (or vice versa) is a drift",
  );
});

test("posting plus explicitly non-posting covers the whole universe, disjointly", () => {
  const universe = new Set<string>(DOCUMENT_KINDS);
  assert.deepEqual(
    new Set<string>([...POSTING_DOC_KINDS, ...NON_POSTING_DOC_KINDS]),
    universe,
  );
  const overlap = [...POSTING_DOC_KINDS].filter((kind) =>
    (NON_POSTING_DOC_KINDS as readonly string[]).includes(kind),
  );
  assert.deepEqual(overlap, []);
  assert.deepEqual(new Set<string>(DOCUMENT_FLOW_KINDS), universe);
});
