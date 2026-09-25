#!/usr/bin/env node
/** Reject floating-point coercion of money-shaped DTO fields in web UI code. */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const requireFromRoot = createRequire(new URL("../package.json", import.meta.url));
const ts = requireFromRoot("typescript-eslint-typescript");
const MONEY_FIELDS = new Set([
  "amount", "balance", "rate", "wage", "cost", "price", "debit", "credit",
  "total", "tax", "gross", "net", "revenue", "expense", "payment",
]);

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text.toLowerCase();
  if (ts.isElementAccessExpression(node) && node.argumentExpression &&
      (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
    return node.argumentExpression.text.toLowerCase();
  }
  return null;
}

export function scanMoneyNumberConversions(source, path = "<source>") {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Number") {
      const argument = node.arguments[0];
      // `amount` in the CSV import mapper is a column index, not a decimal
      // amount. That conversion is intentional and remains a Number selector.
      let enclosingFunction = node.parent;
      while (enclosingFunction && !ts.isFunctionDeclaration(enclosingFunction) && !ts.isFunctionExpression(enclosingFunction) && !ts.isArrowFunction(enclosingFunction)) {
        enclosingFunction = enclosingFunction.parent;
      }
      const csvColumnMapper = enclosingFunction &&
        ((ts.isFunctionDeclaration(enclosingFunction) && enclosingFunction.name?.text === "toEngineMapping") ||
         (ts.isVariableDeclaration(enclosingFunction.parent) && enclosingFunction.parent.name.getText() === "toEngineMapping"));
      const moneyArithmetic = argument && ts.isCallExpression(argument) && ts.isIdentifier(argument.expression) &&
        new Set(["add", "sum", "mulDecimal", "translateFlows"]).has(argument.expression.text);
      const exactPipelineTotal = path.endsWith("web/lib/module-home/customers.ts") &&
        enclosingFunction && ts.isFunctionDeclaration(enclosingFunction) &&
        enclosingFunction.name?.text === "pipelineInOrgCurrency" && argument && ts.isIdentifier(argument) &&
        new Set(["total", "weighted", "closed"]).has(argument.text);
      if (argument && (MONEY_FIELDS.has(propertyName(argument)) || moneyArithmetic || exactPipelineTotal) &&
          !(csvColumnMapper && propertyName(argument) === "amount")) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        violations.push({ path, line: line + 1, field: propertyName(argument) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}

function discoverWebComponents() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "web/components/**/*.tsx", "web/app/**/*.tsx", "web/lib/module-home/*.ts", "web/lib/module-home/*.tsx", "web/lib/module-home/**/*.ts", "web/lib/module-home/**/*.tsx"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split("\0").filter(Boolean).filter((file) =>
    !/\.test\.tsx?$/.test(file) && (/\.tsx?$/.test(file))
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
  console.log("PASS: web UI does not coerce money-shaped decimal fields through Number().");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
