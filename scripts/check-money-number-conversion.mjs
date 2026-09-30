#!/usr/bin/env node
/** Reject floating-point coercion of money-shaped DTO fields in web UI code. */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const requireFromRoot = createRequire(new URL("../package.json", import.meta.url));
const ts = requireFromRoot("typescript");
const MONEY_FIELDS = new Set([
  "amount", "balance", "rate", "wage", "cost", "price", "debit", "credit",
  "total", "tax", "gross", "net", "revenue", "expense", "payment",
]);

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression &&
      (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
    return node.argumentExpression.text;
  }
  return null;
}

function moneyField(name) {
  if (!name) return false;
  const parts = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split("_");
  if (parts.some((part) => ["count", "quantity", "hours", "days", "index", "id", "percent", "pct", "year", "bps", "margin", "tasks", "rules", "runs"].includes(part))) return false;
  return parts.some((part) => MONEY_FIELDS.has(part));
}

export function scanMoneyNumberConversions(source, path = "<source>") {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations = [];
  const bindings = new Map();
  const scopeOf = (node) => {
    let parent = node.parent;
    while (parent && !ts.isBlock(parent) && !ts.isSourceFile(parent) && !ts.isFunctionLike(parent)) parent = parent.parent;
    return parent;
  };
  function bind(node) {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      const scope = scopeOf(node);
      if (!bindings.has(scope)) bindings.set(scope, new Map());
      if (ts.isIdentifier(node.name)) bindings.get(scope).set(node.name.text, { initializer: node.initializer, type: node.type });
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) bindings.get(scope).set(element.name.text, { field: (element.propertyName ?? element.name).getText(file), initializer: element.initializer });
        }
      }
    }
    ts.forEachChild(node, bind);
  }
  bind(file);
  function lookup(node) {
    let scope = scopeOf(node);
    while (scope) {
      const binding = bindings.get(scope)?.get(node.text);
      if (binding) return binding;
      scope = scopeOf(scope);
    }
    return null;
  }
  function moneyExpression(node, seen = new Set()) {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (moneyField(propertyName(node))) return true;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return moneyExpression(node.expression, seen);
    if (ts.isBinaryExpression(node)) return moneyExpression(node.left, seen) || moneyExpression(node.right, seen);
    if (ts.isConditionalExpression(node)) return moneyExpression(node.whenTrue, seen) || moneyExpression(node.whenFalse, seen);
    if (ts.isIdentifier(node)) {
      const binding = lookup(node);
      return !!binding && (moneyField(binding.field) || /^(Money|Rate|Amount|Decimal)$/.test(binding.type?.getText(file) ?? "") || moneyExpression(binding.initializer, seen));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) return new Set(["add", "sum", "mulDecimal", "mulPercent", "div", "translateFlows", "quantizeOverheadMoney"]).has(node.expression.text);
    return false;
  }
  function numberConstructor(node, seen = new Set()) {
    if (!ts.isIdentifier(node) || seen.has(node)) return false;
    if (node.text === "Number") return true;
    seen.add(node);
    const initializer = lookup(node)?.initializer;
    return !!initializer && numberConstructor(initializer, seen);
  }
  function visit(node) {
    if (ts.isCallExpression(node) && numberConstructor(node.expression)) {
      const argument = node.arguments[0];
      let enclosingFunction = node.parent;
      while (enclosingFunction && !ts.isFunctionDeclaration(enclosingFunction) && !ts.isFunctionExpression(enclosingFunction) && !ts.isArrowFunction(enclosingFunction)) enclosingFunction = enclosingFunction.parent;
      // The CSV mapper's amount selector is a column index, not money.
      const csvColumnMapper = enclosingFunction &&
        ((ts.isFunctionDeclaration(enclosingFunction) && enclosingFunction.name?.text === "toEngineMapping") ||
         (ts.isVariableDeclaration(enclosingFunction.parent) && enclosingFunction.parent.name.getText() === "toEngineMapping"));
      if (argument && moneyExpression(argument) && !(csvColumnMapper && ["amount", "debitAmount"].includes(propertyName(argument)))) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        violations.push({ path, line: line + 1, field: propertyName(argument)?.toLowerCase() ?? null });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}

function discoverWebComponents() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "web/components/**/*.tsx", "web/app/**/*.tsx", "web/lib/module-home/*.ts", "web/lib/module-home/*.tsx", "web/lib/module-home/**/*.ts", "web/lib/module-home/**/*.tsx", "web/lib/analytics/true-cost*.ts"], {
    cwd: repoRoot(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split("\0").filter(Boolean).filter((file) =>
    !/\.test\.tsx?$/.test(file) && (/\.tsx?$/.test(file)) && requireFromRoot("node:fs").existsSync(join(repoRoot(), file))
  );
}

export function main() {
  const root = repoRoot();
  const violations = [];
  for (const path of discoverWebComponents()) {
    const source = requireFromRoot("node:fs").readFileSync(join(root, path), "utf8");
    violations.push(...scanMoneyNumberConversions(source, path));
  }
  if (violations.length) {
    console.error("FAIL: money-shaped decimal strings must stay exact in web UI code; use useMoney or exact decimal helpers:");
    for (const violation of violations) console.error(`  ${violation.path}:${violation.line} (Number of ${violation.field})`);
    process.exitCode = 1;
    return;
  }
  console.log("PASS: checked UI and analytics sources contain no Number coercions of recognized money fields, wrappers, aliases or exact arithmetic.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
