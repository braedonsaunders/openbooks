import assert from "node:assert/strict";
import test from "node:test";
import { detectRootOverlaps, findRootOverlap, rootOverlapRefusal, splitRootSegments } from "./roots.ts";

const BANK_A = { id: "a", name: "Bank A", rootPrefix: "sftp/org-1/bank-a" };

test("equal, ancestor, and descendant roots all conflict", () => {
  const equal = findRootOverlap("sftp/org-1/bank-a", [BANK_A]);
  assert.equal(equal?.row.id, "a");
  assert.equal(equal?.relation, "equal");

  const child = findRootOverlap("sftp/org-1/bank-a/sub", [BANK_A]);
  assert.equal(child?.relation, "descendant");

  const parent = findRootOverlap("sftp/org-1", [{ id: "p", name: "Parent", rootPrefix: "sftp/org-1/bank-a/deep" }]);
  assert.equal(parent?.relation, "ancestor");
});

test("sibling and disjoint folders do not conflict", () => {
  assert.equal(findRootOverlap("sftp/org-1/bank-ab", [BANK_A]), null);
  assert.equal(findRootOverlap("sftp/org-1/bank-b", [BANK_A]), null);
  assert.equal(findRootOverlap("sftp/org-2/bank-a", [BANK_A]), null);
});

test("legacy slash shapes are normalized before comparison, never laundered", () => {
  assert.deepEqual(splitRootSegments("/sftp/org-1/bank-a/"), ["sftp", "org-1", "bank-a"]);
  assert.equal(findRootOverlap("sftp/org-1/bank-a/", [BANK_A])?.relation, "equal");
});

test("the refusal names the conflicting server, both folders, and the remedy", () => {
  const hit = findRootOverlap("sftp/org-1/bank-a/sub", [BANK_A])!;
  const message = rootOverlapRefusal("sftp/org-1/bank-a/sub", hit);
  assert.match(message, /Bank A/);
  assert.match(message, /sftp\/org-1\/bank-a\/sub/);
  assert.match(message, /sftp\/org-1\/bank-a/);
  assert.match(message, /choose a folder|delete the conflicting server/);
});

test("the preflight detector names every overlapping pair exactly once", () => {
  const rows = [
    BANK_A,
    { id: "b", name: "Bank B", rootPrefix: "sftp/org-1/bank-a/sub" },
    { id: "c", name: "Bank C", rootPrefix: "sftp/org-1/bank-c" },
  ];
  const pairs = detectRootOverlaps(rows);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.a.id, "a");
  assert.equal(pairs[0]!.b.id, "b");
  assert.deepEqual(detectRootOverlaps([BANK_A, { id: "c", name: "Bank C", rootPrefix: "sftp/org-1/bank-c" }]), []);
});
