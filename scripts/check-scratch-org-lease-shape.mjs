import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FIXTURES_PATH = "engine/src/testing/fixtures.ts";
const INTEGRATION_TEST = /\.integration\.test\.(?:ts|mjs)$/;
const SKIP_DIRS = new Set([".git", ".next", "build", "dist", "node_modules"]);

function scriptKind(file) {
  return file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function parseFile(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, scriptKind(file));
}

function isExported(node) {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function containsScratchOrgType(node) {
  let found = false;
  const visit = (current) => {
    if (ts.isTypeReferenceNode(current)) {
      const name = current.typeName.getText();
      if (name === "ScratchOrg" || name.endsWith(".ScratchOrg")) found = true;
    }
    if (!found) ts.forEachChild(current, visit);
  };
  if (node) visit(node);
  return found;
}

function functionReturnType(node) {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node.type;
  return undefined;
}

function scratchOrgFactories(fixturesPath) {
  const source = parseFile(fixturesPath);
  const localFactories = new Set();
  const exportedFactories = new Set();

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && containsScratchOrgType(functionReturnType(statement))) {
      localFactories.add(statement.name.text);
      if (isExported(statement)) exportedFactories.add(statement.name.text);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const returnType = functionReturnType(declaration.initializer);
      if (!returnType || !containsScratchOrgType(returnType)) continue;
      localFactories.add(declaration.name.text);
      if (isExported(statement)) exportedFactories.add(declaration.name.text);
    }
  }

  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)) continue;
    for (const specifier of statement.exportClause.elements) {
      const localName = (specifier.propertyName ?? specifier.name).text;
      if (localFactories.has(localName)) exportedFactories.add(specifier.name.text);
    }
  }

  return exportedFactories;
}

function collectIntegrationFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (INTEGRATION_TEST.test(entry)) files.push(path);
    }
  };
  walk(root);
  return files;
}

function importTargetsFixtures(specifier, importer, root, fixturesPath) {
  let target;
  if (specifier.startsWith("@openbooks/engine/src/")) {
    target = join(root, "engine/src", specifier.slice("@openbooks/engine/src/".length));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    target = resolve(dirname(importer), specifier.split("?")[0]);
  } else {
    return false;
  }
  if (!target.endsWith(".ts")) target += ".ts";
  return resolve(target) === resolve(fixturesPath);
}

function moduleSpecifierText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function importedFactories(source, file, root, fixturesPath, factories) {
  const named = new Map();
  const namespaces = new Set();

  const addImport = (clause, specifier) => {
    if (!importTargetsFixtures(specifier, file, root, fixturesPath) || !clause) return;
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const exported = (element.propertyName ?? element.name).text;
        if (factories.has(exported)) named.set(element.name.text, exported);
      }
    } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.add(clause.namedBindings.name.text);
    }
  };

  const dynamicFixturesCall = (node) => ts.isCallExpression(node)
    && node.expression.kind === ts.SyntaxKind.ImportKeyword
    && node.arguments.length > 0
    && ts.isStringLiteralLike(node.arguments[0])
    && importTargetsFixtures(node.arguments[0].text, file, root, fixturesPath);

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = moduleSpecifierText(statement.moduleSpecifier);
      if (specifier) addImport(statement.importClause, specifier);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      const call = initializer && ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
      if (!call || !dynamicFixturesCall(call)) continue;
      if (ts.isIdentifier(declaration.name)) namespaces.add(declaration.name.text);
      if (!ts.isObjectBindingPattern(declaration.name)) continue;
      for (const element of declaration.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const exported = element.propertyName
          ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
            ? element.propertyName.text
            : null
          : element.name.text;
        if (exported && factories.has(exported)) named.set(element.name.text, exported);
      }
    }
  }

  return { named, namespaces };
}

