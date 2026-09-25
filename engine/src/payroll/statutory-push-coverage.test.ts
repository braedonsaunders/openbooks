/**
 * Every pushed statutory line is declared by its pack.
 *
 * `statutoryAssessment()` throws on a (systemKey, kind) the pack does not
 * declare — Spain shipped an engine pushing ten keys with two declared and
 * could not run a payroll at all, while its goldens stayed green because
 * they exercised the pure engine, never the push path. This test closes the
 * CLASS: for every pack in the registry it extracts each `pushStatutory`
 * call's (systemKey, kind) from the pack's own sources and requires a
 * matching declared component with an honest assessedOn.
 *
 * The scan is static on purpose: a dynamic run only covers the branches its
 * fixture hits (conditionally pushed lines would slip through), while every
 * call SITE is enumerated here whatever the inputs. Non-literal keys fail
 * the scan loudly so a future dynamic push cannot pass silently — the
 * sanctioned shapes are a `"literal"` key with a `"literal"` kind, and the
 * levy dispatch (I6-payroll-207), which checks the fallback arms plus every
 * routed `statutoryComponent`. A match never spans calls.
 *
 * Run with `node --import tsx` on this file. Run from the repo root: like
 * pack-load-order.test.ts it resolves `engine/src/payroll` relatively.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { PAYROLL_COUNTRY_PACKS } from "./packs.ts";

/** Pack country → source directory (Canada's is `canada`, not `ca`). */
const PACK_DIRS: Record<string, string> = {
  CA: "canada",
  US: "us",
  GB: "gb",
  DE: "de",
  FR: "fr",
  IE: "ie",
  AU: "au",
  IT: "it",
  NL: "nl",
  ES: "es",
  SG: "sg",
  JP: "jp",
  PL: "pl",
  BR: "br",
};

/** Key expr never spans calls: a dynamic site cannot swallow its neighbour's kind literal. */
const PUSH_CALL = /pushStatutory\(\s*((?:(?!pushStatutory\()[\s\S])*?),\s*"([^"]+)"\s*,/g;
/** The levy dispatch key and its kind default, both pinned exactly. */
const DISPATCH_CALL = /pushStatutory\(\s*levy\.statutoryComponent\?\.systemKey\s*\?\?\s*\(\s*[\s\S]*?\?\s*"([^"]+)"\s*:\s*"([^"]+)"\s*\)\s*,\s*levy\.statutoryComponent\?\.kind\s*\?\?\s*"([^"]+)"\s*,/g;
/** `statutoryComponent: { systemKey: "x", kind: "y" }` in a jurisdiction declaration. */
const COMPONENT_DECL = /statutoryComponent:\s*\{\s*systemKey:\s*"([^"]+)"\s*,\s*kind:\s*"([^"]+)"\s*\}/g;
/** `"key"` and nothing else. */
const SINGLE_KEY = /^\s*"([^"]+)"\s*$/;

type PushTarget = { systemKey: string; kind: string };
function pushedKeys(source: string, path: string, componentTargets: PushTarget[]): PushTarget[] {
  const found: Array<{ systemKey: string; kind: string }> = [];
  for (const dispatch of source.matchAll(DISPATCH_CALL)) {
    found.push(
      { systemKey: dispatch[1] ?? "", kind: dispatch[3] ?? "" },
      { systemKey: dispatch[2] ?? "", kind: dispatch[3] ?? "" },
      ...componentTargets,
    );
  }
  for (const match of source.matchAll(PUSH_CALL)) {
    const keyExpr = match[1] ?? "";
    const kind = match[2] ?? "";
    const single = SINGLE_KEY.exec(keyExpr);
    assert.ok(
      single,
      `${path}: non-literal pushStatutory key has no declared shape `
        + `(only "literal" and the levy dispatch are covered): ${keyExpr.trim().slice(0, 120)}`,
    );
    found.push({ systemKey: single[1] ?? "", kind });
  }
  return found;
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.[cm]?tsx?$/.test(entry.name)) continue;
      // Test files push through recording stubs with arbitrary keys — they
      // exercise nothing production consults, so they are out of scope.
      if (/\.test\.[cm]?tsx?$/.test(entry.name)) continue;
      out.push(path);
    }
  };
  walk(dir);
  return out;
}

test("every pushed (systemKey, kind) is declared, for every pack", () => {
  const undeclared: string[] = [];
  for (const [country, pack] of Object.entries(PAYROLL_COUNTRY_PACKS)) {
    const dirName = PACK_DIRS[country];
    assert.ok(dirName, `no source directory mapped for pack ${country} — extend PACK_DIRS`);
    const declared = new Map<string, string>(
      pack.statutorySlots.flatMap((slot) =>
        slot.components.map((component) =>
          [`${component.systemKey}|${component.kind}`, component.assessedOn] as const),
      ),
    );
    const paths = sourcesUnder(join("engine", "src", "payroll", dirName));
    // Every levy-routed push target the pack declares: the dispatch above
    // can push any of these, so each must be a declared component.
    const componentTargets: Array<{ systemKey: string; kind: string }> = [];
    for (const path of paths) {
      const source = readFileSync(path, "utf8");
      for (const decl of source.matchAll(COMPONENT_DECL)) {
        componentTargets.push({ systemKey: decl[1] ?? "", kind: decl[2] ?? "" });
      }
    }
    for (const path of paths) {
      const source = readFileSync(path, "utf8");
      for (const pushed of pushedKeys(source, path, componentTargets)) {
        const assessedOn = declared.get(`${pushed.systemKey}|${pushed.kind}`);
        if (assessedOn === "earnings" || assessedOn === "taxable_income") continue;
        undeclared.push(
          `${country}: ${path} pushes undeclared ${pushed.systemKey}/${pushed.kind}`,
        );
      }
    }
  }
  assert.deepEqual(
    undeclared,
    [],
    "pushed lines with no pack declaration throw in statutoryAssessment:\n"
      + undeclared.join("\n"),
  );
});
