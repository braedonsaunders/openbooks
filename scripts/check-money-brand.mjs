#!/usr/bin/env node
/** Forbid money values crossing the JS Number boundary (MONEY-NUMERIC-ALL).
 *
 * Two tiers. Tier 1 fails unconditionally: `Number(x)`, `parseFloat(x)`,
 * `parseInt(x)`, or unary `+x` on an identifier the file itself types as
 * `Money`, `Rate`, or `Quantity` (annotation, brand-maker assignment, or
 * `as Money` cast), or on a call returning one. The remedy names itself:
 * stay in `engine/src/money/brands.ts` (addMoney/cmpMoney/...) instead of
 * converting.
 *
 * Tier 2 ratchets the pre-brand world: heuristic money-field crossings
 * (`Number(row.amount)` and the like, plus `Number()` of exact-decimal
 * arithmetic results) across engine and package sources are counted
 * against scripts/money-brand-baseline.json, which may only go down.
 * Adoption slices convert sites to the brands boundary and lower it.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const requireFromRoot = createRequire(new URL("../package.json", import.meta.url));
const ts = requireFromRoot("typescript-eslint-typescript");
const fs = requireFromRoot("node:fs");

const BRAND_TYPES = new Set(["Money", "Rate", "Quantity"]);
const BRAND_MAKERS = new Set([
  "parseMoney", "parseRate", "parseQuantity",
  "addMoney", "subMoney", "sumMoney", "negMoney",
  "mulMoney", "divMoney", "mulMoneyRate", "divMoneyRate",
]);
// Exact-decimal calls whose string/bigint result must never cross Number().
const MONEY_ARITHMETIC = new Set([
  ...BRAND_MAKERS,
  "add", "sum", "mul", "div", "mulDecimal", "mulDecimalFactors", "mulPercent",
  "mulRatio", "prorateDays", "normalizeMoney", "normalizeDecimal", "roundMoney",
  "formatMoney", "allocateLargestRemainder", "divideMoney", "divRate", "mulRate",
  "toUnits", "fromUnits", "fixedDecimal", "subscriptionComponentTotal",
]);
const MONEY_FIELDS = new Set([
  "amount", "balance", "rate", "wage", "cost", "price", "debit", "credit",
  "total", "tax", "gross", "net", "revenue", "expense", "payment", "quantity",
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

/** True when a type node mentions a Money/Rate/Quantity brand. */
function typeMentionsBrand(typeNode) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && BRAND_TYPES.has(node.typeName.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  if (typeNode) visit(typeNode);
  return found;
}

/** True when an expression is a call to a brand maker or branded function. */
function isBrandedCall(node, brandedFunctions) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    (BRAND_MAKERS.has(node.expression.text) || brandedFunctions.has(node.expression.text));
}

export function scanMoneyBrandViolations(source, path = "<source>") {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const brandedNames = new Set();
  const brandedFunctions = new Set();
  const brandViolations = [];
  const heuristicViolations = [];

  function collect(node) {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.name && ts.isIdentifier(node.name)) {
      if (typeMentionsBrand(node.type)) brandedNames.add(node.name.text);
      if (node.initializer) {
        if (isBrandedCall(node.initializer, brandedFunctions)) brandedNames.add(node.name.text);
        if (ts.isAsExpression(node.initializer) && typeMentionsBrand(node.initializer.type)) {
          brandedNames.add(node.name.text);
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && typeMentionsBrand(node.type)) {
      brandedFunctions.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
        typeMentionsBrand(node.initializer.type)) {
      brandedFunctions.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  }
  collect(file);

  function isMoneyCall(node) {
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      (MONEY_ARITHMETIC.has(node.expression.text) || brandedFunctions.has(node.expression.text));
  }

  function checkConversion(argument, kind) {
    if (!argument) return;
    const { line } = file.getLineAndCharacterOfPosition(argument.getStart(file));
    const at = { path, line: line + 1, kind };
    if (ts.isIdentifier(argument) && brandedNames.has(argument.text)) {
      brandViolations.push({ ...at, detail: `branded identifier ${argument.text}` });
      return;
    }
    if (isBrandedCall(argument, brandedFunctions)) {
      brandViolations.push({ ...at, detail: "call returning a branded value" });
      return;
    }
    if (isMoneyCall(argument)) {
      heuristicViolations.push({ ...at, detail: "exact-decimal arithmetic result" });
      return;
    }
    if (ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument) || ts.isElementAccessExpression(argument)) {
      const field = ts.isIdentifier(argument) ? argument.text.toLowerCase() : propertyName(argument);
      const callee = ts.isIdentifier(argument) && MONEY_ARITHMETIC.has(argument.text);
      if (callee || (field && MONEY_FIELDS.has(field))) {
        heuristicViolations.push({ ...at, detail: `money-shaped field ${field ?? argument.text}` });
      }
    }
  }

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        (node.expression.text === "Number" || node.expression.text === "parseFloat" || node.expression.text === "parseInt")) {
      checkConversion(node.arguments[0], node.expression.text);
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusToken) {
      checkConversion(node.operand, "unary +");
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { brandViolations, heuristicViolations };
}

export function readBaseline(root) {
  const raw = fs.readFileSync(join(root, "scripts", "money-brand-baseline.json"), "utf8");
  const ceiling = JSON.parse(raw).ceiling;
  if (!Number.isInteger(ceiling) || ceiling < 0) throw new Error("money-brand baseline ceiling must be a non-negative integer");
  return ceiling;
}

function discoverSources() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "engine/src/**/*.ts", "packages/*/src/**/*.ts"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split("\0").filter(Boolean).filter((f) => !/\.test\.ts$/.test(f) && /\.tsx?$/.test(f));
}

export function main() {
  const root = repoRoot();
  const brandViolations = [];
  let heuristicCount = 0;
  const heuristicSites = [];
  for (const path of discoverSources()) {
    const source = fs.readFileSync(join(root, path), "utf8");
    const found = scanMoneyBrandViolations(source, path);
    brandViolations.push(...found.brandViolations);
    heuristicCount += found.heuristicViolations.length;
    heuristicSites.push(...found.heuristicViolations);
  }
  let failed = false;
  if (brandViolations.length) {
    console.error("FAIL: branded Money/Rate/Quantity values must never cross Number(); stay in engine/src/money/brands.ts:");
    for (const v of brandViolations) console.error(`  ${v.path}:${v.line} (${v.kind} on ${v.detail})`);
    failed = true;
  }
  const ceiling = readBaseline(root);
  if (heuristicCount > ceiling) {
    console.error(`FAIL: money-shaped Number() crossings rose to ${heuristicCount}, above the ${ceiling} baseline; convert a site to the brands boundary and lower scripts/money-brand-baseline.json:`);
    for (const v of heuristicSites) console.error(`  ${v.path}:${v.line} (${v.kind} on ${v.detail})`);
    failed = true;
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }
  console.log(`PASS: no branded money→Number conversions; heuristic crossings ${heuristicCount} within baseline ${ceiling}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
