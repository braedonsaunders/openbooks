import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanPayrollPacks } from "./check-payroll-treatment-bases.mjs";

function fixtureTree(packs) {
  const root = mkdtempSync(join(tmpdir(), "openbooks-treatments-"));
  for (const [dir, files] of Object.entries(packs)) {
    for (const [file, content] of Object.entries(files)) {
      const path = join(root, "engine", "src", "payroll", dir, file);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
  }
  return root;
}

const PACK = (body) => `export const PACK = {\n${body}\n};\n`;

const DECLARED = `  deductionTreatments: [{ key: "salary_sacrifice", reduces: ["income"] }],`;
const TAXABLE = `  statutorySlots: [{ components: [{ assessedOn: "taxable_income" }] }],`;
const EARNINGS = `  statutorySlots: [{ components: [{ assessedOn: "earnings" }] }],`;

test("a taxable_income pack with no consumption and no reason fails", () => {
  const root = fixtureTree({
    zz: { "pack.ts": PACK(`${DECLARED}\n${TAXABLE}`), "compute.ts": `export const x = 1;\n` },
  });
  try {
    const findings = scanPayrollPacks(root, {});
    assert.equal(findings.length, 1);
    assert.match(findings[0], /assessedOn "taxable_income"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("consumption through either channel passes, and comments do not count", () => {
  const root = fixtureTree({
    // Generic channel, real code.
    aa: {
      "pack.ts": PACK(`${DECLARED}\n${TAXABLE}`),
      "compute.ts": `export function run(ctx) {\n  return ctx.reducedBases.income;\n}\n`,
    },
    // Legacy channel, real code.
    bb: {
      "pack.ts": PACK(`${DECLARED}\n${TAXABLE}`),
      "compute.ts": `export function run(ctx) {\n  return ctx.deduction("pension_f");\n}\n`,
    },
    // The words in a comment are the aspirational defect, not consumption.
    cc: {
      "pack.ts": PACK(`${DECLARED}\n${TAXABLE}`),
      "compute.ts": `// reducedBases.income would move this, like deduction("pension_f")\nexport const x = 1;\n`,
    },
  });
  try {
    const findings = scanPayrollPacks(root, {});
    assert.equal(findings.length, 1, `expected only the comment-only pack to fail: ${findings.join("; ")}`);
    assert.match(findings[0], /^cc\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("earnings-only packs and missing declarations behave", () => {
  const root = fixtureTree({
    dd: { "pack.ts": PACK(`${DECLARED}\n${EARNINGS}`), "compute.ts": `export const x = 1;\n` },
    ee: { "pack.ts": PACK(`${TAXABLE}`), "compute.ts": `export const x = 1;\n` },
  });
  try {
    const findings = scanPayrollPacks(root, {});
    assert.equal(findings.length, 1, `expected only the undeclared pack to fail: ${findings.join("; ")}`);
    assert.match(findings[0], /declares no deductionTreatments/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allowlist entries need reasons, fire only for gaps, and never go stale", () => {
  const root = fixtureTree({
    ff: { "pack.ts": PACK(`${DECLARED}\n${TAXABLE}`), "compute.ts": `export const x = 1;\n` },
    aa: {
      "pack.ts": PACK(`${DECLARED}\n${TAXABLE}`),
      "compute.ts": `export function run(ctx) {\n  return ctx.reducedBases.income;\n}\n`,
    },
  });
  try {
    // Genuine gap with a reason: clean.
    assert.deepEqual(scanPayrollPacks(root, { ff: "engine prices off gross" }), []);
    // Reasonless: fails.
    const noReason = scanPayrollPacks(root, { ff: "" });
    assert.deepEqual(noReason, ['ff is allowlisted without a reason — allowlist entries carry a reason']);
    // Stale (aa consumes but is listed): fails.
    const stale = scanPayrollPacks(root, { ff: "engine prices off gross", aa: "old gap" });
    assert.ok(stale.some((finding) => /stale entry/.test(finding)), `stale entry must fail: ${stale.join("; ")}`);
    // Unknown directory: fails.
    const unknown = scanPayrollPacks(root, { ff: "engine prices off gross", xx: "nothing" });
    assert.ok(unknown.some((finding) => /names no payroll pack directory/.test(finding)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real tree is clean under the shipped allowlist", () => {
  const findings = scanPayrollPacks();
  assert.deepEqual(findings, [], `guard fails on the real tree: ${findings.join("; ")}`);
});
