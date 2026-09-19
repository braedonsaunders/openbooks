import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/**
 * Feature-gate completeness: a tool the registry hides while its module is
 * off must DECLARE that module, and its execute path must refuse when the
 * module is off — otherwise an org that disabled a module still reaches its
 * data through the assistant/MCP surface while the screens refuse.
 *
 * Rule: any `isFeatureEnabled(org, "<key>")` hard check inside a tool's
 * execute must sit in a tool block that declares `feature: "<key>"`, unless
 * the check only SHAPES output (extra section when on, never a refusal).
 * Output-shaping checks carry an explicit `// soft-feature` marker so a
 * future hard check cannot hide behind this exemption.
 */

const ASSISTANT_TOOL_FILES = [
  "./tools.ts",
  "./tools-analytics.ts",
  "./tools-banking.ts",
  "./tools-construction.ts",
  "./tools-files.ts",
  "./tools-payroll.ts",
  "./tools-hrm.ts",
  "./tools-projects.ts",
  "./tools-reports.ts",
  "./tools-setup.ts",
  "./tools-tax.ts",
  "./tools-write.ts",
] as const;

const HARD_CHECK = /isFeatureEnabled\([^,]+,\s*"([A-Za-z]+)"\)/g;

function toolBlocks(source: string): { name: string; body: string }[] {
  const starts: { name: string; index: number }[] = [];
  for (const match of source.matchAll(/name: "([a-z0-9_]+)",\n/g)) {
    if (match.index !== undefined) starts.push({ name: match[1]!, index: match.index });
  }
  return starts.map((start, i) => ({
    name: start.name,
    body: source.slice(start.index, i + 1 < starts.length ? starts[i + 1]!.index : undefined),
  }));
}

test("every hard isFeatureEnabled check in an assistant tool declares the same feature key", () => {
  const violations: string[] = [];
  for (const file of ASSISTANT_TOOL_FILES) {
    const source = read(file);
    for (const block of toolBlocks(source)) {
      // Tool-name shaped rows inside result mappers (id/name/number) are not
      // tool definitions: a real block carries a gate within its first lines.
      if (!/gate: \{/.test(block.body.slice(0, 1500))) continue;
      const declares = block.body.slice(0, 1500).match(/feature: "([A-Za-z]+)"/);
      for (const match of block.body.matchAll(HARD_CHECK)) {
        const key = match[1]!;
        const before = block.body.slice(0, match.index).split("\n");
        // The marker lives on the check's own line or the line directly above it.
        const context = (before.slice(-2).join("\n") + "\n" + match[0]);
        if (context.includes("soft-feature")) continue;
        if (declares?.[1] !== key) violations.push(`${file} :: ${block.name} checks "${key}" without declaring it`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("soft-feature markers never sit on a refusal path", () => {
  for (const file of ASSISTANT_TOOL_FILES) {
    const source = read(file);
    for (const match of source.matchAll(/.*soft-feature.*\n/g)) {
      assert.doesNotMatch(match[0], /return \{ ok: false/);
    }
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("isFeatureEnabled(") || !line.includes("soft-feature")) return;
      const ahead = lines.slice(i, i + 6).join("\n");
      assert.doesNotMatch(ahead, /feature_disabled/);
    });
  }
});

test("every declared assistant feature key exists in the feature registry", () => {
  const registry = read("../../../engine/src/feature-registry.ts");
  const known = new Set([...registry.matchAll(/key: '([A-Za-z]+)'/g)].map((m) => m[1]!));
  assert.ok(known.size > 10, "feature key extraction looks broken");
  const unknown: string[] = [];
  for (const file of ASSISTANT_TOOL_FILES) {
    for (const block of toolBlocks(read(file))) {
      if (!/gate: \{/.test(block.body.slice(0, 1500))) continue;
      const declares = block.body.slice(0, 1500).match(/feature: "([A-Za-z]+)"/);
      if (declares && !known.has(declares[1]!)) unknown.push(`${file} :: ${block.name} declares unknown feature "${declares[1]}"`);
    }
  }
  assert.deepEqual(unknown, []);
});

const catalog = read("../application/tool-catalog.ts");

/** Slice one definition: the next `definition({` or spread `...([` ends it —
 *  `}),` also matches empty `z.object({}),` schemas, so it cannot. */
function catalogBlock(source: string, at: number): string {
  const ends = ["\n  definition({", "\n  ...(["]
    .map((marker) => source.indexOf(marker, at + 1))
    .filter((index) => index > at);
  assert.ok(ends.length > 0, "definition block does not terminate");
  return source.slice(at, Math.min(...ends));
}
const closeService = read("../application/close.ts");
const approvalsService = read("../application/approvals.ts");

test("publish_close_package declares the advancedClose feature its service enforces", () => {
  assert.match(closeService, /input\.action === "publish" && !\(await isFeatureEnabled\(context\.authz\.user\.orgId, "advancedClose"\)\)/);
  assert.match(catalog, /featureKey: action === "publish" \? "advancedClose" : undefined/);
});

test("app-package tools declare the apps feature key", () => {
  const appToolNames = [
    "list_app_packages",
    "describe_app_vocabulary",
    "draft_app",
    "get_app_draft",
    "get_app_package",
    "discard_app_draft",
    "activate_app_draft",
  ];
  for (const name of appToolNames) {
    const at = catalog.indexOf(`name: "${name}"`);
    assert.ok(at >= 0, `${name} missing from the application catalog`);
    const block = catalogBlock(catalog, at);
    assert.match(block, /featureKey: "apps"/, `${name} must declare featureKey "apps"`);
  }
});

test("approvals tools stay ungated because the service degrades softly without flows", () => {
  // With flows off the worklist returns [] (or pay-run items) instead of
  // refusing, mirroring the HTTP surface, whose flows routes carry no feature
  // fence either — so no featureKey may hide these tools.
  assert.match(approvalsService, /if \(!flowsOn\) return \[\]/);
  for (const name of ["list_approvals", "decide_approval"]) {
    const at = catalog.indexOf(`name: "${name}"`);
    assert.ok(at >= 0, `${name} missing from the application catalog`);
    assert.doesNotMatch(catalogBlock(catalog, at), /featureKey/);
  }
});
