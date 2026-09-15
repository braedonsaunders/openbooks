import assert from "node:assert/strict";
import test from "node:test";
import {
  generateMutants,
  maskSource,
  MUTATION_OPERATORS,
  type GeneratedMutant,
} from "./operators.ts";

function byOperator(mutants: GeneratedMutant[], operator: string): GeneratedMutant[] {
  return mutants.filter((m) => m.operator === operator);
}

function descriptions(mutants: GeneratedMutant[]): string[] {
  return mutants.map((m) => m.description);
}

test("maskSource blanks strings and comments while preserving offsets", () => {
  const source = "const a = \"x + y\"; // a - b\nconst c = 'it\\'s'; /* < > === */\nconst d = `tpl ${1 + 2}`;\n";
  const masked = maskSource(source);
  assert.equal(masked.length, source.length);
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") assert.equal(masked[i], "\n");
  }
  assert.ok(!masked.includes("x + y"));
  assert.ok(!masked.includes("a - b"));
  assert.ok(!masked.includes("==="));
  assert.ok(!masked.includes("1 + 2"));
  const mutants = generateMutants("engine/src/probe.ts", source);
  assert.equal(mutants.length, 0);
});

test("arith-sign-flip swaps binary operators and spares increments, assignment, and arrows", () => {
  const source = [
    "export function add(a: bigint, b: bigint): bigint {",
    "  return a + b;",
    "}",
    "export function net(a: bigint, b: bigint, c: bigint): bigint {",
    "  return (a * b) / c;",
    "}",
    "export function untouched(n: number): number {",
    "  n++;",
    "  n += 2;",
    "  const f = (x: number): number => x;",
    "  return n--;",
    "}",
    "",
  ].join("\n");
  const mutants = byOperator(generateMutants("engine/src/probe.ts", source), "arith-sign-flip");
  assert.deepEqual(descriptions(mutants), [
    "arith '+' -> '-'",
    "arith '*' -> '/'",
    "arith '/' -> '*'",
  ]);
  assert.ok(mutants[0]!.mutatedSource.includes("return a - b;"));
  assert.ok(mutants[1]!.mutatedSource.includes("(a / b) / c;"));
});

test("arith-sign-flip spares scientific-notation exponents", () => {
  const source = "const rate = 1e+10;\nconst tiny = 2E-4;\n";
  assert.equal(byOperator(generateMutants("engine/src/probe.ts", source), "arith-sign-flip").length, 0);
});

test("comparison-flip swaps strict and ordered comparisons but not arrows or shifts", () => {
  const source = [
    "export function check(a: number, b: number): boolean {",
    "  if (a < b) return true;",
    "  if (a <= b) return true;",
    "  if (a === b) return true;",
    "  if (a !== b) return true;",
    "  if (a > b) return true;",
    "  if (a >= b) return true;",
    "  const f = (x: number): number => x << 1 >> 2;",
    "  return f(a) === b;",
    "}",
    "",
  ].join("\n");
  const mutants = byOperator(generateMutants("engine/src/probe.ts", source), "comparison-flip");
  assert.deepEqual(descriptions(mutants), [
    "comparison '<' -> '<='",
    "comparison '<=' -> '<'",
    "comparison '===' -> '!=='",
    "comparison '!==' -> '==='",
    "comparison '>' -> '>='",
    "comparison '>=' -> '>'",
    "comparison '===' -> '!=='",
  ]);
});

test("boundary-shift nudges integer limits both ways and ignores floats and free literals", () => {
  const source = [
    "export function take(items: string[]): string[] {",
    "  const out: string[] = [];",
    "  for (let i = 0; i < 10; i++) {",
    "    out.push(items[i]!);",
    "  }",
    "  if (out.length > 4) return out.slice(0, 4);",
    "  return out;",
    "}",
    "const free = 99;",
    "const ratio = 1.5;",
    "",
  ].join("\n");
  const mutants = byOperator(generateMutants("engine/src/probe.ts", source), "boundary-shift");
  const desc = descriptions(mutants);
  assert.ok(desc.includes("boundary '10' -> '11'"));
  assert.ok(desc.includes("boundary '10' -> '9'"));
  assert.ok(desc.includes("boundary '4' -> '5'"));
  assert.ok(desc.includes("boundary '4' -> '3'"));
  // The unconstrained literal and the float live on lines 9-10: no probe there.
  assert.ok(mutants.every((m) => m.line === 3 || m.line === 6));
});

test("rounding-swap replaces roundDiv calls with truncating division", () => {
  const source = [
    "import { roundDiv } from \"./money.ts\";",
    "export function share(amount: bigint, parts: bigint): bigint {",
    "  return roundDiv(amount, parts);",
    "}",
    "export function down(x: number): number {",
    "  return Math.round(x) + Math.ceil(x);",
    "}",
    "",
  ].join("\n");
  const mutants = byOperator(generateMutants("engine/src/probe.ts", source), "rounding-swap");
  assert.deepEqual(descriptions(mutants), [
    "rounding 'roundDiv(a, b)' -> truncating '((a) / (b))'",
    "rounding 'Math.round' -> 'Math.floor'",
    "rounding 'Math.ceil' -> 'Math.floor'",
  ]);
  assert.ok(mutants[0]!.mutatedSource.includes("(( amount ) / ( parts ))"));
});

