import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFORMANCE_CORPUS, validateCorpus } from "./matrix.ts";
import { createConformanceOrg } from "./roles.ts";
import { runCase } from "./runner.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The conformance corpus, as a test suite.
 *
 * Computation-tier cases run everywhere, including the no-database CI job.
 * Ledger-tier cases post real documents and self-skip without a database, the
 * same way the rest of the integration suite does.
 *
 * A declared gap ASSERTS THAT IT IS STILL A GAP. That is deliberate: when
 * someone implements leases or lower-of-cost-and-NRV, this suite fails and
 * tells them to reclassify the case rather than letting the published matrix
 * quietly understate what the product does.
 */

test("the conformance register is well formed", () => {
  assert.deepEqual(validateCorpus(), []);
});

for (const kase of CONFORMANCE_CORPUS.filter((c) => c.support === "not-implemented")) {
  test(`gap ${kase.id} is still a declared gap`, () => {
    assert.equal(kase.run, undefined, `${kase.id} now has a run function — reclassify its support level`);
    assert.ok(kase.gap && kase.gap.length > 0);
  });
}

for (const kase of CONFORMANCE_CORPUS.filter(
  (c) => c.tier === "computation" && c.support !== "not-implemented",
)) {
  test(`${kase.id} — ${kase.citations[0]!.standard} ${kase.citations[0]!.reference}`, async () => {
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

for (const kase of CONFORMANCE_CORPUS.filter(
  (c) => c.tier === "ledger" && c.support !== "not-implemented",
)) {
  test(
    `${kase.id} — ${kase.citations[0]!.standard} ${kase.citations[0]!.reference}`,
    { skip: !DB },
    async () => {
      // A fresh tenant per case: several cases deliberately leave stock and
      // receivables behind, and a shared tenant would let one case's residue
      // change another case's answer.
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
    },
  );
}
