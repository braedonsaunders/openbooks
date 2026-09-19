// Author-time guard for the pooled-runner masking defect: an integration
// test that eagerly loads web/lib/request-org.ts (even transitively through
// a data reader) replaces the test bypass resolver process-wide, so bare
// fixture writes run RLS-enforced file-alone. Unscoped INSERTs die with
// `new row violates row-level security policy`; unscoped UPDATE/DELETEs
// silently match zero rows (both modes verified against the live policies
// with bypass off + empty org: SELECT/UPDATE see zero rows, INSERT errors).
// The pooled suite masks both.
// Flags per-test-file findings with the import chain and the fix; exit 1
// when any file is exposed.
// Deliberate boundaries: DDL and reads are out of scope (DDL succeeds
// unscoped; reads fail silently but noisily at assertions). Lazy in-test
// import() is safe for setup and ignored. Chains through unresolvable specs
// (workspace packages, next/*) are missed, as are writes after a mid-file
// hooks.deregister() + lazy web re-import.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOnly, parseWiring, resolveReal, staticImports, stringBindings } from "./check-test-mock-surface.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TEST_RE = /\.integration\.test\.(ts|tsx|mts|mjs|js|jsx)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);
const SCAN_SUBS = ["engine/src", "web", "packages", "schema", "e2e"];

// Fixture writers that die on RLS without an explicit scope: bare bootstrap
// inserts into orgs, bare seed helpers insert tenant rows, and bare
// db/tx.execute writes run with RLS enforced. dropScratchOrg self-wraps in
// withBypassContext, so teardown needs no wrapper and is not listed.
// (The entry-point list lives on the writeCalls pattern below.)
// First SQL word of a row-write template. DDL (create/alter/drop/...) is
// NOT RLS-gated and succeeds unscoped, so it is out of scope; reads
// (including WITH..SELECT) return zero rows unscoped - wrong but silent, a
// different class this guard does not chase.
const WRITE_VERBS = new Set(["insert", "update", "delete", "merge"]);
// Anything that installs an explicit scope: bypass blocks for seeds and
// org blocks for tenant writes both survive the resolver replacement.
const SCOPE_CALLS = ["withBypass", "withBypassContext", "withOrg", "withOrgContext"];

const rel = (path, root) => (path.startsWith(root + "/") ? path.slice(root.length + 1) : path);
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fileCache = new Map();
const edgesCache = new Map();
const reachCache = new Map();
const rulesCache = new Map();
export function clearCaches() {
  fileCache.clear();
  edgesCache.clear();
  reachCache.clear();
  rulesCache.clear();
}

// Spec/parent matchers mirroring check-test-mock-surface semantics: a test
// file's registerHooks resolve hook rewrites module resolution process-wide,
// so a mocked or data:-shimmed specifier cuts the real subtree out of the
// load-time closure (e.g. a mocked ../money-server means money-server.ts -
// and everything it alone pulls in - never loads).
function specMatches(rule, value) {
  if (rule.kind === "exact") return value === rule.value;
  if (rule.kind === "suffix") return value.endsWith(rule.value);
  if (rule.kind === "prefix") return value.startsWith(rule.value);
  if (rule.kind === "substr") return value.includes(rule.value);
  return false;
}

function cutByRules(rules, spec, importerPath) {
  for (const rule of rules) {
    if (!specMatches(rule.spec, spec)) continue;
    const parent = rule.parent;
    if (parent && parent.kind !== "any" && !specMatches(parent, importerPath)) continue;
    // First matching rule wins: a mock: or data: rewrite replaces the real
    // module, so the real file (and its subtree) never loads.
    return true;
  }
  return false;
}

function wiringRules(testFile) {
  let rules = rulesCache.get(testFile);
  if (rules === undefined) {
    rules = [];
    const src = readCached(testFile);
    if (src !== null) {
      try {
        rules = parseWiring(src);
      } catch {
        rules = [];
      }
    }
    rulesCache.set(testFile, rules);
  }
  return rules;
}

function readCached(path) {
  let src = fileCache.get(path);
  if (src === undefined) {
    try {
      src = readFileSync(path, "utf8");
    } catch {
      src = null;
    }
    fileCache.set(path, src);
  }
  return src;
}

// Eager (load-time) import edges of one file: static imports, re-exports,
// and top-level dynamic imports all execute before any test runs. Nested
// dynamic imports (route-handler style, inside test bodies) load after setup
// and do not expose fixture creation, so they are not edges here. Edges are
// cached unfiltered: each test file's own resolve-hook mocks cut different
// subtrees, so filtering happens at traversal time.
function eagerEdgesRaw(path, root) {
  let edges = edgesCache.get(`${root}::${path}`);
  if (edges === undefined) {
    edges = [];
    const src = readCached(path);
    if (src !== null) {
      for (const imp of staticImports(src)) {
        if (imp.dynamic) continue;
        const target = resolveReal(imp.spec, path, root);
        if (target) edges.push({ spec: imp.spec, target });
      }
    }
    edgesCache.set(`${root}::${path}`, edges);
  }
  return edges;
}