test("dropped-accumulator removes accumulation statements inside loops only", () => {
  const source = [
    "export function total(xs: bigint[]): bigint {",
    "  let sum = 0n;",
    "  const seen: bigint[] = [];",
    "  for (const x of xs) {",
    "    sum += x;",
    "    seen.push(x);",
    "    const doubled = x * 2n;",
    "    sum += doubled;",
    "  }",
    "  let stray = 0n;",
    "  stray += 1n;",
    "  return sum + stray;",
    "}",
    "",
  ].join("\n");
  const mutants = byOperator(generateMutants("engine/src/probe.ts", source), "dropped-accumulator");
  assert.equal(mutants.length, 3);
  assert.ok(mutants[0]!.mutatedSource.includes("seen.push(x);"));
  assert.ok(!mutants[0]!.mutatedSource.includes("sum += x;"));
  // Declarations are never dropped: only a ReferenceError would be proven.
  assert.ok(mutants.every((m) => m.mutatedSource.includes("const doubled")));
  // Outside the loop nothing is dropped.
  assert.ok(mutants.every((m) => m.mutatedSource.includes("stray += 1n;")));
});

test("guard-negation wraps single-line if and while conditions", () => {
  const source = [
    "export function guard(a: number, b: number): number {",
    "  if (a > 0) {",
    "    return a;",
    "  } else if (b < 0) {",
    "    return b;",
    "  }",
    "  while (a !== b) {",
    "    a += 1;",
    "  }",
    "  return a;",
    "}",
    "",
  ].join("\n");
  const mutants = byOperator(generateMutants("engine/src/probe.ts", source), "guard-negation");
  assert.equal(mutants.length, 3);
  assert.ok(mutants[0]!.mutatedSource.includes("if (!(a > 0)) {"));
  assert.ok(mutants[1]!.mutatedSource.includes("} else if (!(b < 0)) {"));
  assert.ok(mutants[2]!.mutatedSource.includes("while (!(a !== b)) {"));
});

test("early-return-before-write fires only under a provable void return type", () => {
  const source = [
    "export async function persist(db: { insert(x: number): void }): Promise<void> {",
    "  await setup();",
    "  db.insert(1);",
    "}",
    "export function load(db: { insert(x: number): number }): number {",
    "  return db.insert(2);",
    "}",
    "",
  ].join("\n");
  const mutants = byOperator(generateMutants("engine/src/probe.ts", source), "early-return-before-write");
  assert.equal(mutants.length, 1);
  assert.equal(mutants[0]!.line, 3);
  assert.ok(mutants[0]!.mutatedSource.includes("  return;\n  db.insert(1);"));
  assert.ok(mutants[0]!.mutatedSource.includes("return db.insert(2);"));
});

test("generateMutants is deterministic and keys are unique and stable", () => {
  const source = [
    "export function mixed(a: bigint, b: bigint): bigint {",
    "  if (a < b) return a + b;",
    "  return (a * b) / 2n;",
    "}",
    "",
  ].join("\n");
  const first = generateMutants("engine/src/probe.ts", source);
  const second = generateMutants("engine/src/probe.ts", source);
  assert.deepEqual(first.map((m) => m.key), second.map((m) => m.key));
  assert.deepEqual(first.map((m) => m.mutatedSource), second.map((m) => m.mutatedSource));
  assert.equal(new Set(first.map((m) => m.key)).size, first.length);
  assert.ok(first.length > 0);
  for (const m of first) {
    assert.ok(m.mutatedSource !== source);
    assert.ok(MUTATION_OPERATORS.includes(m.operator));
  }
});

test("lineRanges scope generation to the requested file regions", () => {
  const source = [
    "export function top(a: bigint, b: bigint): bigint {",
    "  return a + b;",
    "}",
    "export function bottom(a: bigint, b: bigint): bigint {",
    "  return a + b;",
    "}",
    "",
  ].join("\n");
  const scoped = generateMutants("engine/src/probe.ts", source, { lineRanges: [{ start: 4, end: 6 }] });
  assert.ok(scoped.length > 0);
  assert.ok(scoped.every((m) => m.line >= 4 && m.line <= 6));
});

test("maxPerOperator caps prolific operators deterministically", () => {
  const lines = ["export function big(a: bigint): bigint {"];
  for (let i = 0; i < 30; i += 1) lines.push(`  const v${i} = a + ${i}n + a;`);
  lines.push("  return a;", "}", "");
  const source = lines.join("\n");
  const capped = generateMutants("engine/src/probe.ts", source, { maxPerOperator: 5 });
  assert.ok(byOperator(capped, "arith-sign-flip").length <= 5);
  const recapped = generateMutants("engine/src/probe.ts", source, { maxPerOperator: 5 });
  assert.deepEqual(capped.map((m) => m.key), recapped.map((m) => m.key));
});
