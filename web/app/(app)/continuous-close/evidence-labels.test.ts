import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const packs = [
  "hygiene",
  "collections",
  "reconciliation",
  "payables",
  "payroll",
  "tax",
  "cash",
  "projects",
  "accounting",
  "finance",
  "forensics",
];

// Every evidence kind the agent packs can emit (extracted from source so a
// new kind without a catalog label fails closed instead of rendering raw).
const kinds = new Set<string>();
for (const pack of packs) {
  const src = readFileSync(join(root, "engine", "src", "agents", `${pack}.ts`), "utf8");
  for (const match of src.matchAll(/kind: "([a-z_]+)"/g)) kinds.add(match[1]!);
}
assert.ok(kinds.size > 30, `expected the pack kind enumeration, got ${kinds.size}`);

const catalogs: Record<string, Record<string, unknown>> = {};
for (const locale of ["en", "fr", "es"]) {
  catalogs[locale] = JSON.parse(
    readFileSync(join(root, "web", "messages", locale, "continuous-close.json"), "utf8"),
  ) as Record<string, unknown>;
}

test("F-t11-002: every emitted evidence kind has a label in en/fr/es", () => {
  const missing: string[] = [];
  for (const kind of [...kinds].sort()) {
    for (const locale of ["en", "fr", "es"]) {
      const evidence = (catalogs[locale]!.evidence ?? {}) as Record<string, unknown>;
      const label = evidence[kind];
      if (typeof label !== "string" || label.length === 0) missing.push(`${locale}:evidence.${kind}`);
    }
  }
  assert.deepEqual(missing, [], "evidence labels must exist for every emitted kind");
});

test("F-t11-002: fr/es evidence labels are translated, not English echoes", () => {
  const en = (catalogs.en!.evidence ?? {}) as Record<string, string>;
  for (const locale of ["fr", "es"]) {
    const evidence = (catalogs[locale]!.evidence ?? {}) as Record<string, string>;
    const echoes = [...kinds].filter((kind) => evidence[kind] === en[kind]);
    assert.deepEqual(echoes, [], `${locale} evidence labels must differ from en`);
  }
});
