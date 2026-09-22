import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TEST_RE = /\.test\.(ts|tsx|mts|mjs|js|jsx)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);

export function collectTestFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (TEST_RE.test(entry)) out.push(path);
    }
  };
  for (const sub of ["engine/src", "web", "packages", "schema", "e2e", "scripts"]) {
    try {
      if (statSync(join(root, sub)).isDirectory()) walk(join(root, sub));
    } catch { /* optional tree absent */ }
  }
  return out;
}

const fileCache = new Map();
export function readCached(path) {
  if (!fileCache.has(path)) {
    try {
      fileCache.set(path, readFileSync(path, "utf8"));
    } catch {
      fileCache.set(path, null);
    }
  }
  return fileCache.get(path);
}

// Cross-file caches: module graphs are heavily shared across test files, so
// lexing/parsing/resolution results are memoized for the process lifetime.
const codeCache = new Map();
const importsCache = new Map();
const exportsCache = new Map();
const resolveCache = new Map();
export function clearCaches() {
  fileCache.clear();
  codeCache.clear();
  importsCache.clear();
  exportsCache.clear();
  resolveCache.clear();
}

function existingTs(path) {
  for (const candidate of [path, `${path}.ts`, `${path}.tsx`, `${path}.mts`, `${path}.js`, `${path}.mjs`, join(path, "index.ts"), join(path, "index.tsx")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

export function webRootFor(fromFile, root = ROOT) {
  let dir = dirname(fromFile);
  while (dir.startsWith(root) && dir !== root) {
    try {
      if (statSync(join(dir, "package.json")).isFile()) {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.name === "web" || (pkg.name === "openbooks" && dir === root)) return dir === root ? join(root, "web") : dir;
      }
    } catch { /* keep climbing */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(root, "web");
}

export function resolveReal(spec, fromFile, root = ROOT) {
  if (!spec || spec === "server-only" || spec.startsWith("node:") || spec.startsWith("data:") || spec.startsWith("mock:")) return null;
  for (const [alias, target] of [["@openbooks/engine/src/", "engine/src/"], ["@openbooks/schema/src/", "schema/src/"]]) {
    if (spec.startsWith(alias)) return existingTs(join(root, target + spec.slice(alias.length)));
  }
  if (spec.startsWith("@/")) {
    const webRoot = webRootFor(fromFile, root);
    const withoutQuery = spec.split("?")[0];
    return existingTs(join(webRoot, withoutQuery.slice(2)));
  }
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return existingTs(join(dirname(fromFile), spec.split("?")[0]));
  }
  return null;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\n\\:"'`])\/\/[^\n]*/g, "$1");
}

// Code-only projection: replaces comments, string contents, and template
// literal text with spaces (newlines preserved). ${} expression contents are
// real code and are kept. The import/export scanners must never see words
// inside inert text — a fixture template containing the word "import" is the
// exact phantom this checker exists to prevent.
export function codeOnly(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  // Single/double-quoted contents are kept verbatim: import specifiers live
  // in them. Only template text and comments are inert.
  const push = (char) => out.push(char === "\n" ? "\n" : " ");
  const copyString = (quote) => {
    out.push(quote);
    i++;
    while (i < n) {
      const char = src[i];
      out.push(char);
      if (char === "\\") {
        out.push(src[i + 1] ?? "");
        i += 2;
        continue;
      }
      i++;
      if (char === quote || (char === "\n" && quote !== "`")) return;
    }
  };
  const skipTemplate = () => {
    out.push("`");
    i++;
    while (i < n) {
      const char = src[i];
      if (char === "\\") { push(char); push(src[i + 1] ?? ""); i += 2; continue; }
      if (char === "`") { out.push("`"); i++; return; }
      if (char === "$" && src[i + 1] === "{") {
        out.push("${");
        i += 2;
        skipBraced();
        continue;
      }
      push(char);
      i++;
    }
  };
  const skipBraced = () => {
    let depth = 1;
    while (i < n && depth > 0) {
      const char = src[i];
      if (char === "'" || char === '"') { copyString(char); continue; }
      if (char === "`") { skipTemplate(); continue; }
      if (char === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") { push(src[i]); i++; }
        continue;
      }
      if (char === "/" && src[i + 1] === "*") {
        push("/"); push("*"); i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { push(src[i]); i++; }
        push("*"); push("/"); i += 2;
        continue;
      }
      if (char === "{") depth++;
      if (char === "}") {
        depth--;
        if (depth === 0) { out.push("}"); i++; return; }
      }
      out.push(char);
      i++;
    }
  };
  while (i < n) {
    const char = src[i];
    if (char === "'" || char === '"') { copyString(char); continue; }
    if (char === "`") { skipTemplate(); continue; }
    if (char === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") { push(src[i]); i++; }
      continue;
    }
    if (char === "/" && src[i + 1] === "*") {
      push("/"); push("*"); i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { push(src[i]); i++; }
      if (i < n) { push("*"); push("/"); i += 2; }
      continue;
    }
    out.push(char);
    i++;
  }
  return out.join("");
}

// Top-level `const NAME = 'literal'` string bindings, so variable dynamic
// imports (`await import(routeUrl)` with `routeUrl = './route.ts?tag'`) and
// `new URL('./x?tag', import.meta.url)` SUT loads resolve. Template bindings
// keep only the static prefix before the first ${}.
export function stringBindings(code) {
  const bindings = new Map();
  for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(`((?:\\\`|(?!\`).)*?)`|(['"])((?:\\\4|(?!\4).)*?)\4)/g)) {
    const raw = match[3] !== undefined ? match[3] : match[5];
    const prefix = raw.split("${")[0].replace(/\\(['"`\\])/g, "$1");
    if (prefix) bindings.set(match[1], prefix);
  }
  return bindings;
}

// Static + dynamic imports. Dynamic specs may be literals, bound variable
// names, or templates (static prefix used). Returns
// [{spec, names:Set(orig names), dynamic, reexport, star}].
export function staticImports(src) {
  const out = [];
  const clean = stripComments(src);
  const bindings = stringBindings(clean);
  const resolveDynamic = (raw) => {
    const trimmed = raw.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed) && bindings.has(trimmed)) return bindings.get(trimmed);
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return null;
    return trimmed;
  };
  // Brace depth before a position, for dynamic-import laziness. String
  // contents are skipped (an unbalanced brace in a message must not demote
  // a top-level import); braces inside regex literals can still miscount,
  // which only ever demotes toward lazy.
  const depthAt = (index) => {
    let depth = 0;
    let k = 0;
    while (k < index) {
      const char = clean[k];
      if (char === "'" || char === '"') {
        const quote = char;
        k++;
        while (k < index && clean[k] !== quote) {
          if (clean[k] === "\\") k++;
          k++;
        }
        k++;
        continue;
      }
      if (char === "{") depth++;
      else if (char === "}") depth--;
      k++;
    }
    return depth;
  };
  // The argument scan must respect QUOTES, not stop at the first `)`. It used
  // to be /import\s*\(\s*([^)]*?)\)/, which truncates any specifier containing
  // a parenthesis — and Next.js route groups are exactly that:
  // `import('../app/(app)/ar/view')` captured `'../app/(app` and stopped at the
  // `)` INSIDE the string. The spec then matched neither the literal nor the
  // template shape, resolved to nothing, and the entire imported subtree became
  // invisible to this guard. That is how a loader stub missing an export went
  // unreported: the file importing it was never walked.
  const dynamicCall = /import\s*\(\s*(?:(['"`])((?:\\.|(?!\1)[^\\])*)\1|([A-Za-z_$][\w$]*))\s*(?:,[\s\S]*?)?\)/g;
  for (const match of clean.matchAll(dynamicCall)) {
    const inner = match[2] !== undefined ? `${match[1]}${match[2]}${match[1]}` : (match[3] ?? "").trim();
    const literal = inner.match(/^(['"])((?:\\\1|(?!\1).)+)\1$/);
    const template = inner.match(/^`((?:\\\`|(?!\`).)*)`$/);
    let spec = null;
    if (literal) spec = literal[2].replace(/\\(['"`\\])/g, "$1");
    else if (template) spec = template[1].split("${")[0].replace(/\\(['"`\\])/g, "$1");
    else spec = resolveDynamic(inner);
    if (!spec) continue;
    // The `?tag` SUT load and any top-level dynamic import always execute,
    // so their subtrees are static. Nested dynamic imports may never run.
    const alwaysRuns = spec.includes("?") || depthAt(match.index) === 0;
    out.push({ spec, names: new Set(), dynamic: !alwaysRuns, reexport: false, star: false });
  }
  for (const match of clean.matchAll(/import\s+(?!\s*type\b)((?:[^{}'"]|\{[^}]*\})*?\s+from\s+)?(['"])((?:\\\2|(?!\2).)+)\2/g)) {
    const clause = (match[1] ?? "").trim();
    if (/^\s*type[\s{]/.test(clause)) continue;
    const names = new Set();
    let star = false;
    if (clause) {
      const named = clause.match(/\{([^}]*)\}/);
      if (named) {
        for (const part of named[1].split(",")) {
          const trimmed = part.trim();
          if (!trimmed || trimmed.startsWith("type ")) continue;
          const name = trimmed.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*$/);
          if (name) names.add(name[1]);
        }
      }
      if (/\*\s*as\s/.test(clause)) star = true;
    }
    out.push({ spec: match[3], names, dynamic: false, reexport: false, star });
  }
  for (const match of clean.matchAll(/export\s+(?:\{[^}]*\}|\*[^;]*?)\s+from\s+(['"])((?:\\\1|(?!\1).)+)\1/g)) {
    const statement = match[0];
    if (/^\s*export\s+type\s/.test(statement)) continue;
    const names = new Set();
    let star = false;
    if (/\*\s*from/.test(statement)) star = true;
    else {
      const named = statement.match(/\{([^}]*)\}/);
      if (named) {
        for (const part of named[1].split(",")) {
          const trimmed = part.trim();
          if (!trimmed || trimmed.startsWith("type ")) continue;
          const name = trimmed.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*$/);
          if (name) names.add(name[1]);
        }
      }
    }
    out.push({ spec: match[2], names, dynamic: false, reexport: true, star });
  }
  return out;
}

// Runtime (value) exports of a module source: function/const/let/var/class
// names plus `export {}` members. Type-only exports are excluded.
export function moduleExports(src) {
  const names = new Set();
  const clean = stripComments(src);
  for (const match of clean.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of clean.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of clean.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const trimmed = part.trim().replace(/^type\s+/, "");
      if (!trimmed) continue;
      const name = trimmed.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/);
      if (name) names.add(name[2] ?? name[1]);
    }
  }
  return names;
}

/**
 * Names a double serves by re-exporting a real module wholesale.
 *
 * moduleExports reads DECLARATIONS only, so `export * from` is invisible to
 * it and every name the target provides reads as missing — even though the
 * double genuinely serves them at runtime. That is backwards for the shape
 * this guard most wants to encourage: re-exporting the real module instead of
 * hand-copying its surface, which is the only version that cannot drift.
 *
 * The specifier is taken as the first quoted string on the statement, which
 * covers both a plain literal and the `new URL('./x.ts', import.meta.url).href`
 * form the inline doubles use to name a real sibling module.
 */
export function starReexports(body, fromFile, root = ROOT) {
  const names = new Set();
  for (const line of stripComments(body).split("\n")) {
    const star = line.match(/export\s*\*\s*from\s*(.+)$/);
    if (!star) continue;
    // In the `new URL('./x.ts', import.meta.url).href` form the outer quote
    // pairs with the interpolation's OWN quote, so a general quoted-run match
    // captures `${new URL(` and never sees the path between them. A specifier
    // carries no whitespace, so that pattern fails at the outer quote and the
    // scan advances to the real one. Both shapes are collected and the first
    // candidate that actually resolves wins.
    const candidates = new Set();
    for (const m of star[1].matchAll(/['"`]([^'"`\s]+)['"`]/g)) candidates.add(m[1]);
    for (const m of star[1].matchAll(/['"`]([^'"`]+)['"`]/g)) candidates.add(m[1]);
    for (const candidate of candidates) {
      const target = cachedResolve(candidate, fromFile, root);
      if (!target) continue;
      for (const name of cachedExports(target)) names.add(name);
      break;
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Protected surfaces: validation and money kernels are never hand-doubled.
// ---------------------------------------------------------------------------

// Real modules whose doubles can drift from the one implementation the
// product relies on. Replacing one with a hand copy is not isolation — it is
// a fork of validation. A parseJsonBody stub returning { ok: true } is
// structurally incapable of producing the refusal the boundary exists to
// enforce, so every malformed-body case behind it reports green untested
// (the documented worst defect class in AGENTS.md). Money-kernel doubles
// have the same shape with amounts instead of bodies: a hand normalizeMoney
// or canonicalDecimal decides money questions the real kernel would refuse.
const PROTECTED_REAL_PATHS = new Set(
  [
    "web/lib/api/json.ts",
    "web/lib/exact-decimal.ts",
    "web/lib/payroll-decimal-refusal.ts",
    "engine/src/money/money.ts",
    "engine/src/money/exact-decimal.ts",
    "engine/src/money/decimal-refusal.ts",
  ].map((relative) => join(ROOT, relative)),
);

// Export names whose declaration marks a mock body as a hand double of a
// protected surface no matter which specifier it is wired to — inline data:
// stubs and renamed wirings included.
const PROTECTED_EXPORT_NAMES = new Set([
  "parseJsonBody",
  "jsonObject",
  "exactMoney",
  "canonicalDecimal",
  "normalizeMoney",
]);

/**
 * A mock body is exempt when it is ONLY re-exports of the real protected
 * module (`export * from '@openbooks/engine/src/money/money.ts'`): it then
 * serves the genuine implementation and cannot drift, which is the
 * compliant way to keep one mock serving protected names plus its own
 * module-local stubs. Any local declaration forfeits the exemption, because
 * a local export shadows the re-exported one.
 */
export function isPureReexportOfProtected(body, fromFile, root = ROOT) {
  const clean = stripComments(body);
  if (/export\s+(?:async\s+)?(?:function|class|const|let|var)\s/.test(clean)) return false;
  const statements = [...clean.matchAll(/export\s*(\{[^}]*\}|\*)\s*from\s*(['"`])([^'"`]+)\2/g)];
  if (statements.length === 0) return false;
  const remainder = clean.replace(/export\s*(\{[^}]*\}|\*)\s*from\s*(['"`])([^'"`]+)\2/g, "");
  if (/\bexport\b/.test(remainder)) return false;
  return statements.some((statement) => {
    const target = resolveReal(statement[3], fromFile, root);
    return target !== null && PROTECTED_REAL_PATHS.has(target);
  });
}

// Conversion queue for existing hand doubles. Each entry is a live double
// still serving a protected surface; the ratchet is bidirectional — a NEW
// double outside this list fails the build, and a conversion that leaves its
// entry behind fails it too (stale). Strike the entry in the same commit
// that deletes the double.
export const PROTECTED_DOUBLE_ALLOWLIST = new Map(Object.entries({
  "web/app/api/_order/handlers.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/accounts/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/admin/payment-operations/[resource]/[id]/route-patch-required-fields.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/admin/payment-operations/[resource]/[id]/route-patch-validation.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/admin/payment-operations/[resource]/[id]/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/admin/users/route-party.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/admin/users/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/analytics/cashflow/categories/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
  },
  "web/app/api/analytics/true-cost/config/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
    "decimal": "hand double of the decimal classifier; conversion queued - load or re-export the real module",
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
  },
  "web/app/api/apps/marketplace/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/assets/[id]/dispose/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
    "exact-decimal": "hand double of the decimal classifier; conversion queued - load or re-export the real module",
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
  },
  "web/app/api/assets/[id]/remeasure/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
    "exact-decimal": "hand double of the decimal classifier; conversion queued - load or re-export the real module",
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
  },
  "web/app/api/banking/import/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/banking/reconciliations/[id]/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
    "exact-decimal": "hand double of the decimal classifier; conversion queued - load or re-export the real module",
  },
  "web/app/api/billing-requests/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
    "exact-decimal": "hand double of the decimal classifier; conversion queued - load or re-export the real module",
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
  },
  "web/app/api/budgets/[id]/actions/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/compliance/waivers/[id]/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/crm/opportunities/[id]/route.test.ts": {
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
    "exact-decimal": "hand double of the decimal classifier; conversion queued - load or re-export the real module",
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/file-cabinet/attachments/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/file-cabinet/bulk-download/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/flows/gates/bulk/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/flows/gates/decide/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/forms/templates/[key]/publish/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/forms/templates/[key]/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/hrm/comp-cycles/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/insights/cards/[id]/route.test.ts": {
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/internal/overhead/publish/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/parties/[id]/route.test.ts": {
    "exact-decimal": "hand double of the decimal classifier; conversion queued - load or re-export the real module",
  },
  "web/app/api/parties/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/payroll/remittances/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/payroll/runs/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/payroll/settings/rates/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
    "exact-decimal": "hand double of the decimal classifier; conversion queued - load or re-export the real module",
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
  },
  "web/app/api/payroll/year-end/amendments/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/payroll/year-end/file/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/project-charges/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/project-schedule/route.integration.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/projects/[id]/percent-complete/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/projects/[id]/route.integration.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
    "decimal": "hand double of the decimal classifier; conversion queued - load or re-export the real module",
  },
  "web/app/api/projects/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/psp/settlements/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/rate-book-assignments/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/receipts/runs/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/records/[typeKey]/[id]/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/sign/field-tickets/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/subscriptions/route.test.ts": {
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/tax/filings/[id]/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/app/api/tax/filings/route.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/lib/bank-statement-upload.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/lib/pdf-templates/values.test.ts": {
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
  },
  "web/lib/permissions.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
  },
  "web/lib/project-schedule.test.ts": {
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
  },
  "web/lib/subcontract-feature-integration.test.ts": {
    "json": "hand double of the JSON validation boundary; conversion queued - load or re-export the real module",
    "exact-decimal": "hand double of the decimal classifier; conversion queued - load or re-export the real module",
    "money": "hand double of the money kernel; conversion queued - load or re-export the real module",
  },
}));

function specMatcher(object, method, literal) {
  const value = literal.replace(/\\(['"`\\])/g, "$1");
  if (method === "exact") return { kind: "exact", value };
  if (method === "endsWith") return { kind: "suffix", value };
  if (method === "startsWith") return { kind: "prefix", value };
  return { kind: "substr", value };
}

// Every parentURL alternative in a condition: `includes('a') ||
// includes('b')` scopes the rule to BOTH parents, so each alternative
// becomes its own rule on expansion (one missed disjunct leaves its edge
// falsely real — e.g. a merge-route importer the analyzer routed to the real
// authz subtree while the runtime mock served it).
function parentMatchers(condition) {
  const out = [];
  const push = (match) => {
    const parent = specMatcher(null, match[1], match[2]);
    if (!out.some((seen) => JSON.stringify(seen) === JSON.stringify(parent))) out.push(parent);
  };
  for (const re of [
    /parentURL\?\.\s*(endsWith|startsWith|includes)\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /parentURL\s*\.\s*(endsWith|startsWith|includes)\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /parentURL\s*(?:\?\?|\|\|)\s*[^()]+\)\s*\.\s*(endsWith|startsWith|includes)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ]) {
    for (const match of condition.matchAll(re)) push(match);
  }
  return out;
}

// The consequence expression of `if (...)` starting at `from`. String-aware
// brace matching, so braces inside messages (including data: URLs) cannot
// end the span early. Works for blocks, single returns with object literals,
// and bare calls under ASI style (no trailing semicolon).
function consequence(src, from) {
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== "{") {
    // Single statement: brace-match an object literal when one opens the
    // statement, otherwise run to the line end (ASI) or semicolon.
    if (/return\b/.test(src.slice(i, i + 7))) {
      const open = src.indexOf("{", i);
      const newline = src.indexOf("\n", i);
      const semi = src.indexOf(";", i);
      const lineEnd = Math.min(newline < 0 ? Infinity : newline, semi < 0 ? Infinity : semi);
      if (open >= 0 && open < lineEnd) i = open;
      else return lineEnd === Infinity ? "" : src.slice(from, lineEnd + 1);
    } else {
      const newline = src.indexOf("\n", i);
      const semi = src.indexOf(";", i);
      const lineEnd = Math.min(newline < 0 ? Infinity : newline, semi < 0 ? Infinity : semi);
      return lineEnd === Infinity ? "" : src.slice(from, lineEnd + 1);
    }
  }
  let depth = 0;
  let quote = null;
  const start = i;
  while (i < src.length) {
    const char = src[i];
    if (quote) {
      if (char === "\\") { i += 2; continue; }
      if (char === quote) quote = null;
      i++;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; i++; continue; }
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i++;
  }
  return "";
}

// Shim helpers: `const virtual = (source) => ({ shortCircuit: true, url:
// 'data:...' + ... })` factories whose call in a rule consequence replaces
// the module with a data: stub. The consequence only shows `return
// virtual('export {}')`, so the data: URL never appears at the rule site.
function shimHelpers(src) {
  const helpers = new Set();
  const returnsStub = (body) =>
    /shortCircuit\s*:\s*true/.test(body) && /url\s*:\s*['"`]data:/.test(body);
  for (const match of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\(?\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    while (end < src.length) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}") {
        depth--;
        if (depth === 0) break;
      }
      end++;
    }
    if (returnsStub(src.slice(open, end))) helpers.add(match[1]);
  }
  for (const match of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    while (end < src.length) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}") {
        depth--;
        if (depth === 0) break;
      }
      end++;
    }
    if (returnsStub(src.slice(open, end))) helpers.add(match[1]);
  }
  return helpers;
}

// Outer parent guards: `if (context.parentURL?.includes("X")) { ...
// if (specifier === "Y") ... }`. The inner specifier rule only fires under
// the outer guard; without it the analyzer routes every importer's Y to the
// mock — over-mocking that hides real subtrees and forges needs the mock
// never serves at runtime (e.g. view-permission suites scoping next-intl
// mocks to one view.ts while the analyzer blamed them for getLocale
// imported by an unrelated analytics module).
function outerParentGuards(src) {
  const guards = [];
  for (const match of src.matchAll(/if\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    let closed = false;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")") {
        depth--;
        if (depth === 0) { closed = true; break; }
      }
    }
    if (!closed) continue;
    const condition = src.slice(match.index, end + 1);
    if (!/parentURL/.test(condition) || /\bspecifier\b/.test(condition)) continue;
    const alternatives = parentMatchers(condition);
    if (alternatives.length === 0) continue;
    const block = consequence(src, end + 1);
    if (!block) continue;
    const blockEnd = src.indexOf(block, end + 1) + block.length;
    for (const parent of alternatives) guards.push({ start: match.index, end: blockEnd, parent });
  }
  return guards;
}

// Wiring rules from a test file's resolve hook. Ordered; first match wins.
// Rule: {spec:{kind,value}, parent:{kind,value?}, mock:string|null}
// mock === null means shimmed to a non-mock (data:/real rewrite) — cut, no needs.
export function parseWiring(src) {
  const rules = [];
  const helpers = shimHelpers(src);
  const guards = outerParentGuards(src);
  // Literal [real, mock:X] pairs (Map literals, arrays) and .set('real','mock:X').
  for (const match of src.matchAll(/\[\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]mock:([^'"`]+)['"`]\s*\]/g)) {
    rules.push({ spec: { kind: "exact", value: match[1] }, parent: { kind: "any" }, mock: match[2] });
  }
  for (const match of src.matchAll(/\.set\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]mock:([^'"`]+)['"`]\s*\)/g)) {
    rules.push({ spec: { kind: "exact", value: match[1] }, parent: { kind: "any" }, mock: match[2] });
  }
  // Object-literal wiring: const mocks = { 'real': 'mock:X', ... }; mocks[specifier].
  for (const match of src.matchAll(/['"`]([^'"`]+)['"`]\s*:\s*['"`]mock:([^'"`]+)['"`]/g)) {
    rules.push({ spec: { kind: "exact", value: match[1] }, parent: { kind: "any" }, mock: match[2] });
  }
  // Conditional specifier tests: every `specifier === 'X'` /
  // endsWith / startsWith / includes / match('X') test inside an `if`
  // condition shares the if's consequence. Scanning the whole condition (not
  // just a leading test) models `||`-chained alternatives
  // (`if (specifier === 'a' || specifier === 'b')`, where only the first
  // disjunct used to become a rule and the second edge stayed falsely real)
  // and parentURL-first wirings (`if (parentURL... && specifier...)`, where
  // no rule used to exist at all and data-shimmed subtrees stayed falsely
  // load-bearing).
  const specTest = /specifier\s*\.?\s*(===|!==|endsWith|startsWith|includes|match)\s*(\(\s*['"`]([^'"`]+)['"`]\s*\)|['"`]([^'"`]+)['"`])/g;
  for (const match of src.matchAll(/if\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    let closed = false;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")") {
        depth--;
        if (depth === 0) { closed = true; break; }
      }
    }
    if (!closed) continue;
    const condition = src.slice(match.index, end + 1);
    const tests = [...condition.matchAll(specTest)];
    if (tests.length === 0) continue;
    const block = consequence(src, end + 1);
    if (!block) continue;
    const mock = block.match(/url:\s*['"`]mock:([^'"`]+)['"`]/);
    // An inline data-URL stub carries REAL module source with a real export
    // set, so it is compared like any other mock body rather than cut. Only a
    // data: URL whose payload is NOT a literal here (built from a variable, or
    // a helper the factory hides) still cuts — there is nothing to read.
    const inline = block.match(/url:\s*['"`]data:text\/javascript,((?:\\.|[^'"`\\])*)['"`]/);
    const comparableInline = inline !== null && /\bexport\b/.test(decodeInlineShim(inline[1]));
    // Data-URL shims ('server-only', 'next/...') cut the edge with no needs.
    // A bare nextResolve() rewrite stays real — only mock/data returns cut.
    // A TEMPLATE url (url: `data:...${x}`) is dynamically built, so it cuts the
    // edge exactly like a literal data: shim. It must be recognised from the
    // blanked projection too: the projection empties template TEXT, so the
    // `data:` prefix is gone and only the backtick survives. Missing this made
    // the rule vanish entirely and the walk descend into the REAL module,
    // producing a false gap against a stub that was in fact serving it.
    let shim = /url:\s*['"`](data:|https?:)/.test(block) || /url:\s*`/.test(block);
    if (!shim && helpers.size > 0) {
      // `return virtual('export {}')`: the stub factory hides the data: URL.
      const call = block.match(/return\s+([A-Za-z_$][\w$]*)\s*[(`'"]/) ??
        src.slice(end + 1, end + 201).match(/return\s+([A-Za-z_$][\w$]*)\s*[(`'"]/);
      if (call && helpers.has(call[1])) shim = true;
    }
    if (!mock && !shim && !comparableInline) continue;
    // One rule per specifier alternative per parent alternative: every
    // disjunct shares the if's consequence, and first-match-wins is
    // unaffected since expanded siblings conclude identically.
    let parents = parentMatchers(condition + block.slice(0, 200));
    if (parents.length === 0) {
      // Nested guard: the specifier test sits inside an outer
      // `if (parentURL...)` block, so the rule only fires for those parents.
      // Innermost span wins; same-span alternatives are all kept.
      let innerStart = -1;
      for (const guard of guards) {
        if (match.index > guard.start && match.index < guard.end) {
          if (guard.start > innerStart) {
            innerStart = guard.start;
            parents = [];
          }
          if (guard.start === innerStart &&
            !parents.some((seen) => JSON.stringify(seen) === JSON.stringify(guard.parent))) {
            parents.push(guard.parent);
          }
        }
      }
    }
    if (parents.length === 0) parents = [{ kind: "any" }];
    for (const test of tests) {
      const method = test[1];
      if (method === "!==") continue;
      const literal = test[3] ?? test[4] ?? "";
      const spec = method === "==="
        ? { kind: "exact", value: literal }
        : method === "match"
          ? { kind: "unparseable-regex", value: literal }
          : specMatcher(null, method, literal);
      for (const parent of parents) {
        rules.push({
          spec,
          parent,
          // An inline stub's key IS its body, so needs land on the same
          // entry mockBlocks registered. null only where nothing is readable.
          // Comparable only when the payload is a non-empty LITERAL that
          // declares exports. A payload built by concatenation
          // ('data:text/javascript,' + encodeURIComponent(src)) is not
          // readable here, and bucketing those under one empty body made
          // every name look missing — 46 false gaps on the first attempt.
          mock: mock ? mock[1] : (comparableInline ? inlineShimKey(inline[1]) : null),
          shimmed: !mock,
        });
      }
    }
  }
  return rules;
}

function specMatches(rule, spec) {
  if (rule.kind === "exact") return spec === rule.value;
  if (rule.kind === "suffix") return spec.endsWith(rule.value);
  if (rule.kind === "prefix") return spec.startsWith(rule.value);
  if (rule.kind === "substr") return spec.includes(rule.value);
  return false;
}

function parentMatches(rule, parentURL) {
  if (!rule || rule.kind === "any") return true;
  if (!parentURL) return true;
  return specMatches(rule, parentURL);
}

// One template-literal unescape pass: a mock body embedded in the test file
// as `...` source reaches the loader with \` → `, \$ → $, \\ → \ and the
// usual single escapes decoded. Lexing must see the effective module source,
// or inner templates misalign the lexer and hide real exports.
export function unescapeTemplate(body) {
  let out = "";
  let i = 0;
  const hex = (digits) => {
    let value = 0;
    for (const digit of digits) {
      const parsed = parseInt(digit, 16);
      if (Number.isNaN(parsed)) return null;
      value = value * 16 + parsed;
    }
    return String.fromCharCode(value);
  };
  while (i < body.length) {
    const char = body[i];
    if (char !== "\\") { out += char; i++; continue; }
    const next = body[i + 1];
    if (next === undefined) { out += "\\"; i++; continue; }
    if (next === "n") { out += "\n"; i += 2; continue; }
    if (next === "r") { out += "\r"; i += 2; continue; }
    if (next === "t") { out += "\t"; i += 2; continue; }
    if (next === "b") { out += "\b"; i += 2; continue; }
    if (next === "f") { out += "\f"; i += 2; continue; }
    if (next === "v") { out += "\v"; i += 2; continue; }
    if (next === "\n") { i += 2; continue; }
    if (next === "0" && !/[0-9]/.test(body[i + 2] ?? "")) { out += "\0"; i += 2; continue; }
    if (next === "x" && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 2, i + 4))) {
      out += hex(body.slice(i + 2, i + 4)); i += 4; continue;
    }
    if (next === "u") {
      const braced = body.slice(i + 2).match(/^\{([0-9a-fA-F]+)\}/);
      if (braced) { out += String.fromCodePoint(parseInt(braced[1], 16)); i += 3 + braced[1].length; continue; }
      if (/^[0-9a-fA-F]{4}$/.test(body.slice(i + 2, i + 6))) {
        out += hex(body.slice(i + 2, i + 6)); i += 6; continue;
      }
    }
    out += next;
    i += 2;
  }
  return out;
}

// Mock source bodies: ['mock:X', `...`] | ["mock:X", "..."] | .set('mock:X', `...`)
export function mockBlocks(src, raw) {
  const blocks = new Map();
  // Bodies slice from `raw` (same length as the projection): the projection
  // blanks template text, but a mock body IS code at runtime and must be
  // parsed whole. Offsets line up because the projection preserves length.
  const source = raw ?? src;
  // The structure scan runs on the raw text (true escapes, true nesting);
  // offsets line up with the projection because it preserves length.
  const takeTemplate = (start) => {
    let i = start;
    let depth = 0;
    while (i < source.length) {
      const char = source[i];
      if (char === "\\") { i += 2; continue; }
      if (char === "`" && depth === 0) break;
      if (char === "$" && source[i + 1] === "{") { depth++; i += 2; continue; }
      if (char === "}" && depth > 0) { depth--; i++; continue; }
      i++;
    }
    return source.slice(start, i);
  };
  for (const match of src.matchAll(/\[\s*['"`]mock:([^'"`]+)['"`]\s*,\s*`/g)) {
    if (!blocks.has(match[1])) blocks.set(match[1], unescapeTemplate(takeTemplate(match.index + match[0].length)));
  }
  for (const match of src.matchAll(/\[\s*['"`]mock:([^'"`]+)['"`]\s*,\s*(['"])((?:\\\2|(?!\2).)*)\2\s*\]/g)) {
    if (!blocks.has(match[1])) blocks.set(match[1], match[3].replace(/\\(['"`\\])/g, "$1"));
  }
  for (const match of src.matchAll(/\.set\(\s*['"`]mock:([^'"`]+)['"`]\s*,\s*`/g)) {
    if (!blocks.has(match[1])) blocks.set(match[1], unescapeTemplate(takeTemplate(match.index + match[0].length)));
  }
  // INLINE data-URL stubs are mock bodies too, and used to be invisible here.
  // A loader hook may answer `url: 'data:text/javascript,export function a(){}'`
  // — real module source, carrying a real (and possibly incomplete) export set.
  // The rule scanner treated every data: URL as a trivial shim and cut the edge
  // with no needs, so a stub that omitted an export the importer needed was
  // never compared. That is not a hypothetical: a loader stub exporting only
  // `groupTabs` served a module that had come to import `customerGroupTabs`,
  // the importing module failed to LINK, and the whole test file registered
  // ZERO tests instead of failing. Keyed by the literal payload so the rule
  // scanner can name the same body without threading state between the two.
  for (const match of source.matchAll(/(['"`])data:text\/javascript,((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const payload = match[2];
    if (payload === undefined) continue;
    const body = decodeInlineShim(payload);
    if (!/\bexport\b/.test(body)) continue;
    const key = inlineShimKey(payload);
    if (!blocks.has(key)) blocks.set(key, body);
  }
  return blocks;
}

/** Stable key for an inline data-URL stub body: its own decoded source. */
export function inlineShimKey(payload) {
  return `data:${payload.slice(0, 120)}`;
}

/** The runtime source an inline data-URL stub serves. */
export function decodeInlineShim(payload) {
  const unescaped = payload.replace(/\\n/g, "\n").replace(/\\(['"`\\])/g, "$1");
  try {
    return decodeURIComponent(unescaped);
  } catch {
    return unescaped;
  }
}

export function matchRule(rules, spec, parentURL) {
  for (const rule of rules) {
    if (rule.spec.kind === "unparseable-regex") continue;
    if (specMatches(rule.spec, spec) && parentMatches(rule.parent, parentURL)) return rule;
  }
  return null;
}

// Check one test file. Returns {gaps, lazy, unmodeled, deadMocks}.
// gaps: [{spec, mock, names, via}] — static needs the mock does not provide.
export function cachedCode(path) {
  if (!codeCache.has(path)) {
    const src = readCached(path);
    codeCache.set(path, src === null ? null : codeOnly(src));
  }
  return codeCache.get(path);
}

export function cachedImports(path) {
  if (!importsCache.has(path)) {
    const code = cachedCode(path);
    importsCache.set(path, code === null ? [] : staticImports(code));
  }
  return importsCache.get(path);
}

export function cachedExports(path) {
  if (!exportsCache.has(path)) {
    const code = cachedCode(path);
    exportsCache.set(path, code === null ? new Set() : moduleExports(code));
  }
  return exportsCache.get(path);
}

export function cachedResolve(spec, fromFile, root = ROOT) {
  const key = `${fromFile}::${spec}::${root}`;
  if (!resolveCache.has(key)) resolveCache.set(key, resolveReal(spec, fromFile, root));
  return resolveCache.get(key);
}

/**
 * True when a file stubs with an inline data: module whose source is a literal
 * and declares exports — the only inline shape whose export set is readable
 * statically. Payloads assembled at runtime are deliberately out of scope.
 */
export function hasComparableInlineStub(src) {
  for (const match of src.matchAll(/(['"`])data:text\/javascript,((?:\\.|(?!\1)[^\\])*)\1/g)) {
    if (/\bexport\b/.test(decodeInlineShim(match[2] ?? ""))) return true;
  }
  return false;
}

export function checkFile(path, root = ROOT) {
  const src = readCached(path);
  const empty = { gaps: [], lazy: [], unmodeled: false, deadMocks: [], doubles: [] };
  // The entry gate USED to be `src.includes("mock:")` alone, which skipped an
  // entire class of stub: a loader hook may answer with an inline
  // `data:text/javascript,...` module and never write the string "mock:" at
  // all. Such a file was not merely under-analyzed, it was never opened — so a
  // stub that omitted an export its importer needed went unreported, the
  // importing module failed to LINK, and the test file registered ZERO tests
  // instead of failing. Admit inline data-URL stubs too.
  if (!src) return empty;
  // Admit a file with no "mock:" scheme ONLY when it carries an inline stub this
  // scanner can actually read: a literal data: payload that declares exports.
  // Admitting every data: URL instead marked 48 files "unmodeled" — they stub
  // with payloads built by concatenation, which is not readable here, so there
  // is nothing to model and nothing to report.
  if (!src.includes("mock:") && !hasComparableInlineStub(src)) return empty;
  if (!src.includes("registerHooks")) return empty;
  // All scanners run on the code-only projection (same length/newlines):
  // inert template text can never forge wiring, blocks, imports, or exports.
  const code = cachedCode(path);
  const rules = parseWiring(code);
  const blocks = mockBlocks(code, src);
  // "unmodeled" means AUTHORED mock: bodies with no wiring to reach them — a
  // real authoring mistake. Inline data: bodies are discovered, not authored,
  // so they must not raise it: counting them flagged 48 files that are fine.
  const authoredBlocks = [...blocks.keys()].filter((key) => !key.startsWith("data:"));
  if (rules.length === 0 && authoredBlocks.length > 0) return { ...empty, unmodeled: true };
  // Protected-surface doubles: a hand copy of the validation or money kernel
  // cannot produce the refusals the real one enforces, so it is refused here
  // (allow-listed at the tree level while its conversion is queued). A body
  // that only re-exports the real module is exempt — it cannot drift.
  const doubles = [];
  const seenDoubles = new Set();
  for (const rule of rules) {
    if (!rule.mock) continue;
    const body = blocks.get(rule.mock);
    if (body === undefined) continue;
    const declared = moduleExports(codeOnly(body));
    const protectedNames = [...declared].filter((name) => PROTECTED_EXPORT_NAMES.has(name)).sort();
    const target = rule.spec.kind === "exact" ? resolveReal(rule.spec.value, path, root) : null;
    const targetProtected = target !== null && PROTECTED_REAL_PATHS.has(target);
    if (!targetProtected && protectedNames.length === 0) continue;
    if (isPureReexportOfProtected(body, path, root)) continue;
    const key = `${rule.mock}::${protectedNames.join(",")}`;
    if (seenDoubles.has(key)) continue;
    seenDoubles.add(key);
    doubles.push({
      spec: rule.mock,
      names: protectedNames,
      target: targetProtected ? rule.spec.value : null,
    });
  }
  const needs = new Map(); // mockKey -> Map(name -> via)
  const lazyNeeds = new Map();
  const visitedStatic = new Set();
  const visitedLazy = new Set();
  const queue = [];
  const note = (mockKey, name, via, lazy) => {
    const table = lazy ? lazyNeeds : needs;
    if (!table.has(mockKey)) table.set(mockKey, new Map());
    if (!table.get(mockKey).has(name)) table.get(mockKey).set(name, via);
  };
  // Queue entries carry laziness: anything reached only through a dynamic
  // import may never execute, so its needs are warnings, not gaps.
  const parent = new Map(); // file -> {importer, spec} for chains
  const enqueue = (file, lazy, via) => {
    if (!file) return;
    // A lazily-reached module re-processed on a static path upgrades to
    // static: its needs fail the build, not merely warn.
    if (lazy && (visitedStatic.has(file) || visitedLazy.has(file))) return;
    if (!lazy && visitedStatic.has(file)) return;
    (lazy ? visitedLazy : visitedStatic).add(file);
    if (via !== undefined && !parent.has(file)) parent.set(file, via);
    queue.push({ file, lazy });
  };
  const chainTo = (file) => {
    const links = [file.replace(root + "/", "")];
    let cursor = file;
    const seenChain = new Set([file]);
    while (parent.get(cursor)) {
      const { importer, spec } = parent.get(cursor);
      links[0] = `${importer} -[${spec}]-> ${links[0]}`;
      cursor = `${root}/${importer}`;
      if (seenChain.has(cursor)) break;
      seenChain.add(cursor);
    }
    return links[0];
  };
  for (const imp of cachedImports(path)) {
    const rule = matchRule(rules, imp.spec, path);
    if (rule) {
      if (rule.mock) for (const name of imp.names) note(rule.mock, name, path, imp.dynamic);
      continue;
    }
    enqueue(cachedResolve(imp.spec, path, root), imp.dynamic, { importer: path.replace(root + "/", ""), spec: imp.spec });
  }
  let guard = 0;
  while (queue.length > 0) {
    if (++guard > 6000) break;
    const { file: current, lazy: parentLazy } = queue.pop();
    if (readCached(current) === null) continue;
    for (const imp of cachedImports(current)) {
      const lazy = parentLazy || imp.dynamic;
      const rule = matchRule(rules, imp.spec, current);
      if (rule) {
        if (rule.mock) {
          for (const name of imp.names) note(rule.mock, name, current, lazy);
          if (imp.star) {
            const target = cachedResolve(imp.spec, current, root);
            if (target) for (const name of cachedExports(target)) note(rule.mock, name, current, lazy);
          }
        }
        continue;
      }
      enqueue(cachedResolve(imp.spec, current, root), lazy, { importer: current.replace(root + "/", ""), spec: imp.spec });
    }
  }
  const gaps = [];
  for (const [mockKey, names] of needs) {
    const body = blocks.get(mockKey);
    if (body === undefined) continue;
    const have = new Set([
      ...moduleExports(codeOnly(body)),
      ...starReexports(body, path, root),
    ]);
    const missing = [...names.keys()].filter((name) => !have.has(name));
    if (missing.length > 0) {
      gaps.push({
        spec: mockKey,
        names: missing.sort(),
        via: Object.fromEntries(missing.map((name) => [name, chainTo(names.get(name) ?? path)])),
      });
    }
  }
  const gapNames = new Set(gaps.flatMap((gap) => gap.names.map((name) => `${gap.spec}::${name}`)));
  const lazy = [];
  for (const [mockKey, names] of lazyNeeds) {
    const body = blocks.get(mockKey);
    if (body === undefined) continue;
    const have = moduleExports(codeOnly(body));
    const missing = [...names.keys()].filter((name) => !have.has(name) && !gapNames.has(`${mockKey}::${name}`));
    if (missing.length > 0) lazy.push({ spec: mockKey, names: missing.sort() });
  }
  return { gaps, lazy, unmodeled: false, deadMocks: [], doubles };
}

export function checkTree(root = ROOT, allowlist = PROTECTED_DOUBLE_ALLOWLIST) {
  const files = collectTestFiles(root);
  const report = { files: files.length, gaps: [], lazy: [], unmodeled: [], checked: 0, doubles: [], allowedDoubles: [], staleDoubles: [] };
  for (const file of files) {
    const result = checkFile(file, root);
    if (result.unmodeled) report.unmodeled.push(file.replace(root + "/", ""));
    if (result.gaps.length > 0 || result.lazy.length > 0) report.checked++;
    for (const gap of result.gaps) report.gaps.push({ file: file.replace(root + "/", ""), ...gap });
    for (const entry of result.lazy) report.lazy.push({ file: file.replace(root + "/", ""), ...entry });
    const rel = file.replace(root + "/", "");
    for (const double of result.doubles) {
      const entry = allowlist.get(rel);
      if (entry && Object.prototype.hasOwnProperty.call(entry, double.spec)) {
        report.allowedDoubles.push({ file: rel, spec: double.spec });
      } else {
        report.doubles.push({ file: rel, ...double });
      }
    }
  }
  // Bidirectional ratchet: an allow-list entry nothing matches any more is
  // stale and fails, so deleting a double must strike its entry in the same
  // commit — the list can only shrink.
  const live = new Set([...report.doubles, ...report.allowedDoubles].map((entry) => `${entry.file}::${entry.spec}`));
  for (const [file, specs] of allowlist) {
    for (const spec of Object.keys(specs)) {
      if (!live.has(`${file}::${spec}`)) report.staleDoubles.push({ file, spec });
    }
  }
  return report;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === join(process.cwd(), process.argv[1]) || process.argv[1].endsWith("check-test-mock-surface.mjs") : false;
if (invoked) {
  const root = process.argv[2] ?? ROOT;
  const report = checkTree(root);
  for (const gap of report.gaps) {
    console.log(`${gap.file} [mock:${gap.spec}] missing: ${gap.names.join(", ")}`);
    for (const name of gap.names) console.log(`    ${name} required by ${gap.via[name]}`);
  }
  for (const file of report.unmodeled) {
    console.log(`${file}: mock wiring not modelable; extend parseWiring or model the file explicitly`);
  }
  for (const double of report.doubles) {
    const surface = double.target ?? "protected export names";
    console.log(`${double.file} [mock:${double.spec}] hand double of protected surface ${surface}${double.names.length > 0 ? ` (${double.names.join(", ")})` : ""}; convert to the real module or re-export it, then strike the allow-list entry`);
  }
  for (const stale of report.staleDoubles) {
    console.log(`${stale.file} [mock:${stale.spec}] allow-list entry matches no live double; strike it in the commit that removed the double`);
  }
  if (report.allowedDoubles.length > 0) {
    console.log(`allow-listed protected doubles (conversion queue): ${report.allowedDoubles.length}`);
  }
  if (report.lazy.length > 0) {
    console.error(`lazy notes (reachable only through dynamic import; warnings, not failures): ${report.lazy.length}`);
    for (const entry of report.lazy.slice(0, 20)) {
      console.error(`  ${entry.file} [mock:${entry.spec}] lazy-missing: ${entry.names.join(", ")}`);
    }
  }
  console.log(`checked ${report.files} test files; gaps=${report.gaps.length} unmodeled=${report.unmodeled.length} doubles=${report.doubles.length} staleDoubles=${report.staleDoubles.length}`);
  process.exit(report.gaps.length > 0 || report.unmodeled.length > 0 || report.doubles.length > 0 || report.staleDoubles.length > 0 ? 1 : 0);
}
