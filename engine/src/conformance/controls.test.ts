import assert from "node:assert/strict";
import { test } from "node:test";
import { createConformanceOrg } from "./roles.ts";
import { runCase } from "./runner.ts";
import { CONTROL_CORPUS, validateControls } from "./controls.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The internal-controls evidence set, as a test suite.
 *
 * Same doctrine as the standards corpus (conformance.test.ts): computation
 * cases run everywhere including the no-database CI job; ledger cases post
 * through the real kernel and self-skip without a database; a declared gap
 * asserts that it is still a gap so the published matrix can never quietly
 * overstate what the product does. These cases cite AUDIT-CONTROLS.md
 * control ids, never a published standard paragraph.
 */

test("the controls register is well formed", () => {
  assert.deepEqual(validateControls(), []);
});

for (const kase of CONTROL_CORPUS.filter((c) => c.support === "not-implemented")) {
  test(`gap ${kase.id} is still a declared gap`, () => {
    assert.equal(kase.run, undefined, `${kase.id} now has a run function — reclassify its support level`);
    assert.ok(kase.gap && kase.gap.length > 0);
  });
}

for (const kase of CONTROL_CORPUS.filter(
  (c) => c.tier === "computation" && c.support !== "not-implemented",
)) {
  test(`${kase.id} — control ${kase.control}`, async () => {
    const result = await runCase(kase);
    assert.equal(
      result.status,
      "pass",
      [
        result.error ? `error: ${result.error}` : "",
        ...result.differences.map((d) => `${d.at}: expected ${d.expected}, got ${d.actual}`),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  });
}

for (const kase of CONTROL_CORPUS.filter(
  (c) => c.tier === "ledger" && c.support !== "not-implemented",
)) {
  test(`${kase.id} — control ${kase.control}`, { skip: !DB }, async () => {
    // A fresh tenant per case: allocation runs leave journals and lineage
    // behind, and a shared tenant would let one case's residue change
    // another case's answer.
    const org = await createConformanceOrg();
    try {
      const result = await runCase(kase, { ledger: { roles: org.roles, ledger: org.ledger } });
      assert.equal(
        result.status,
        "pass",
        [
          result.error ? `error: ${result.error}` : "",
          ...result.differences.map((d) => `${d.at}: expected ${d.expected}, got ${d.actual}`),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } finally {
      await org.drop();
    }
  });
}