function testBindings(source) {
  const named = new Set(["test", "it"]);
  const namespaces = new Set();
  const hooks = new Set(["before"]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || moduleSpecifierText(statement.moduleSpecifier) !== "node:test") continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) named.add(clause.name.text);
    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text);
    else {
      for (const element of clause.namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === "test" || imported === "it") named.add(element.name.text);
        if (imported === "before") hooks.add(element.name.text);
      }
    }
  }
  return { named, namespaces, hooks };
}

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

function isMemberCall(expression, namespaces, method) {
  return ts.isPropertyAccessExpression(expression)
    && namespaces.has(expression.expression.getText())
    && expression.name.text === method;
}

function isRegistrationCall(call, bindings, name) {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) {
    if (name === "test") return bindings.named.has(expression.text);
    return bindings.hooks.has(expression.text);
  }
  return name === "test"
    ? isMemberCall(expression, bindings.namespaces, "test") || isMemberCall(expression, bindings.namespaces, "it")
    : isMemberCall(expression, bindings.namespaces, "before");
}

function callbackNode(argument, source) {
  if (!argument) return null;
  if (isFunctionLike(argument)) return argument;
  if (!ts.isIdentifier(argument)) return null;
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === argument.text) return statement;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === argument.text
          && declaration.initializer && isFunctionLike(declaration.initializer)) return declaration.initializer;
      }
    }
  }
  return null;
}

function factoryInvocationName(call, factories, imported) {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return imported.named.get(expression.text) ?? null;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
    && imported.namespaces.has(expression.expression.text) && factories.has(expression.name.text)) {
    return expression.name.text;
  }
  if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)
    && imported.namespaces.has(expression.expression.text) && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression) && factories.has(expression.argumentExpression.text)) {
    return expression.argumentExpression.text;
  }
  return null;
}

function factoryInvocations(callback, factories, imported) {
  const found = new Set();
  if (!callback) return found;
  const visit = (node, root = false) => {
    if (isFunctionLike(node) && !root) return;
    if (ts.isCallExpression(node)) {
      const factory = factoryInvocationName(node, factories, imported);
      if (factory) found.add(factory);
    }
    if (found.size === factories.size) {
      return;
    }
    ts.forEachChild(node, (child) => visit(child));
  };
  visit(callback, true);
  return found;
}

function analyzeFile(file, root, fixturesPath, factories) {
  const source = parseFile(file);
  const imported = importedFactories(source, file, root, fixturesPath, factories);
  const bindings = testBindings(source);
  let topLevelTests = 0;
  const violations = [];

  const visitTopLevel = (node) => {
    if (isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      if (isRegistrationCall(node, bindings, "test")) {
        topLevelTests += 1;
        return;
      }
      if (isRegistrationCall(node, bindings, "before")) {
        const callback = callbackNode(node.arguments[0], source);
        const invokedFactories = factoryInvocations(callback, factories, imported);
        if (invokedFactories.size > 0) {
          violations.push({
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            factories: [...invokedFactories].sort(),
          });
        }
      }
    }
    ts.forEachChild(node, visitTopLevel);
  };
  for (const statement of source.statements) visitTopLevel(statement);

  if (topLevelTests <= 1) return [];
  return violations.map((violation) => ({
    file,
    line: violation.line,
    topLevelTests,
    factories: violation.factories,
  }));
}

export function checkTree(root = ROOT) {
  const fixturesPath = join(root, FIXTURES_PATH);
  const factories = scratchOrgFactories(fixturesPath);
  const files = collectIntegrationFiles(root);
  const violations = files.flatMap((file) => analyzeFile(file, root, fixturesPath, factories));
  return { filesChecked: files.length, factories: [...factories].sort(), violations };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkTree();
  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(`${relative(ROOT, violation.file)}:${violation.line} creates ${violation.factories.join(", ")} in top-level before() with ${violation.topLevelTests} top-level tests`);
    }
    console.error(`[scratch-org-lease-shape] ${result.violations.length} violation(s) in ${result.filesChecked} integration files`);
    process.exitCode = 1;
  } else {
    console.log(`[scratch-org-lease-shape] ${result.filesChecked} integration files; 0 violations`);
  }
}
