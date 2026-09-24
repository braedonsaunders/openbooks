import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Unit partition: no database. The DB-backed posted-reports contracts
// (parallel-book isolation, truncation, one-book readers) live in
// reports-posted.integration.test.ts. What stays here drives the real
// resolveFormulaTaxRate against a scripted runner: configured rates
// resolve, absent/invalid/negative configs refuse by name, and a revision
// dated before its update is treated as absent.
test("formula TAX_RATE resolves configured rates and fails closed", () => {
  const source = `
    import assert from "node:assert/strict";
    import { resolveFormulaTaxRate } from "./web/lib/cash/core.ts";

    const fixtures = new Map([
      ["org-gst", { defaultRatePercent: "5", updatedAt: "2026-08-01" }],
      ["org-bc", { defaultRatePercent: "12", updatedAt: "2026-08-01" }],
      ["org-revision", { defaultRatePercent: "9", updatedAt: "2026-08-01" }],
      ["org-malformed", { defaultRatePercent: "not-a-rate", updatedAt: "2026-08-01" }],
      ["org-negative", { defaultRatePercent: "-1", updatedAt: "2026-08-01" }],
      ["org-empty", { defaultRatePercent: "", updatedAt: "2026-08-01" }],
    ]);
    const runner = {
      async execute(query) {
        const chunks = Array.isArray(query.queryChunks) ? query.queryChunks : [];
        const params = chunks.filter((chunk) => typeof chunk === "string");
        const [orgId, asOfIso] = params;
        const fixture = fixtures.get(orgId);
        if (!fixture || asOfIso < fixture.updatedAt) return { rows: [] };
        return { rows: [{ defaultRatePercent: fixture.defaultRatePercent }] };
      },
    };
    assert.equal(await resolveFormulaTaxRate("org-gst", "2026-08-31", runner), 0.05);
    assert.equal(await resolveFormulaTaxRate("org-bc", "2026-08-31", runner), 0.12);

    await assert.rejects(
      resolveFormulaTaxRate("org-missing", "2026-08-31", runner),
      /requires an enabled manual tax-rate provider with settings\\.defaultRatePercent/,
    );
    await assert.rejects(
      resolveFormulaTaxRate("org-malformed", "2026-08-31", runner),
      /has an invalid settings\\.defaultRatePercent/,
    );
    await assert.rejects(
      resolveFormulaTaxRate("org-negative", "2026-08-31", runner),
      /has an invalid settings\\.defaultRatePercent/,
    );
    await assert.rejects(
      resolveFormulaTaxRate("org-empty", "2026-08-31", runner),
      /requires an enabled manual tax-rate provider with settings\\.defaultRatePercent/,
    );
    assert.equal(await resolveFormulaTaxRate("org-revision", "2026-08-01", runner), 0.09);
    await assert.rejects(
      resolveFormulaTaxRate("org-revision", "2026-07-31", runner),
      /requires an enabled manual tax-rate provider with settings\\.defaultRatePercent/,
    );
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
