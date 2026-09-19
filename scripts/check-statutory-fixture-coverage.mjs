// Static guard for the refuse-by-name fixture gap: a commit made
// live-but-unconfigured statutory levies REFUSE BY NAME instead of accruing
// 0.00, and every test fixture that had been relying on a zero broke one CI
// round at a time (holiday-eligibility, ytd-tax, then e2e ca_hsf, employer
// cost, us_sui across four partitions and six hours), because a fail-fast
// suite reports the FIRST failure and never the COUNT.
//
// This guard answers one question mechanically: WHICH FIXTURES SEED AN
// EMPLOYEE IN A REGION A SLOT COVERS, AND DO NOT CONFIGURE THAT SLOT?
//
// Both sides are DERIVED, never listed:
//   - coverage: every statutory rate slot in every registered pack, read off
//     PAYROLL_COUNTRY_PACKS / each pack's statutoryRates (the slot
//     declarations carry country, scope, regions and whenUnconfigured).
//     Only whenUnconfigured === "refuse" slots can break a fixture.
//   - seeds: (country, region) pairs from employee profile fixtures — SQL
//     INSERTs and UPDATEs on employee_payroll_profiles, POSTs to
//     /api/payroll/profiles (flat object literals carrying employeePartyId),
//     with one-hop value resolution (const bindings, helper params bound at
//     call sites with defaults, ?? fallbacks, ternaries, member access
//     through in-file const objects and in-file helper returns).
//   - configs: the engine's upsertStatutoryRate, raw SQL inserts into
//     payroll_statutory_rates, PUT/POST to /api/payroll/settings/rates, and
//     the legacy settings blob (payroll.us.sui.<REGION>) the packs still
//     honour as a fallback. A trigger whose slot cannot be resolved is a
//     LOUD unknown-config finding, never silent absence: a false "at risk"
//     costs five minutes, a false "safe" costs six hours. Unresolvable seed
//     regions are likewise loud unknown-seed findings.
//
// Second dimension: COUNTRY-SPECIFIC BEHAVIOUR HIDDEN AS LOWERCASE
// SYSTEM-KEY LITERALS IN GENERIC PRODUCT CODE. check-country-neutrality
// matches UPPERCASE country/form codes, so a lowercase list like the payslip
// YTD subquery's ('income_tax', 'qc_income_tax', 'fit', ...) passes it clean
// while nine packs print YTD tax 0.00 (and Italy prints short). The
// vocabulary (systemKeys from every pack's components plus slot systemKeys)
// is derived from the registry — never listed here. A generic product file
// naming a pack's key is a country branch in disguise or a set that goes
// stale on the next pack; either way it fails until allowlisted with a
// reason.
//
// WHAT THIS GUARD DOES NOT COVER (a guard trusted for more than it checks
// is worse than no guard):
//   - test files for dimension 2: expectations pin behaviour loudly, and
//     staleness there is a coverage gap, not wrong money on a document.
//   - dynamically built keys (`${country}_tax`, concatenation, lookups by
//     variable): no literal, no finding. If you build a key dynamically in
//     generic code, you own the proof it resolves for every pack.
//   - frozen migrations: they enumerate old key sets by design (history
//     cannot be edited); the forward-migration rule owns their staleness.
//   - the constraint's other two layers: a key filtered in SQL but also
//     declared in a column default, a field schema, or a handler is still
//     half-present — absence in the scanned layer proves nothing about the
//     others. If you conclude a document is pack-clean, check all three.
//   - cross-file helpers for dimension 1: seed/config resolution stays
//     inside one file (call-site unions, not imports). A helper in another
//     file seeding a covered region is out of reach — say so if you add one.
//
// Needs no database (pure text scan + registry import), so every shard runs
// it. Run with `node --import tsx` (it imports the pack registry):
//   node --import tsx scripts/check-statutory-fixture-coverage.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  declaredPackRates,
  packRates,
  packStatutoryComponents,
  PAYROLL_COUNTRY_PACKS,
} from "../engine/src/payroll/packs.ts";
import { splitTests } from "./check-test-loop-anchors.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TEST_RE = /\.test\.(ts|tsx|mts|mjs|js|jsx)$/;
const E2E_RE = /\.spec\.ts$/;
const FIXTURE_BASE_RE = /(fixture|fixtures|seed|seeds|helper|helpers)/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);
const SCAN_SUBS = ["engine/src", "web", "packages", "schema", "e2e"];

export function collectTestFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (TEST_RE.test(entry) || E2E_RE.test(entry) || FIXTURE_BASE_RE.test(entry)) out.push(path);
    }
  };
  for (const sub of SCAN_SUBS) {
    try {
      if (statSync(join(root, sub)).isDirectory()) walk(join(root, sub));
    } catch { /* optional tree absent */ }
  }
  return out.sort();
}

const rel = (path, root) => (path.startsWith(root + "/") ? path.slice(root.length + 1) : path);

// ---------------------------------------------------------------------------
// Coverage, derived from the pack registry (never listed here).
// ---------------------------------------------------------------------------

/** Every refuse-when-unconfigured slot with the regions it covers. */
export function refuseSlots(
  rates = declaredPackRates(),
  packs = PAYROLL_COUNTRY_PACKS,
) {
  const out = [];
  for (const entry of rates) {
    const known = packs[entry.country]?.regions?.known ?? [];
    for (const slot of entry.slots) {
      if (slot.whenUnconfigured !== "refuse") continue;
      out.push({
        country: entry.country,
        key: slot.key,
        scope: slot.scope,
        regions: slot.scope === "org"
          ? null
          : (slot.regions ? [...slot.regions] : [...known]),
      });
    }
  }
  return out;
}

/** True when a (country, region) seed is inside a slot's coverage. */
export function slotCovers(slot, country, region) {
  if (slot.country !== country) return false;
  if (slot.scope === "org") return true;
  return slot.regions.includes(region);
}

// ---------------------------------------------------------------------------
// Length-preserving comment mask: triggers must be code, but string and
// template contents are the signal (SQL lives in template text), so unlike
// codeOnly only comments are blanked.
// ---------------------------------------------------------------------------

export function maskComments(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  while (i < n) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] !== "/" && src[i + 1] !== "*") {
      const j = skipRegex(src, i);
      if (j > i) { i = j; continue; }
    }
    if (ch === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (ch === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      blank(i, j < 0 ? n : j + 2);
      i = j < 0 ? n : j + 2;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(src, i);
    } else {
      i++;
    }
  }
  return out.join("");
}

function skipString(src, i) {
  const quote = src[i];
  const n = src.length;
  i++;
  let depth = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (quote === "`" && ch === "$" && src[i + 1] === "{") { i += 2; depth++; continue; }
    if (quote === "`" && depth > 0 && ch === "{") { depth++; i++; continue; }
    if (quote === "`" && depth > 0 && ch === "}") { depth--; i++; continue; }
    if (depth === 0 && ch === quote) return i + 1;
    if (depth === 0 && quote !== "`" && ch === "\n") return i;
    if (ch === "'" || ch === '"' || (ch === "`" && depth > 0)) {
      // A nested string inside ${...}: skip it whole so its braces cannot
      // close the interpolation early.
      if (depth > 0) { i = skipString(src, i); continue; }
    }
    i++;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Balanced-delimiter helpers over masked source (offsets match raw source).
// ---------------------------------------------------------------------------

const OPEN = { "(": ")", "[": "]", "{": "}" };
const CLOSE = { ")": "(", "]": "[", "}": "{" };

/**
 * Skip a regex literal starting at `i` (text[i] === "/"), or -1 when the
 * slash is division. A `/` opens a regex when the previous significant
 * token expects an expression (start, opener, operator, comma, semicolon,
 * `=>`, or keywords like `return`/`typeof`/`case`). Character classes and
 * escapes are honoured so `[(]` or `\/` cannot end the literal early.
 */
export function skipRegex(text, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(text[k])) k--;
  const prev = k >= 0 ? text[k] : "";
  const word = (text.slice(0, k + 1).match(/[A-Za-z_$][\w$]*$/) ?? [])[0] ?? "";
  const expectsExpr = prev === "" || ",=:[(!&|?{};+-*%<>^~".includes(prev)
    || (prev === ">" && text[k - 1] === "=")
    || /^(?:return|typeof|case|in|of|new|delete|void|throw|do|else|yield|await)$/.test(word);
  if (!expectsExpr) return -1;
  let j = i + 1;
  let inClass = false;
  while (j < text.length) {
    const ch = text[j];
    if (ch === "\\") { j += 2; continue; }
    if (ch === "\n") return -1;
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      j++;
      while (j < text.length && /[a-z]/i.test(text[j])) j++;
      return j;
    }
    j++;
  }
  return -1;
}

