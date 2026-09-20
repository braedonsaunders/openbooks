import assert from "node:assert/strict";
import test from "node:test";
import { PAYROLL_COUNTRY_PACKS } from "./packs.ts";
import {
  LaborComplianceBuildError,
  constructionRulesFor,
  laborComplianceFilesFor,
  type LaborComplianceReportContext,
} from "./labor-compliance.ts";

/**
 * Labor-compliance declaration conformance (HR-13, payroll-lane
 * conditions): present implies non-empty, every transcribed figure cited,
 * and the twelve packs with no such concept declaring nothing — so the
 * generic layer's refuse-by-name has something to refuse on.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

test("packs declaring labor-compliance files declare a non-empty, well-formed list", () => {
  for (const [code, pack] of Object.entries(PAYROLL_COUNTRY_PACKS)) {
    if (pack.laborComplianceFiles === undefined) continue;
    const formats = pack.laborComplianceFiles();
    assert.ok(
      formats.length > 0,
      `${code} declares laborComplianceFiles but lists no file — present implies non-empty; remove the field or declare a file`,
    );
    const keys = new Set<string>();
    for (const format of formats) {
      assert.ok(format.key.trim().length > 0, `${code} declares a file with a blank key`);
      assert.ok(!keys.has(format.key), `${code} declares file key ${format.key} twice — keys live once`);
      keys.add(format.key);
      assert.ok(format.label.trim().length > 0, `${code} file ${format.key} has a blank label`);
      assert.equal(typeof format.build, "function", `${code} file ${format.key} has no builder`);
    }
  }
});

test("the US pack declares the federal weekly file and one state XML; every other pack declares none", () => {
  const us = PAYROLL_COUNTRY_PACKS.US!;
  assert.ok(us, "US pack registered");
  const keys = laborComplianceFilesFor(us!).map((format) => format.key);
  assert.deepEqual(keys, ["federal-weekly", "state-xml"]);
  for (const [code, pack] of Object.entries(PAYROLL_COUNTRY_PACKS)) {
    if (code === "US") continue;
    assert.deepEqual(
      laborComplianceFilesFor(pack),
      [],
      `${code} must declare no labor-compliance files — the generic layer refuses by name when a pack declares none`,
    );
  }
});

test("packs declaring construction declare cited, effective-dated rules; only CA declares", () => {
  for (const [code, pack] of Object.entries(PAYROLL_COUNTRY_PACKS)) {
    const rules = constructionRulesFor(pack.construction);
    if (pack.construction === undefined) {
      assert.deepEqual(rules, [], `${code} reader must be empty`);
      continue;
    }
    assert.ok(
      rules.length > 0,
      `${code} declares construction but lists no rule — present implies non-empty`,
    );
    for (const rule of rules) {
      assert.ok("citation" in rule && rule.citation.trim().length > 0, `${code} ${rule.kind} has no citation`);
      assert.ok(
        "effectiveFrom" in rule && DATE.test(rule.effectiveFrom),
        `${code} ${rule.kind} has no YYYY-MM-DD effectiveFrom`,
      );
    }
  }
  assert.ok(
    (PAYROLL_COUNTRY_PACKS.CA?.construction?.rules.length ?? 0) > 0,
    "CA pack must declare its construction carve-outs",
  );
  for (const [code, pack] of Object.entries(PAYROLL_COUNTRY_PACKS)) {
    if (code === "CA") continue;
    assert.equal(pack.construction, undefined, `${code} must declare no construction carve-outs`);
  }
});

const CONTEXT: LaborComplianceReportContext = {
  orgName: "Acme Construction",
  projectName: "Harbour Bridge",
  projectReference: "HB-1042",
  weekEnding: "2026-09-13",
  generatedAt: "2026-09-14T09:00:00.000Z",
  rows: [
    {
      employmentId: "emp-1",
      displayName: "Jo Rivera",
      classificationCode: "ELEC-J",
      classificationName: "Electrician (journey)",
      day: "2026-09-08",
      hours: "8.0000",
      baseRate: "52.7500",
      fringeCash: "4.1000",
      fringeCredit: "6.2500",
      deductions: "120.0000",
      net: "302.0000",
      rateSource: "prevailing",
    },
  ],
};

test("builders refuse an empty payload and nameless rows by name, and are deterministic", () => {
  const [federal] = laborComplianceFilesFor(PAYROLL_COUNTRY_PACKS.US!);
  assert.ok(federal, "US federal weekly file declared");
  assert.throws(
    () => federal.build({ ...CONTEXT, rows: [] }),
    (error: unknown) =>
      error instanceof LaborComplianceBuildError && /no resolved worker\/classification\/day rows/.test(error.message),
  );
  assert.throws(
    () =>
      federal.build({
        ...CONTEXT,
        rows: [{ ...CONTEXT.rows[0]!, displayName: "  " }],
      }),
    LaborComplianceBuildError,
  );
  const first = federal.build(CONTEXT);
  const second = federal.build(CONTEXT);
  assert.deepEqual(second, first, "same context must build the same bytes");
  assert.equal(first.filename, "certified-payroll-hb-1042-2026-09-13.txt");
  assert.ok(first.body.includes("Jo Rivera") && first.body.includes("ELEC-J"));
  const [xml] = laborComplianceFilesFor(PAYROLL_COUNTRY_PACKS.US!).slice(1);
  assert.ok(xml, "US state XML declared");
  const rendered = xml.build(CONTEXT);
  assert.equal(rendered.contentType, "application/xml");
  assert.ok(rendered.body.includes("<certifiedPayroll"));
});

test("a pack with no declaration reads as no files — the generic refusal point", () => {
  assert.deepEqual(laborComplianceFilesFor({}), []);
  assert.deepEqual(constructionRulesFor(undefined), []);
});
