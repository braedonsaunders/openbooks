#!/usr/bin/env node
/**
 * Repo-wide audit: a fetch Response body must never be parsed before its
 * status is checked.
 *
 * A refusal that is computed must reach the caller. Three times in one day a
 * client read `await res.json()` and only afterwards asked `if (!res.ok)` —
 * so a non-JSON error body (an unhandled-throw 500 with an EMPTY body, a
 * proxy page, an empty 502) threw a SyntaxError out of the parse and the
 * operator read "Failed to execute 'json' on 'Response'" instead of the
 * server's refusal. The fix is adoption, not one more hand edit: the
 * convention is `readApiErrorMessage` (web/lib/api-error.ts — check the
 * status FIRST, parse only to extract a server `{ error }`, keep the
 * fallback on non-JSON), and this checker fails the build when a new site
 * parses before checking.
 *
 * A site violates when ALL of these hold (AST-walked, never grepped — a grep
 * counts comments and string literals as code):
 *
 *   viol1  the parsed receiver is a fetch Response: a variable initialized
 *          or assigned from `fetch(...)`, or a `.then()` callback parameter
 *          on a fetch chain. `req.json()` in route handlers and
 *          `NextResponse.json()` never match, because their receivers are
 *          never fetch-assigned;
 *   viol2  no status guard precedes the parse in the same function: an
 *          `if (!res.ok)` / `if (res.status !== 200)`-style check whose
 *          branch throws or returns. A bare `if (!res.ok) { toast; }` that
 *          falls through does NOT guard — the parse still runs on failure.
 *          Compound guards count when the boolean structure still routes
 *          every failure out (`if (!res.ok || cancelled) return` guards;
 *          `if (!res.ok && retryable) throw` does not), and a parse nested
 *          in the success branch (`if (res.ok && fresh) { ...parse... }`,
 *          or the ternary `r.ok ? r.json() : fallback`) is guarded;
 *   viol3  the parse is not the guarded expression the convention blesses:
 *          `res.json().catch(...)`, a parse already inside the success
 *          branch of a status check, or the sanctioned helper shape — a
 *          `try { body = await res.json() } catch { body = null }` whose try
 *          block checks no status and whose catch does not rethrow (the
 *          local fetchJson/postJson helpers and readApiErrorMessage itself
 *          all take this shape: the SyntaxError is converted to a fallback,
 *          never surfaced as the message);
 *   viol4  the same flow acknowledges the status ANYWHERE on the same
 *          receiver — after the parse, or before it without guarding. A
 *          success-path parse with no status read anywhere is a different
 *          pattern and out of scope for this guard, deliberately: this
 *          guard proves an ORDERING (the flow does check the status, but
 *          only after it could already have thrown on the body). A flow
 *          that never reads the status at all has no error branch to
 *          reorder; it fails in two ways (SyntaxError on a non-JSON body,
 *          and a JSON refusal it silently treats as success) and the fix
 *          is to add a status check, which is a different rule ("every
 *          fetch acknowledges its status") with its own census and its
 *          own allow-list. Catching it here would let a site pass by
 *          deleting its status check, which is the opposite of the intent.
 *
 * Compliant rewrites, in order of preference:
 *
 *   if (!res.ok) throw new Error(await readApiErrorMessage(res, 'fallback'))
 *   const body = await res.json()
 *
 * Exemptions live in check-fetch-response-parse.allowlist.json, keyed by
 * (path, nearest named enclosing function), each carrying a reviewed reason.
 * The ratchet cuts both ways: a site NOT on the list fails immediately, and
 * a list entry whose site no longer violates ALSO fails ("fixed — remove
 * from the allow-list"), so the list cannot rot into permanent amnesty.
 * An allow-list reason of "server always returns JSON" is only honest with
 * the route evidence cited: the handler must map every throw to a JSON body
 * (a catch-all returning NextResponse.json, including 500s). A route that
 * rethrows non-domain errors (`catch (e) { ...; throw e }`) can answer an
 * unhandled empty 500 and proves nothing — convert the client instead.
 * Infra-level non-JSON (proxy HTML pages, empty 502s) stays possible under
 * every entry; that residue is what full adoption of readApiErrorMessage
 * covers, hence every such reason ends in "guard adoption pending".
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// The repository pins its own parser: devDependency alias
// typescript-eslint-typescript -> npm:typescript@6.0.3 (the classic JS
// compiler API). No dependency is added beyond what package.json already pins.
const requireFromRoot = createRequire(new URL("../package.json", import.meta.url));
const ts = requireFromRoot("typescript-eslint-typescript");

const SELF_PATH = "scripts/check-fetch-response-parse.mjs";
const ALLOWLIST_PATH = "scripts/check-fetch-response-parse.allowlist.json";
/**
 * The allow-list may only SHRINK. This is the count at the guard-first
 * landing (129 sites held for typechecked conversion batches, queue item 60,
 * parent item 47); a change that
 * needs a larger list is a new violation being exempted, which is the thing
 * the guard exists to refuse. Lower this number as batches land; never raise
 * it. The stale-entry ratchet below stops entries rotting; this stops the
 * list growing.
 */
