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
 * the scan loudly so a future dynamic push cannot pass silently — the one
 * sanctioned shape is a `cond ? "a" : "b"` ternary, both arms checked (the
 * US state/local split).
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
};

/** `pushStatutory(<key expr>, "<kind>", ...)` — key expr is one literal or a ternary. */
const PUSH_CALL = /pushStatutory\(\s*([\s\S]*?),\s*"([^"]+)"\s*,/g;
/** `cond ? "a" : "b"` — both arms are pushed keys when the call runs. */
const TERNARY_KEYS = /^\s*[\s\S]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\s*$/;
/** `"key"` and nothing else. */
const SINGLE_KEY = /^\s*"([^"]+)"\s*$/;

function pushedKeys(source: string, path: string): Array<{ systemKey: string; kind: string }> {
  const found: Array<{ systemKey: string; kind: string }> = [];
  for (const match of source.matchAll(PUSH_CALL)) {
    const keyExpr = match[1] ?? "";
    const kind = match[2] ?? "";
    const ternary = TERNARY_KEYS.exec(keyExpr);
    if (ternary) {
      found.push({ systemKey: ternary[1] ?? "", kind }, { systemKey: ternary[2] ?? "", kind });
      continue;
    }
    const single = SINGLE_KEY.exec(keyExpr);
    assert.ok(
      single,
      `${path}: non-literal pushStatutory key has no declared shape `
        + `(only "literal" and 'cond ? "a" : "b"' are covered): ${keyExpr.trim().slice(0, 120)}`,
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
    for (const path of sourcesUnder(join("engine", "src", "payroll", dirName))) {
      const source = readFileSync(path, "utf8");
      for (const pushed of pushedKeys(source, path)) {
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