/** Advance one step in a delimiter walk, skipping strings/comments/regex. */
function walkStep(text, i) {
  const ch = text[i];
  if (ch === "'" || ch === '"' || ch === "`") return skipString(text, i);
  if (ch === "/" && text[i + 1] === "/") {
    let j = i;
    while (j < text.length && text[j] !== "\n") j++;
    return j;
  }
  if (ch === "/" && text[i + 1] === "*") {
    const j = text.indexOf("*/", i + 2);
    return j < 0 ? text.length : j + 2;
  }
  if (ch === "/") {
    const j = skipRegex(text, i);
    if (j > i) return j;
  }
  return i;
}

/** Index just past the closer matching the opener at `open`, or -1. */
export function matchClose(text, open) {
  const want = OPEN[text[open]];
  if (!want) return -1;
  let i = skipString(text, open) === open + 1 && false ? open : open;
  // Reuse the string skipper: start inside the opener.
  i = open + 1;
  let depth = 1;
  const n = text.length;
  while (i < n) {
    const stepped = walkStep(text, i);
    if (stepped !== i) { i = stepped; continue; }
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (ch === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (OPEN[ch]) depth++;
    else if (CLOSE[ch]) {
      depth--;
      if (depth === 0) return ch === want ? i + 1 : -1;
    }
    i++;
  }
  return -1;
}

/** Split on `sep` at nesting depth 0 (string-aware). */
export function splitTopLevel(text, sep = ",") {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const stepped = walkStep(text, i);
    if (stepped !== i) { i = stepped; continue; }
    const ch = text[i];
    if (OPEN[ch]) depth++;
    else if (CLOSE[ch]) depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
    i++;
  }
  parts.push(text.slice(start));
  return parts;
}

/** Top-level `key: value` (or shorthand `key`) pairs of an object literal. */
export function objectPairs(body) {
  const out = [];
  for (const part of splitTopLevel(body)) {
    const match = part.match(/^\s*(?:["']?)([A-Za-z_$][\w$]*)(?:["']?)\s*(:\s*([\s\S]*))?$/);
    if (!match) continue;
    out.push({ key: match[1], value: match[3] ?? null });
  }
  return out;
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

// ---------------------------------------------------------------------------
// One-hop value resolution. Returns { values: string[] } or { unknown }.
// Over-approximates (unions every spelling it can see); anything it cannot
// see is UNKNOWN, which the caller reports loudly, never as absent.
// ---------------------------------------------------------------------------

export function functionDefs(masked) {
  const defs = new Map();
  const push = (name, paramsText, defStart, paramsEnd) => {
    if (!defs.has(name)) defs.set(name, []);
    // Body extent: the first brace block after the parameter list, so call
    // sites inside the signature itself never count and helpers can be
    // attributed to the tests that call them.
    let bodyStart = -1;
    let bodyEnd = -1;
    const brace = masked.indexOf("{", paramsEnd);
    if (brace >= 0 && brace - paramsEnd < 500) {
      const close = matchClose(masked, brace);
      if (close > brace) { bodyStart = brace; bodyEnd = close; }
    }
    defs.get(name).push({ name, paramsText, defStart, paramsEnd, bodyStart, bodyEnd });
  };
  for (const m of masked.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const paramsOpen = m.index + m[0].length - 1;
    const paramsEnd = matchClose(masked, paramsOpen);
    if (paramsEnd < 0) continue;
    push(m[1], masked.slice(paramsOpen), m.index, paramsEnd);
  }
  for (const m of masked.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) {
    // Arrow with parenthesised params: `name = async (a, b) =>`.
    const paramsOpen = masked.indexOf("(", m.index);
    const paramsEnd = matchClose(masked, paramsOpen);
    if (paramsEnd < 0) continue;
    const after = masked.indexOf("=>", paramsEnd);
    if (after > 0 && after - paramsEnd < 200) {
      push(m[1], masked.slice(paramsOpen), m.index, paramsEnd);
    }
  }
  return defs;
}

export function paramsOf(paramsText) {
  const open = paramsText.indexOf("(");
  const close = matchClose(paramsText, open);
  if (open < 0 || close < 0) return [];
  return splitTopLevel(paramsText.slice(open + 1, close - 1)).map((part) => {
    // TypeScript annotations sit between the name and any default
    // (`province: string = "QC"`): the name leads, the default follows the
    // first top-level `=` that is not part of `=>`, `==`, `!=`, `<=`, `>=`.
    const name = (part.match(/^\s*([A-Za-z_$][\w$]*)/) ?? [])[1];
    if (!name) return null;
    let eq = -1;
    let depth = 0;
    let i = 0;
    while (i < part.length) {
      const stepped = walkStep(part, i);
      if (stepped !== i) { i = stepped; continue; }
      const ch = part[i];
      if (OPEN[ch]) depth++;
      else if (CLOSE[ch]) depth--;
      else if (depth === 0 && ch === "=" && part[i + 1] !== ">" && part[i + 1] !== "="
        && !/[=<>!]/.test(part[i - 1] ?? "")) {
        eq = i;
        break;
      }
      i++;
    }
    return { name, def: eq >= 0 ? part.slice(eq + 1).trim() || null : null };
  }).filter(Boolean);
}

const inRanges = (ranges, index) =>
  !ranges || ranges.some(([start, end]) => index >= start && index < end);

function constBindings(masked, name, scope = null) {
  const out = [];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of masked.matchAll(new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*`, "g"))) {
    if (scope && !inRanges(scope.ranges, m.index)) continue;
    const start = m.index + m[0].length;
    const ch = masked[start];
    let end;
    if (ch === "{" || ch === "[" || ch === "(") end = matchClose(masked, start);
    else {
      // To the semicolon at depth 0 (or a bounded run when ASI omits it).
      let depth = 0;
      let i = start;
      end = -1;
      while (i < masked.length && i - start < 3000) {
        const stepped = walkStep(masked, i);
        if (stepped !== i) { i = stepped; continue; }
        const c = masked[i];
        if (OPEN[c]) depth++;
        else if (CLOSE[c]) depth--;
        else if (c === ";" && depth === 0) { end = i; break; }
        else if (c === "\n" && depth === 0 && /^(?:const|let|var|function|import|export|return)\b/.test(masked.slice(i + 1, i + 9))) { end = i; break; }
        i++;
      }
      if (end < 0) end = Math.min(masked.length, start + 3000);
    }
    if (end > start) out.push(masked.slice(start, end < 0 ? start : end));
  }
  return out;
}

function callArgs(masked, name, defs = null, scope = null) {
  const out = [];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of masked.matchAll(new RegExp(`\\b${esc}\\s*\\(`, "g"))) {
    // A definition's own parameter list is not a call site.
    if (defs?.has(name) && defs.get(name).some((def) => m.index >= def.defStart && m.index < def.paramsEnd)) continue;
    if (scope && !inRanges(scope.ranges, m.index)) continue;
    const open = masked.indexOf("(", m.index);
    const close = matchClose(masked, open);
    if (open < 0 || close < 0) continue;
    out.push({ args: splitTopLevel(masked.slice(open + 1, close - 1)), index: m.index });
  }
  return out;
}

export function resolveExpr(expr, masked, defs, seen = new Set(), depth = 0, scope = null) {
  if (depth > 10) return { unknown: "resolution depth exceeded" };
  let text = expr.trim();
  // TypeScript postfix non-null assertions (`x!`, `a[0]!`) change nothing
  // static. Strip only postfix `!` (preceded by a value, not followed by
  // `=`), never prefix `!x` and never `!=` / `!==`.
  text = text.replace(/([\w\]\)'"`])!(?![=])/g, "$1");
  // Unwrap one ${...} layer at a time (SQL interpolations).
  while (/^\$\{[\s\S]*\}$/.test(text)) {
    const close = matchClose(text, text.indexOf("${") + 1);
    if (close === text.length) text = text.slice(2, -1).trim();
    else break;
  }
  // Quoted literal (backticks only when uninterpolated — masked source keeps
  // ${...} code, so a backtick holding one is not a literal).
  const q = text.match(/^'((?:[^'\\]|\\.)*)'$/) || text.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (q) return { values: [q[1]] };
  if (/^`[^`$]*$/.test(text) && text.endsWith("`")) return { values: [text.slice(1, -1)] };
  // Array literal: union of elements.
  if (/^\[/.test(text)) {
    const close = matchClose(text, 0);
    if (close === text.length) {
      const values = [];
      for (const el of splitTopLevel(text.slice(1, -1))) {
        const r = resolveExpr(el, masked, defs, seen, depth + 1, scope);
        if (r.unknown) return r;
        values.push(...r.values);
      }
      return { values };
    }
  }
  // ?? / || fallback and ternary: union of every literal branch (condition
  // ignored — over-approximation is the safe direction for seeds).
  const co = splitCoalesce(text);
  if (co) {
    const values = [];
    for (const part of co) {
      const r = resolveExpr(part, masked, defs, seen, depth + 1, scope);
      if (r.unknown) return r;
      values.push(...r.values);
    }
    return { values };
  }
  const tern = splitTernary(text);
  if (tern) {
    const values = [];
    for (const branch of tern) {
      const r = resolveExpr(branch, masked, defs, seen, depth + 1, scope);
      if (r.unknown) return r;
      values.push(...r.values);
    }
    return { values };
  }
  // Member / index access: resolve the base, then the property.
  const mem = splitMember(text);
  if (mem) {
    return resolveMember(mem.base, mem.prop, masked, defs, seen, depth, scope);
  }
  // TypeScript non-null assertions (`x!`, `a[0]!`) change nothing static.
  if (/!$/.test(text) && !/!=/.test(text.slice(-2))) {
    return resolveExpr(text.slice(0, -1).trim(), masked, defs, seen, depth + 1, scope);
  }
  // Numerics/booleans/null flow through (tax years, flags — not regions).
  // Before the identifier branch: `false` is a value, not a binding.
  if (/^(?:null|true|false|-?\d+(?:\.\d+)?)$/.test(text)) return { values: [text] };
  // Bare identifier: destructured loop tuple, const binding, else helper
  // param bound at call sites.
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    if (seen.has(`id:${text}`)) return { unknown: `cyclic binding ${text}` };
    const next = new Set(seen).add(`id:${text}`);
    const destructured = resolveDestructured(text, masked, defs, next, depth, scope);
    if (destructured) return destructured;
    const bound = constBindings(masked, text, scope);
    if (bound.length > 0) {
      const values = [];
      for (const b of bound) {
        const r = resolveExpr(b, masked, defs, next, depth + 1, scope);
        if (r.unknown) return r;
        values.push(...r.values);
      }
      return { values };
    }
    const fromParams = resolveParam(text, masked, defs, next, depth, scope);
    if (fromParams) return fromParams;
    // Uppercase module constants holding region lists are out of scope here;
    // callers surface them as unknown rather than guessed.
    return { unknown: `unbound identifier ${text}` };
  }
  return { unknown: `unhandled expression ${text.slice(0, 60)}` };
}

