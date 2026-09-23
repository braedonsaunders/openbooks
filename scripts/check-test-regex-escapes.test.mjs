import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ALLOWLIST,
  isAllowlisted,
  isEscapeClass,
  regexLiterals,
  scanFile,
  scanTree,
  suspectRun,
} from "./check-test-regex-escapes.mjs";

test("a double backslash in a test regex literal is suspect, a single is not", () => {
  assert.equal(suspectRun(1), 0);
  assert.equal(suspectRun(2), 2);
  assert.equal(suspectRun(3), 3);
});

test("division slashes are not regexes, return-position slashes are", () => {
  const found = regexLiterals(`const half = total / 2;
assert.match(source, /seed-project-types\\./);
if (ok) { ratio = a / b; }
return /done/.test(text);
`);
  assert.deepEqual(
    found.map((entry) => entry.pattern),
    ["seed-project-types\\.", "done"],
  );
});

test("a vacuous double-backslash literal is flagged with file and line", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbooks-regex-escapes-"));
  try {
    const file = join(dir, "pinned.test.ts");
    writeFileSync(file, `import assert from "node:assert/strict";
import test from "node:test";
test("pins hold", () => {
  assert.match(text, /value\\\\\\.\\d+/);
  assert.match(text, /plain\\.\\d+/);
});
`);
    const findings = scanFile(file, dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 4);
    assert.match(findings[0].snippet, /value/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an allowlisted literal is suppressed only with its reason on record", () => {
  const entry = ALLOWLIST.find((candidate) => candidate.file === "schema/canonical-baseline-generator.test.ts");
  assert.ok(entry, "the psql-metacommand entry must exist");
  assert.match(entry.reason, /psql/);
  assert.ok(isAllowlisted("schema/canonical-baseline-generator.test.ts", "/\\\\restrict|\\\\unrestrict/"));
  assert.ok(!isAllowlisted("schema/canonical-baseline-generator.test.ts", "/something-else\\\\d+/"));
  assert.ok(!isAllowlisted("other/file.test.ts", "/\\\\restrict/"));
});

test("the live repository has no unallowlisted double-backslash test regexes", () => {
  const findings = scanTree();
  assert.deepEqual(findings, [], `${findings.length} suspect regexes:\n${findings.map((finding) => `${finding.file}:${finding.line} [${finding.origin}] ${finding.snippet}`).join("\n")}`);
});

test("the escapeRegExp idiom is recognised by shape, in any file, without an allowlist entry", () => {
  assert.equal(isEscapeClass("[.*+?^${}()|[\\]\\\\]"), true);
  assert.equal(isEscapeClass("[.*+?${}()|[\\]\\\\]"), true, "the variant without ^");
  const dir = mkdtempSync(join(tmpdir(), "openbooks-regex-escapes-"));
  try {
    const file = join(dir, "fresh.test.ts");
    const text = `const escaped = name.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");\n`;
    writeFileSync(file, text);
    // Seen, then exempted: an empty result from a scan that never found the
    // literal would pass this test for the wrong reason.
    assert.deepEqual(regexLiterals(text).map((entry) => entry.pattern), ["[.*+?^${}()|[\\]\\\\]"]);
    assert.deepEqual(scanFile(file, dir), [], "a new file using the idiom needs no allowlist entry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(
    !ALLOWLIST.some((entry) => /escapeRegExp/i.test(entry.reason)),
    "the idiom is exempt by shape; a per-file entry for it would only hide a new use",
  );
});

test("a backslash in a short or mixed class is still checked", () => {
  assert.equal(isEscapeClass("[\\\\.]"), false, "a two-member class may be a mis-escape");
  assert.equal(isEscapeClass("[a\\\\]"), false, "a class with a non-metacharacter is not the idiom");
  assert.equal(isEscapeClass("\\\\d"), false, "outside a class, a double backslash is the vacuous case");
});