export const ALLOWLIST_CEILING = 129;

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadAllowlist(readFile = (file) => readFileSync(join(repoRoot(), file), "utf8")) {
  let entries;
  try {
    entries = JSON.parse(readFile(ALLOWLIST_PATH));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) throw new Error(`${ALLOWLIST_PATH} must hold a JSON array`);
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || typeof entry.fn !== "string") {
      throw new Error(`${ALLOWLIST_PATH}: every entry needs string "path" and "fn"`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new Error(`${ALLOWLIST_PATH}: ${entry.path} (${entry.fn}) carries no reviewed reason`);
    }
    const key = `${entry.path}::${entry.fn}`;
    if (seen.has(key)) throw new Error(`${ALLOWLIST_PATH} contains duplicate entry ${key}`);
    seen.add(key);
  }
  return entries;
}

function discoverClientSources() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "web/**/*.ts", "web/**/*.tsx"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .filter(
      (file) =>
        !/\.test\.[tj]sx?$/.test(file) && !/\.d\.tsx?$/.test(file) && file !== SELF_PATH,
    );
}

function isFunctionLike(node) {
  return (
    node != null &&
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node))
  );
}

function nearestFunction(node) {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function functionNameOf(node) {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return undefined;
}

/** Nearest NAMED enclosing operation; anonymous callbacks resolve outward so
 *  a parse buried in a `.then()` still reports the operation that owns it. */
function namedEnclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) {
      const name = functionNameOf(current);
      if (name) return name;
    }
    current = current.parent;
  }
  return "(top-level)";
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** True when the expression is `fetch(...)` or a `.then()/.catch()/.finally()`
 *  chain rooted at `fetch(...)`. */
function fetchRootedChain(node) {
  const unwrapped = unwrapExpression(node);
  if (!ts.isCallExpression(unwrapped)) return false;
  if (ts.isIdentifier(unwrapped.expression) && unwrapped.expression.text === "fetch") return true;
  let inner = unwrapped.expression;
  if (!ts.isPropertyAccessExpression(inner)) return false;
  inner = unwrapExpression(inner.expression);
  while (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
    inner = unwrapExpression(inner.expression.expression);
  }
  return ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === "fetch";
}

/** Response idents visible in a file: variables initialized or assigned from
 *  `fetch(...)`, and `.then()` callback parameters on a fetch chain. Each
 *  entry records the function that owns the binding (null for top level). */
