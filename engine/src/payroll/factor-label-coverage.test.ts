import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  factorLabelForPack,
  PAYROLL_COUNTRY_PACKS,
  type PayrollCountryPack,
} from "./packs.ts";
import { calculatePub15T } from "./us/pub15t.ts";
import type { FilingStatus } from "./us/rates.ts";
import { calculateT4127 } from "./canada/t4127.ts";
import type { Province } from "./canada/rates.ts";
import { calculateTp1015 } from "./canada/quebec/tp1015.ts";

// Every factor a pack's engine can trace must resolve to a label that is
// not the code echoed back — otherwise the stub trace renders the code
// twice (the label falls back to the key AND the key prints beside it).
//
// The traced set is DERIVED, never restated: the guard scans each pack's
// own sources for every channel a factor reaches the stub through, and
// drives the fixture-free pure engines (Pub 15-T, T4127, TP-1015) to catch
// keys no literal names (T4127's annualTax parts, TP-1015's QC_ prefix).
// A hardcoded list of codes would go stale the moment someone traces a new
// factor — which is exactly how this class reached 211 unlabeled.
//
// computeStatutory itself is DB-backed and unreachable here, so its extras
// (B/I/PI/IE, the conditional levy factors, SIT_/LIT_ mirrors) are covered
// by scanning its source: literal keys must be labelled, and genuinely
// open-ended keys (operator-entered sub-region codes) must be described by
// the pack's describeFactor instead of a map.

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** Registry country → source directory (repo layout, not tax doctrine). */
function sourceDir(country: string): string {
  if (country === "CA") return join(HERE, "canada");
  if (country === "US") return join(HERE, "us");
  return join(HERE, country.toLowerCase());
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts") && !entry.includes(".test.")) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Strip strings, template literals, regex literals and comments so braces
 * inside them cannot fool the block scan. A char scanner, not a regex:
 * prose apostrophes ("employee's") would pair up as string delimiters and
 * swallow real code, and byte-read regexes mislead (tool display doubles
 * backslashes), so no pattern here contains one.
 *
 * Regex literals use the standard heuristic: a `/` opens one when the
 * previous significant character cannot end an expression. The scanned
 * sources only need the `= /.../.exec(...)` shape, but the heuristic
 * covers the general positions so a future literal does not silently
 * shift a block boundary (a shifted boundary hides keys — a false green,
 * the one direction this guard must never fail).
 */
function codeOnly(source: string): string {
  let out = "";
  let state: "code" | "sq" | "dq" | "tpl" | "regex" | "line" | "block" = "code";
  let lastSig = "";
  const tplStack: number[] = [];
  let i = 0;
  const push = (ch: string): void => {
    out += ch;
    if (ch.trim() !== "") lastSig = ch;
  };
  const regexOpens = (): boolean => {
    if (lastSig === "") return true;
    if ("=(:,[!&|?;{".includes(lastSig)) return true;
    return /(?:^|[^A-Za-z0-9_$])(?:return|typeof|case|do|else|in|of|new|delete|void|yield|await)\s*$/.test(out);
  };
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1] ?? "";
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        push(ch);
      }
      i++;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      if (ch === "\n") push(ch);
      i++;
      continue;
    }
    if (state === "sq" || state === "dq") {
      const quote = state === "sq" ? "'" : "\"";
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) state = "code";
      if (ch === "\n") push(ch);
      i++;
      continue;
    }
    if (state === "regex") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n") {
        state = "code";
        push(ch);
        i++;
        continue;
      }
      if (ch === "/") {
        state = "code";
        i++;
        while (/[a-z]/.test(source[i] ?? "")) i++;
        continue;
      }
      i++;
      continue;
    }
    if (state === "tpl") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        state = "code";
        i++;
        continue;
      }
      if (ch === "$" && next === "{") {
        tplStack.push(0);
        state = "code";
        push("{");
        i += 2;
        continue;
      }
      if (ch === "\n") push(ch);
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (ch === "'") {
      state = "sq";
      i++;
      continue;
    }
    if (ch === "\"") {
      state = "dq";
      i++;
      continue;
    }
    if (ch === "`") {
      state = "tpl";
      i++;
      continue;
    }
    if (ch === "/" && regexOpens()) {
      state = "regex";
      i++;
      continue;
    }
    if (ch === "{") {
      if (tplStack.length > 0) tplStack[tplStack.length - 1]! += 1;
      push(ch);
      i++;
      continue;
    }
    if (ch === "}") {
      if (tplStack.length > 0) {
        const top = tplStack[tplStack.length - 1]! - 1;
        if (top < 0) {
          tplStack.pop();
          state = "tpl";
          i++;
          continue;
        }
        tplStack[tplStack.length - 1]! = top;
      }
      push(ch);
      i++;
      continue;
    }
    push(ch);
    i++;
  }
  return out;
}

/**
 * ALL_CAPS `KEY:` entries of one brace block. The key must follow `{` or
 * `,` — otherwise camelCase fields like `arrcoSalT1:` yield a phantom `T1`
 * (seen live against fr/cotisations.ts). Line-start anchoring would miss
 * single-line returns (`return { I: income, PI: pensionable }`), and the
 * minimum length is zero because single-letter factors exist (`I:`, `L:`).
 */
