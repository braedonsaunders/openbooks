import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Refuse raw caught-error messages while permitting public validation prose.
 * Symbols preserve lexical scope: a callback's issue.message is not the
 * enclosing catch variable, even when the identifiers happen to match.
 * Besides responses, `new` domain-error constructions embedding a caught
 * message are refused — a curated-class error built from driver text
 * serializes the leak one layer down, where the response scan cannot see
 * it. Three shapes stay permitted: plumbing built on the base Error class
 * (routes map unknown Errors to a logged 500, and the response rule still
 * guards their serialization); a call through a sanitizer (a callee named
 * *sanitiz*) which washes the taint by contract; and a read inside the
 * consequent of an `instanceof` narrowing to a named domain error —
 * narrowing proves the message was curated at the class's own throw
 * sites, whether the read feeds a response or a construction (narrowing
 * to the base Error class exempts nothing, since driver failures are
 * Errors too). */
export function scanText(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = (name) => (name === file ? source : undefined);
  const program = ts.createProgram([file], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  const caught = new Set();
  const assignments = [];
  const responses = [];
  const symbol = (node) => (ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined);
  const unwrap = (node) => {
    while (
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      node = node.expression;
    return node;
  };
  function collect(node) {
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const binding = symbol(node.variableDeclaration.name);
      if (binding) caught.add(binding);
    }
    if (ts.isVariableDeclaration(node) && node.initializer)
      assignments.push([node.name, node.initializer]);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      assignments.push([node.left, node.right]);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "json"
    )
      responses.push(node);
    if (ts.isNewExpression(node)) constructions.push(node);
    // `if (caught instanceof DomainError) { ... }`: the consequent may read
    // the narrowed domain message. Recorded here, resolved against the
    // catch bindings after the walk (a narrowing to base Error exempts
    // nothing — driver failures are Errors too).
    if (
      ts.isIfStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
    ) {
      const left = unwrap(node.expression.left);
      const right = node.expression.right;
      if (ts.isIdentifier(left) && ts.isIdentifier(right)) {
        guardCandidates.push({
          left,
          target: right.text,
          start: node.thenStatement.getStart(source),
          end: node.thenStatement.getEnd(),
        });
      }
    }
    ts.forEachChild(node, collect);
  }
  const constructions = [];
  const guardCandidates = [];
  collect(source);
  function referencesCaught(node) {
    if (caught.has(symbol(node))) return true;
    return Boolean(ts.forEachChild(node, referencesCaught));
  }
  function sanitizerCall(node) {
    return (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && /sanitiz/i.test(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          /sanitiz/i.test(node.expression.name.text)))
    );
  }
  function rawMessage(node) {
    if (sanitizerCall(node)) return false;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "message" &&
      referencesCaught(node.expression)
    )
      return true;
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "message" &&
      referencesCaught(node.expression)
    )
      return true;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "String" &&
      node.arguments.some(referencesCaught)
    )
      return true;
    return Boolean(ts.forEachChild(node, rawMessage));
  }
  // Follow aliases of the caught object without confusing a safe message
  // or a shadowed callback binding with that object.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, value] of assignments) {
      const binding = symbol(name);
      if (!binding) continue;
      if (caught.has(symbol(unwrap(value))) && !caught.has(binding)) {
        caught.add(binding);
        changed = true;
      }
    }
  }
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  // instanceof-narrowed domain reads: the guard's consequent range per
  // caught binding, for targets other than the base Error class.
  const guards = guardCandidates
    .filter((guard) => guard.target !== "Error" && caught.has(symbol(guard.left)))
    .map((guard) => ({ binding: symbol(guard.left), start: guard.start, end: guard.end }));
  // Every raw caught-message read under a node: exempt only when each
  // one sits inside an instanceof-narrowed consequent for its binding.
  function rawReads(node, out = []) {
    if (sanitizerCall(node)) return out;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "message" &&
      referencesCaught(node.expression)
    ) {
      out.push(node);
      return out;
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "message" &&
      referencesCaught(node.expression)
    ) {
      out.push(node);
      return out;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "String" &&
      node.arguments.some(referencesCaught)
    ) {
      out.push(node);
      return out;
    }
    // The callback must return undefined: forEachChild stops traversal on
    // a truthy return, and the accumulator array is always truthy.
    ts.forEachChild(node, (child) => {
      rawReads(child, out);
    });
    return out;
  }
  function guarded(read) {
    const target = ts.isCallExpression(read) ? null : symbol(read.expression);
    return guards.some(
      (guard) =>
        (target ? guard.binding === target : false) &&
        read.getStart(source) >= guard.start &&
        read.getEnd() <= guard.end,
    );
  }
  function isBaseErrorConstruction(node) {
    return ts.isIdentifier(node.expression) && node.expression.text === "Error";
  }
  // Responses read through the same guard: a narrowed domain message is
  // curated at its throw sites, so only unguarded reads are refused.
  const responseLines = responses
    .filter((response) => {
      if (!response.arguments[0] || !rawMessage(response.arguments[0])) return false;
      return rawReads(response.arguments[0]).some((read) => !guarded(read));
    })
    .map(lineOf);
  const constructionLines = constructions
    .filter((constructed) => {
      if (!constructed.arguments || isBaseErrorConstruction(constructed)) return false;
      return [...constructed.arguments].some((argument) => {
        if (!argument || !rawMessage(argument)) return false;
        return rawReads(argument).some((read) => !guarded(read));
      });
    })
    .map(lineOf);
  return [...new Set([...responseLines, ...constructionLines])].sort((a, b) => a - b);
}

function main() {
  const root = process.cwd();
  const routes = [];
  function walk(dir, into, accept) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, into, accept);
      else if (accept(entry.name)) into.push(path);
    }
  }
  walk(join(root, "web/app/api"), routes, (name) => /route\.[cm]?[jt]sx?$/.test(name));
  // Engine services construct the user-facing errors the routes
  // serialize: a curated-class error built from driver text leaks one
  // layer down, where the response scan cannot see it. The engine scope
  // is the audited self-service + flows-decision surface; other modules
  // adopt the same rule file by file as their owners clear the hits.
  const engine = [
    "engine/src/hrm/change-requests.ts",
    "engine/src/flows/gates.ts",
    "engine/src/flows/decision-cause.ts",
  ].map((name) => join(root, name));
  for (const name of readdirSync(join(root, "engine/src/hrm/self-service"))) {
    if (/\.m?[jt]s$/.test(name) && !/\.test\.m?[jt]s$/.test(name))
      engine.push(join(root, "engine/src/hrm/self-service", name));
  }
  const violations = [...routes, ...engine].flatMap((file) =>
    scanText(file, readFileSync(file, "utf8")).map((line) => `${relative(root, file)}:${line}`),
  );
  if (violations.length) {
    console.error(
      `Raw caught error messages serialized by API responses or error constructions:\n${violations.join("\n")}`,
    );
    process.exitCode = 1;
  } else
    console.log(
      `API error sanitization check passed (${routes.length} route handlers and ${engine.length} engine services scanned).`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