function collectResponseIdents(sourceFile) {
  const found = [];
  const owningFunction = (node) => {
    let current = node.parent;
    while (current) {
      if (isFunctionLike(current)) return current;
      current = current.parent;
    }
    return null;
  };
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      fetchRootedChain(node.initializer)
    ) {
      found.push({ name: node.name.text, scopeFn: owningFunction(node) });
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      fetchRootedChain(node.right)
    ) {
      found.push({ name: node.left.text, scopeFn: owningFunction(node) });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "then"
    ) {
      const receiver = unwrapExpression(node.expression.expression);
      const fetchRooted =
        (ts.isCallExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          receiver.expression.text === "fetch") ||
        fetchRootedChain(node.expression.expression);
      if (fetchRooted) {
        for (const argument of node.arguments) {
          if (
            (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
            argument.parameters.length > 0 &&
            ts.isIdentifier(argument.parameters[0].name)
          ) {
            found.push({ name: argument.parameters[0].name.text, scopeFn: argument });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** True when a binding owned by scopeFn is visible at parseFn. */
function bindingVisibleAt(binding, parseFn) {
  if (binding.scopeFn === null) return true;
  if (parseFn === null) return false;
  if (binding.scopeFn === parseFn) return true;
  let current = parseFn.parent;
  while (current) {
    if (current === binding.scopeFn) return true;
    current = current.parent;
  }
  return false;
}

/** The `.catch()` refuge: `res.json().catch(...)` cannot throw, so the
 *  refusal survives as the caught value. Only a `.catch` on the SAME promise
 *  chain excuses — a `.catch` two callbacks later still runs the parse first. */
function hasSameChainCatch(jsonCall) {
  let current = jsonCall.parent;
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "catch"
    ) {
      return true;
    }
    if (
      isFunctionLike(current) ||
      ts.isExpressionStatement(current) ||
      ts.isVariableStatement(current) ||
      ts.isVariableDeclaration(current) ||
      ts.isReturnStatement(current) ||
      ts.isIfStatement(current) ||
      ts.isBlock(current) ||
      ts.isTryStatement(current)
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function containsThrow(node) {
  let hit = false;
  const visit = (child) => {
    if (hit) return;
    if (ts.isThrowStatement(child)) {
      hit = true;
      return;
    }
    if (isFunctionLike(child)) return;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return hit;
}

function containsThrowOrReturn(node) {
  let hit = false;
  const visit = (child) => {
    if (hit) return;
    if (ts.isThrowStatement(child) || ts.isReturnStatement(child)) {
      hit = true;
      return;
    }
    if (isFunctionLike(child)) return;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return hit;
}

/**
 * Classify a single status test on one receiver: `!res.ok` and
 * `res.status !== 200`-style failures are "negative", the bare `res.ok`
 * success reads are "positive". Leading `!` and parentheses are folded in
 * (`(!(res.ok))` is negative). Anything else is not a status test this
 * checker can reason about — callers split `&&`/`||` chains first and only
 * excuse the shapes documented there.
 */
function classifyStatusCondition(condition, name) {
  let node = condition;
  let negated = false;
  for (;;) {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      negated = !negated;
      node = node.operand;
      continue;
    }
    break;
  }
  const settle = (classification) => {
    if (classification === null) return null;
    if (!negated) return classification;
    return classification === "positive" ? "negative" : "positive";
  };
  const text = node.getText().replace(/\s+/g, " ");
  if (new RegExp(`^${name}\\.ok$`).test(text)) return settle("positive");
  let match = new RegExp(`^${name}\\.ok\\s*===?\\s*(true|false)$`).exec(text);
  if (match) return settle(match[1] === "true" ? "positive" : "negative");
  match = new RegExp(`^${name}\\.ok\\s*!==?\\s*(true|false)$`).exec(text);
  if (match) return settle(match[1] === "true" ? "negative" : "positive");
  match = new RegExp(`^${name}\\.status\\s*([!<>=]+)\\s*(\\d+)$`).exec(text);
  if (match) {
    const operator = match[1];
    const code = Number(match[2]);
    const success = code >= 200 && code < 300;
    if (operator === "===" || operator === "==") return settle(success ? "positive" : "negative");
    if (operator === "!==" || operator === "!=") return settle(success ? "negative" : "positive");
    if (operator === ">=" || operator === ">") return settle(code >= 300 ? "negative" : "positive");
    if (operator === "<" || operator === "<=") return settle("positive");
  }
  return null;
}

/**
 * Split a condition into its top-level `||` disjuncts. A negative status
 * test anywhere in the disjunction still exits through the taken branch:
 * `if (!res.ok || cancelled) return` guards the parse below it.
 */
function orDisjuncts(condition) {
  if (ts.isParenthesizedExpression(condition)) return orDisjuncts(condition.expression);
  if (
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.BarBarToken
  ) {
    return [...orDisjuncts(condition.left), ...orDisjuncts(condition.right)];
  }
  return [condition];
}

/**
 * Split a condition into its top-level `&&` conjuncts. A positive status
 * test anywhere in the conjunction still means the taken branch saw ok:
 * `if (res.ok && fresh) { parse }` parses only on success.
 */
function andConjuncts(condition) {
  if (ts.isParenthesizedExpression(condition)) return andConjuncts(condition.expression);
  if (
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [...andConjuncts(condition.left), ...andConjuncts(condition.right)];
  }
  return [condition];
}

/** The taken branch runs whenever any disjunct holds — it guards the parse
 *  below when a NEGATIVE status test is one of them. */
function thenBranchGuards(condition, name) {
  return orDisjuncts(condition).some(
    (disjunct) => classifyStatusCondition(disjunct, name) === "negative",
  );
}

/** A ternary routes the same way an if does: `r.ok ? r.json() : fallback`
 *  parses only on success, and `!r.ok ? fallback : r.json()` only on failure.
 *  The parse nested in the success side saw ok. */
function ternaryBranchSawOk(conditional, name, inConsequent) {
  if (inConsequent) return thenBranchSawOk(conditional.condition, name);
  return elseBranchSawOk(conditional.condition, name);
}

/** The taken branch runs only when every conjunct holds — the parse nested
 *  in it saw ok when a POSITIVE status test is one of them. */
function thenBranchSawOk(condition, name) {
  return andConjuncts(condition).some(
    (conjunct) => classifyStatusCondition(conjunct, name) === "positive",
  );
}

/** The else branch runs only when every disjunct fails — the parse nested
 *  in it saw ok when a NEGATIVE status test is one of them
 *  (`if (!res.ok || stale) { ... } else { parse }` parses only on ok). */
function elseBranchSawOk(condition, name) {
  return orDisjuncts(condition).some(
    (disjunct) => classifyStatusCondition(disjunct, name) === "negative",
  );
}

/** The else branch throws or returns while the taken branch required ok —
 *  control past the statement saw ok (`if (res.ok && fresh) { ... } else {
 *  throw }` leaves no failure path past it). */
function elseBranchGuards(condition, name) {
  return andConjuncts(condition).some(
    (conjunct) => classifyStatusCondition(conjunct, name) === "positive",
  );
}

/** Every `name.ok` / `name.status` read under root, excluding nested
 *  function bodies (a check inside a later callback is not this statement's
 *  guard). Positions are source offsets. */
function statusReadsIn(root, name) {
  const reads = [];
  const visit = (node) => {
    if (node !== root && isFunctionLike(node)) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name &&
      (node.name.text === "ok" || node.name.text === "status")
    ) {
      reads.push(node.getStart());
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return reads;
}

/**
 * The sanctioned-helper refuge: `try { body = await res.json() } catch {
 * body = null }` converts the SyntaxError to a fallback at the parse site,
 * exactly like readApiErrorMessage does. It excuses only when the try block
 * checks no status on the same receiver (the status is the CALLER's job, via
 * the returned `{ status, body }`) and the catch does not rethrow — a catch
 * that rethrows hands the SyntaxError straight back to the operator.
 */
function excusedAsGuardedParse(jsonCall, name) {
  let current = jsonCall.parent;
  while (current) {
    if (isFunctionLike(current)) return false;
    if (ts.isTryStatement(current)) {
      const tryBlock = current.tryBlock;
      if (!jsonCallWithin(current.tryBlock, jsonCall)) return false;
      if (statusReadsIn(tryBlock, name).length > 0) return false;
      if (!current.catchClause) return false;
      if (containsThrow(current.catchClause)) return false;
      return true;
    }
    current = current.parent;
  }
  return false;
}

function jsonCallWithin(root, target) {
  let hit = false;
  const visit = (node) => {
    if (hit || node === target) {
      if (node === target) hit = true;
      return;
    }
    if (node !== root && isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return hit;
}

/**
 * A preceding status guard in the same function: an `if` on the receiver
 * BEFORE the parse whose taken branch throws or returns (a guard clause),
 * or a parse nested in the success branch of a positive check. A status read
 * that merely toasts and falls through guards nothing — the parse still runs
 * on the failure path.
 */
function guardedBeforeParse(parseFn, sourceFile, jsonCall, name) {
  const jsonPos = jsonCall.getStart();
  // Containment first: the parse already sits in the success branch.
  // Direct ternary branch first: `r.ok ? r.json() : fallback` nests the
  // parse as the conditional itself, one level above where the climb starts.
  const directParent = jsonCall.parent;
  if (directParent && ts.isConditionalExpression(directParent)) {
    if (directParent.whenTrue === jsonCall && ternaryBranchSawOk(directParent, name, true)) {
      return true;
    }
    if (directParent.whenFalse === jsonCall && ternaryBranchSawOk(directParent, name, false)) {
      return true;
    }
  }
  let current = jsonCall.parent;
  while (current && current !== parseFn && current !== sourceFile) {
    const parent = current.parent;
    if (parent && ts.isIfStatement(parent)) {
      if (parent.thenStatement === current && thenBranchSawOk(parent.expression, name)) return true;
      if (parent.elseStatement === current && elseBranchSawOk(parent.expression, name)) return true;
    }
    if (parent && ts.isConditionalExpression(parent)) {
      if (parent.whenTrue === current && ternaryBranchSawOk(parent, name, true)) return true;
      if (parent.whenFalse === current && ternaryBranchSawOk(parent, name, false)) return true;
    }
    current = parent;
  }
  // Then preceding guard clauses in the same function flow.
  let guarded = false;
  const visit = (node) => {
    if (guarded) return;
    if (node !== parseFn && node !== sourceFile && isFunctionLike(node)) return;
    if (ts.isIfStatement(node) && node.getStart() < jsonPos) {
      if (thenBranchGuards(node.expression, name) && containsThrowOrReturn(node.thenStatement)) {
        guarded = true;
        return;
      }
      if (
        node.elseStatement &&
        elseBranchGuards(node.expression, name) &&
        containsThrowOrReturn(node.elseStatement)
      ) {
        guarded = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parseFn ?? sourceFile);
  return guarded;
}

/**
 * Any status read on the same receiver anywhere the binding is visible —
 * same function or a downstream `.then()` continuation. This is what makes
 * the shape reachable: the code admits the status matters. A check AFTER the
 * parse means the parse runs first; a check BEFORE the parse that neither
 * throws nor returns lets the parse run on the failure path anyway. Only a
 * real guard (handled by guardedBeforeParse) or no status read at all (a
 * success-path parse, out of scope) keeps the site clean.
 */
function statusReadAnywhere(parseFn, sourceFile, name, idents) {
  const scopeRoot = (() => {
    // The widest function in which the binding is visible: the binding's own
    // scope walked outward to the file. A check in a downstream continuation
    // still runs after the parse, so it still counts.
    let widest = sourceFile;
    for (const binding of idents) {
      if (binding.name !== name || !bindingVisibleAt(binding, parseFn)) continue;
      if (binding.scopeFn !== null) widest = binding.scopeFn;
    }
    return widest;
  })();
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name &&
      (node.name.text === "ok" || node.name.text === "status")
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scopeRoot);
  return found;
}

export function auditRepository(files, readSource = (file) => readFileSync(file, "utf8")) {
  const violations = [];
  const syntaxErrors = [];
  let scannedFiles = 0;

  for (const file of files) {
    let sourceText;
    try {
      sourceText = readSource(file);
    } catch {
      continue;
    }
    if (!sourceText.includes(".json(")) continue;
    scannedFiles += 1;

    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    if (sourceFile.parseDiagnostics.length > 0) {
      syntaxErrors.push(file);
      continue;
    }

    const idents = collectResponseIdents(sourceFile);
    if (idents.length === 0) continue;

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "json" &&
        ts.isIdentifier(node.expression.expression)
      ) {
        const name = node.expression.expression.text;
        const parseFn = nearestFunction(node);
        if (!idents.some((binding) => binding.name === name && bindingVisibleAt(binding, parseFn))) {
          ts.forEachChild(node, visit);
          return;
        }
        if (hasSameChainCatch(node)) {
          ts.forEachChild(node, visit);
          return;
        }
        if (excusedAsGuardedParse(node, name)) {
          ts.forEachChild(node, visit);
          return;
        }
        if (guardedBeforeParse(parseFn, sourceFile, node, name)) {
          ts.forEachChild(node, visit);
          return;
        }
        if (!statusReadAnywhere(parseFn, sourceFile, name, idents)) {
          ts.forEachChild(node, visit);
          return;
        }
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        violations.push({ path: file, line, fn: namedEnclosingFunction(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return { scannedFiles, violations, syntaxErrors };
}

/**
 * Split live violations against the allow-list. Exported so the guard's own
 * tests can prove both directions of the ratchet without shelling out.
 */
export function reconcile(violations, allowlist) {
  const baselineKeys = new Map(allowlist.map((entry) => [`${entry.path}::${entry.fn}`, entry]));
  const knownGaps = [];
  const newViolations = [];
  const matchedKeys = new Set();
  for (const site of violations) {
    const key = `${site.path}::${site.fn}`;
    const entry = baselineKeys.get(key);
    if (entry) {
      matchedKeys.add(key);
      knownGaps.push({ ...site, reason: entry.reason });
    } else {
      newViolations.push(site);
    }
  }
  const staleEntries = allowlist.filter((entry) => !matchedKeys.has(`${entry.path}::${entry.fn}`));
  return { knownGaps, newViolations, staleEntries };
}

function main() {
  const allowlist = loadAllowlist();
  const { scannedFiles, violations, syntaxErrors } = auditRepository(discoverClientSources());

  let failed = false;
  if (syntaxErrors.length > 0) {
    failed = true;
    console.error(
      `FAIL: ${syntaxErrors.length} file(s) have syntax errors, so the AST walk cannot reason about them.\n` +
        `Fix the syntax first — an unparseable file reports no violations and the gate would green a tree it never measured:`,
    );
    for (const file of syntaxErrors) console.error(`  ${file}`);
  }

  if (allowlist.length > ALLOWLIST_CEILING) {
    console.error(
      `FAIL ${ALLOWLIST_PATH} holds ${allowlist.length} entries, above the ceiling of ${ALLOWLIST_CEILING}: ` +
        "the allow-list may only shrink — convert the site (status check before the parse) instead of listing it.",
    );
    process.exitCode = 1;
    return;
  }
  const { knownGaps, newViolations, staleEntries } = reconcile(violations, allowlist);

  if (newViolations.length > 0) {
    failed = true;
    console.error(
      `FAIL: ${newViolations.length} response bod${newViolations.length === 1 ? "y is" : "ies are"} parsed before the status is checked.\n` +
        `A non-JSON error body (an unhandled-throw 500 with an EMPTY body, a proxy page, an empty 502)\n` +
        `throws a SyntaxError out of res.json() and the operator never sees the server's refusal.\n` +
        `Check the status first, then read the failure through readApiErrorMessage from web/lib/api-error.ts:\n` +
        `\n` +
        `  if (!res.ok) throw new Error(await readApiErrorMessage(res, 'fallback'))\n` +
        `  const body = await res.json()\n`,
    );
    for (const site of newViolations) console.error(`  ${site.path}:${site.line} (${site.fn})`);
  }
  if (staleEntries.length > 0) {
    failed = true;
    console.error("FAIL: allow-list entries no longer violate:");
    for (const entry of staleEntries) {
      console.error(`  ${entry.path} (${entry.fn}): fixed — remove from ${ALLOWLIST_PATH}`);
    }
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log(
    `PASS: all response parses across ${scannedFiles} files check the status first ` +
      `(${violations.length} known gap(s) allow-listed).`,
  );
  for (const gap of knownGaps) {
    console.log(`  allow-listed ${gap.path}:${gap.line} (${gap.fn}): ${gap.reason}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
