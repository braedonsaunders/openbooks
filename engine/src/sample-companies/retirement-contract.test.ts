import assert from "node:assert/strict";
import test from "node:test";
import { parseRetirementSelection, assertRetirementDatabase, assertRetirementPartition, retirementDigest } from "./retirement-contract.ts";

const keep = "00000000-0000-4000-8000-000000000001";
const retire = "00000000-0000-4000-8000-000000000002";
const extra = "00000000-0000-4000-8000-000000000003";
const selection = { version: 1, database: { database: "evaluation", serverAddress: "127.0.0.1/32", serverPort: 5432, clusterName: "reviewed-cluster" },
  retainOrgIds: [keep], retireOrgIds: [retire], reason: "Remove explicitly reviewed extra evaluation tenant" };

test("retirement requires explicit disjoint complete native tenant identities", () => {
  const parsed = parseRetirementSelection(selection);
  assert.doesNotThrow(() => assertRetirementPartition(parsed, [retire, keep]));
  assert.throws(() => parseRetirementSelection({ ...selection, retireOrgIds: [keep] }), /both retained and retired/);
  assert.throws(() => parseRetirementSelection({ ...selection, retainOrgIds: [] }), /explicit native company UUIDs/);
  assert.throws(() => parseRetirementSelection({ ...selection, retireOrgIds: [retire, retire] }), /duplicate/);
  assert.throws(() => parseRetirementSelection({ ...selection, retireOrgIds: ["SIM%"] }), /wildcard/);
  assert.throws(() => parseRetirementSelection({ ...selection, deleteAllOthers: true }), /exactly/);
  assert.throws(() => assertRetirementPartition(parsed, [retire, keep, extra]), /inventory differs/);
  assert.throws(() => assertRetirementPartition(parsed, [keep]), /inventory differs/);
});

test("retirement refuses every wrong database identity component", () => {
  const parsed = parseRetirementSelection(selection);
  assert.doesNotThrow(() => assertRetirementDatabase(parsed.database, { ...parsed.database }));
  const unnamed = parseRetirementSelection({ ...selection, database: { ...selection.database, clusterName: "" } });
  assert.equal(unnamed.database.clusterName, "", "an explicitly observed empty cluster name remains an exact identity component");
  assert.throws(() => assertRetirementDatabase(unnamed.database, parsed.database), /differs/);
  for (const key of ["database", "serverAddress", "serverPort", "clusterName"] as const) {
    const actual = { ...parsed.database, [key]: key === "serverPort" ? 5433 : "another-value" };
    assert.throws(() => assertRetirementDatabase(parsed.database, actual), /differs from the reviewed native receipt/);
  }
});

test("maintenance digest pins reviewed target membership, source schema and dependency evidence", () => {
  const plan = { selection: parseRetirementSelection(selection), schemaDigest: "source-one", retainedDependencies: [] };
  const digest = retirementDigest(plan);
  assert.equal(digest, retirementDigest({ retainedDependencies: [], schemaDigest: "source-one", selection: parseRetirementSelection(selection) }));
  assert.notEqual(digest, retirementDigest({ ...plan, schemaDigest: "source-two" }));
  assert.notEqual(digest, retirementDigest({ ...plan, retainedDependencies: [{ orgId: keep, sourceOrgId: retire }] }));
  assert.notEqual(digest, retirementDigest({ ...plan, selection: parseRetirementSelection({ ...selection, retireOrgIds: [extra] }) }));
});
