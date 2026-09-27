#!/usr/bin/env node
/**
 * Repo-wide ratchet: tests must exercise behaviour, not pin source text.
 *
 * A "source pin" is a test that reads a repository source file (.ts, .tsx,
 * .mjs, .js, .sql, .yml, .css) as TEXT and asserts on it. For example,
 * `assert.match(routeSource, /guardSubsidiaryScope\(authz, gate\.subsidiary_id\)/)`
 * proves a line exists, not that the route refuses an out-of-scope caller.
 * The 2026-09-23 census sampled 40 such tests, and all 40 were change
 * detectors: they break when the code is reformatted or refactored, and they
 * stay green when the behaviour regresses through any path the regex doesn't
 * mention. About 30% were written alongside a bug fix and only re-check the
 * fixed line.
 *
 * The file is parsed and bound, and a read counts when the file name its
 * path ends in has a source extension (through joins, `new URL`, bindings,
 * same-file path helpers and directory walks). Everything computed from what
 * it returns is followed inside that file: variable and destructuring
 * bindings and later assignments; string and array methods (`.slice`,
 * `.split`, `.replace`, `.filter`, indexing) and the callbacks run over the
 * pieces; positions, booleans and counts read off the text (`.indexOf`,
 * `.includes`, `re.test(text)`, `.length`); template interpolation and
 * concatenation; collections filled with it or under a condition on it
 * (`if (!text.includes(x)) offenders.push(file)`); and functions declared in
 * the same file, both helpers that return such a value and helpers that
 * assert on one. A test is a pin when an assertion (`assert.*`, a named
 * import from node:assert, or `expect`) inspects such a value.
 *
 * Text that is RUN rather than inspected is not followed: an argument to any
 * other call the file does not declare (`tx.execute(sql.raw(body))`, a
 * parser) or a callback handed to an assertion (`assert.rejects(() => ...)`).
 *
 * The rule, per test FILE:
 *   - count the tests (test/it calls, subtests counted on their own) that
 *     assert on source text;
 *   - a file NOT in scripts/test-source-pins.allowlist.json must have 0;
 *   - a file IN it may not exceed its recorded count, and an entry whose
 *     count is now too high is stale and must be lowered. The list only
 *     shrinks; it is the burn-down.
 *
 * A file whose text assertions pin an external or published CONTRACT that
 * IS the behaviour (a CI or release workflow's triggers, a published and
 * immutable migration's bytes) declares it in a header comment:
 *     // source-pin-contract: <the contract, in at least 20 characters>
 * That exempts the file. Reviewers judge the declaration; this checker only
 * requires that it be explicit.
 *
 *   node scripts/check-test-source-pins.mjs
 *   node scripts/check-test-source-pins.mjs --write-baseline   (one-time)
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_PATH = join(ROOT, "scripts", "test-source-pins.allowlist.json");
const TEST_GLOBS = ["scripts", "deploy", "engine", "packages", "web", "schema", "e2e"]
  .flatMap((root) => ["ts", "tsx", "js", "mjs"].map((ext) => `${root}/**/*.test.${ext}`));
const SOURCE_EXTENSION = /\.(?:tsx?|mjs|js|sql|ya?ml|css)$/;
const FIXTURE_PATH = /fixture|__fixtures__|testdata|golden|snapshots?\//i;
const CONTRACT = /^\s*\/\/\s*source-pin-contract:\s*(.{20,})$/m;
const READERS = new Set(["readFileSync", "readFile"]);
const ASSERT_MODULE = /^(?:node:)?assert(?:\/strict)?$/;
const LISTING_METHODS = /^(?:filter|map|flatMap|find|sort|concat|slice)$/;
const TEST_CALLEE = /^(?:(?:test|it)(?:\.(?:only|skip|todo))?|[A-Za-z_$][\w$]*\.test)$/;
// Methods that answer a question about their ARGUMENT (`re.test(text)`,
// `list.includes(text)`), so a tainted argument taints the answer.
const QUESTION_METHODS = /^(?:test|exec|match|matchAll|search|includes|indexOf|lastIndexOf|startsWith|endsWith|has|concat|localeCompare)$/;
// Methods whose callback decides the result (`files.filter((f) => read(f).includes(x))`).
const CALLBACK_METHODS = /^(?:filter|find|findLast|findIndex|findLastIndex|some|every|map|flatMap|reduce|sort|toSorted)$/;
// Collection writes: the collection now holds what was written.
const COLLECTION_WRITES = /^(?:push|unshift|add|set|splice)$/;
// Global functions and constructors that hand their argument back unchanged.
const PASS_THROUGH = /^(?:String|Array\.from|Object\.values|Object\.entries|Object\.fromEntries|String\.raw|Set|Map)$/;

function strip(node) {
  while (
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isAwaitExpression(node)
    || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))
  ) node = node.expression;
  return node;
}

function calleeText(call) {
  return call.expression.getText().replace(/\s+|\?/g, "");
}

function scriptKind(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** One file, bound by the compiler so every identifier resolves to its own declaration. */
function bind(fileName, text) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const host = {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "",
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: () => undefined,
  };
  const options = { noLib: true, noResolve: true, allowJs: true, noEmit: true, types: [] };
  const program = ts.createProgram([fileName], options, host);
  return { sourceFile: program.getSourceFile(fileName), checker: program.getTypeChecker() };
}

function analyzer(sourceFile, checker) {
  const active = new Set();
  // Every later write to a variable, with the conditions it happens under:
  // `if (!src.includes(x)) missing.push(file)` makes `missing` a function of
  // the text as surely as `missing = src`.
  const writes = new Map();
  const record = (target, values, at) => {
    const base = strip(target);
    const name = ts.isElementAccessExpression(base) || ts.isPropertyAccessExpression(base) ? strip(base.expression) : base;
    if (!ts.isIdentifier(name)) return;
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) writes.set(symbol, [...(writes.get(symbol) ?? []), { values, at }]);
  };
  const visitWrites = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) record(node.left, [node.right], node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && COLLECTION_WRITES.test(node.expression.name.text)) record(node.expression.expression, [...node.arguments], node);
    ts.forEachChild(node, visitWrites);
  };
  visitWrites(sourceFile);

  /** The conditions under which a statement runs: enclosing branches and earlier early exits. */
  function controlConditions(node, boundary) {
    const conditions = [];
    for (let child = node, parent = node.parent; parent && child !== boundary; child = parent, parent = parent.parent) {
      if (ts.isIfStatement(parent) && child !== parent.expression) conditions.push(parent.expression);
      else if (ts.isConditionalExpression(parent) && child !== parent.condition) conditions.push(parent.condition);
      else if (ts.isBinaryExpression(parent) && child === parent.right
        && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
          .includes(parent.operatorToken.kind)) conditions.push(parent.left);
      else if ((ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && child !== parent.expression) conditions.push(parent.expression);
      else if (ts.isForStatement(parent) && parent.condition && child === parent.statement) conditions.push(parent.condition);
      if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
        for (const statement of parent.statements) {
          if (statement === child) break;
          if (ts.isIfStatement(statement) && exits(statement.thenStatement)) conditions.push(statement.expression);
        }
      }
    }
    return conditions;
  }

  function exits(statement) {
    if (ts.isBlock(statement)) return statement.statements.length > 0 && exits(statement.statements.at(-1));
    return ts.isContinueStatement(statement) || ts.isReturnStatement(statement)
      || ts.isBreakStatement(statement) || ts.isThrowStatement(statement);
  }

  function guarded(key, compute) {
    if (active.has(key)) return false;
    active.add(key);
    try { return compute(); } finally { active.delete(key); }
  }

  function declarationsOf(identifier) {
    const symbol = ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier
      ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
      : checker.getSymbolAtLocation(identifier);
    return { symbol, declarations: symbol?.declarations ?? [] };
  }

  /** The variable or parameter a (possibly nested) binding element belongs to. */
  function bindingRoot(declaration) {
    let node = declaration;
    while (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) node = node.parent;
    return node;
  }

  /** The value a variable or parameter declaration is bound to, with the environment it is evaluated in. */
  function boundValues(declaration, env) {
    const root = bindingRoot(declaration);
    if (ts.isVariableDeclaration(root)) {
      const loop = root.parent?.parent;
      if (loop && ts.isForOfStatement(loop)) return [{ expression: loop.expression, env }];
      if (loop && ts.isForInStatement(loop)) return [];
      return root.initializer ? [{ expression: root.initializer, env }] : [];
    }
    if (ts.isParameter(root)) {
      const passed = env?.get(root);
      if (passed) return [passed];
      // A callback handed to a method of source text receives pieces of it.
      const fn = root.parent;
      const call = fn.parent;
      if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && call && ts.isCallExpression(call)
        && call.arguments.includes(fn) && ts.isPropertyAccessExpression(call.expression)) {
        return [{ expression: call.expression.expression, env }];
      }
    }
    return [];
  }

  function functionOf(expression) {
    const callee = strip(expression);
    if (!ts.isIdentifier(callee)) return null;
    for (const declaration of declarationsOf(callee).declarations) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const value = strip(declaration.initializer);
        if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
        // `const read = memoize((path) => readFileSync(path))`: calling the
        // wrapper's result runs the one function it was handed.
        if (ts.isCallExpression(value)) {
          const handed = value.arguments.filter((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
          if (handed.length === 1) return handed[0];
        }
      }
    }
    return null;
  }

  function callEnvironment(fn, call, env) {
    const next = new Map();
    fn.parameters.forEach((parameter, index) => {
      const argument = call.arguments[index];
      if (argument) next.set(parameter, { expression: argument, env });
    });
    return next;
  }

  function returnStatements(fn) {
    if (!ts.isBlock(fn.body)) return [];
    const found = [];
    const visit = (node) => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) found.push(node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    return found;
  }

  function returnedExpressions(fn) {
    return ts.isBlock(fn.body) ? returnStatements(fn).map((statement) => statement.expression) : [fn.body];
  }

  /** Does calling this function yield a value decided by source text, either returned or chosen by it? */
  function returnsTaint(fn, env) {
    return returnedExpressions(fn).some((value) => tainted(value, env))
      || returnStatements(fn).some((statement) =>
        controlConditions(statement, fn.body).some((condition) => tainted(condition, env)));
  }

  /**
   * The literal text a path's FILE NAME can be: the last piece of a join or
   * template, the first argument of `new URL`, a binding's value, a same-file
   * helper's return, and the entries a listing walk admitted
   * (`readdirSync(dir).filter((name) => name.endsWith(".ts"))`,
   * `if (entry.name === "route.ts") out.push(child)`). Directories
   * (`dirname(...)`), property reads of non-literal objects and other calls
   * contribute nothing, so neither a fixture's field nor the directory of a
   * source file passes for a source path.
   */
  function pathEvidence(expression, env) {
    const out = [];
    const literals = (node) => {
      if (ts.isStringLiteralLike(node)) out.push(node.text);
      ts.forEachChild(node, literals);
    };
    const visit = (node, scope) => {
      node = strip(node);
      if (ts.isStringLiteralLike(node)) out.push(node.text);
      else if (ts.isTemplateExpression(node)) {
        const tail = node.templateSpans.at(-1);
        if (tail.literal.text) out.push(tail.literal.text);
        else visit(tail.expression, scope);
      } else if (ts.isIdentifier(node)) {
        const { symbol, declarations } = declarationsOf(node);
        for (const declaration of declarations) {
          for (const bound of boundValues(declaration, scope)) {
            guarded(bound.expression, () => (visit(bound.expression, bound.env), false));
          }
        }
        for (const write of (symbol && writes.get(symbol)) ?? []) {
          guarded(write.at, () => {
            write.values.forEach((value) => visit(value, undefined));
            controlConditions(write.at).forEach(literals);
            return false;
          });
        }
      } else if (ts.isBinaryExpression(node)) visit(node.right, scope);
      else if (ts.isConditionalExpression(node)) { visit(node.whenTrue, scope); visit(node.whenFalse, scope); }
      else if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
        for (const element of ts.isArrayLiteralExpression(node) ? node.elements : node.properties) {
          if (ts.isPropertyAssignment(element)) visit(element.initializer, scope);
          else if (ts.isShorthandPropertyAssignment(element)) visit(element.name, scope);
          else if (!ts.isObjectLiteralElement(element)) visit(element, scope);
        }
      } else if (ts.isSpreadElement(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        visit(node.expression, scope);
      } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const fn = ts.isCallExpression(node) && functionOf(node.expression);
        if (fn) {
          const inner = callEnvironment(fn, node, scope);
          guarded(fn, () => (returnedExpressions(fn).forEach((value) => visit(value, inner)), false));
          return;
        }
        const callee = strip(node.expression);
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        const args = node.arguments ?? [];
        if (/^(?:join|resolve|normalize|relative)$/.test(name)) { if (args.length) visit(args.at(-1), scope); }
        else if (/^(?:URL|fileURLToPath|basename|String|globSync|glob|entries|values|keys|from)$/.test(name)) {
          if (args.length) visit(args[0], scope);
        } else if (ts.isPropertyAccessExpression(callee) && LISTING_METHODS.test(name)) {
          visit(callee.expression, scope);
          for (const argument of args) {
            if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) literals(argument.body);
          }
        }
      }
    };
    visit(expression, env);
    return out;
  }

  function readsSource(call, env) {
    const callee = strip(call.expression);
    let isReader = false;
    if (ts.isIdentifier(callee) && READERS.has(callee.text)) {
      // A same-file function or parameter that happens to be called readFile
      // (an SFTP helper) is not the filesystem.
      isReader = !functionOf(callee) && !declarationsOf(callee).declarations.some((declaration) =>
        ts.isParameter(bindingRoot(declaration)));
    } else if (ts.isPropertyAccessExpression(callee) && READERS.has(callee.name.text)) {
      isReader = /^(?:fs|fsp|promises|fs\.promises|nodeFs|fsPromises)$/.test(callee.expression.getText());
    }
    if (!isReader || call.arguments.length === 0) return false;
    // A fixture directory anywhere in the path makes it data; a listed source
    // file that merely lives under such a name is still source.
    const evidence = pathEvidence(call.arguments[0], env);
    if (evidence.some((text) => FIXTURE_PATH.test(text) && !SOURCE_EXTENSION.test(text))) return false;
    return evidence.some((text) => SOURCE_EXTENSION.test(text) && !FIXTURE_PATH.test(text));
  }

  /**
   * Is this value computed from repository source text? Pieces of the text,
   * positions and booleans read off it, and collections built from it all
   * count: an assertion on any of them is an assertion on the text. A call
   * that only consumes the text (`tx.execute(sql.raw(body))`, a parser) is
   * not followed, and neither is a callback handed to an assertion
   * (`assert.rejects(() => tx.execute(sql))`): both run the text rather than
   * inspect it.
   */
  function tainted(node, env) {
    node = strip(node);
    if (ts.isIdentifier(node)) {
      const { symbol, declarations } = declarationsOf(node);
      return declarations.some((declaration) => guarded(declaration, () =>
        boundValues(declaration, env).some((bound) => tainted(bound.expression, bound.env))))
        || (symbol !== undefined && guarded(symbol, () => (writes.get(symbol) ?? []).some((write) =>
          write.values.some((value) => tainted(value, undefined))
          || controlConditions(write.at).some((condition) => tainted(condition, undefined)))));
    }
    if (ts.isCallExpression(node)) {
      if (readsSource(node, env)) return true;
      const callee = strip(node.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        if (tainted(callee.expression, env)) return true;
        const method = callee.name.text;
        if (QUESTION_METHODS.test(method) && node.arguments.some((argument) => tainted(argument, env))) return true;
        if (CALLBACK_METHODS.test(method) && node.arguments.some((argument) =>
          (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
          && returnsTaint(argument, env))) return true;
      }
      if (PASS_THROUGH.test(calleeText(node))) return node.arguments.some((argument) => tainted(argument, env));
      const fn = functionOf(node.expression);
      if (fn) {
        const inner = callEnvironment(fn, node, env);
        return guarded(fn, () => returnsTaint(fn, inner));
      }
      return false;
    }
    if (ts.isNewExpression(node)) {
      return PASS_THROUGH.test(calleeText(node)) && (node.arguments ?? []).some((argument) => tainted(argument, env));
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return tainted(node.expression, env);
    if (ts.isTemplateExpression(node)) return node.templateSpans.some((span) => tainted(span.expression, env));
    if (ts.isTaggedTemplateExpression(node)) {
      return calleeText({ expression: node.tag }) === "String.raw" && ts.isTemplateExpression(node.template)
        && node.template.templateSpans.some((span) => tainted(span.expression, env));
    }
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (kind === ts.SyntaxKind.CommaToken
        || (kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment)) return tainted(node.right, env);
      return tainted(node.left, env) || tainted(node.right, env);
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) return tainted(node.operand, env);
    if (ts.isTypeOfExpression(node) || ts.isSpreadElement(node)) return tainted(node.expression, env);
    if (ts.isConditionalExpression(node)) {
      return tainted(node.condition, env) || tainted(node.whenTrue, env) || tainted(node.whenFalse, env);
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.some((element) => tainted(element, env));
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some((property) =>
        (ts.isPropertyAssignment(property) && tainted(property.initializer, env))
        || (ts.isShorthandPropertyAssignment(property) && tainted(property.name, env))
        || (ts.isSpreadAssignment(property) && tainted(property.expression, env)));
    }
    return false;
  }

  /** The values an assertion inspects: its arguments, or for `expect(x).toY(z)` both x and z. */
  function inspected(call) {
    const parts = [...call.arguments];
    for (let callee = strip(call.expression); ;) {
      if (ts.isPropertyAccessExpression(callee)) callee = strip(callee.expression);
      else if (ts.isCallExpression(callee)) { parts.push(...callee.arguments); callee = strip(callee.expression); }
      else break;
    }
    return parts;
  }

  function isAssertion(call) {
    const text = calleeText(call);
    if (/^(?:[A-Za-z_$][\w$]*\.)?assert(?:\.[A-Za-z_$][\w$]*)*$/.test(text) || /^expect\(/.test(text)) return true;
    const root = strip(call.expression);
    const base = ts.isPropertyAccessExpression(root) ? strip(root.expression) : root;
    if (!ts.isIdentifier(base)) return false;
    return declarationsOf(base).declarations.some((declaration) => {
      let node = declaration;
      while (node && !ts.isImportDeclaration(node)) node = node.parent;
      return node && ASSERT_MODULE.test(node.moduleSpecifier.text);
    });
  }

  function isTestCall(node) {
    return ts.isCallExpression(node) && TEST_CALLEE.test(calleeText(node));
  }

  /** Does running this code assert on source text? Nested tests are judged on their own. */
  function asserts(body, env) {
    const visit = (node) => {
      if (isTestCall(node)) return false;
      if (ts.isCallExpression(node)) {
        if (isAssertion(node) && inspected(node).some((part) => tainted(part, env))) return node;
        const fn = functionOf(node.expression);
        const inner = fn && guarded(fn, () => asserts(fn.body, callEnvironment(fn, node, env)));
        if (inner) return inner;
      }
      return ts.forEachChild(node, visit) ?? false;
    };
    return visit(body);
  }

  return { asserts, isTestCall, functionOf };
}

/** The tests in one file that assert on source text, by name and line. */
export function sourcePinTests(source, fileName = "file.test.ts") {
  if (CONTRACT.test(source) || !/readFile/.test(source)) return [];
  const { sourceFile, checker } = bind(fileName, source);
  const { asserts, isTestCall, functionOf } = analyzer(sourceFile, checker);
  const pins = [];
  const visit = (node) => {
    if (isTestCall(node)) {
      const body = [...node.arguments].reverse().find((argument) =>
        ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) ?? functionOf(node.arguments.at(-1) ?? node);
      const assertion = body && asserts(body.body ?? body, undefined);
      if (assertion) {
        const title = node.arguments[0];
        const name = title && ts.isStringLiteralLike(title) ? title.text : title?.getText() ?? "";
        const lineOf = (at) => sourceFile.getLineAndCharacterOfPosition(at.getStart()).line + 1;
        pins.push({ name, line: lineOf(node), assertion: lineOf(assertion) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return pins;
}

export function scanTree(root = ROOT) {
  const files = [...new Set(TEST_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: root })))]
    .filter((file) => !file.includes("node_modules"))
    .sort();
  const counts = {};
  for (const file of files) {
    const pins = sourcePinTests(readFileSync(join(root, file), "utf8"), file);
    if (pins.length > 0) counts[file] = pins.length;
  }
  return counts;
}

/** Compare today's counts with the allowlist. The list only shrinks. */
export function reconcile(counts, allowlist) {
  const problems = [];
  for (const [file, count] of Object.entries(counts)) {
    const allowed = allowlist[file];
    if (allowed === undefined) {
      problems.push(`${file}: ${count} new source-pin test(s). Test the behaviour instead (see scripts/check-test-source-pins.mjs)`);
    } else if (count > allowed) {
      problems.push(`${file}: ${count} source-pin tests, allowlist permits ${allowed}. Do not add more`);
    }
  }
  for (const [file, allowed] of Object.entries(allowlist)) {
    const count = counts[file] ?? 0;
    if (count < allowed) {
      problems.push(`${file}: allowlist says ${allowed} but only ${count} remain. Lower the entry${count === 0 ? " (delete it)" : ""} so the ratchet holds`);
    }
  }
  return problems;
}

function loadAllowlist() {
  return JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")).files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const counts = scanTree();
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (process.argv.includes("--write-baseline")) {
    writeFileSync(
      ALLOWLIST_PATH,
      `${JSON.stringify({
        $comment: "Burn-down of tests that assert on repository source text (change detectors). Entries may only be lowered or removed. See scripts/check-test-source-pins.mjs.",
        files: counts,
      }, null, 2)}\n`,
    );
    console.log(`wrote baseline: ${Object.keys(counts).length} files, ${total} source-pin tests`);
    process.exit(0);
  }
  const problems = reconcile(counts, loadAllowlist());
  for (const problem of problems) {
    console.error(problem);
    const file = problem.slice(0, problem.indexOf(": "));
    if (!counts[file]) continue;
    for (const pin of sourcePinTests(readFileSync(join(ROOT, file), "utf8"), file)) {
      console.error(`  line ${pin.line}: "${pin.name}" asserts on source text at line ${pin.assertion}`);
    }
  }
  console.log(`checked test source pins; ${total} remaining in ${Object.keys(counts).length} files; violations=${problems.length}`);
  process.exit(problems.length > 0 ? 1 : 0);
}
