import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

/**
 * No payroll refusal may tell an operator to edit a source file. A refusal
 * is any string the engine can throw at an operator (thrown errors, the
 * `message`/`operatorMessage`/`detail` refusal sentences, slot and region
 * reason declarations, filing notes and download refusals) — never the
 * pack's own declaration data (rates modules, scaffold steps and templates,
 * edition citations) and never a code comment. This test parses every
 * non-test module under engine/src/payroll and fails on any refusal-position
 * string literal that names a source path or instructs a transcription:
 * the operator remedy is the Statutory-rates back-fill where the pack reads
 * an operator-entered slot, or "not yet supported; contact support" where
 * it does not. Developer transcription guidance lives in code comments,
 * which this test never reads.
 */

const PAYROLL_ROOT = resolve(import.meta.dirname);
const PATH_PATTERN = /engine\/src\//;
/**
 * A transcription *instruction*: the bare word "transcribe" (never the
 * state descriptions "transcribed", "transcribes", "does not transcribe")
 * together with the refusal formula — a "before …" timing clause, an
 * "into …" destination, or a "… first" ordering. Legitimate operator data
 * entry ("transcribe … from the identity document / payroll records onto
 * the form") carries none of those and is not flagged.
 */
const TRANSCRIBE_WORD = /\btranscribe\b/i;
const REFUSAL_FORMULA =
  /before (calculating|filing|finalising|certifying|paying|settling|issuing|pricing)|\binto\b|\bfirst\b/i;

/**
 * Declaration positions whose strings are pack data or developer
 * instructions, never refusals: the scaffold machinery's modules, steps,
 * templates and file paths, and edition citations (provenance naming the
 * publication and the transcribed file, not an instruction to edit it).
 */
const DATA_PROPERTIES = new Set([
  "ratesModule",
  "path",
  "module",
  "steps",
  "files",
  "barrels",
  "template",
  "purpose",
  "citation",
]);
const DATA_VARIABLES = /_(MODULE|SCAFFOLD|TEMPLATE|STEPS)$/;

interface Hit {
  file: string;
  line: number;
  kind: string;
  text: string;
}

function collectFiles(dir: string, into: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, into);
    } else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts")) {
      into.push(full);
    }
  }
}

function isAllowlisted(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
    // SQL and other tagged templates carry comments, never refusals.
    if (ts.isTaggedTemplateExpression(current)) return true;
    if (ts.isPropertyAssignment(current)) {
      const name = current.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        if (DATA_PROPERTIES.has(name.text)) return true;
      }
    }
    if (ts.isVariableDeclaration(current)) {
      const name = current.name;
      if (ts.isIdentifier(name) && DATA_VARIABLES.test(name.text)) return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Refusal strings are routinely concatenated across lines ("a " + "b") or
 * interpolated across template spans, so a fragment-level check misses a
 * violation split across two fragments. Climb from every string fragment to
 * the outermost string-composing expression and check that whole text, once
 * per expression.
 */
function outermostMessage(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (
      (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      ts.isTemplateExpression(parent) ||
      ts.isTemplateSpan(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    ) {
      current = parent;
      continue;
    }
    break;
  }
  return current;
}

function scanFile(file: string): Hit[] {
  const source = readFileSync(file, "utf8");
  const script = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];
  const seen = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const whole = outermostMessage(node);
      if (!seen.has(whole)) {
        seen.add(whole);
        if (!isAllowlisted(whole)) {
          const text = whole.getText(script);
          const line = script.getLineAndCharacterOfPosition(whole.getStart(script)).line + 1;
          const snippet = text.replace(/\s+/g, " ").slice(0, 160);
          if (PATH_PATTERN.test(text)) {
            hits.push({ file, line, kind: "source-path", text: snippet });
          } else if (TRANSCRIBE_WORD.test(text) && REFUSAL_FORMULA.test(text)) {
            hits.push({ file, line, kind: "transcribe-instruction", text: snippet });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(script);
  return hits;
}

test("no payroll refusal names a source path or instructs a transcription", () => {
  const files: string[] = [];
  collectFiles(PAYROLL_ROOT, files);
  assert.ok(files.length > 100, `expected the payroll tree, found ${files.length} modules`);
  const hits = files.flatMap(scanFile);
  assert.deepEqual(
    hits,
    [],
    `refusals must carry the operator remedy, never a source path or transcription instruction:\n` +
      hits.map((hit) => `${hit.file}:${hit.line} [${hit.kind}] ${hit.text}`).join("\n"),
  );
});