// Top-level `??` split (ignores `||`/`&&` mixes: only whole-expression
// fallbacks of the `a ?? "LIT"` / `a || "LIT"` shape are unions).
function splitCoalesce(text) {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const stepped = walkStep(text, i);
    if (stepped !== i) { i = stepped; continue; }
    const ch = text[i];
    if (OPEN[ch]) depth++;
    else if (CLOSE[ch]) depth--;
    else if (depth === 0 && (text.startsWith("??", i) || text.startsWith("||", i))) {
      const parts = [text.slice(0, i), text.slice(i + 2)];
      // Only when every operand is present and non-empty.
      if (parts.every((p) => p.trim())) return parts;
      return null;
    }
    i++;
  }
  return null;
}

function splitTernary(text) {
  let depth = 0;
  let q = -1;
  let i = 0;
  while (i < text.length) {
    const stepped = walkStep(text, i);
    if (stepped !== i) { i = stepped; continue; }
    const ch = text[i];
    if (OPEN[ch]) depth++;
    else if (CLOSE[ch]) depth--;
    else if (depth === 0 && ch === "?") q = i;
    else if (depth === 0 && ch === ":" && q >= 0) {
      return [text.slice(q + 1, i), text.slice(i + 1)];
    }
    i++;
  }
  return null;
}

// Split `base.prop`, `base["prop"]` or `base[expr]` into base + prop expr:
// the last top-level `.` or `[` (forward scan, string-aware).
function splitMember(text) {
  let depth = 0;
  let lastDot = -1;
  let lastBracket = -1;
  let k = 0;
  const stepK = () => {
    const stepped = walkStep(text, k);
    if (stepped !== k) { k = stepped; return true; }
    return false;
  };
  while (k < text.length) {
    if (stepK()) continue;
    const ch = text[k];
    if (OPEN[ch]) depth++;
    else if (CLOSE[ch]) depth--;
    else if (depth === 0 && ch === ".") lastDot = k;
    else if (depth === 0 && ch === "[") lastBracket = k;
    k++;
  }
  if (lastBracket > lastDot && lastBracket >= 0) {
    const close = matchClose(text, lastBracket);
    if (close === text.length) {
      return { base: text.slice(0, lastBracket), prop: text.slice(lastBracket + 1, -1) };
    }
  }
  if (lastDot >= 0) {
    const prop = text.slice(lastDot + 1);
    if (/^[A-Za-z_$][\w$]*$/.test(prop)) return { base: text.slice(0, lastDot), prop: `"${prop}"` };
  }
  return null;
}