function requestOrgTarget(root) {
  return join(root, "web", "lib", "request-org.ts");
}

const unescapeSpec = (text) => text.replace(/\\(['"`\\])/g, "$1");

// The test file's own load points: hoisted static imports/re-exports
// (pos -1: they evaluate before any module body) and top-level dynamic
// imports (pos = offset: module evaluation runs them in source order, so a
// top-level write before one still sees the test bypass).
/**
 * Dynamic `import(...)` calls, with the argument text and its offset.
 *
 * The argument scan MUST respect quotes. It used to be
 * /import\s*\(\s*([^)]*?)\)/ at both call sites below, which stops at the first
 * ")" — and a Next.js route group puts one INSIDE the specifier:
 * `import('../app/(app)/ar/view')` captured `'../app/(app`, matched no literal
 * shape, and the load point was silently dropped. For this guard that means a
 * module reached through a route group was invisible to reachability, so writes
 * behind it were never attributed to a bypass scope. Route groups are used
 * throughout this app, so the blind spot was large and quiet.
 *
 * One helper, two call sites: the idiom was copied once already (it is also how
 * the mock-surface guard lost whole import subtrees), so it lives in exactly one
 * place here.
 */
function dynamicImportCalls(code) {
  const calls = [];
  const pattern = /import\s*\(\s*(?:(['"`])((?:\\.|(?!\1)[^\\])*)\1|([A-Za-z_$][\w$]*))\s*(?:,[\s\S]*?)?\)/g;
  for (const match of code.matchAll(pattern)) {
    const inner = match[2] !== undefined
      ? `${match[1]}${match[2]}${match[1]}`
      : (match[3] ?? "");
    calls.push({ inner, index: match.index });
  }
  return calls;
}

export function ownLoadPoints(code) {
  const points = [];
  const statik = /import\s+(?!\s*type\b)((?:[^{}'"]|\{[^}]*\})*?\s+from\s+)?(['"])((?:\\\2|(?!\2).)+)\2/g;
  for (const match of code.matchAll(statik)) {
    const clause = (match[1] ?? "").trim();
    if (/^\s*type[\s{]/.test(clause)) continue;
    points.push({ spec: unescapeSpec(match[3]), pos: -1 });
  }
  for (const match of code.matchAll(/export\s+(?:\{[^}]*\}|\*[^;]*?)\s+from\s+(['"])((?:\\\1|(?!\1).)+)\1/g)) {
    if (/^\s*export\s+type\s/.test(match[0])) continue;
    points.push({ spec: unescapeSpec(match[2]), pos: -1 });
  }
  const bindings = stringBindings(code);
  for (const call of dynamicImportCalls(code)) {
    if (braceDepthAt(code, call.index) !== 0) continue;
    const inner = call.inner.trim();
    const literal = inner.match(/^(['"])((?:\\\1|(?!\1).)+)\1$/);
    if (literal) {
      points.push({ spec: unescapeSpec(literal[2]), pos: call.index });
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(inner) && bindings.has(inner)) {
      points.push({ spec: bindings.get(inner), pos: call.index });
    }
  }
  return points;
}

// Brace depth at an offset, skipping string/template spans (an unbalanced
// brace in a message must not move a top-level import; braces inside regex
// literals can still miscount, which only ever demotes toward nested).
function braceDepthAt(code, index) {
  let depth = 0;
  let i = 0;
  while (i < index) {
    const char = code[i];
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      i++;
      while (i < index && code[i] !== quote) {
        if (code[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    i++;
  }
  return depth;
}

export function reachesTarget(start, rules, root) {
  const target = requestOrgTarget(root);
  if (start === target) return true;
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of eagerEdgesRaw(current, root)) {
      if (cutByRules(rules, edge.spec, current)) continue;
      if (edge.target === target) return true;
      if (!seen.has(edge.target)) {
        seen.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return false;
}

// Offset the resolver replacement starts at: -1 when a hoisted import
// reaches request-org (everything exposed), else the earliest top-level
// dynamic import that does, else Infinity (unreachable - no findings).
export function exposureOffset(path, root) {
  const rules = wiringRules(path);
  const src = readCached(path);
  if (src === null) return Infinity;
  let offset = Infinity;
  for (const point of ownLoadPoints(codeOnly(src))) {
    if (cutByRules(rules, point.spec, path)) continue;
    const target = resolveReal(point.spec, path, root);
    if (!target || !reachesTarget(target, rules, root)) continue;
    if (point.pos === -1) return -1;
    offset = Math.min(offset, point.pos);
  }
  // A chain exists but no load point was positioned (e.g. a template
  // dynamic import): expose everything rather than miss the defect.
  if (offset === Infinity && exposureChain(path, root)) return -1;
  return offset;
}

// The projection with single/double-quoted contents blanked (offsets kept):
// structural scans must never see `seed(` inside a failure message.
// Template `${...}` interpolations blanked (delimiters included, offsets
// kept): interpolation bodies are balanced code, so erasing them preserves
// paren/brace balance while letting the lexers below stay dumb - a `)` or
// `}` inside an interpolation (or a string therein) can otherwise desync
// brace/paren counting for the rest of the file.
export function noInterp(code) {
  let out = "";
  let i = 0;
  const blank = (char) => {
    out += char === "\n" ? "\n" : " ";
  };
  const copyQuoted = (quote) => {
    out += quote;
    i++;
    while (i < code.length && code[i] !== quote) {
      if (code[i] === "\\") {
        blank(" ");
        blank(" ");
        i += 2;
        continue;
      }
      blank(code[i]);
      i++;
    }
    out += code[i] ?? "";
    i++;
  };
  const blankTemplate = () => {
    // Entered on the opening backtick; consumes through its match.
    out += "`";
    i++;
    while (i < code.length) {
      if (code[i] === "\\") {
        blank(" ");
        blank(" ");
        i += 2;
        continue;
      }
      if (code[i] === "`") {
        out += "`";
        i++;
        return;
      }
      if (code[i] === "$" && code[i + 1] === "{") {
        blank(" ");
        blank(" ");
        i += 2;
        blankBalanced();
        continue;
      }
      blank(code[i]);
      i++;
    }
  };
  const blankBalanced = () => {
    // Blanks to the matching `}` of an interpolation.
    let depth = 1;
    while (i < code.length && depth > 0) {
      if (code[i] === "'" || code[i] === '"') {
        copyQuotedBlank(code[i]);
        continue;
      }
      if (code[i] === "`") {
        blankTemplate();
        continue;
      }
      if (code[i] === "\\") {
        blank(" ");
        blank(" ");
        i += 2;
        continue;
      }
      if (code[i] === "$" && code[i + 1] === "{") {
        depth++;
        blank(" ");
        blank(" ");
        i += 2;
        continue;
      }
      if (code[i] === "}") {
        depth--;
        if (depth === 0) {
          out += "}";
          i++;
          return;
        }
        blank(" ");
        i++;
        continue;
      }
      blank(code[i]);
      i++;
    }
  };
  const copyQuotedBlank = (quote) => {
    blank(quote);
    i++;
    while (i < code.length && code[i] !== quote) {
      if (code[i] === "\\") {
        blank(" ");
        blank(" ");
        i += 2;
        continue;
      }
      blank(code[i]);
      i++;
    }
    blank(code[i] ?? " ");
    i++;
  };
  while (i < code.length) {
    const char = code[i];
    if (char === "'" || char === '"') {
      copyQuoted(char);
      continue;
    }
    if (char === "`") {
      blankTemplate();
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

export function stripped(code) {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const char = code[i];
    if (char === "'" || char === '"') {
      out += char;
      i++;
      while (i < code.length && code[i] !== char) {
        if (code[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += code[i] ?? "";
      i++;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

// Load-time import chain from the test file to web/lib/request-org.ts, or
// null. Importing that module REPLACES the test bypass resolver process-wide
// (registerRequestOrgResolver overwrites), so every file on this list runs
// its setup with RLS enforced.
export function exposureChain(testFile, root = ROOT) {
  const cacheKey = `${root}::${testFile}`;
  if (reachCache.has(cacheKey)) return reachCache.get(cacheKey);
  const target = requestOrgTarget(root);
  const rules = wiringRules(testFile);
  let chain = null;
  if (testFile !== target) {
    const parents = new Map([[testFile, null]]);
    const queue = [testFile];
    while (queue.length > 0 && !parents.has(target)) {
      const current = queue.shift();
      for (const edge of eagerEdgesRaw(current, root)) {
        // Mocked or data:-shimmed by this test file's own resolve hook:
        // the real module never loads, so its subtree cannot expose setup.
        if (cutByRules(rules, edge.spec, current)) continue;
        if (!parents.has(edge.target)) {
          parents.set(edge.target, current);
          queue.push(edge.target);
        }
      }
    }
    if (parents.has(target)) {
      chain = [];
      for (let node = target; node !== null; node = parents.get(node)) chain.unshift(node);
    }
  }
  reachCache.set(cacheKey, chain);
  return chain;
}

// Balanced [start, end) of the call starting at the `(` at openIndex.
// String-aware; runs on noInterp text where templates hold no live code.
export function callExtent(src, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < src.length; i++) {
    const char = src[i];
    if (quote) {
      if (char === "\\") { i++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "`") {
      // Template text and interpolations are blanked upstream (noInterp),
      // so this only ever spans inert text to its closing backtick.
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "`") break;
        i++;
      }
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return [openIndex, i + 1];
    }
  }
  return null;
}

// Balanced {..} body starting at the `{` at openIndex (same lexer).
export function braceExtent(src, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < src.length; i++) {
    const char = src[i];
    if (quote) {
      if (char === "\\") { i++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "`") {
      // Template text and interpolations are blanked upstream (noInterp),
      // so this only ever spans inert text to its closing backtick.
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "`") break;
        i++;
      }
      continue;
    }
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return [openIndex, i + 1];
    }
  }
  return null;
}

// A fixture-write call: a fixture entry point (matched on the stripped
// projection, so a name inside a message is not a call), or db/tx.execute
// whose SQL template starts with a write verb (matched on raw: the
// projection blanks template text). All inputs share offsets.
export function writeCalls(src, text) {
  const out = [];
  for (const match of text.matchAll(/\b(createScratchOrg|seedFlowActors|seedApprovalFlow|seedDraftDocument|createScratchUser|seedAdoption|calculatedRun|markLegacy)\s*\(/g)) {
    out.push({ index: match.index, call: `${match[1]}(...)` });
  }
  // Any receiver's .execute()/.query() whose first template/string argument
  // starts with a write verb: pooled clients (writer/client/pool) carry the
  // same ambient GUCs, so their writes die unscoped exactly like db.execute.
  for (const match of src.matchAll(/\b(\w+)\.(execute|query)\s*\(/g)) {
    const receiver = match[1];
    let i = match.index + match[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.slice(i, i + 3) === "sql" && !/[A-Za-z_$0-9]/.test(src[i + 3] ?? "")) {
      i += 3;
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === ".") {
        // sql.raw(`...`) / sql.join(...): the template lives inside.
        i++;
        while (i < src.length && /[A-Za-z_$0-9]/.test(src[i])) i++;
        while (i < src.length && /\s/.test(src[i])) i++;
        if (src[i] === "(") {
          i++;
          while (i < src.length && /\s/.test(src[i])) i++;
        }
      }
    }
    const quote = src[i];
    if (quote !== "`" && quote !== "'" && quote !== '"') continue;
    const head = src.slice(i + 1, i + 401).replace(/'([^'\\]|\\.)*'/g, "''");
    const first = (head.match(/^\s*([A-Za-z]+)/) ?? [])[1]?.toLowerCase();
    if (!first) continue;
    if (WRITE_VERBS.has(first)) {
      out.push({ index: match.index, call: `${receiver}.${match[2]}(${first} ...)` });
      continue;
    }
    if (first === "with" && /\b(insert|update|delete|merge)\b/i.test(head)) {
      out.push({ index: match.index, call: `${receiver}.${match[2]}(with ... insert/update/delete ...)` });
    }
  }
  return out;
}

// [start, end) extents of every withBypass*/withOrg* callback argument.
export function scopeRegions(code) {
  const regions = [];
  const names = SCOPE_CALLS.join("|");
  for (const match of code.matchAll(new RegExp(`\\b(${names})\\s*\\(`, "g"))) {
    const open = match.index + match[0].length - 1;
    const extent = callExtent(code, open);
    if (extent) regions.push(extent);
  }
  return regions;
}

const inRegions = (regions, index) => regions.some(([start, end]) => index >= start && index < end);

// Tracked RLS-exposure baseline (the ratchet). Every file below was verified
// to eagerly load web/lib/request-org.ts at import time (resolver-slot probe:
// the module-body registration observably replaces the preloaded test
// bypass), with unscoped fixture writes that die file-alone with 42501 or
// silently match zero rows. The fleet is working through this queue with the
// withBypassContext (seeds) / withOrgContext (reads and product calls) split.
// Rules: a file NOT on this list must have zero findings (a new exposure
// fails the build); a file fixed must leave this list in the same commit
// (a stale entry fails the build). Shrink this list only by fixing files —
// never add an entry without a slot-probe verification behind it.
// 109 files, 831 unscoped writes.
export const BASELINE_EXPOSED = new Map([
  ["web/app/(app)/admin/setup/agents/overview-loader.integration.test.ts", { writes: 5, via: "view.ts -> money-server.ts -> locale.ts -> auth.ts" }],
  ["web/app/(app)/admin/setup/agents/view-permission.integration.test.ts", { writes: 2, via: "view.ts -> money-server.ts -> locale.ts -> auth.ts" }],
  ["web/app/(app)/dashboard/_metrics-approval-union.integration.test.ts", { writes: 8, via: "authz.ts -> auth.ts" }],
  ["web/app/(app)/dashboard/_metrics-arap-tiles.integration.test.ts", { writes: 11, via: "authz.ts -> auth.ts" }],
  ["web/app/api/admin/setup/overhead/route-publish-validation.integration.test.ts", { writes: 1, via: "route.ts -> overhead-publish.ts -> true-cost-data.ts -> money-server.ts -> locale.ts -> auth.ts" }],
  ["web/app/api/admin/users/route.integration.test.ts", { writes: 3, via: "route.ts -> auth-reset.ts -> auth.ts" }],
  ["web/app/api/ap-capture/capture-revision-guard.integration.test.ts", { writes: 6, via: "route.ts -> documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/app/api/compliance/information-returns/route-threshold.integration.test.ts", { writes: 2, via: "route.ts -> compliance.ts -> core.ts -> org-scope.ts -> auth.ts" }],
  ["web/app/api/crm/activities/[id]/route-duration.integration.test.ts", { writes: 2, via: "route.ts -> crm.ts -> documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/app/api/documents/[id]/route-malformed-id.integration.test.ts", { writes: 1, via: "route.ts -> documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/app/api/journals/[id]/route-custom-preservation.integration.test.ts", { writes: 4, via: "documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/app/api/journals/[id]/route-malformed-id.integration.test.ts", { writes: 1, via: "route.ts -> documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/application/setup-commands.integration.test.ts", { writes: 13, via: "tool-catalog.ts -> authz.ts -> auth.ts" }],
  ["web/lib/apps/custom-field-controls.integration.test.ts", { writes: 15, via: "store.ts -> platform.ts -> documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/apps/query-catalog.integration.test.ts", { writes: 5, via: "custom-record-report-catalog.ts -> authz.ts -> auth.ts" }],
  ["web/lib/assistant/tool-contract.integration.test.ts", { writes: 2, via: "registry.ts -> authz.ts -> auth.ts" }],
  ["web/lib/assistant/tools-assets.integration.test.ts", { writes: 2, via: "registry.ts -> authz.ts -> auth.ts" }],
  ["web/lib/assistant/tools-equipment.integration.test.ts", { writes: 2, via: "registry.ts -> authz.ts -> auth.ts" }],
  ["web/lib/assistant/tools-expenses.integration.test.ts", { writes: 13, via: "registry.ts -> authz.ts -> auth.ts" }],
  ["web/lib/assistant/tools-files-scope.integration.test.ts", { writes: 7, via: "registry.ts -> tools.ts -> data.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/assistant/tools-inventory.integration.test.ts", { writes: 2, via: "registry.ts -> authz.ts -> auth.ts" }],
  ["web/lib/assistant/tools-meta.integration.test.ts", { writes: 6, via: "registry.ts -> authz.ts -> auth.ts" }],
  ["web/lib/assistant/tools-ops.integration.test.ts", { writes: 12, via: "registry.ts -> authz.ts -> auth.ts" }],
  ["web/lib/assistant/tools-orders.integration.test.ts", { writes: 2, via: "registry.ts -> authz.ts -> auth.ts" }],
  ["web/lib/assistant/tools-subcontracts.integration.test.ts", { writes: 2, via: "registry.ts -> authz.ts -> auth.ts" }],
  ["web/lib/crm-forecast-snapshots.integration.test.ts", { writes: 5, via: "route.ts -> crm.ts -> documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/crm-party-lifecycle.integration.test.ts", { writes: 9, via: "route.ts -> crm.ts -> documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/crm-write-validation.integration.test.ts", { writes: 1, via: "route.ts -> crm.ts -> documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/data-io/transaction-roundtrip.integration.test.ts", { writes: 2, via: "transaction-resources.ts -> documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/data-io/transaction-subsidiary.integration.test.ts", { writes: 2, via: "transaction-resources.ts -> documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/module-home/purchasing-pulse-tieout.integration.test.ts", { writes: 5, via: "core.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/module-home/purchasing-subsidiaryless-scope.integration.test.ts", { writes: 8, via: "purchasing.ts -> core.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/order-billed-unwind.integration.test.ts", { writes: 4, via: "order-cycle.ts -> bills.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/order-read-scope.integration.test.ts", { writes: 8, via: "handlers.ts -> authz.ts -> auth.ts" }],
  ["web/lib/primary-book-history.integration.test.ts", { writes: 21, via: "route.ts -> documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/project-billing-accounting.integration.test.ts", { writes: 46, via: "bills.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/recurring-controls.integration.test.ts", { writes: 7, via: "route.ts -> documents.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/report-drill-scope.integration.test.ts", { writes: 1, via: "transaction-detail.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/reports/aging-null-subsidiary.integration.test.ts", { writes: 2, via: "aging.ts -> org-scope.ts -> auth.ts" }],
  ["web/lib/statement-book-selection.integration.test.ts", { writes: 4, via: "authz.ts -> auth.ts" }],
  ["web/lib/wip-account-policy.integration.test.ts", { writes: 5, via: "wip-billing.ts -> bills.ts -> org-scope.ts -> auth.ts" }],
]);


// Extents of test/it/hook callbacks: they always run after module evaluation,
// so writes inside them are never early-safe - even when the test is declared
// before the exposing import. describe() bodies are excluded on purpose: they
// run inline during collection, so source order applies to them.
function deferredRegions(code) {
  const regions = [];
  for (const match of code.matchAll(/\b(?:test|it|before|beforeEach|after|afterEach)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const extent = callExtent(code, open);
    if (extent) regions.push(extent);
  }
  return regions;
}

// A helper referenced by name as a test/it/hook callback (`test("x", seed)`):
// the reference is a deferred call site even though it has no parens. A
// `describe` body runs inline at collection, so a describe-named reference
// stays positional and is not collected here.
function namedCallbackSites(code, name) {
  const out = [];
  const pattern = new RegExp(`\\b(?:test|it|before|beforeEach|after|afterEach)\\s*\\(\\s*['"\`]([^'"\`]{0,70})['"\`]\\s*,\\s*${esc(name)}\\s*[,)]`, "g");
  for (const match of code.matchAll(pattern)) out.push({ index: match.index, test: match[1] });
  return out;
}

// File-local function definitions with their body extents. `function`
// declarations resolve through balanced params plus an optional return
// annotation (an object-literal annotation is skipped when a second block
// follows it); `const` arrows resolve through `=>` and require the block
// before any `;`, so expression bodies and object literals never match.
export function functionDefs(code) {
  const defs = [];
  const seen = new Set();
  const lex = (i, state) => {
    const char = code[i];
    if (state.quote) {
      if (char === "\\") return { skip: 1 };
      if (char === state.quote) state.quote = null;
      return {};
    }
    if (char === "'" || char === '"' || char === "`") { state.quote = char; return {}; }
    if (char === "(") state.paren++;
    if (char === ")") state.paren--;
    if (char === "{") state.brace++;
    if (char === "}") state.brace--;
    return {};
  };
  const nextNonSpace = (i) => {
    while (i < code.length && /\s/.test(code[i])) i++;
    return i;
  };
  const functionBody = (from) => {
    const state = { quote: null, paren: 0, brace: 0 };
    let i = nextNonSpace(from);
    if (code[i] === "<") {
      let angle = 0;
      while (i < code.length) {
        const stepped = lex(i, state);
        if (stepped.skip) i += stepped.skip;
        if (!state.quote && code[i] === "<") angle++;
        if (!state.quote && code[i] === ">") {
          angle--;
          if (angle === 0) { i++; break; }
        }
        i++;
      }
      i = nextNonSpace(i);
    }
    if (code[i] !== "(") return null;
    const params = callExtent(code, i);
    if (!params) return null;
    i = nextNonSpace(params[1]);
    if (code[i] === ";") return null;
    while (i < code.length) {
      if (code[i] === "{") {
        const extent = braceExtent(code, i);
        if (!extent) return null;
        // An object-literal return annotation is followed by the real body
        // block; a body is not followed by another block.
        const after = nextNonSpace(extent[1]);
        if (code[after] === "{") {
          i = after;
          continue;
        }
        return extent;
      }
      if (code[i] === ";") return null;
      i++;
    }
    return null;
  };
  const arrowBody = (from) => {
    const state = { quote: null, paren: 0, brace: 0 };
    for (let i = from; i < code.length; i++) {
      const before = { ...state };
      const stepped = lex(i, state);
      if (stepped.skip) i += stepped.skip;
      if (!state.quote && code[i] === "=" && code[i + 1] === ">" && before.paren === 0 && before.brace === 0) {
        const j = nextNonSpace(i + 2);
        // Parenthesized or single-identifier expression bodies have no block.
        if (code[j] !== "{") return null;
        return braceExtent(code, j);
      }
      if (!state.quote && code[i] === ";" && before.paren === 0 && before.brace === 0) return null;
      if (!state.quote && code[i] === "{" && before.paren === 0 && before.brace === 0) return null;
    }
    return null;
  };
  const add = (name, nameIndex, extent) => {
    if (seen.has(name) || !extent) return;
    seen.add(name);
    defs.push({ name, nameIndex, bodyStart: extent[0], bodyEnd: extent[1] });
  };
  for (const match of code.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    add(match[1], match.index + match[0].indexOf(match[1]), functionBody(match.index + match[0].length));
  }
  for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?/g)) {
    add(match[1], match.index + match[0].indexOf(match[1]), arrowBody(match.index + match[0].length));
  }
  return defs;
}

function callsOf(code, name) {
  const out = [];
  for (const match of code.matchAll(new RegExp(`\\b${esc(name)}\\s*\\(`, "g"))) out.push(match.index);
  return out;
}

function findEnclosing(code, index, raw) {
  const before = (raw ?? code).slice(0, index);
  const matches = [...before.matchAll(/\b(?:test|it|describe|before|beforeEach|after|afterEach)\s*\(\s*(['"`])((?:\\\1|(?!\1).){0,200}?)\1/g)];
  if (matches.length === 0) return "top level";
  const last = matches[matches.length - 1];
  return last[2];
}

// A top-level installTrustedTestDatabaseBypass() call re-registers the test
// bypass AFTER every hoisted static import has evaluated, so it neutralizes
// any request-org load the file's own top-level imports pulled in: the
// resolver slot is last-writer-wins on globalThis. Only a LATER load can
// re-expose the file — a top-level dynamic import after the call, or a lazy
// in-test import (which re-clobbers the slot for the rest of the process).
// Either re-exposure voids the reinstall and the scan falls back to the
// unscoped analysis. Returns the install index, or -1.
export function reinstallPos(code, text, path, root) {
  const deferred = deferredRegions(text);
  const defs = functionDefs(text);
  const topLevel = (index) =>
    !inRegions(deferred, index) &&
    !defs.some((def) => index > def.bodyStart && index < def.bodyEnd);
  let pos = -1;
  for (const match of text.matchAll(/\binstallTrustedTestDatabaseBypass\s*\(/g)) {
    if (!topLevel(match.index)) continue;
    if (pos < 0 || match.index < pos) pos = match.index;
  }
  // The direct idiom: registerRequestOrgResolver(() => ({ orgId: null,
  // bypass: true })) after the reader imports. Only a resolver carrying
  // bypass authority reinstalls it — a scoped (orgId, bypass false) or
  // undefined resolver establishes enforcement, not coverage.
  for (const match of text.matchAll(/\bregisterRequestOrgResolver\s*\(/g)) {
    if (!topLevel(match.index)) continue;
    const extent = callExtent(text, match.index + match[0].length - 1);
    if (!extent) continue;
    if (!/bypass\s*:\s*true/.test(text.slice(extent[0], extent[1]))) continue;
    if (pos < 0 || match.index < pos) pos = match.index;
  }
  if (pos < 0) return -1;
  const rules = wiringRules(path);
  const reaches = (spec, importer) => {
    if (cutByRules(rules, spec, importer)) return false;
    const target = resolveReal(spec, importer, root);
    return !!target && reachesTarget(target, rules, root);
  };
  for (const point of ownLoadPoints(code)) {
    if (point.pos > pos && reaches(point.spec, path)) return -1;
  }
  const bindings = stringBindings(code);
  for (const call of dynamicImportCalls(code)) {
    if (braceDepthAt(code, call.index) === 0) continue;
    const inner = call.inner.trim();
    const literal = inner.match(/^(['"])((?:\\\1|(?!\1).)+)\1$/);
    let spec = null;
    if (literal) spec = unescapeSpec(literal[2]);
    else if (/^[A-Za-z_$][\w$]*$/.test(inner) && bindings.has(inner)) spec = bindings.get(inner);
    if (spec && reaches(spec, path)) return -1;
  }
  return pos;
}

export function scanFile(path, root = ROOT) {
  // scanTree always hands us absolute paths, but an ad-hoc caller checking one
  // file naturally types a repo-relative one — and that resolves against the
  // process cwd, not the repo. Run from anywhere but the repo root and the read
  // below misses, so the file reports ZERO findings and reads CLEAN. That false
  // green has already been offered as proof once. Resolve against the repo root
  // so a one-off check cannot disagree with scanTree about the same file.
  if (!isAbsolute(path)) path = resolve(root, path);
  const raw = readCached(path);
  if (raw === null || !TEST_RE.test(path.split("/").pop())) return [];
  const chain = exposureChain(path, root);
  if (!chain) return [];
  const via = chain.slice(1, -1).map((node) => rel(node, root).split("/").pop()).join(" -> ");
  const code = codeOnly(raw);
  // Structural scans run on the quote-stripped projection (a `seed(` inside
  // a failure message is not a call); SQL words come from raw, and test
  // names come from raw. All three share offsets.
  const text = noInterp(stripped(code));
  const regions = scopeRegions(text);
  const defs = functionDefs(text);
  const calls = writeCalls(raw, text);
  const exposedFrom = exposureOffset(path, root);
  const deferred = deferredRegions(text);
  const reinstall = reinstallPos(code, text, path, root);
  // Module evaluation runs top-level statements in order, so a top-level
  // write before the first request-org load still sees the test bypass.
  // Anything inside a function body or a test/it/hook callback runs after
  // evaluation: exposed. `late` marks call sites known to run deferred
  // (named test callbacks). A top-level bypass reinstall covers every write
  // that runs after it: all deferred writes, and top-level writes past it.
  const earlySafe = (index) => {
    if (defs.some((def) => index > def.bodyStart && index < def.bodyEnd)) return false;
    return index < exposedFrom;
  };
  const reinstallCovers = (index, late) => {
    if (reinstall < 0) return false;
    if (late || inRegions(deferred, index)) return true;
    if (defs.some((def) => index > def.bodyStart && index < def.bodyEnd)) return false;
    return index > reinstall;
  };
  const covered = (index, late = false) =>
    inRegions(regions, index) || reinstallCovers(index, late) ||
    (!late && !inRegions(deferred, index) && earlySafe(index));
  // Callers of a helper: direct references plus named test callbacks.
  // The declaration site itself matches `name(` and precedes the body;
  // it is not a call. Test names come from code: stripped blanks contents.
  const callersOf = (owner) => {
    const callers = callsOf(text, owner.name)
      .filter((index) => index !== owner.nameIndex && (index < owner.bodyStart || index >= owner.bodyEnd))
      .map((index) => ({ index, late: inRegions(deferred, index) }));
    for (const site of namedCallbackSites(code, owner.name)) {
      callers.push({ index: site.index, late: true, test: site.test });
    }
    return callers;
  };
  // Transitive coverage fixpoint: a helper is clean when every caller is
  // covered — or calls from another clean helper (seed helpers calling seed
  // helpers). Optimistic start, monotone removal; recursion without an
  // externally covered caller cleans nothing.
  const clean = new Set(defs.map((def) => def.name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const def of defs) {
      if (!clean.has(def.name)) continue;
      const callers = callersOf(def);
      if (callers.length === 0) continue;
      const ok = callers.every((caller) =>
        covered(caller.index, caller.late) ||
        defs.some((inner) => inner.name !== def.name && clean.has(inner.name) &&
          caller.index > inner.bodyStart && caller.index < inner.bodyEnd));
      if (!ok) {
        clean.delete(def.name);
        changed = true;
      }
    }
  }
  const findings = [];
  const lineOf = (index) => raw.slice(0, index).split("\n").length;
  for (const call of calls) {
    if (covered(call.index, inRegions(deferred, call.index))) continue;
    // A write inside a file-local helper is covered when every (transitive)
    // caller runs inside a scope region (or before the exposure).
    const owner = defs.find((def) => call.index > def.bodyStart && call.index < def.bodyEnd);
    if (owner) {
      if (covered(owner.bodyStart)) continue;
      if (clean.has(owner.name)) continue;
      const callers = callersOf(owner);
      if (callers.length === 0) continue;
      // Name the uncovered end caller: a caller inside another (clean)
      // helper is a covered path, so prefer the caller that is neither
      // covered nor sheltered when one exists.
      const sheltered = (caller) => defs.some((inner) =>
        clean.has(inner.name) && caller.index > inner.bodyStart && caller.index < inner.bodyEnd);
      const bad = callers.find((caller) => !covered(caller.index, caller.late) && !sheltered(caller)) ??
        callers.find((caller) => !covered(caller.index, caller.late));
      findings.push({
        file: rel(path, root),
        line: lineOf(call.index),
        name: (bad.test ?? findEnclosing(code, bad.index, raw)).slice(0, 70),
        call: call.call.slice(0, 70),
        via: via.slice(0, 200),
        note: `inside helper ${owner.name}(), called without a scope`,
      });
      continue;
    }
    findings.push({
      file: rel(path, root),
      line: lineOf(call.index),
      name: findEnclosing(code, call.index, raw).slice(0, 70),
      call: call.call.slice(0, 70),
      via: via.slice(0, 200),
      note: "",
    });
  }
  return findings;
}

export function collectTestFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path);
      else if (TEST_RE.test(entry)) out.push(path);
    }
  };
  for (const sub of SCAN_SUBS) walk(join(root, sub));
  return out;
}

export function scanTree(root = ROOT) {
  const findings = [];
  for (const file of collectTestFiles(root)) {
    for (const finding of scanFile(file, root)) findings.push(finding);
  }
  return findings;
}

const invoked = process.argv[1] ? process.argv[1].endsWith("check-test-bypass-scope.mjs") : false;
if (invoked) {
const findings = scanTree(process.argv[2] ?? ROOT);
for (const finding of findings) {
  const where = finding.note ? `${finding.call} ${finding.note}` : finding.call;
  console.log(
    `${finding.file}:${finding.line} [${finding.name}] ${where} performs unscoped fixture writes, but this file eagerly loads web/lib/request-org.ts (${finding.via || "directly"}).\n` +
    `  WHY THIS FAILS (and why the symptom misleads): --import ./engine/src/test-database-bypass.ts installs a bypass resolver for the test process, but importing ` +
    `request-org.ts REPLACES it process-wide (the slot lives on globalThis) with a resolver returning undefined outside a Next.js request - so every unscoped write from here on runs RLS-enforced. ` +
    `An unscoped INSERT then dies at setup with \`new row violates row-level security policy\` (looks like a product regression; observed at bootstrapScratchOrg). ` +
    `An unscoped UPDATE/DELETE is worse: it silently matches zero rows, so setup never applies and the test can pass while proving nothing. ` +
    `scripts/test-suite.mjs masks both (pooled leases avoid bare bootstrap; permissive database roles hide the rest) - do not rely on a green pool run. ` +
    `Fix: wrap fixture creation and seed writes in withBypass()/withBypassContext() (reads: withOrgContext(); withOrg() also scopes writes; dropScratchOrg already self-wraps). ` +
    `Lazy in-test import() of route handlers after setup is safe for setup; eager top-level reader imports are not.`,
  );
}
console.log(`checked test bypass scope; exposed=${findings.length}`);
  process.exit(findings.length > 0 ? 1 : 0);
}