#!/usr/bin/env node
/**
 * Repo-wide guard: values must never be interpolated into sql.raw.
 *
 * Postgres string literals use single quotes, so a template substitution
 * inside (or beside) single quotes in sql.raw is a VALUE in SQL text — the
 * injection shape that broke out of `org_id = '<value>'` through the
 * field-ticket import CLI's --org and ran arbitrary SQL as the script role.
 * Bound parameters must carry values; sql.raw keeps identifiers
 * (double-quoted or bare table/column names) only.
 *
 * The rule is structural, never a file list: flag a sql.raw(...) call whose
 * argument is a template literal with at least one substitution and at least
 * one single quote, or a `+` concatenation mixing a single-quoted string
 * with a non-literal operand. Comments and string literals never match —
 * the walk is AST-based (the repo-pinned TypeScript compiler API), not
 * grepped — and test files are out of scope: fault-injection fixtures build
 * hostile SQL on purpose.
 *
 *   node scripts/check-sql-raw-interpolation.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The repository pins its own parser: devDependency alias
// typescript-eslint-typescript -> npm:typescript (the classic JS compiler
// API). No dependency is added beyond what package.json already pins.
const requireFromRoot = createRequire(new URL("../package.json", import.meta.url));
const ts = requireFromRoot("typescript-eslint-typescript");

const SELF_PATH = "scripts/check-sql-raw-interpolation.mjs";
const SELF_TEST = "scripts/check-sql-raw-interpolation.test.mjs";

export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function discoverSources() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z",
      "engine/src/**/*.ts", "engine/src/**/*.tsx",
      "web/**/*.ts", "web/**/*.tsx",
      "scripts/**/*.mjs",
      "packages/**/*.ts", "packages/**/*.tsx"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .filter((file) => !/\.test\.[tj]sx?$/.test(file) && !/\.test\.mjs$/.test(file))
    .filter((file) => !/\.d\.tsx?$/.test(file) && file !== SELF_PATH && file !== SELF_TEST);
}

function isSqlRawCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "sql" &&
    node.expression.name.text === "raw"
  );
}

/**
 * A substitution crossing a SQL string-literal boundary: a template literal
 * part (head or span literal — never the ${...} expression's own source,
 * where quotes are code such as an identifier-escaper replacing '"' with
 * '""') that starts or ends with a single quote. That shape is a value in
 * SQL text: `'${orgId}'`, `('${a}', '${b}')`, nested list builders like
 * `(${keys.map((k) => `'${k}'`).join(",")})`. A template whose quotes sit
 * mid-literal away from every boundary (constants such as `coalesce(${col},
 * '')`) is an identifier site, out of scope for this check.
 */
function templateHasAdjacentQuote(node) {
  const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
  return parts.some((text) => text.startsWith("'") || text.endsWith("'"));
}

function subtreeHasAdjacentQuote(node) {
  if (ts.isTemplateExpression(node)) {
    if (templateHasAdjacentQuote(node)) return true;
    return node.templateSpans.some((span) => subtreeHasAdjacentQuote(span.expression));
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found) found = subtreeHasAdjacentQuote(child);
  });
  return found;
}

function isPlusConcat(node) {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/** A `+` tree mixing a single-quoted string with a computed operand. */
function concatMixesQuotedString(root) {
  const operands = [];
  const gather = (node) => {
    if (isPlusConcat(node)) {
      gather(node.left);
      gather(node.right);
    } else {
      operands.push(node);
    }
  };
  gather(root);
  const hasQuoted = operands.some(
    (operand) =>
      (ts.isStringLiteral(operand) || ts.isNoSubstitutionTemplateLiteral(operand)) &&
      operand.text.includes("'"),
  );
  const hasComputed = operands.some(
    (operand) =>
      !ts.isStringLiteral(operand) &&
      !ts.isNoSubstitutionTemplateLiteral(operand) &&
      !ts.isNumericLiteral(operand),
  );
  return hasQuoted && hasComputed;
}

function subtreeHasQuotedConcat(node) {
  if (isPlusConcat(node) && concatMixesQuotedString(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found) found = subtreeHasQuotedConcat(child);
  });
  return found;
}

/** A single string constant (possibly with quotes) is not interpolation. */
function isStaticLiteral(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
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

/** Nearest NAMED enclosing function, or "(top-level)". */
function enclosingFunctionName(node) {
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

export function scanSource(path, content) {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const findings = [];
  const visit = (node) => {
    if (isSqlRawCall(node)) {
      const [arg] = node.arguments;
      if (
        arg &&
        !isStaticLiteral(arg) &&
        (subtreeHasAdjacentQuote(arg) || subtreeHasQuotedConcat(arg))
      ) {
        const snippet = arg.getText().replace(/\s+/g, " ").trim().slice(0, 160);
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        findings.push({ path, line: line + 1, fn: enclosingFunctionName(node), kind: "sql.raw value interpolation", arg: snippet });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

export function scanTree(readFile = (file) => readFileSync(join(repoRoot(), file), "utf8")) {
  return discoverSources().flatMap((file) => scanSource(file, readFile(file)));
}

/** Zero tolerance: every finding is a problem (no allow-list to grow). */
export function checkTree(findings = scanTree()) {
  return findings.map(
    (finding) =>
      `${finding.path}:${finding.line} [${finding.fn}] ${finding.kind} (${finding.arg}, …) interpolates a value into raw SQL — ` +
      `a quote in the value breaks out and runs as SQL. Carry values as bound parameters ` +
      `(sql\`\${value}\`, sql.join for lists) and keep sql.raw for identifiers only.`,
  );
}

const invoked = process.argv[1] ? process.argv[1].endsWith("check-sql-raw-interpolation.mjs") : false;
if (invoked) {
  const findings = scanTree();
  const problems = checkTree(findings);
  for (const problem of problems) console.log(problem);
  console.log(`checked sql.raw interpolation; violations=${problems.length} (sites=${findings.length})`);
  process.exit(problems.length > 0 ? 1 : 0);
}
