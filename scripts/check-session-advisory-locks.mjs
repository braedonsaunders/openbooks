#!/usr/bin/env node
/** Session advisory locks must be acquired/released on a checked-out client. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const files = execFileSync("git", ["ls-files", "-z", "--", "engine/src", "scripts", "packages", "web"], {
  encoding: "utf8",
}).split("\0").filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file) && !/\.test\.[cm]?[jt]sx?$/.test(file));
const lockPattern = /\bpg_(?:try_)?advisory_(?:lock|unlock)(?:_shared)?\b/;
const violations = [];

function propertyCall(node, name) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === name;
}

for (const file of files) {
  const sourceText = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const declarations = new Map();
  const pinnedNames = new Set();
  function indexDeclarations(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer.getText(source);
      declarations.set(node.name.text, node.initializer);
      if (/\b(?:pool|longPool|basePool|maintenancePool)\s*\.\s*connect\s*\(/.test(init) ||
          /\braw(?:Long)?Connect\s*\(/.test(init)) {
        pinnedNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, indexDeclarations);
  }
  indexDeclarations(source);

  function hasLockSql(node, seen = new Set()) {
    if (lockPattern.test(node.getText(source))) return true;
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return false;
      const declaration = declarations.get(node.text);
      if (!declaration) return false;
      seen.add(node.text);
      return hasLockSql(declaration, seen);
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && hasLockSql(child, seen)) found = true;
    });
    return found;
  }

  function inspect(node) {
    if ((propertyCall(node, "query") || propertyCall(node, "execute")) &&
        node.arguments.some((argument) => hasLockSql(argument))) {
      const receiver = node.expression.expression;
      const receiverName = ts.isIdentifier(receiver) ? receiver.text : receiver.getText(source);
      const method = node.expression.name.text;
      if (method !== "query" || !pinnedNames.has(receiverName)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        violations.push(`${file}:${line}: session advisory lock uses ${receiverName}.${method}; acquire it on a checked-out client and unlock through that same client`);
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}

if (violations.length) {
  console.error(`Found ${violations.length} session advisory lock call(s) outside a pinned client:`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`checked session advisory locks; all calls in ${files.length} production source files use pinned clients`);
}
