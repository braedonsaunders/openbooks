import assert from "node:assert/strict";
import test from "node:test";
import {
  allowlistKey,
  checkTree,
  loadAllowlist,
  scanSource,
  scanTree,
} from "./check-civil-date-arithmetic.mjs";

// Realistic violator in the shape the sweep kept finding: a payroll window
// helper splitting ISO dates and differencing them through Date.UTC. The old
// spelling reads a 0099-12-25..0100-01-07 period as -693946 days.
const PAYROLL_WINDOW = `export function inclusiveDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}`;

test("flags Date.UTC with a variable year inside a realistic window helper", () => {
  const findings = scanSource("engine/src/payroll/sample.ts", PAYROLL_WINDOW); // source-path: synthetic
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((finding) => finding.fn),
    ["inclusiveDays", "inclusiveDays"],
  );
  assert.ok(findings.every((finding) => finding.kind === "Date.UTC"));
});

test("the refusal names the file, the function, and the remedy", () => {
  const problems = checkTree([], scanSource("engine/src/payroll/sample.ts", PAYROLL_WINDOW)); // source-path: synthetic
  assert.equal(problems.length, 2);
  assert.match(problems[0], /engine\/src\/payroll\/sample\.ts:\d+/); // source-path: synthetic
  assert.match(problems[0], /inclusiveDays/);
  assert.match(problems[0], /years 0-99 onto 1900-1999/);
  assert.match(problems[0], /platform\/business-date\.ts/);
  assert.match(problems[0], /utcDateFromParts/);
});

test("passes literal years, single-argument construction, and prose", () => {
  const clean = `// Date.UTC(year, ...) maps years 0-99 onto 1900-1999, so don't.
export function monthEnd(year: number, month1: number): number {
  const literal = new Date(Date.UTC(2026, 1, 1)).getTime();
  const parsed = new Date("0096-02-01T00:00:00Z").getTime();
  const copied = new Date(parsed).getTime();
  const note = "Date.UTC(y, m, d) is forbidden here";
  return literal + parsed + copied + note.length + new Date(Date.UTC(year, month1, 0)).getUTCDate() - new Date(Date.UTC(year, month1, 0)).getUTCDate();
}`;
  // Only the two variable-year constructions fire; the literal, the
  // single-argument forms, the comment and the string stay silent.
  const findings = scanSource("engine/src/sample.ts", clean); // source-path: synthetic
  assert.equal(findings.length, 2);
});

test("flags multi-argument new Date with a variable year, on one line or many", () => {
  const local = `export function monthEnd(year: number, month: number): string {
  const day = new Date(year, month, 0).getUTCDate();
  const first = new Date(
    year, month - 1, 1,
  );
  return day + first.getUTCDate() > 0 ? "x" : "y";
}`;
  const findings = scanSource("engine/src/sample.ts", local); // source-path: synthetic
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.kind === "new Date"));
  assert.deepEqual(
    findings.map((finding) => finding.arg),
    ["year", "year"],
  );
});

test("keys findings by file, function, enclosing test, and year argument", () => {
  const inTest = `test("window spans the century", () => {
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
  assert.equal(days, 13);
});`;
  const findings = scanSource("engine/src/sample.test.ts", inTest); // source-path: synthetic
  assert.equal(findings.length, 2);
  assert.equal(findings[0]?.fn, "(top-level)");
  assert.equal(findings[0]?.test, "window spans the century");
  assert.equal(findings[0]?.arg, "ty");
  assert.equal(
    allowlistKey(findings[0]),
    "engine/src/sample.test.ts::(top-level)::window spans the century::ty", // source-path: synthetic
  );
});

test("a stale allow-list entry fails like an unlisted site does", () => {
  const stale = [
    {
      path: "engine/src/gone.ts", // source-path: synthetic
      fn: "nope",
      test: "",
      arg: "year",
      reason: "nothing cites this anymore",
    },
  ];
  assert.match(checkTree(stale, [])[0] ?? "", /stale/);
});

test("the live tree matches the reviewed allow-list exactly", () => {
  const allowlist = loadAllowlist();
  assert.ok(allowlist.length > 0, "the allow-list must not be empty while exceptions remain");
  for (const entry of allowlist) {
    assert.notEqual(entry.reason.trim(), "", `${entry.path} carries a reviewed reason`);
  }
  const findings = scanTree();
  assert.deepEqual(checkTree(allowlist, findings), []);
});
