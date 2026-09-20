/**
 * Line-oriented mutant operators for the OpenBooks financial engine.
 *
 * Candidate sites are source-text edits, but classification is AST-backed:
 * the TypeScript parser (already a repo dependency) identifies real
 * expression operators, so generic angle brackets (`Map<string, number>`)
 * are never mistaken for comparisons and type-only literals
 * (`Parameters<F>[0]`) are never mistaken for runtime boundary literals.
 * Masked-text scans (strings/comments blanked, offsets preserved) still
 * serve the remaining operators, and template interpolations stay excluded
 * (conservative by design: no mutant is generated inside `${...}`).
 * The runner syntax-gates every mutant and reports unparseable ones as
 * `error` (excluded from the score, never counted as killed) — a backstop,
 * not the filter.
 *
 * What each operator probes, in financial terms:
 * - arith-sign-flip:         a posted debit/credit or allocation with the wrong sign.
 * - comparison-flip:         an off-by-one boundary (period open/closed, limit reached).
 * - boundary-shift:          fence-post limits (loop bounds, literal caps, day counts).
 * - rounding-swap:           half-away-from-zero silently replaced by truncation.
 * - dropped-accumulator:     a loop that forgets to accumulate one leg of money.
 * - guard-negation:          an inverted authorization/invariant check.
 * - early-return-before-write: a write that never happens (silent data loss).
 */

import ts from "typescript";

export type MutationOperator =
  | "arith-sign-flip"
  | "comparison-flip"
  | "boundary-shift"
  | "rounding-swap"
  | "dropped-accumulator"
  | "guard-negation"
  | "early-return-before-write";

export const MUTATION_OPERATORS: readonly MutationOperator[] = [
  "arith-sign-flip",
  "comparison-flip",
  "boundary-shift",
  "rounding-swap",
  "dropped-accumulator",
  "guard-negation",
  "early-return-before-write",
] as const;

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface GenerateMutantsOptions {
  /** 1-based inclusive line ranges to restrict generation (file scoping). */
  readonly lineRanges?: readonly LineRange[];
  /** Deterministic cap per operator, applied after sorting by position. */
  readonly maxPerOperator?: number;
}

export const DEFAULT_MAX_PER_OPERATOR = 50;

export interface GeneratedMutant {
  /** Stable id: target:line:operator:column:occurrence. */
  readonly key: string;
  /** Repo-relative path of the mutated file. */
  readonly target: string;
  readonly operator: MutationOperator;
  /** 1-based line of the mutation site in the ORIGINAL source. */
  readonly line: number;
  /** 1-based column of the mutation site in the ORIGINAL source. */
  readonly column: number;
  readonly description: string;
  readonly mutatedSource: string;
}

interface PendingMutant {
  operator: MutationOperator;
  line: number;
  column: number;
  description: string;
  start: number;
  end: number;
  text: string;
  deleteLine?: number;
  insertBeforeLine?: number;
  insertText?: string;
}

type Push = (m: PendingMutant) => void;

/**
 * Blank strings and comments, preserving offsets and newlines, so operator
 * scans never fire inside a literal or dead code. Template interpolations
 * are treated as opaque string content: a mutant inside `${...}` is
 * deliberately never generated (conservative by design).
 */
export function maskSource(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  const blank = (ch: string): string => (ch === "\n" ? "\n" : " ");
  while (i < n) {
    const ch = source[i]!;
    const next = i + 1 < n ? source[i + 1]! : "";
    if (ch === "/" && next === "/") {
      out.push(" ", " ");
      i += 2;
      while (i < n && source[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
    } else if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < n && !(source[i] === "*" && i + 1 < n && source[i + 1] === "/")) {
        out.push(blank(source[i]!));
        i += 1;
      }
      if (i < n) {
        out.push(" ", " ");
        i += 2;
      }
    } else if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out.push(" ");
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          out.push(" ", " ");
          i += 2;
          continue;
        }
        // A raw newline ends an unterminated single/double-quoted literal;
        // tagged templates may legally span lines, so preserve newlines.
        if (source[i] === "\n" && quote !== "`") break;
        out.push(blank(source[i]!));
        i += 1;
      }
      if (i < n) {
        out.push(" ");
        i += 1;
      }
    } else {
      out.push(ch);
      i += 1;
    }
  }
  return out.join("");
}

function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetToLineColumn(starts: number[], offset: number): { line: number; column: number } {
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1]! <= offset) line += 1;
  return { line: line + 1, column: offset - starts[line]! + 1 };
}

