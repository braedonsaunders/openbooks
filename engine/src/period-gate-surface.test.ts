import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * One period gate (fleet 8, P7): app-layer code must never call the raw
 * `period_module_is_closed()` SQL function directly. That function knows
 * nothing about the allowImportedLocks exemption — it refuses
 * source-owned imported locks exactly like user locks — while the shared
 * app gate (assertPeriodModulesOpen / arePeriodModulesOpen in
 * engine/src/close.ts) carries the exemption policy explicitly, defaulting
 * to no exemption. Every direct caller is a second, silent answer to "may
 * something post into this period" that can disagree with the gate: a
 * migration replay allowed through postDocument --migration would be
 * refused by whichever engine still asked the raw function, or — far
 * worse — a future caller could pick the raw function thinking it is the
 * whole rule and silently stop refusing.
 *
 * Route through the shared gate instead: assertPeriodModulesOpen for
 * fail-fast checks, arePeriodModulesOpen for advisory discovery
 * (runners that skip closed periods). Leave allowImportedLocks unset —
 * only historical replay (the engine/src/posting.ts migration path, backed
 * by the je_guard storage guard) may opt into crossing source-owned
 * locks. A SQL-level check that genuinely cannot go through the app gate
 * must use the p_allow_imported-aware period_module_blocks_write, never
 * the raw function.
 */

const APP_ROOTS = ["engine/src", "web"];
const CALL = /period_module_is_closed\s*\(/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "node_modules") continue;
      yield* sourceFiles(path);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      yield path;
    }
  }
}

/** Strip block and line comments so explanatory prose never trips the ban. */
function codeOnly(text: string): string {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlocks
    .split("\n")
    .map((line) => {
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === "/" && line[i + 1] === "/" && !inSingle && !inDouble) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

test("app-layer code never calls raw period_module_is_closed SQL", () => {
  const offenders: string[] = [];
  for (const root of APP_ROOTS) {
    for (const file of sourceFiles(join(import.meta.dirname, "..", "..", root))) {
      const text = readFileSync(file, "utf8");
      if (CALL.test(codeOnly(text))) offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `direct period_module_is_closed() calls answer "may this post" without the ` +
      `allowImportedLocks exemption policy the shared gate carries: route through ` +
      `assertPeriodModulesOpen / arePeriodModulesOpen in engine/src/close.ts ` +
      `(default: imported locks refuse like user locks; only historical replay ` +
      `may opt in). Offenders:\n${offenders.join("\n")}`,
  );
});

test("the comment stripper sees through explanatory prose", () => {
  assert.ok(!CALL.test(codeOnly(`// period_module_is_closed(org) is banned\nconst ok = 1;`)));
  assert.ok(!CALL.test(codeOnly(`/* period_module_is_closed(org) */\nconst ok = 1;`)));
  assert.ok(CALL.test(codeOnly(`select period_module_is_closed(\${orgId}, p.id) as closed`)));
});