function resolveMember(base, prop, masked, defs, seen, depth, scope = null) {
  if (seen.has(`m:${base}.${prop}`)) return { unknown: `cyclic member ${base}.${prop}` };
  const next = new Set(seen).add(`m:${base}.${prop}`);
  const b = base.trim();
  // Direct call of an in-file helper: analyse its return object literal with
  // THIS call's arguments bound to its parameters.
  const call = b.match(/^(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/);
  if (call && defs.has(call[1])) {
    return resolveHelperProp(defs.get(call[1])[0], call[2], prop, masked, defs, next, depth, scope);
  }
  // Indexed const object (RAIL_FORMAT[rail]): resolve the index to entries —
  // a literal picks one, a parameter unions its call-site values, anything
  // else unions every entry — then read the property off each.
  const indexed = b.match(/^([A-Za-z_$][\w$]*)\[([\s\S]*)\]$/);
  if (indexed) {
    const bound = constBindings(masked, indexed[1], scope);
    const objects = bound.filter((binding) => /^\{/.test(binding.trim()));
    if (objects.length > 0) {
      const idx = resolveExpr(indexed[2], masked, defs, next, depth + 1, scope);
      const values = [];
      for (const obj of objects) {
        const close = matchClose(obj.trim(), 0);
        const pairs = objectPairs(obj.trim().slice(1, close - 1));
        const picked = idx.unknown
          ? pairs
          : pairs.filter((p) => idx.values.includes(p.key));
        if (picked.length === 0 && !idx.unknown) {
          return { unknown: `index ${indexed[2].slice(0, 30)} absent in ${indexed[1]}` };
        }
        for (const p of picked) {
          if (p.value == null) continue;
          const r = readProp(p.value, prop, masked, defs, next, depth + 1, scope);
          if (r.unknown) return r;
          values.push(...r.values);
        }
      }
      if (values.length > 0) return { values };
      return { unknown: `no readable entry in ${indexed[1]}` };
    }
  }
  // A parameter dotted through (options.country): bind the object at each
  // call site (or the default) and read the property off it.
  if (/^[A-Za-z_$][\w$]*$/.test(b)) {
    const bound = constBindings(masked, b, scope);
    const values = [];
    let found = false;
    for (const binding of bound) {
      const r = readProp(binding, prop, masked, defs, next, depth, scope);
      if (r.unknown) return r;
      found = true;
      values.push(...r.values);
    }
    const objects = paramObjects(masked, defs, b, scope);
    if (objects) {
      for (const arg of objects.exprs) {
        const r = readProp(arg, prop, masked, defs, next, depth, scope);
        if (r.unknown) return r;
        found = true;
        values.push(...r.values);
      }
    }
    if (found) return { values };
    return { unknown: `unbound base ${b}` };
  }
  return { unknown: `unhandled member base ${b.slice(0, 40)}` };
}

// Read `.prop` off an object literal; anything else re-enters member
// resolution on the composed expression (cycle-guarded by the caller).
function readProp(binding, prop, masked, defs, seen, depth, scope = null) {
  const t = binding.trim();
  const key = prop.trim().replace(/^["']|["']$/g, "");
  if (/^\{/.test(t)) {
    const close = matchClose(t, 0);
    if (close < 0) return { unknown: "unbalanced object literal" };
    const body = t.slice(1, close - 1);
    for (const { key: k, value } of objectPairs(body)) {
      if (k === key) {
        if (value == null) return resolveExpr(k, masked, defs, seen, depth + 1, scope);
        return resolveExpr(value, masked, defs, seen, depth + 1, scope);
      }
    }
    // A spread may carry the key; without one the literal is complete and
    // the read is undefined — an empty union, so ?? fallbacks resolve
    // exactly and bare reads surface as empty (loud at pushSeeds).
    if (/\.\.\./.test(body)) return { unknown: `property ${key} possibly spread` };
    return { values: [] };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(t)) {
    const inner = constBindings(masked, t, scope);
    if (inner.length > 0) {
      const values = [];
      for (const b of inner) {
        const r = readProp(b, prop, masked, defs, seen, depth + 1, scope);
        if (r.unknown) return r;
        values.push(...r.values);
      }
      return { values };
    }
  }
  return resolveMember(t, prop, masked, defs, seen, depth, scope);
}

// `for (const [a, b] of [["x", "ON"], ...] as const)`: the identifier is a
// tuple position — union that position across the literal rows. Only the
// needed position must resolve; sibling positions may be dynamic (UUIDs).
export function resolveDestructured(name, masked, defs, seen, depth, scope = null) {
  // Union across every matching loop: one unparseable loop (Object.entries,
  // a helper call) must not shadow a literal one. A loop whose rows parse
  // but whose cell is unresolvable is genuine unknown — unless another loop
  // resolves, union wins (over-approximation is the safe direction).
  const values = [];
  let failure = null;
  for (const m of masked.matchAll(
    /for\s*\(\s*(?:const|let|var)\s*\[([^\]]*)\]\s*of\s*/g,
  )) {
    if (scope && !inRanges(scope.ranges, m.index)) continue;
    const pattern = splitTopLevel(m[1]).map((p) => p.trim());
    const index = pattern.indexOf(name);
    if (index < 0) continue;
    // Balanced read of the iterated array.
    const open = masked.indexOf("[", m.index + m[0].length);
    if (open < 0 || open - (m.index + m[0].length) > 500) continue;
    const close = matchClose(masked, open);
    if (close < 0) continue;
    const rowsText = masked.slice(open + 1, close - 1);
    // A trailing comma leaves an empty final row — not a shape violation.
    const rows = splitTopLevel(rowsText).filter((row) => row.trim() !== "");
    if (rows.length === 0 || !rows.every((row) => row.trim().startsWith("["))) continue;
    for (const row of rows) {
      const trimmed = row.trim();
      const cells = splitTopLevel(trimmed.slice(1, trimmed.lastIndexOf("]")));
      if (index >= cells.length) { failure ??= `tuple index out of range for ${name}`; break; }
      const r = resolveExpr(cells[index], masked, defs, seen, depth + 1, scope);
      if (r.unknown) { failure ??= r.unknown; break; }
      values.push(...r.values);
    }
  }
  if (values.length > 0) return { values };
  if (failure) return { unknown: failure };
  return null;
}

// Call-site argument expressions plus the default for a helper parameter,
// shared by value resolution (resolveParam) and member reads
// (resolveMember, which reads a property off each object instead).
function paramObjects(masked, defs, name, scope = null) {
  const sites = paramCallArgs(masked, defs, name, scope);
  if (!sites) return null;
  const exprs = [...sites.args];
  if (sites.def) exprs.push(sites.def);
  return { exprs };
}

// For a bare identifier that is a helper parameter: every call-site argument
// expression plus the default.
function resolveParam(name, masked, defs, seen, depth, scope = null) {
  const objects = paramObjects(masked, defs, name, scope);
  if (!objects) return null;
  const values = [];
  for (const arg of objects.exprs) {
    const r = resolveExpr(arg, masked, defs, seen, depth + 1, scope);
    if (r.unknown) return r;
    values.push(...r.values);
  }
  return values.length > 0 ? { values } : null;
}

// The helper definition enclosing `offset` that takes `name` (closest
// definition wins, so sibling helpers with same-shaped params do not leak
// into each other); absent an enclosing one, the first definition.
function paramCallArgs(masked, defs, name, scope = null) {
  let fallback = null;
  let best = null;
  for (const [, list] of defs) {
    for (const def of list) {
      const params = paramsOf(def.paramsText);
      const index = params.findIndex((p) => p.name === name);
      if (index < 0) continue;
      const entry = { def, index, default: params[index].def };
      if (!fallback) fallback = entry;
      if (scope && def.defStart <= scope.offset && (!best || def.defStart > best.def.defStart)) {
        best = entry;
      }
    }
  }
  const chosen = best ?? fallback;
  if (!chosen) return null;
  const args = [];
  for (const call of callArgs(masked, chosen.def.name, defs, scope)) {
    // A trailing comma leaves an empty final element that must not shadow
    // the parameter default.
    if (chosen.index < call.args.length && call.args[chosen.index].trim() !== "") {
      args.push(call.args[chosen.index]);
    }
  }
  return { args, def: chosen.default };
}

function resolveHelperProp(def, argsText, prop, masked, defs, seen, depth, scope = null) {
  const params = paramsOf(def.paramsText);
  const args = splitTopLevel(argsText);
  const bindings = new Map(params.map((p, i) => [p.name, i < args.length ? args[i] : p.def]));
  // Find `return {` in the helper body: scan from the definition point.
  const from = def.bodyStart >= 0 ? def.bodyStart : def.defStart;
  const body = masked.slice(from, from + 20000);
  const m = body.match(/return\s*\{/);
  if (!m) return { unknown: `helper ${def.name} has no object return` };
  const open = from + m.index + m[0].length - 1;
  const close = matchClose(masked, open);
  if (close < 0) return { unknown: `helper ${def.name} return unbalanced` };
  const key = prop.trim().replace(/^["']|["']$/g, "");
  for (const { key: k, value } of objectPairs(masked.slice(open + 1, close - 1))) {
    if (k === key) {
      const v = value ?? k; // shorthand: resolve the in-scope binding.
      return resolveScoped(v, bindings, masked, defs, seen, depth + 1, scope);
    }
  }
  return { unknown: `helper ${def.name} return lacks ${key}` };
}

function resolveScoped(expr, bindings, masked, defs, seen, depth, scope = null) {
  const t = expr.trim();
  if (bindings.has(t)) {
    const bound = bindings.get(t);
    if (bound == null) return { unknown: `parameter ${t} unbound at call` };
    return resolveExpr(bound, masked, defs, seen, depth + 1, scope);
  }
  return resolveExpr(t, masked, defs, seen, depth + 1, scope);
}

// ---------------------------------------------------------------------------
// Seeds: (country, region) pairs per file.
// ---------------------------------------------------------------------------

function pushSeeds(seeds, countries, regions, line, detail) {
  if (countries.unknown) return { unknownSeed: `country: ${countries.unknown} (${detail})`, line };
  if (regions.unknown) return { unknownSeed: `region: ${regions.unknown} (${detail})`, line };
  if (countries.values.length === 0 || regions.values.length === 0) {
    return { unknownSeed: `resolves to no static value (${detail})`, line };
  }
  for (const c of countries.values) {
    for (const r of regions.values) seeds.push({ country: c, region: r, line });
  }
  return null;
}

function seedsFromInsert(masked, defs, sc, seeds, unknowns, file) {
  for (const m of masked.matchAll(/insert\s+into\s+employee_payroll_profiles\s*\(/gi)) {
    if (!inRanges(sc.ranges, m.index)) continue;
    const line = lineOf(masked, m.index);
    sc.offset = m.index;
    const colsOpen = masked.indexOf("(", m.index);
    const colsClose = matchClose(masked, colsOpen);
    if (colsClose < 0) {
      unknowns.push({ file, line, kind: "unknown-seed", detail: "profile insert columns unbalanced" });
      continue;
    }
    const cols = splitTopLevel(masked.slice(colsOpen + 1, colsClose - 1))
      .map((c) => c.trim().toLowerCase());
    const rest = masked.slice(colsClose);
    const vm = rest.match(/values\s*\(/i);
    if (!vm) {
      unknowns.push({ file, line, kind: "unknown-seed", detail: "profile insert without values" });
      continue;
    }
    const valsOpen = colsClose + vm.index + vm[0].length - 1;
    const valsClose = matchClose(masked, valsOpen);
    if (valsClose < 0) {
      unknowns.push({ file, line, kind: "unknown-seed", detail: "profile insert values unbalanced" });
      continue;
    }
    const vals = splitTopLevel(masked.slice(valsOpen + 1, valsClose - 1));
    const at = (name) => cols.indexOf(name);
    // Absent country column means the schema default: CA.
    const countries = at("country") < 0
      ? { values: ["CA"] }
      : resolveExpr(vals[at("country")] ?? "", masked, defs, new Set(), 0, sc);
    const regions = at("province") < 0
      ? { unknown: "no province column" }
      : resolveExpr(vals[at("province")] ?? "", masked, defs, new Set(), 0, sc);
    const problem = pushSeeds(seeds, countries, regions, line, `profile insert line ${line}`);
    if (problem) unknowns.push({ file, line, kind: "unknown-seed", detail: problem.unknownSeed });
  }
}

function seedsFromUpdate(masked, defs, sc, seeds, unknowns, file) {
  for (const m of masked.matchAll(/update\s+employee_payroll_profiles\s+set\s+/gi)) {
    if (!inRanges(sc.ranges, m.index)) continue;
    const line = lineOf(masked, m.index);
    sc.offset = m.index;
    let start = m.index + m[0].length;
    // To WHERE at depth 0, the template end, or a bound.
    let depth = 0;
    let i = start;
    while (i < masked.length && i - start < 3000) {
      const stepped = walkStep(masked, i);
      if (stepped !== i) { i = stepped; continue; }
      const ch = masked[i];
      if (OPEN[ch]) depth++;
      else if (CLOSE[ch]) depth--;
      else if (depth === 0 && /^\bwhere\b/i.test(masked.slice(i, i + 6))) break;
      else if (depth < 0) break;
      i++;
    }
    const countries = { values: [] };
    const regions = { values: [] };
    let sawCountry = false;
    let sawRegion = false;
    for (const part of splitTopLevel(masked.slice(start, i))) {
      const a = part.match(/^\s*(country|province)\s*=\s*([\s\S]*)$/i);
      if (!a) continue;
      if (a[1].toLowerCase() === "country") {
        sawCountry = true;
        const r = resolveExpr(a[2], masked, defs, new Set(), 0, sc);
        if (r.unknown) countries.unknown = r.unknown;
        else countries.values.push(...r.values);
      } else {
        sawRegion = true;
        const r = resolveExpr(a[2], masked, defs, new Set(), 0, sc);
        if (r.unknown) regions.unknown = r.unknown;
        else regions.values.push(...r.values);
      }
    }
    if (!sawCountry && !sawRegion) continue;
    // An UPDATE naming only one side leaves the other at its prior value,
    // which no static scan can know: loud, never assumed.
    const problem = pushSeeds(
      seeds,
      sawCountry ? countries : { unknown: "update leaves country at its prior value" },
      sawRegion ? regions : { unknown: "update leaves province at its prior value" },
      line,
      `profile update line ${line}`,
    );
    if (problem) unknowns.push({ file, line, kind: "unknown-seed", detail: problem.unknownSeed });
  }
}

function seedsFromObjects(masked, defs, sc, seeds, unknowns, file) {
  for (const m of masked.matchAll(/\{([^{}]*)\}/g)) {
    if (!inRanges(sc.ranges, m.index)) continue;
    const pairs = objectPairs(m[1]);
    const byKey = new Map(pairs.map((p) => [p.key, p.value]));
    // A profile body, not a holiday query or a filing account: it names the
    // employee AND both jurisdiction keys.
    if (!byKey.has("employeePartyId") || !byKey.has("country") || !byKey.has("province")) continue;
    const line = lineOf(masked, m.index);
    sc.offset = m.index;
    const countries = resolveExpr(byKey.get("country") ?? "", masked, defs, new Set(), 0, sc);
    const regions = resolveExpr(byKey.get("province") ?? "", masked, defs, new Set(), 0, sc);
    const problem = pushSeeds(seeds, countries, regions, line, `profile object line ${line}`);
    if (problem) unknowns.push({ file, line, kind: "unknown-seed", detail: problem.unknownSeed });
  }
}

// ---------------------------------------------------------------------------
// Configs: slot keys per file, by every spelling the tree uses.
// ---------------------------------------------------------------------------

function configsFromUpsert(masked, defs, sc, slots, unknowns, file) {
  for (const m of masked.matchAll(/\bupsertStatutoryRate\s*\(/g)) {
    if (!inRanges(sc.ranges, m.index)) continue;
    // A test double DEFINING upsertStatutoryRate (`function f(`, `const f
    // = (`, `export async function f(`) is not a configuration — only calls
    // configure. Calls are preceded by `await`, `return`, `(`, `;`, `=>`.
    const before = masked.slice(Math.max(0, m.index - 30), m.index);
    if (/(?:function\s*|=>\s*|[:=]\s*(?:async\s*)?)$/.test(before)) continue;
    const line = lineOf(masked, m.index);
    sc.offset = m.index;
    const open = masked.indexOf("(", m.index);
    const close = matchClose(masked, open);
    if (close < 0) {
      unknowns.push({ file, line, kind: "unknown-config", detail: "upsertStatutoryRate call unbalanced" });
      continue;
    }
    const body = masked.slice(open + 1, close - 1);
    const km = body.match(/rateKey\s*:\s*([^,}]+)/);
    if (!km) {
      unknowns.push({ file, line, kind: "unknown-config", detail: "upsertStatutoryRate without rateKey" });
      continue;
    }
    const r = resolveExpr(km[1], masked, defs, new Set(), 0, sc);
    if (r.unknown) {
      unknowns.push({ file, line, kind: "unknown-config", detail: `upsertStatutoryRate rateKey: ${r.unknown}` });
      continue;
    }
    for (const v of r.values) slots.add(v);
  }
}

function configsFromSql(masked, defs, sc, slots, unknowns, file) {
  for (const m of masked.matchAll(/insert\s+into\s+payroll_statutory_rates\s*\(/gi)) {
    if (!inRanges(sc.ranges, m.index)) continue;
    const line = lineOf(masked, m.index);
    sc.offset = m.index;
    const colsOpen = masked.indexOf("(", m.index);
    const colsClose = matchClose(masked, colsOpen);
    if (colsClose < 0) {
      unknowns.push({ file, line, kind: "unknown-config", detail: "rate insert columns unbalanced" });
      continue;
    }
    const cols = splitTopLevel(masked.slice(colsOpen + 1, colsClose - 1))
      .map((c) => c.trim().toLowerCase());
    const rest = masked.slice(colsClose);
    const vm = rest.match(/values\s*\(/i);
    if (!vm) {
      unknowns.push({ file, line, kind: "unknown-config", detail: "rate insert without values" });
      continue;
    }
    const valsOpen = colsClose + vm.index + vm[0].length - 1;
    const valsClose = matchClose(masked, valsOpen);
    if (valsClose < 0) {
      unknowns.push({ file, line, kind: "unknown-config", detail: "rate insert values unbalanced" });
      continue;
    }
    const vals = splitTopLevel(masked.slice(valsOpen + 1, valsClose - 1));
    const at = cols.indexOf("rate_key");
    if (at < 0 || at >= vals.length) {
      unknowns.push({ file, line, kind: "unknown-config", detail: "rate insert without rate_key" });
      continue;
    }
    const r = resolveExpr(vals[at], masked, defs, new Set(), 0, sc);
    if (r.unknown) {
      unknowns.push({ file, line, kind: "unknown-config", detail: `rate insert rate_key: ${r.unknown}` });
      continue;
    }
    for (const v of r.values) slots.add(v);
  }
}

function configsFromApi(masked, defs, sc, slots, unknowns, file) {
  for (const m of masked.matchAll(/(["'])\/api\/payroll\/settings\/rates\1/g)) {
    if (!inRanges(sc.ranges, m.index)) continue;
    const line = lineOf(masked, m.index);
    sc.offset = m.index;
    // The request body is the first object literal after the endpoint.
    const open = masked.indexOf("{", m.index);
    if (open < 0 || open - m.index > 2000) {
      unknowns.push({ file, line, kind: "unknown-config", detail: "rates API call without a body" });
      continue;
    }
    const close = matchClose(masked, open);
    if (close < 0) {
      unknowns.push({ file, line, kind: "unknown-config", detail: "rates API body unbalanced" });
      continue;
    }
    const byKey = new Map(objectPairs(masked.slice(open + 1, close - 1)).map((p) => [p.key, p.value]));
    if (!byKey.has("rateKey")) {
      unknowns.push({ file, line, kind: "unknown-config", detail: "rates API body without rateKey" });
      continue;
    }
    const r = resolveExpr(byKey.get("rateKey") ?? "", masked, defs, new Set(), 0, sc);
    if (r.unknown) {
      unknowns.push({ file, line, kind: "unknown-config", detail: `rates API rateKey: ${r.unknown}` });
      continue;
    }
    for (const v of r.values) slots.add(v);
  }
}

function configsFromBlob(masked, defs, sc, slots, unknowns, file) {
  // The legacy org-settings fallback the packs still honour: only the SUI
  // spelling can silence a refuse slot (us_futa and ca_eht are zero slots).
  // `sui: { TX: {...} }` configures us_sui, as does `sui:
  // Object.fromEntries([...states].map(...))`; `sui: { rate, wageBase }` is
  // a direct engine argument (calculatePub15T), not a configuration. Any
  // other shape is LOUD — a silent miss here is a false "safe".
  for (const m of masked.matchAll(/\bsui\s*:/g)) {
    if (!inRanges(sc.ranges, m.index)) continue;
    const line = lineOf(masked, m.index);
    sc.offset = m.index;
    const after = masked.slice(m.index + m[0].length).trimStart();
    if (after.startsWith("{")) {
      const open = masked.indexOf("{", m.index);
      const close = matchClose(masked, open);
      if (close < 0) {
        unknowns.push({ file, line, kind: "unknown-config", detail: "sui blob unbalanced" });
        continue;
      }
      const pairs = objectPairs(masked.slice(open + 1, close - 1));
      const regionKeys = pairs.filter((p) => /^[A-Z]{2}$/.test(p.key));
      const rateKeys = pairs.filter((p) => /^(rate|wageBase|wage_base)$/.test(p.key));
      if (regionKeys.length > 0) {
        slots.add("us_sui");
      } else if (rateKeys.length === pairs.length && pairs.length > 0) {
        // Engine argument, not a configuration — ignore.
      } else {
        unknowns.push({
          file,
          line,
          kind: "unknown-config",
          detail: `sui value of unrecognised shape (${pairs.map((p) => p.key).join(", ") || "empty"}) — `
            + "teach the scanner or move it to a scoped rate row",
        });
      }
      continue;
    }
    if (/^Object\.fromEntries\s*\(/.test(after)) {
      // Regions carried in an array literal mapped to entries.
      const open = masked.indexOf("(", m.index);
      const close = matchClose(masked, open);
      if (close < 0) {
        unknowns.push({ file, line, kind: "unknown-config", detail: "sui fromEntries unbalanced" });
        continue;
      }
      const regions = masked.slice(open + 1, close - 1).match(/["']([A-Z]{2})["']/g) ?? [];
      if (regions.length > 0) {
        slots.add("us_sui");
      } else {
        unknowns.push({
          file,
          line,
          kind: "unknown-config",
          detail: "sui fromEntries with no static region literals — teach the scanner",
        });
      }
      continue;
    }
    unknowns.push({
      file,
      line,
      kind: "unknown-config",
      detail: `sui value of unrecognised shape (${after.slice(0, 40)}) — teach the scanner`,
    });
  }
  for (const m of masked.matchAll(/\bfutaRate\s*:/g)) {
    if (!inRanges(sc.ranges, m.index)) continue;
    slots.add("us_futa");
  }
}

// ---------------------------------------------------------------------------
// Per-file and per-tree scans.
// ---------------------------------------------------------------------------

// A scope is one attribution unit: a test block plus the helpers it calls
// (transitively), the hook blocks that wrap it, and module-top-level code.
// Serial e2e suites share ONE tenant across tests (config in an early test
// covers seeds in a later one), so e2e and fixture modules scan file-wide;
// node:test files isolate per test (scratch orgs), so they scan per test.
/** The test callback's own body (the last argument), so module-level code
 *  between tests is not mistaken for test code. Falls back to null (caller
 *  uses the whole extent) when the shape is unrecognised. */
export function testCallback(masked, extent) {
  // The unit starts at the preceding delimiter; long (masked) comment blocks
  // can sit between it and the keyword, so allow a wide window — but never
  // past this unit's end.
  const window = masked.slice(extent.start, Math.min(extent.end, extent.start + 3000));
  const m = /\b(?:test|it)\s*\(/.exec(window);
  if (!m) return null;
  const open = extent.start + m.index + m[0].length - 1;
  const close = matchClose(masked, open);
  if (close < 0) return null;
  // Walk the call's top level and cut it into arguments: the callback is
  // the last NON-EMPTY one (a trailing comma must not promote `)` into the
  // search). The callback's `=>` (or `function` keyword) starts its body.
  let depth = 0;
  const commas = [];
  let i = open + 1;
  while (i < close) {
    const stepped = walkStep(masked, i);
    if (stepped !== i) { i = stepped; continue; }
    const ch = masked[i];
    if (OPEN[ch]) depth++;
    else if (CLOSE[ch]) depth--;
    else if (ch === "," && depth === 0) commas.push(i);
    i++;
  }
  const bounds = [open, ...commas, close - 1];
  let span = null;
  for (let s = bounds.length - 1; s >= 1; s--) {
    if (masked.slice(bounds[s - 1] + 1, bounds[s]).trim() !== "") {
      span = [bounds[s - 1] + 1, bounds[s]];
      break;
    }
  }
  if (!span) return null;
  const tail = masked.slice(span[0], span[1]);
  const arrow = tail.search(/=>/);
  if (arrow >= 0) {
    const after = span[0] + arrow + 2;
    let k = after;
    while (k < span[1] && /\s/.test(masked[k])) k++;
    if (masked[k] === "{") {
      const end = matchClose(masked, k);
      if (end > k) return [k, end];
    }
    return [after, span[1]];
  }
  const fn = /\bfunction\b/.exec(tail);
  if (fn) {
    const k = masked.indexOf("{", span[0] + fn.index);
    const end = k >= 0 ? matchClose(masked, k) : -1;
    if (end > k) return [k, end];
  }
  return null;
}

export function scopesFor(masked, defs, fileLevel) {
  if (fileLevel) return [{ name: null, ranges: null }];
  const units = splitTests(masked);
  // Re-derive ends: each unit runs to the next unit's start.
  const starts = units.map((unit) => unit.start);
  const extents = units.map((unit, k) => ({
    name: unit.name,
    line: unit.line,
    start: unit.start,
    end: k + 1 < starts.length ? starts[k + 1] : masked.length,
  }));
  const hooks = [];
  for (const m of masked.matchAll(/\b(?:before|beforeEach|after|afterEach)\s*\(/g)) {
    const open = masked.indexOf("(", m.index);
    const close = matchClose(masked, open);
    if (close > open) hooks.push([m.index, close]);
  }
  const fnBodies = [];
  for (const [, list] of defs) {
    for (const def of list) {
      if (def.bodyStart >= 0) fnBodies.push({ name: def.name, start: def.bodyStart, end: def.bodyEnd });
    }
  }
  // Module-top-level: everything outside test callbacks, hook blocks and
  // helper bodies. Test extents run to the next test's start, so module
  // consts and helpers BETWEEN tests sit textually inside some test's
  // extent — subtracting whole extents would hide shared fixtures from
  // every other scope. Subtract only the test callback bodies instead.
  const cut = [...extents.map((e) => testCallback(masked, e)).filter(Boolean), ...hooks];
  for (const body of fnBodies) cut.push([body.start, body.end]);
  cut.sort((a, b) => a[0] - b[0]);
  const topLevel = [];
  let cursor = 0;
  for (const [start, end] of cut) {
    if (start > cursor) topLevel.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < masked.length) topLevel.push([cursor, masked.length]);
  const calledHelpers = (extent) => {
    const seen = new Set();
    const queue = [extent];
    const names = [...defs.keys()];
    const mentioned = (body, offset, name) => {
      // A helper's own signature is not a call: `function addEmployee(`
      // must not mark every later test as calling addEmployee.
      const re = new RegExp(`\\b${name}\\s*\\(`, "g");
      let m;
      while ((m = re.exec(body)) !== null) {
        const at = offset + m.index + m[0].lastIndexOf(name);
        const self = (defs.get(name) ?? []).some(
          (def) => at >= def.defStart && at < def.paramsEnd,
        );
        if (!self) return true;
      }
      return false;
    };
    while (queue.length > 0) {
      const [start, end] = queue.pop();
      const body = masked.slice(start, end);
      for (const name of names) {
        if (seen.has(name)) continue;
        if (mentioned(body, start, name)) {
          seen.add(name);
          for (const def of defs.get(name)) {
            if (def.bodyStart >= 0) queue.push([def.bodyStart, def.bodyEnd]);
          }
        }
      }
    }
    return seen;
  };
  return extents.map((extent) => {
    // The test's OWN code is its callback body — not the whole extent, which
    // textually swallows the helpers defined between this test and the next.
    // Those helpers attribute via calledHelpers only when actually called.
    const callback = testCallback(masked, extent);
    const own = callback ?? [extent.start, extent.end];
    const ranges = [own, ...hooks, ...topLevel];
    for (const name of calledHelpers(own)) {
      for (const def of defs.get(name)) {
        if (def.bodyStart >= 0) ranges.push([def.bodyStart, def.bodyEnd]);
      }
    }
    return { name: extent.name, line: extent.line, ranges };
  });
}

export function scanScope(masked, defs, file, sc, opts, slotsCover) {
  const seeds = [];
  const unknowns = [];
  const slots = new Set();
  seedsFromInsert(masked, defs, sc, seeds, unknowns, file);
  seedsFromUpdate(masked, defs, sc, seeds, unknowns, file);
  seedsFromObjects(masked, defs, sc, seeds, unknowns, file);
  configsFromUpsert(masked, defs, sc, slots, unknowns, file);
  configsFromSql(masked, defs, sc, slots, unknowns, file);
  configsFromApi(masked, defs, sc, slots, unknowns, file);
  configsFromBlob(masked, defs, sc, slots, unknowns, file);
  const countries = opts.countries ?? null;
  const findings = [];
  for (const u of unknowns) findings.push({ ...u, test: sc.name ?? null });
  for (const seed of seeds) {
    if (countries && !countries.has(seed.country)) continue;
    for (const slot of slotsCover) {
      if (!slotCovers(slot, seed.country, seed.region)) continue;
      if (slots.has(slot.key)) continue;
      findings.push({
        file,
        line: seed.line,
        test: sc.name ?? null,
        kind: "at-risk",
        slot: slot.key,
        region: seed.region,
        detail: `seeds (${seed.country}, ${seed.region}) covered by refuse slot "${slot.key}" without configuring it`,
      });
    }
  }
  return { seeds, slots: [...slots], findings };
}

export function scanFile(path, root = ROOT, opts = {}) {
  const raw = readFileSync(path, "utf8");
  const masked = maskComments(raw);
  const defs = functionDefs(masked);
  const file = rel(path, root);
  const fileLevel = !/\.test\.(ts|tsx|mts|mjs|js|jsx)$/.test(path) || opts.granularity === "file";
  const slotsCover = opts.refuse ?? refuseSlots(opts.rates, opts.packs);
  const out = { seeds: [], slots: new Set(), findings: [] };
  const scopes = scopesFor(masked, defs, fileLevel || opts.granularity === "file");
  for (const scope of scopes) {
    const sc = { ranges: scope.ranges, offset: 0, name: scope.name ?? null };
    const result = scanScope(masked, defs, file, sc, opts, slotsCover);
    // De-duplicate identical findings across scopes of one file (shared
    // helpers appear in many scopes): same kind/file/line/slot/region once.
    for (const seed of result.seeds) {
      if (!out.seeds.some((s) => s.country === seed.country && s.region === seed.region && s.line === seed.line)) {
        out.seeds.push(seed);
      }
    }
    for (const slot of result.slots) out.slots.add(slot);
    for (const finding of result.findings) {
      // One finding per code fact: the same (kind, line, slot, region)
      // reached from several scopes merges, keeping every test name, so a
      // helper shared by N tests reports once instead of N times.
      const key = `${finding.kind}:${finding.line}:${finding.slot ?? ""}:${finding.region ?? ""}:${finding.detail}`;
      const prior = out.findings.find((f) =>
        `${f.kind}:${f.line}:${f.slot ?? ""}:${f.region ?? ""}:${f.detail}` === key);
      if (prior) {
        for (const name of finding.tests ?? []) {
          prior.tests ??= [];
          if (!prior.tests.includes(name)) prior.tests.push(name);
        }
        if (finding.test && !(prior.tests ?? []).includes(finding.test)) {
          prior.tests ??= [];
          prior.tests.push(finding.test);
        }
      } else {
        out.findings.push({ ...finding, tests: finding.test ? [finding.test] : [] });
      }
    }
  }
  return { seeds: out.seeds, slots: [...out.slots], findings: out.findings };
}

export function scanTree(root = ROOT, opts = {}) {
  const slotsCover = opts.refuse ?? refuseSlots(opts.rates, opts.packs);
  const vocab = opts.vocab ?? packSystemKeys();
  const findings = [];
  for (const path of collectTestFiles(root)) {
    const { findings: fileFindings } = scanFile(path, root, { ...opts, refuse: slotsCover });
    for (const finding of fileFindings) findings.push(finding);
  }
  for (const path of collectProductFiles(root)) {
    for (const finding of scanSystemKeys(path, root, vocab)) findings.push(finding);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Dimension 2: pack-declared systemKeys named literally in generic PRODUCT
// code. check-country-neutrality matches UPPERCASE country/form codes, so a
// lowercase system-key list like values.ts:287 passes it clean while nine
// packs print YTD tax 0.00 on payslips (and Italy prints short). The
// vocabulary is derived from the registry — never listed here.
// ---------------------------------------------------------------------------

/** systemKey → countries declaring it (components plus slot systemKeys). */
export function packSystemKeys(countries = Object.keys(PAYROLL_COUNTRY_PACKS)) {
  const vocab = new Map();
  for (const country of countries) {
    const keys = new Set([
      ...packStatutoryComponents(country).map((c) => c.systemKey),
      ...packRates(country).slots.flatMap((slot) => [...slot.systemKeys]),
    ]);
    for (const key of keys) {
      if (!vocab.has(key)) vocab.set(key, []);
      vocab.get(key).push(country);
    }
  }
  return vocab;
}

const PRODUCT_SUBS = ["web/lib", "web/app", "engine/src", "packages", "schema", "e2e"];
const PACK_SUBDIR = /^engine\/src\/payroll\/[^/]+\//;
const TAX_PACKS_DIR = /country-tax-packs\//;
const MIGRATIONS_DIR = /\/migrations\//;
const SELF_RE = /check-statutory-fixture-coverage/;

export function isPackFile(file) {
  return PACK_SUBDIR.test(file) || TAX_PACKS_DIR.test(file);
}

export function collectProductFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts|mjs|js|jsx)$/.test(entry)) out.push(path);
    }
  };
  for (const sub of PRODUCT_SUBS) {
    try {
      if (statSync(join(root, sub)).isDirectory()) walk(join(root, sub));
    } catch { /* optional tree absent */ }
  }
  return out.sort().filter((path) => {
    const file = rel(path, root);
    if (TEST_RE.test(file) || E2E_RE.test(file)) return false;
    if (isPackFile(file) || MIGRATIONS_DIR.test(file) || SELF_RE.test(file)) return false;
    return true;
  });
}

/**
 * One finding per (file, systemKey): the literal, its first line, every line,
 * and which packs declare it. Runs on the comment-masked source, so prose
 * about a key is not a hit — only code naming it. Single-quoted, double-
 * quoted and plain backtick literals count; interpolated templates cannot be
 * matched statically (stated non-coverage — see header).
 */
export function scanSystemKeys(path, root = ROOT, vocab = packSystemKeys()) {
  const raw = readFileSync(path, "utf8");
  const masked = maskComments(raw);
  const file = rel(path, root);
  const findings = [];
  for (const [key, countries] of vocab) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(['"\`])${esc}\\1`, "g");
    let m;
    const lines = [];
    while ((m = re.exec(masked)) !== null) lines.push(lineOf(masked, m.index));
    if (lines.length === 0) continue;
    findings.push({
      file,
      line: lines[0],
      lines,
      kind: "system-key",
      key,
      countries,
      detail: `names pack-declared systemKey "${key}" (declared by ${countries.join(", ")}) literally in generic code`,
    });
  }
  return findings;
}

// Tracked coverage baseline (the ratchet). Every entry below names a file the
// scanner flags, the slot it flags it for, and WHY the flag is accepted
// rather than fixed. Rules, same as the sibling guards: a file/slot NOT on
// this list must have zero findings (a new gap fails the build — fix the
// fixture, do not list it); a fixed entry must leave this list in the same
// commit (a stale entry fails the build). Shrink this list only by
// configuring fixtures or narrowing the scanner's over-approximation — never
// by adding an entry without the reason behind it.
// Serial e2e and refusal-behaviour suites seed covered regions on purpose;
// the entries say so. Unknown-seed/config entries name dynamic code the
// scanner cannot resolve; each was read by a human and the reading is
// recorded.
export const ALLOWLIST = new Map([
]);

/** Allowlist key: `file :: slot` (dimension 1 at-risk), `file ::
 * unknown-seed|unknown-config` (dimension 1 loud unknowns), `file ::
 * syskey:<key>` (dimension 2; the syskey: prefix keeps the systemKey
 * namespace apart from rate-slot keys). */
export function findingKey(finding) {
  if (finding.kind === "at-risk") return `${finding.file} :: ${finding.slot}`;
  if (finding.kind === "system-key") return `${finding.file} :: syskey:${finding.key}`;
  return `${finding.file} :: ${finding.kind}`;
}

const invoked = process.argv[1] ? process.argv[1].endsWith("check-statutory-fixture-coverage.mjs") : false;
if (invoked) {
  const root = process.argv[2] ?? ROOT;
  const findings = scanTree(root);
  const unlisted = findings.filter((finding) => !ALLOWLIST.has(findingKey(finding)));
  for (const finding of findings) {
    const what = finding.kind === "at-risk"
      ? `at-risk: seeds region ${finding.region} covered by refuse slot "${finding.slot}" without configuring it`
        + (finding.test ? ` [${finding.test.slice(0, 60)}]` : "")
      : finding.kind === "system-key"
        ? `system-key: ${finding.detail} at line(s) ${finding.lines.join(", ")}`
        : `${finding.kind}: ${finding.detail}`;
    const listed = ALLOWLIST.has(findingKey(finding));
    console.log(`${finding.file}:${finding.line} ${listed ? "(allowlisted)" : "(NEW)"} ${what}`);
  }
  for (const [key, entry] of ALLOWLIST) {
    const stale = !findings.some((finding) => findingKey(finding) === key);
    if (stale) console.log(`${key} allowlist entry is stale: ${entry.reason}`);
  }
  const staleCount = [...ALLOWLIST.keys()].filter((key) =>
    !findings.some((finding) => findingKey(finding) === key)).length;
  console.log(
    `checked statutory fixture coverage; findings=${findings.length} unlisted=${unlisted.length} stale=${staleCount}`,
  );
  process.exit(unlisted.length > 0 || staleCount > 0 ? 1 : 0);
}
