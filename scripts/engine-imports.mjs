/** Syntax-aware dependency extraction shared by the engine boundary checks. */
import ts from "typescript";

export function importsOf(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    let literal;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      literal = node.moduleSpecifier;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      literal = node.moduleReference.expression;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      literal = node.argument.literal;
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const resolver =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "resolve" &&
        ((ts.isIdentifier(callee.expression) && callee.expression.text === "require") ||
          (ts.isMetaProperty(callee.expression) &&
            callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword));
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require") ||
        resolver
      ) {
        literal = node.arguments[0];
      }
    }
    if (literal && ts.isStringLiteralLike(literal)) {
      imports.push({
        spec: literal.text,
        line: source.getLineAndCharacterOfPosition(literal.getStart(source)).line + 1,
      });
    } else if (literal) {
      // Computed loaders still cannot splice a private engine path into a URL.
      const fragments = [];
      const collect = (part) => {
        if (ts.isStringLiteralLike(part)) fragments.push(part.text);
        ts.forEachChild(part, collect);
      };
      collect(literal);
      const spec = fragments.join("");
      if (spec.includes("engine/src/") || spec.includes("@openbooks/engine/")) {
        imports.push({
          spec,
          computed: true,
          line: source.getLineAndCharacterOfPosition(literal.getStart(source)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}
