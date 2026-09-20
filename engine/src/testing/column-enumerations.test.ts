import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { COLUMN_ENUMERATIONS, STANCES, type Stance } from "./column-enumerations.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCAN_ROOTS = ["engine/src", "web/lib", "web/app", "web/components", "packages", "scripts", "deploy"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", "vendor"]);
const SOURCE_RE = /\.(?:ts|tsx|mjs|js)$/;
const TEST_RE = /\.test\.(?:ts|tsx|mjs|js)$/;
const ENUMERATION_RE = /information_schema\.columns\b|\bpg_attribute\b/;
const GENERATED_FILTER_RE = /is_generated|attgenerated/;
/** Lines around a `feeds-a-write` site that must show the generated-column filter. */
const FILTER_WINDOW = { before: 6, after: 8 };

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) yield* sourceFiles(path);
    else if (stats.isFile() && SOURCE_RE.test(entry) && !TEST_RE.test(entry)) yield path;
  }
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

interface FoundSite { line: number; text: string }

function enumerationSites(lines: readonly string[]): FoundSite[] {
  const sites: FoundSite[] = [];
  lines.forEach((text, index) => {
    if (!isCommentLine(text) && ENUMERATION_RE.test(text)) sites.push({ line: index + 1, text: text.trim() });
  });
  return sites;
}

function scan(): Map<string, { lines: string[]; sites: FoundSite[] }> {
  const found = new Map<string, { lines: string[]; sites: FoundSite[] }>();
  for (const root of SCAN_ROOTS) {
    let absolute: string;
    try { absolute = join(ROOT, root); statSync(absolute); } catch { continue; }
    for (const file of sourceFiles(absolute)) {
      const lines = readFileSync(file, "utf8").split("\n");
      const sites = enumerationSites(lines);
      if (sites.length) found.set(relative(ROOT, file).split(sep).join("/"), { lines, sites });
    }
  }
  return found;
}

function stanceMenu(): string {
  return (Object.keys(STANCES) as Stance[]).map((stance) => `  - ${stance}: ${STANCES[stance]}`).join("\n");
}

test("the registry declares every catalog column enumeration exactly once, in source order", () => {
  const registered = new Map(COLUMN_ENUMERATIONS.map((entry) => [entry.file, entry]));
  assert.equal(registered.size, COLUMN_ENUMERATIONS.length, "a file is registered twice; merge its sites into one entry in source order");

  const found = scan();
  const problems: string[] = [];
  for (const [file, { sites }] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = registered.get(file);
    const where = sites.map((site) => `      line ${site.line}: ${site.text}`).join("\n");
    if (!entry) {
      problems.push(
        `${file} enumerates table columns from the PostgreSQL catalog at ${sites.length} site(s) but is not registered:\n${where}\n` +
        `    Register it in engine/src/testing/column-enumerations.ts and declare, per site, what it does about GENERATED ALWAYS columns:\n${stanceMenu()}`,
      );
      continue;
    }
    if (entry.sites.length !== sites.length) {
      problems.push(
        `${file} has ${sites.length} catalog enumeration site(s) but the registry declares ${entry.sites.length}:\n${where}\n` +
        `    Every site declares its own stance, in source order. Stances:\n${stanceMenu()}`,
      );
    }
  }
  for (const entry of COLUMN_ENUMERATIONS) {
    if (!found.has(entry.file)) {
      problems.push(`${entry.file} is registered but no longer enumerates catalog columns (or the file is gone); remove its registration`);
    }
  }
  assert.equal(problems.length, 0, `\n${problems.join("\n\n")}\n`);
});

test("every feeds-a-write enumeration visibly excludes generated columns", () => {
  const found = scan();
  const problems: string[] = [];
  for (const entry of COLUMN_ENUMERATIONS) {
    const file = found.get(entry.file);
    if (!file || file.sites.length !== entry.sites.length) continue; // reported by the registry test
    entry.sites.forEach((declared, index) => {
      if (declared.stance !== "feeds-a-write") return;
      const site = file.sites[index]!;
      const from = Math.max(0, site.line - 1 - FILTER_WINDOW.before);
      const to = Math.min(file.lines.length, site.line - 1 + FILTER_WINDOW.after + 1);
      const window = file.lines.slice(from, to).join("\n");
      if (!GENERATED_FILTER_RE.test(window)) {
        problems.push(
          `${entry.file} line ${site.line} is declared feeds-a-write but nothing within ${FILTER_WINDOW.before} lines above / ` +
          `${FILTER_WINDOW.after} below mentions is_generated or attgenerated. ${STANCES["feeds-a-write"]}.`,
        );
      }
    });
  }
  assert.equal(problems.length, 0, `\n${problems.join("\n\n")}\n`);
});

test("the stance menu names the consequence a new enumeration must reason about", () => {
  // The failure text is the documentation; keep it from drifting into jargon.
  for (const [stance, meaning] of Object.entries(STANCES)) {
    assert.ok(meaning.length > 60, `${stance} needs a sentence a newcomer can act on`);
  }
  assert.match(STANCES["feeds-a-write"], /is_generated = 'NEVER'/);
});
