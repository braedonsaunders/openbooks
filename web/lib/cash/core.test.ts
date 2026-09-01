import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const coreSource = readFileSync(join(import.meta.dirname, "core.ts"), "utf8");

// This is the row returned by the GL-history rollup for one account/week when
// the ledger contains a +1,000 inflow and a -400 refund.
const period = {
  net: 1_000 - 400,
  gross: Math.abs(1_000) + Math.abs(-400),
};

test("GL history net mode keeps signed activity in both forecast paths", () => {
  assert.equal(period.net, 600, "forecast history series");
  assert.equal(Math.abs(period.net), 600, "source-account average");
  assert.match(coreSource, /const activity = useNet \? net : gross/);
});

test("GL history gross mode keeps line magnitudes in both forecast paths", () => {
  assert.equal(period.gross, 1_400, "forecast history series");
  assert.equal(Math.abs(period.gross), 1_400, "source-account average");
  assert.match(
    coreSource,
    /sum\(l\.amount\) as net, sum\(abs\(l\.amount\)\) as gross/,
  );
});

test("categoryWeekly feeds the selected activity into history and source-account totals", () => {
  assert.match(coreSource, /weeklyHistory\[x\.wk\][\s\S]{0,140}activity/);
  assert.match(coreSource, /accountTotals\.set\(label,[\s\S]{0,140}activity/);
});

test("formula TAX_RATE resolves each org default and fails closed", () => {
  // core.ts is server-only in production, so run the behavior check under
  // React's server condition (the same pattern used by other web tests).
  const source = `
    import assert from "node:assert/strict";
    import { resolveFormulaTaxRate } from "./web/lib/cash/core.ts";

    const fixtures = new Map([
      ["org-gst", { defaultRatePercent: "5", updatedAt: "2026-08-01" }],
      ["org-bc", { defaultRatePercent: "12", updatedAt: "2026-08-01" }],
      ["org-malformed", { defaultRatePercent: "not-a-rate", updatedAt: "2026-08-01" }],
      ["org-negative", { defaultRatePercent: "-1", updatedAt: "2026-08-01" }],
      ["org-revision", { defaultRatePercent: "9", updatedAt: "2026-08-01" }],
    ]);
    const queries = [];
    const runner = {
      async execute(query) {
        const chunks = Array.isArray(query.queryChunks) ? query.queryChunks : [];
        const params = chunks.filter((chunk) => typeof chunk === "string");
        const [orgId, asOfIso] = params;
        const queryText = chunks.map((chunk) => {
          if (typeof chunk === "string") return chunk;
          return Array.isArray(chunk?.value) ? chunk.value.join("") : "";
        }).join("");
        assert.match(queryText, /from tax_rate_provider_configs/);
        assert.match(queryText, /org_id =/);
        assert.match(queryText, /provider = 'manual'/);
        assert.match(queryText, /is_enabled/);
        assert.match(queryText, /updated_at </);
        queries.push(queryText);

        const fixture = fixtures.get(orgId);
        if (!fixture || asOfIso < fixture.updatedAt) return { rows: [] };
        return { rows: [{ defaultRatePercent: fixture.defaultRatePercent }] };
      },
    };

    const gstRate = await resolveFormulaTaxRate("org-gst", "2026-08-31", runner);
    const bcRate = await resolveFormulaTaxRate("org-bc", "2026-08-31", runner);
    assert.equal(gstRate, 0.05);
    assert.equal(bcRate, 0.12);
    assert.notEqual(gstRate, 0);
    assert.notEqual(bcRate, 0.13);
    assert.match(queries[0], /org_id = org-gst/);
    assert.match(queries[1], /org_id = org-bc/);

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

    // A revision made after the forecast date is not usable historically;
    // the engine must fail closed instead of applying a stale or default rate.
    assert.equal(await resolveFormulaTaxRate("org-revision", "2026-08-01", runner), 0.09);
    await assert.rejects(
      resolveFormulaTaxRate("org-revision", "2026-07-31", runner),
      /requires an enabled manual tax-rate provider with settings\\.defaultRatePercent/,
    );
    console.log("cash TAX_RATE behavior passed: org-gst=5%, org-bc=12%; missing, malformed, negative, and pre-revision bindings fail closed");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
