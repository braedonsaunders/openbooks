import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Unit partition: no database. The DB-backed posted-reports contracts
// (parallel-book isolation, truncation, one-book readers) live in
// reports-posted.integration.test.ts. What stays here drives the real
// resolveFormulaTaxRate and the native enacted-rate reader against a database
// boundary: configured rates resolve, invalid/negative rates refuse, and
// configuration outside its effective dates is treated as absent.
test("formula TAX_RATE resolves configured rates and fails closed", () => {
  const source = `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    import { pathToFileURL } from "node:url";
    import { PgDialect } from "drizzle-orm/pg-core";
    const dialect = new PgDialect();
    const fixtures = [
      ["org-standard", null, "federal", "5", "2026-08-01", null],
      ["org-stacked", null, "federal", "7", "2026-08-01", null],
      ["org-stacked", "sub-province", "provincial", "5", "2026-08-01", null],
      ["org-revision", null, "federal", "9", "2026-08-01", "2026-08-31"],
      ["org-malformed", null, "federal", "not-a-rate", "2026-08-01", null],
      ["org-negative", null, "federal", "-1", "2026-08-01", null],
      ["org-zero", null, "federal", "0", "2026-08-01", null],
    ];
    globalThis.__reportRateDatabase = {
      async execute(query) {
        const rendered = dialect.sqlToQuery(query);
        assert.match(rendered.sql, /from income_tax_rates/);
        assert.match(rendered.sql, /where org_id =/);
        assert.match(rendered.sql, /and is_active/);
        assert.match(rendered.sql, /subsidiary_id is not distinct from/);
        const [orgId, asOfIso, throughIso, subsidiaryId] = rendered.params;
        assert.equal(asOfIso, throughIso);
        return { rows: fixtures.filter(([org, sub, , , from, to]) =>
          org === orgId && sub === subsidiaryId && from <= asOfIso && (to === null || to >= asOfIso)
        ).map(([, , jurisdiction, rate]) => ({ jurisdiction, rate })) };
      },
    };
    const dbUrl = pathToFileURL(process.cwd() + "/engine/src/platform/db.ts").href;
    const nativeDbUrl = dbUrl + "?report-native";
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url !== dbUrl) return resolved;
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        "export * from " + JSON.stringify(nativeDbUrl) + "; export const db = globalThis.__reportRateDatabase;"
      ) };
    } });
    try {
    const { resolveFormulaTaxRate } = await import("./web/lib/cash/core.ts");
    assert.equal(await resolveFormulaTaxRate("org-standard", "2026-08-31"), "0.05");
    assert.equal(await resolveFormulaTaxRate("org-stacked", "2026-08-31", "sub-province"), "0.12");
    assert.equal(await resolveFormulaTaxRate("org-stacked", "2026-08-31", "sub-other"), "0.07");
    assert.equal(await resolveFormulaTaxRate("org-zero", "2026-08-31"), "0");

    await assert.rejects(
      resolveFormulaTaxRate("org-missing", "2026-08-31"),
      /no enacted income tax rate.*org-missing.*2026-08-31.*Setup.*Income tax rates/,
    );
    await assert.rejects(
      resolveFormulaTaxRate("org-malformed", "2026-08-31"),
      /not a decimal number.*not-a-rate/,
    );
    await assert.rejects(
      resolveFormulaTaxRate("org-negative", "2026-08-31"),
      /federal.*negative rate.*-1.*correct the income tax rate configuration/,
    );
    await assert.rejects(
      resolveFormulaTaxRate("org-empty", "2026-08-31"),
      /no enacted income tax rate.*org-empty.*Setup.*Income tax rates/,
    );
    assert.equal(await resolveFormulaTaxRate("org-revision", "2026-08-01"), "0.09");
    assert.equal(await resolveFormulaTaxRate("org-revision", "2026-08-31"), "0.09");
    await assert.rejects(
      resolveFormulaTaxRate("org-revision", "2026-07-31"),
      /no enacted income tax rate.*org-revision.*2026-07-31/,
    );
    await assert.rejects(
      resolveFormulaTaxRate("org-revision", "2026-09-01"),
      /no enacted income tax rate.*org-revision.*2026-09-01/,
    );
    } finally {
      hooks.deregister();
      const native = await import(nativeDbUrl);
      await Promise.all([native.pool.end(), native.longPool.end()]);
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