function blockKeys(block: string): string[] {
  const keys: string[] = [];
  for (const match of block.matchAll(/(?:\{|,)\s*([A-Z][A-Z0-9_]{0,40})\s*:/g)) {
    keys.push(match[1]!);
  }
  return keys;
}

/**
 * Every `{ ... }` block opened by `return {`, `factors = {`, or a factors
 * variable declaration — brace-depth walked, so nested ternaries and
 * spreads cannot cut the block short.
 */
function literalBlocks(clean: string): string[] {
  const blocks: string[] = [];
  const opener = /(?:return|factors)\s*(?::[^=;]+)?=\s*\{|return\s*\{|(?:const|let|var)\s+factors\s*(?::[^=;]+)?=\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(clean)) !== null) {
    let depth = 0;
    let i = match.index + match[0].length - 1;
    for (; i < clean.length; i++) {
      if (clean[i] === "{") depth++;
      else if (clean[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(clean.slice(match.index, i + 1));
  }
  return blocks;
}

interface TracedSet {
  keys: Map<string, string>;
  openEnded: boolean;
}

function collectStatic(dir: string): TracedSet {
  const keys = new Map<string, string>();
  let openEnded = false;
  for (const file of sourceFiles(dir)) {
    const source = readFileSync(file, "utf8");
    const relative = file.slice(HERE.length);
    const quebecPrefixed = file.endsWith(join("quebec", "tp1015.ts"));
    for (const match of source.matchAll(/trace\("([A-Za-z0-9_]+)"\)/g)) {
      const key = quebecPrefixed ? `QC_${match[1]!}` : match[1]!;
      if (!keys.has(key)) keys.set(key, relative);
    }
    for (
      const match of source.matchAll(/factors\.([A-Z][A-Za-z0-9_:]*)\s*=/g)
    ) {
      if (!keys.has(match[1]!)) keys.set(match[1]!, relative);
    }
    for (
      const match of source.matchAll(/factors\["([A-Z][A-Za-z0-9_:]*)"\]\s*=/g)
    ) {
      if (!keys.has(match[1]!)) keys.set(match[1]!, relative);
    }
    const clean = codeOnly(source);
    for (const block of literalBlocks(clean)) {
      for (const key of blockKeys(block)) {
        const labelled = quebecPrefixed && !key.startsWith("QC_")
          ? `QC_${key}`
          : key;
        if (!keys.has(labelled)) keys.set(labelled, relative);
      }
    }
    // Template-literal keys in factors flows (`factors[`QC_${k}`]`,
    // `{ [`SIT_..._${code}`]: ... }`). The QC_ prefix is fully enumerated
    // by the trace scan above; anything else is open-ended and must be
    // described by the pack's describeFactor, never enumerated.
    for (const match of clean.matchAll(/factors\[\s*`([^`]*)\]/g)) {
      const prefix = match[1]!.split("${")[0]!;
      if (!prefix.startsWith("QC_")) openEnded = true;
    }
    for (const match of clean.matchAll(/\[\s*`([^`]*\$\{[^`]*)\]\s*:/g)) {
      const prefix = match[1]!.split("${")[0]!;
      if (!prefix.startsWith("QC_")) openEnded = true;
    }
  }
  return { keys, openEnded };
}

/**
 * Fixture-free pure engines, driven over representative 2026 inputs. This
 * catches keys no literal names: T4127's annualTax parts (K1..T2, whose
 * provincial half differs by province — ON for the full set, QC for the
 * abatement, ZZ for the outside-Canada surtax) and the bonus path (F5B,
 * TB, I2/AB need non-periodic pay).
 */
function collectDynamic(country: string): Map<string, string> {
  const keys = new Map<string, string>();
  const add = (factors: Record<string, string>, origin: string): void => {
    for (const key of Object.keys(factors)) {
      if (!keys.has(key)) keys.set(key, origin);
    }
  };
  if (country === "US") {
    add(
      calculatePub15T({
        payDate: "2026-06-15",
        periodsPerYear: 26,
        wages: "2000",
        supplemental: "500",
        filingStatus: "single" as FilingStatus,
      }).factors,
      "calculatePub15T",
    );
  }
  if (country === "CA") {
    for (const province of ["ON", "QC", "ZZ"] as Province[]) {
      add(
        calculateT4127({
          payDate: "2026-03-15",
          province,
          periodsPerYear: 26,
          income: "2000",
          nonPeriodic: "500",
        }).factors,
        `calculateT4127/${province}`,
      );
    }
    add(
      calculateTp1015({
        payDate: "2026-03-15",
        periodsPerYear: 26,
        income: "2000",
        nonPeriodic: "500",
        qpp: "100",
        pensionable: "2500",
      }).factors,
      "calculateTp1015",
    );
  }
  return keys;
}

function tracedKeys(pack: PayrollCountryPack): { keys: Map<string, string>; openEnded: boolean } {
  const { keys, openEnded } = collectStatic(sourceDir(pack.country));
  for (const [key, origin] of collectDynamic(pack.country)) {
    if (!keys.has(key)) keys.set(key, origin);
  }
  return { keys, openEnded };
}

for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
  test(`${pack.country}: every traced factor resolves to a real label`, () => {
    const { keys, openEnded } = tracedKeys(pack);
    assert.ok(keys.size > 0, `${pack.country} traces no factors at all`);
    if (openEnded) {
      assert.equal(
        typeof pack.describeFactor,
        "function",
        `${pack.country} emits open-ended factor keys but declares no describeFactor`,
      );
    }
    for (const [key, origin] of keys) {
      const label = factorLabelForPack(pack, key);
      assert.ok(
        typeof label === "string" && label.length > 0 && label !== key,
        `${pack.country}/${key} (from ${origin}) has no pack-declared label`,
      );
    }
  });

  test(`${pack.country}: declared labels are real strings`, () => {
    for (const [key, label] of Object.entries(pack.factorLabels)) {
      assert.ok(
        typeof label === "string" && label.length > 0,
        `${pack.country}/${key} declares an empty label`,
      );
    }
  });
}