/**
 * Parse once per generation pass. ScriptKind.TS matters: without it a
 * generic instantiation (`Map<string>`) could lex as comparisons.
 * setParentPointers lets boundary-shift test type ancestry.
 */
function parseSource(source: string): ts.SourceFile {
  return ts.createSourceFile("mutation-target.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Template interpolations are real expressions but stay excluded (conservative). */
function insideTemplate(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isTemplateSpan(current) || ts.isTemplateExpression(current)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Real expression arithmetic only: BinaryExpression `+ - * /` plus unary
 * financial signs (`-amount`, `+fee`). Type syntax, increments, compound
 * assignment, arrows, shifts, and scientific-notation exponents are not
 * BinaryExpression/ unary-sign nodes, so they can never become candidates —
 * including unspaced runtime operators (`a+b`) the old text heuristic
 * could not tell apart from generics.
 */
function mutateArithSignFlip(source: string, sourceFile: ts.SourceFile, starts: number[], push: Push): void {
  const emit = (offset: number, ch: string, flipped: string): void => {
    const { line, column } = offsetToLineColumn(starts, offset);
    push({ operator: "arith-sign-flip", line, column, description: `arith '${ch}' -> '${flipped}'`, start: offset, end: offset + 1, text: flipped });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      if (!insideTemplate(node)) {
        const start = node.operatorToken.getStart(sourceFile);
        switch (node.operatorToken.kind) {
          case ts.SyntaxKind.PlusToken:
            emit(start, "+", "-");
            break;
          case ts.SyntaxKind.MinusToken:
            emit(start, "-", "+");
            break;
          case ts.SyntaxKind.AsteriskToken:
            emit(start, "*", "/");
            break;
          case ts.SyntaxKind.SlashToken:
            emit(start, "/", "*");
            break;
          default:
            break;
        }
      }
    } else if (ts.isPrefixUnaryExpression(node)) {
      if (
        (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken) &&
        !insideTemplate(node)
      ) {
        const start = node.getStart(sourceFile);
        const ch = source[start]!;
        emit(start, ch, ch === "+" ? "-" : "+");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/**
 * Real expression comparisons only: BinaryExpression `< <= > >= === !==`.
 * Generic brackets, arrows, and shifts are different AST shapes, so no
 * spacing heuristic is needed — unspaced runtime comparisons (`a<b`)
 * mutate exactly like spaced ones.
 */
function mutateComparisonFlip(sourceFile: ts.SourceFile, starts: number[], push: Push): void {
  const emit = (offset: number, end: number, description: string, text: string): void => {
    const { line, column } = offsetToLineColumn(starts, offset);
    push({ operator: "comparison-flip", line, column, description, start: offset, end, text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && !insideTemplate(node)) {
      const start = node.operatorToken.getStart(sourceFile);
      const end = node.operatorToken.getEnd();
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.LessThanToken:
          emit(start, end, "comparison '<' -> '<='", "<=");
          break;
        case ts.SyntaxKind.LessThanEqualsToken:
          emit(start, end, "comparison '<=' -> '<'", "<");
          break;
        case ts.SyntaxKind.GreaterThanToken:
          emit(start, end, "comparison '>' -> '>='", ">=");
          break;
        case ts.SyntaxKind.GreaterThanEqualsToken:
          emit(start, end, "comparison '>=' -> '>'", ">");
          break;
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
          emit(start, end, "comparison '===' -> '!=='", "!==");
          break;
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
          emit(start, end, "comparison '!==' -> '==='", "===");
          break;
        default:
          break;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const LIMIT_LINE_PATTERN =
  /(\bfor\b|\bwhile\b|\bif\b|<=?|>=?|===|!==|\blength\b|\bslice\b|\bsubstring\b|\bpadStart\b|\bpadEnd\b|\blimit\b|\bthreshold\b|\bmax\b|\bmin\b|\bexpire\b|\bdays?\b|\bmonths?\b)/;

/**
 * Numeric/bigint literals that live inside type syntax (`Parameters<F>[0]`,
 * literal union members, generic arguments) are erased at runtime: shifting
 * them yields survivors no suite can kill. Collect their spans so the
 * line scan below can skip them; runtime literals keep existing semantics.
 */
function collectTypeLiteralRanges(sourceFile: ts.SourceFile): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const visit = (node: ts.Node): void => {
    if (
      node.kind === ts.SyntaxKind.NumericLiteral ||
      node.kind === ts.SyntaxKind.BigIntLiteral
    ) {
      let current: ts.Node | undefined = node.parent;
      while (current) {
        if (ts.isTypeNode(current)) {
          ranges.push({ start: node.getStart(sourceFile), end: node.getEnd() });
          break;
        }
        current = current.parent;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return ranges;
}

function mutateBoundaryShift(
  maskedLines: string[],
  lineOffsets: number[],
  starts: number[],
  push: Push,
  typeLiteralRanges: ReadonlyArray<{ start: number; end: number }> = [],
): void {
  void starts;
  const inTypeSyntax = (absStart: number, absEnd: number): boolean =>
    typeLiteralRanges.some((r) => absStart >= r.start && absEnd <= r.end);
  for (let lineIdx = 0; lineIdx < maskedLines.length; lineIdx += 1) {
    const line = maskedLines[lineIdx]!;
    if (!LIMIT_LINE_PATTERN.test(line)) continue;
    const literal = /(^|[^A-Za-z0-9_$.])(\d[\d_]*n?)(?![A-Za-z0-9_$])/g;
    let match: RegExpExecArray | null;
    while ((match = literal.exec(line)) !== null) {
      const token = match[2]!;
      const tokenStart = match.index + match[1]!.length;
      const absStart = lineOffsets[lineIdx]! + tokenStart;
      if (inTypeSyntax(absStart, absStart + token.length)) continue;
      // A float's integer part (`1.5`) is not a limit.
      const after = line[tokenStart + token.length];
      const afterNext = line[tokenStart + token.length + 1];
      if (after === "." && afterNext !== undefined && /[0-9]/.test(afterNext)) continue;
      const digits = token.replace(/_/g, "").replace(/n$/, "");
      if (digits.length === 0 || digits.length > 15) continue;
      const value = Number(digits);
      if (!Number.isSafeInteger(value)) continue;
      const suffix = token.endsWith("n") ? "n" : "";
      const line1 = lineIdx + 1;
      const column = tokenStart + 1;
      for (const shifted of [value + 1, value - 1]) {
        push({
          operator: "boundary-shift", line: line1, column,
          description: `boundary '${token}' -> '${shifted}${suffix}'`,
          start: absStart, end: absStart + token.length, text: `${shifted}${suffix}`,
        });
      }
    }
  }
}

function findMatchingParen(masked: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i += 1) {
    if (masked[i] === "(") depth += 1;
    else if (masked[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelComma(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) return i;
  }
  return -1;
}

function mutateRoundingSwap(source: string, masked: string, starts: number[], push: Push): void {
  // roundDiv(a, b) -> ((a) / (b)): exact half-away replaced by truncation.
  const call = /\broundDiv\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(masked)) !== null) {
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = findMatchingParen(masked, openIdx);
    if (closeIdx < 0) continue;
    const argsText = source.slice(openIdx + 1, closeIdx);
    const comma = splitTopLevelComma(argsText);
    if (comma < 0) continue;
    const first = argsText.slice(0, comma).trim();
    const rest = argsText.slice(comma + 1).trim();
    if (!first || !rest || splitTopLevelComma(rest) >= 0) continue;
    const { line, column } = offsetToLineColumn(starts, match.index);
    push({
      operator: "rounding-swap", line, column,
      description: "rounding 'roundDiv(a, b)' -> truncating '((a) / (b))'",
      start: match.index, end: closeIdx + 1, text: `(( ${first} ) / ( ${rest} ))`,
    });
  }
  // Math.round(x) -> Math.floor(x), Math.ceil(x) -> Math.floor(x).
  const mathCall = /\bMath\s*\.\s*(round|ceil)\s*\(/g;
  while ((match = mathCall.exec(masked)) !== null) {
    const name = match[1]!;
    const nameIdx = match.index + match[0].indexOf(name);
    const { line, column } = offsetToLineColumn(starts, nameIdx);
    push({
      operator: "rounding-swap", line, column,
      description: `rounding 'Math.${name}' -> 'Math.floor'`,
      start: nameIdx, end: nameIdx + name.length, text: "floor",
    });
  }
}

/** Header-then-brace-depth scan for `for`/`while` body line ranges (0-based). */
function scanLoopRanges(maskedLines: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let pendingLoop = false;
  for (let idx = 0; idx < maskedLines.length; idx += 1) {
    const line = maskedLines[idx]!;
    if (/^\s*(for|while)\b/.test(line)) pendingLoop = true;
    let opened = 0;
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
        opened += 1;
      } else if (ch === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
    if (!pendingLoop) continue;
    if (opened > 0) {
      const bodyDepth = depth;
      let end = idx;
      let scan = depth;
      for (let j = idx + 1; j < maskedLines.length; j += 1) {
        for (const ch of maskedLines[j]!) {
          if (ch === "{") scan += 1;
          else if (ch === "}") scan -= 1;
        }
        if (scan < bodyDepth) {
          end = j - 1;
          break;
        }
        end = j;
      }
      ranges.push({ start: idx + 1, end });
      pendingLoop = false;
    } else if (/^\s*(for|while)\b/.test(line)) {
      // Header without a brace on this line: either the brace lands on a
      // later line (keep waiting) or the whole body sits on this same line
      // (`for (...) total += x;`), where no safe single-line drop exists.
      const headerless = line.replace(/^\s*(for|while)\b/, "");
      if (/\).*\S/.test(headerless)) pendingLoop = false;
    } else if (!line.includes("{")) {
      // Single-statement body without braces: the first non-header line only.
      ranges.push({ start: idx, end: idx });
      pendingLoop = false;
    } else {
      pendingLoop = false;
    }
  }
  return ranges;
}

const ACCUMULATOR_PATTERN = /(\+=|-=|\*=|\/=|%=|\.push\s*\()/;
const DECLARATION_START = /^\s*(const|let|var|import|export|function|class|return|type|interface)\b/;

function mutateDroppedAccumulator(maskedLines: string[], push: Push): void {
  const ranges = scanLoopRanges(maskedLines);
  const inside = (lineIdx: number): boolean => ranges.some((r) => lineIdx >= r.start && lineIdx <= r.end);
  for (let idx = 0; idx < maskedLines.length; idx += 1) {
    if (!inside(idx)) continue;
    const line = maskedLines[idx]!;
    const trimmed = line.trim();
    if (!trimmed.endsWith(";")) continue;
    if (!ACCUMULATOR_PATTERN.test(line)) continue;
    // Dropping a declaration would only prove the suite notices a
    // ReferenceError; statements with no binding effect are the probe.
    if (DECLARATION_START.test(line)) continue;
    const column = line.indexOf(trimmed) + 1;
    push({
      operator: "dropped-accumulator", line: idx + 1, column,
      description: `dropped accumulator statement '${trimmed.slice(0, 72)}'`,
      start: -1, end: -1, text: "", deleteLine: idx,
    });
  }
}

function mutateGuardNegation(
  maskedLines: string[],
  sourceLines: string[],
  lineOffsets: number[],
  push: Push,
): void {
  for (let idx = 0; idx < maskedLines.length; idx += 1) {
    const line = maskedLines[idx]!;
    if (!/^\s*(?:\}\s*)?(if|else\s+if|while)\b/.test(line)) continue;
    const openInLine = line.indexOf("(");
    if (openInLine < 0) continue;
    // Single-line conditions only; multi-line guards are skipped.
    let depth = 0;
    let closeInLine = -1;
    for (let k = openInLine; k < line.length; k += 1) {
      if (line[k] === "(") depth += 1;
      else if (line[k] === ")") {
        depth -= 1;
        if (depth === 0) {
          closeInLine = k;
          break;
        }
      }
    }
    if (closeInLine < 0) continue;
    // Locate on the masked line (strings/comments blanked) but splice the
    // ORIGINAL text: a masked condition would plant spaces where a string
    // literal stood and every such mutant would be a syntax error.
    const condition = sourceLines[idx]!.slice(openInLine + 1, closeInLine);
    if (!condition.trim()) continue;
    push({
      operator: "guard-negation", line: idx + 1, column: openInLine + 2,
      description: `guard negated '(${condition.trim().slice(0, 64)})'`,
      start: lineOffsets[idx]! + openInLine + 1, end: lineOffsets[idx]! + closeInLine,
      text: `!(${condition})`,
    });
  }
}

const WRITE_CALL_PATTERN = /\.(insert|update|delete|execute|save|write)\s*\(/;
const VOID_RETURN_PATTERN = /\)\s*:\s*(Promise<\s*void\s*>|void)\b/;

function mutateEarlyReturn(maskedLines: string[], push: Push): void {
  for (let idx = 0; idx < maskedLines.length; idx += 1) {
    const line = maskedLines[idx]!;
    if (!WRITE_CALL_PATTERN.test(line)) continue;
    // Walk back to the enclosing function/method header; only a provable
    // void return annotation admits the inserted `return;`, so the mutant
    // always parses and always typechecks.
    let header: string | null = null;
    for (let back = idx; back >= Math.max(0, idx - 40); back -= 1) {
      const candidate = maskedLines[back]!;
      if (/^\s*\}\s*$/.test(candidate) && back !== idx) break;
      if (/\bfunction\b.*\{\s*$/.test(candidate) || /=>\s*\{\s*$/.test(candidate)) {
        header = candidate;
        break;
      }
      if (/^\s*(export\s+)?(async\s+)?\w[\w$]*\s*\(.*\)\s*(:\s*[^{]+)?\{\s*$/.test(candidate)) {
        header = candidate;
        break;
      }
    }
    if (header === null || !VOID_RETURN_PATTERN.test(header)) continue;
    const indent = line.match(/^\s*/)?.[0] ?? "";
    push({
      operator: "early-return-before-write", line: idx + 1, column: 1,
      description: `early return before '${line.trim().slice(0, 64)}'`,
      start: -1, end: -1, text: "",
      insertBeforeLine: idx, insertText: `${indent}return;`,
    });
  }
}

/**
 * Generate mutants for one file. Ordering is deterministic (source order
 * within each operator, operators in MUTATION_OPERATORS order); each operator
 * is capped so a 3000-line kernel file cannot flood the run queue. The final
 * list is sorted by line for stable sampling and reporting.
 */
export function generateMutants(
  target: string,
  source: string,
  options: GenerateMutantsOptions = {},
): GeneratedMutant[] {
  const masked = maskSource(source);
  const starts = lineStartOffsets(source);
  const maskedLines = masked.split("\n");

  const pending: PendingMutant[] = [];
  const push: Push = (m) => {
    pending.push(m);
  };
  const sourceLines = source.split("\n");

  const sourceFile = parseSource(source);
  mutateArithSignFlip(source, sourceFile, starts, push);
  mutateComparisonFlip(sourceFile, starts, push);
  mutateBoundaryShift(maskedLines, starts, starts, push, collectTypeLiteralRanges(sourceFile));
  mutateRoundingSwap(source, masked, starts, push);
  mutateDroppedAccumulator(maskedLines, push);
  mutateGuardNegation(maskedLines, sourceLines, starts, push);
  mutateEarlyReturn(maskedLines, push);

  const maxPerOperator = options.maxPerOperator ?? DEFAULT_MAX_PER_OPERATOR;
  const inRange = (line: number): boolean => {
    if (!options.lineRanges || options.lineRanges.length === 0) return true;
    return options.lineRanges.some((r) => line >= r.start && line <= r.end);
  };

  const result: GeneratedMutant[] = [];
  const occurrence = new Map<string, number>();
  for (const op of MUTATION_OPERATORS) {
    const list = pending
      .filter((m) => m.operator === op)
      .sort((a, b) => a.line - b.line || a.column - b.column || (a.description < b.description ? -1 : 1));
    let emitted = 0;
    for (const m of list) {
      if (emitted >= maxPerOperator) break;
      if (!inRange(m.line)) continue;
      const siteKey = `${op}:${m.line}:${m.column}`;
      const n = (occurrence.get(siteKey) ?? 0) + 1;
      occurrence.set(siteKey, n);
      let mutatedSource: string;
      if (m.deleteLine !== undefined) {
        const copy = sourceLines.slice();
        copy.splice(m.deleteLine, 1);
        mutatedSource = copy.join("\n");
      } else if (m.insertBeforeLine !== undefined) {
        const copy = sourceLines.slice();
        copy.splice(m.insertBeforeLine, 0, m.insertText ?? "return;");
        mutatedSource = copy.join("\n");
      } else {
        mutatedSource = source.slice(0, m.start) + m.text + source.slice(m.end);
      }
      if (mutatedSource === source) continue;
      emitted += 1;
      result.push({
        key: `${target}:${m.line}:${op}:${m.column}:${n}`,
        target,
        operator: op,
        line: m.line,
        column: m.column,
        description: m.description,
        mutatedSource,
      });
    }
  }
  result.sort((a, b) => a.line - b.line || (a.key < b.key ? -1 : 1));
  return result;
}
