import { canonicalDecimal } from "./exact-decimal.ts";
import { decimalNullRefusal } from "./decimal-refusal.ts";
import { roundDiv } from "./money.ts";
import { rational as exactRational, compareRational, RationalError, RATIONAL_DIGITS, type Rational } from "./rational.ts";

/** A deliberately small expression language: no code execution, property access, clock, or I/O. */
export type ExpressionType =
  | { readonly kind: "scalar" | "hours" | "boolean" }
  | { readonly kind: "money" | "hourly_rate"; readonly currency: string };

export interface ExpressionInput {
  readonly name: string;
  readonly type: ExpressionType;
}

export interface ExpressionRounding {
  readonly scale: number;
  readonly mode: "half_away_from_zero" | "half_even" | "towards_zero";
  readonly maxWholeDigits: number;
}

export class ExpressionError extends Error {
  readonly name = "ExpressionError";
  constructor(readonly code: "INVALID_EXPRESSION" | "INVALID_INPUT" | "TYPE_MISMATCH" | "LIMIT" | "DIVISION_BY_ZERO", message: string) {
    super(message);
  }
}

// Bound both parsing and exact intermediate arithmetic before allocating large values.
export const EXPRESSION_LIMITS = Object.freeze({ characters: 4096, tokens: 512, depth: 32, inputs: 128, decimalCharacters: 64, rationalDigits: RATIONAL_DIGITS });
const FUNCTIONS = ["min", "max", "clamp", "if", "and", "or", "not"] as const;
type FunctionName = (typeof FUNCTIONS)[number];
type Operator = "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=";
type Token = { kind: "number" | "identifier"; text: string } | { kind: "symbol"; text: string };
type Node =
  | { kind: "literal"; value: Rational; type: ExpressionType }
  | { kind: "input"; name: string; type: ExpressionType }
  | { kind: "negate"; operand: Node; type: ExpressionType }
  | { kind: "binary"; operator: Operator; left: Node; right: Node; type: ExpressionType }
  | { kind: "call"; name: FunctionName; arguments: readonly Node[]; type: ExpressionType };
type Value = Rational | boolean;
const SCALAR: ExpressionType = Object.freeze({ kind: "scalar" });
const BOOLEAN: ExpressionType = Object.freeze({ kind: "boolean" });

function refusal(code: ExpressionError["code"], message: string): never {
  throw new ExpressionError(code, message);
}

function typeLabel(type: ExpressionType): string {
  return "currency" in type ? `${type.kind} (${type.currency})` : type.kind;
}

function sameType(a: ExpressionType, b: ExpressionType): boolean {
  return typeLabel(a) === typeLabel(b);
}

function numeric(node: Node): void {
  if (node.type.kind === "boolean") refusal("TYPE_MISMATCH", "A boolean cannot be used as an amount — use if(condition, yes, no) to choose a numeric value.");
}

function matching(a: Node, b: Node, operation: string): void {
  // A numeric literal takes the surrounding unit: money + 25 means 25 in
  // that money's currency. Declared scalar inputs never acquire a unit implicitly.
  const isLiteral = (node: Node): boolean => node.kind === "literal" || (node.kind === "negate" && isLiteral(node.operand));
  if (isLiteral(a) && a.type.kind === "scalar" && b.type.kind !== "boolean") a.type = b.type;
  if (isLiteral(b) && b.type.kind === "scalar" && a.type.kind !== "boolean") b.type = a.type;
  if (!sameType(a.type, b.type)) refusal("TYPE_MISMATCH", `${operation} requires matching units; received ${typeLabel(a.type)} and ${typeLabel(b.type)} — use values in the same currency and unit.`);
}

function productType(a: ExpressionType, b: ExpressionType, divide: boolean): ExpressionType {
  if (b.kind === "scalar") return a;
  if (!divide && a.kind === "scalar") return b;
  if (divide && sameType(a, b)) return SCALAR;
  if (!divide && a.kind === "hours" && b.kind === "hourly_rate") return { kind: "money", currency: b.currency };
  if (!divide && b.kind === "hours" && a.kind === "hourly_rate") return { kind: "money", currency: a.currency };
  if (divide && a.kind === "money" && b.kind === "hours") return { kind: "hourly_rate", currency: a.currency };
  if (divide && a.kind === "money" && b.kind === "hourly_rate" && a.currency === b.currency) return { kind: "hours" };
  return refusal("TYPE_MISMATCH", `Cannot ${divide ? "divide" : "multiply"} ${typeLabel(a)} by ${typeLabel(b)} — use an explicit scalar factor or a compatible hours and hourly-rate pair.`);
}

function rational(numerator: bigint, denominator: bigint): Rational {
  try {
    return exactRational(numerator, denominator);
  } catch (error) {
    if (!(error instanceof RationalError)) throw error;
    return refusal(error.code, error.code === "DIVISION_BY_ZERO"
      ? "The formula divides by zero — correct the divisor or use if(condition, yes, no) to handle a zero input."
      : "The formula exceeds the exact-arithmetic limit — simplify repeated multiplication or division before trying again.");
  }
}

function decimal(raw: unknown, label: string): Rational {
  if (typeof raw === "string" && raw.length > EXPRESSION_LIMITS.decimalCharacters) refusal("LIMIT", `${label} exceeds ${EXPRESSION_LIMITS.decimalCharacters} characters — enter a plain decimal with at most 15 whole digits and 18 decimal places.`);
  const text = canonicalDecimal(raw, 18);
  if (text === null) refusal("INVALID_INPUT", decimalNullRefusal(label, "a decimal", raw, 18));
  const [whole = "0", fraction = ""] = text.replace(/^-/, "").split(".");
  if (whole.replace(/^0+/, "").length > 15) refusal("LIMIT", `${label} allows at most 15 whole digits — reduce the value before trying again.`);
  const units = BigInt(whole + fraction) * (text.startsWith("-") ? -1n : 1n);
  return rational(units, 10n ** BigInt(fraction.length));
}

function tokenize(source: string): Token[] {
  if (typeof source !== "string" || source.trim().length === 0) refusal("INVALID_EXPRESSION", "The formula is empty — enter an expression before previewing it.");
  if (source.length > EXPRESSION_LIMITS.characters) refusal("LIMIT", `The formula exceeds ${EXPRESSION_LIMITS.characters} characters — simplify it before trying again.`);
  const result: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    if (/\s/.test(source[offset]!)) { offset += 1; continue; }
    const rest = source.slice(offset);
    const number = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(rest);
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    const symbol = /^(?:<=|>=|==|!=|[+\-*/<>() ,])/.exec(rest);
    if (number) result.push({ kind: "number", text: number[0] });
    else if (identifier) result.push({ kind: "identifier", text: identifier[0] });
    else if (symbol) result.push({ kind: "symbol", text: symbol[0] });
    else refusal("INVALID_EXPRESSION", `The formula contains ${JSON.stringify(source[offset])} — use decimal values, declared inputs, arithmetic, comparisons, and min/max/clamp/if/and/or/not.`);
    offset += (number ?? identifier ?? symbol)![0].length;
    if (result.length > EXPRESSION_LIMITS.tokens) refusal("LIMIT", `The formula exceeds ${EXPRESSION_LIMITS.tokens} tokens — split or simplify the expression.`);
  }
  return result;
}

class Parser {
  private position = 0;
  readonly dependencies = new Set<string>();
  constructor(private readonly tokens: readonly Token[], private readonly inputs: ReadonlyMap<string, ExpressionType>) {}
  parse(): Node {
    const node = this.expression(0);
    if (this.peek()) refusal("INVALID_EXPRESSION", "The formula has trailing input after a complete expression — check its operators and parentheses.");
    return node;
  }
  private peek(): Token | undefined { return this.tokens[this.position]; }
  private take(text: string): boolean {
    if (this.peek()?.text !== text) return false;
    this.position += 1;
    return true;
  }
  private expression(depth: number): Node {
    let left = this.sum(depth);
    const operator = this.peek()?.text;
    if (operator && ["<", "<=", ">", ">=", "==", "!="].includes(operator)) {
      this.position += 1;
      const right = this.sum(depth);
      matching(left, right, "Comparison");
      if (!["==", "!="].includes(operator)) { numeric(left); numeric(right); }
      left = { kind: "binary", operator: operator as Operator, left, right, type: BOOLEAN };
    }
    return left;
  }
  private sum(depth: number): Node {
    let left = this.product(depth);
    while (this.peek()?.text === "+" || this.peek()?.text === "-") {
      const operator = this.tokens[this.position++]!.text as "+" | "-";
      const right = this.product(depth);
      numeric(left); numeric(right); matching(left, right, "Addition or subtraction");
      left = { kind: "binary", operator, left, right, type: left.type };
    }
    return left;
  }
  private product(depth: number): Node {
    let left = this.factor(depth);
    while (this.peek()?.text === "*" || this.peek()?.text === "/") {
      const operator = this.tokens[this.position++]!.text as "*" | "/";
      const right = this.factor(depth);
      numeric(left); numeric(right);
      left = { kind: "binary", operator, left, right, type: productType(left.type, right.type, operator === "/") };
    }
    return left;
  }
  private factor(depth: number): Node {
    if (depth > EXPRESSION_LIMITS.depth) refusal("LIMIT", `The formula exceeds ${EXPRESSION_LIMITS.depth} nested expressions — reduce its nesting.`);
    if (this.take("-")) {
      const operand = this.factor(depth + 1);
      numeric(operand);
      return { kind: "negate", operand, type: operand.type };
    }
    if (this.take("+")) return this.factor(depth + 1);
    if (this.take("(")) {
      const node = this.expression(depth + 1);
      if (!this.take(")")) refusal("INVALID_EXPRESSION", "The formula has an unclosed parenthesis — add its closing parenthesis.");
      return node;
    }
    const token = this.peek();
    if (token?.kind === "number") {
      this.position += 1;
      return { kind: "literal", value: decimal(token.text, "Formula value"), type: SCALAR };
    }
    if (token?.kind === "identifier") {
      this.position += 1;
      if (this.take("(")) return this.call(token.text, depth + 1);
      const type = this.inputs.get(token.text);
      if (!type) {
        const names = [...this.inputs.keys()];
        const available = names.length ? `available inputs are ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", and other declared inputs" : ""}` : "no inputs have been declared";
        refusal("INVALID_EXPRESSION", `The formula names ${JSON.stringify(token.text)} — ${available}; choose a declared input.`);
      }
      this.dependencies.add(token.text);
      return { kind: "input", name: token.text, type };
    }
    return refusal("INVALID_EXPRESSION", "The formula ends mid-expression or has an unexpected token — complete its operand.");
  }
  private call(name: string, depth: number): Node {
    if (!(FUNCTIONS as readonly string[]).includes(name)) refusal("INVALID_EXPRESSION", `The formula calls ${JSON.stringify(name)} — available functions are min, max, clamp, if, and, or, not; choose one of these functions.`);
    const args: Node[] = [];
    if (!this.take(")")) {
      do { args.push(this.expression(depth)); } while (this.take(","));
      if (!this.take(")")) refusal("INVALID_EXPRESSION", `The call to ${name} is missing its closing parenthesis — complete the call.`);
    }
    const count = args.length;
    if (name === "if" || name === "clamp") {
      if (count !== 3) refusal("INVALID_EXPRESSION", `${name} takes exactly three arguments — correct the call.`);
    } else if (name === "not") {
      if (count !== 1) refusal("INVALID_EXPRESSION", "not takes exactly one boolean argument — correct the call.");
    } else if (count === 0) refusal("INVALID_EXPRESSION", `${name} needs at least one argument — supply its values.`);
    let type: ExpressionType;
    if (name === "if") {
      if (args[0]!.type.kind !== "boolean") refusal("TYPE_MISMATCH", "if requires a boolean condition — use a comparison or a declared boolean input.");
      matching(args[1]!, args[2]!, "The branches of if");
      type = args[1]!.type;
    } else if (name === "and" || name === "or" || name === "not") {
      if (args.some((arg) => arg.type.kind !== "boolean")) refusal("TYPE_MISMATCH", `${name} requires boolean arguments — use comparisons or declared boolean inputs.`);
      type = BOOLEAN;
    } else {
      const anchor = args.find((arg) => arg.kind !== "literal") ?? args[0]!;
      for (const arg of args) { numeric(arg); matching(anchor, arg, name); }
      type = args[0]!.type;
    }
    return { kind: "call", name: name as FunctionName, arguments: args, type };
  }
}

function asRational(value: Value): Rational {
  if (typeof value === "boolean") return refusal("TYPE_MISMATCH", "A boolean cannot be priced as an amount — select a numeric branch with if.");
  return value;
}

function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  return compareRational(a, b);
}

function evaluate(node: Node, inputs: ReadonlyMap<string, Value>): Value {
  if (node.kind === "literal") return node.value;
  if (node.kind === "input") return inputs.get(node.name)!;
  if (node.kind === "negate") {
    const value = asRational(evaluate(node.operand, inputs));
    return { numerator: -value.numerator, denominator: value.denominator };
  }
  if (node.kind === "binary") {
    const left = evaluate(node.left, inputs), right = evaluate(node.right, inputs);
    if (typeof left === "boolean" || typeof right === "boolean") return node.operator === "==" ? left === right : left !== right;
    switch (node.operator) {
      case "+": return rational(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator);
      case "-": return rational(left.numerator * right.denominator - right.numerator * left.denominator, left.denominator * right.denominator);
      case "*": return rational(left.numerator * right.numerator, left.denominator * right.denominator);
      case "/": return rational(left.numerator * right.denominator, left.denominator * right.numerator);
      case "<": return compare(left, right) < 0;
      case "<=": return compare(left, right) <= 0;
      case ">": return compare(left, right) > 0;
      case ">=": return compare(left, right) >= 0;
      case "==": return compare(left, right) === 0;
      case "!=": return compare(left, right) !== 0;
    }
  }
  const args = node.arguments;
  // A conditional validates both branches at compile time, and evaluates only the selected branch.
  if (node.name === "if") return evaluate(args[evaluate(args[0]!, inputs) === true ? 1 : 2]!, inputs);
  if (node.name === "and") return args.every((arg) => evaluate(arg, inputs) === true);
  if (node.name === "or") return args.some((arg) => evaluate(arg, inputs) === true);
  if (node.name === "not") return evaluate(args[0]!, inputs) !== true;
  const values = args.map((arg) => asRational(evaluate(arg, inputs)));
  if (node.name === "clamp") {
    const [value, low, high] = values as [Rational, Rational, Rational];
    if (compare(low, high) > 0) return refusal("INVALID_INPUT", "clamp has a lower bound above its upper bound — put its bounds in ascending order.");
    return compare(value, low) < 0 ? low : compare(value, high) > 0 ? high : value;
  }
  return values.reduce((chosen, value) => compare(value, chosen) * (node.name === "min" ? 1 : -1) < 0 ? value : chosen);
}

function rounded(value: Rational, rounding: ExpressionRounding): string {
  if (!Number.isInteger(rounding.scale) || rounding.scale < 0 || rounding.scale > 18
      || !Number.isInteger(rounding.maxWholeDigits) || rounding.maxWholeDigits < 1 || rounding.maxWholeDigits > 15
      || !["half_away_from_zero", "half_even", "towards_zero"].includes(rounding.mode)) {
    refusal("INVALID_INPUT", "Declare a rounding mode, a scale from 0 through 18, and a whole-digit limit from 1 through 15 before pricing the formula.");
  }
  const scale = 10n ** BigInt(rounding.scale);
  const numerator = value.numerator * scale;
  let units: bigint;
  if (rounding.mode === "half_away_from_zero") units = roundDiv(numerator, value.denominator);
  else {
    units = numerator / value.denominator;
    if (rounding.mode === "half_even") {
      const remainder = numerator % value.denominator;
      const twice = (remainder < 0n ? -remainder : remainder) * 2n;
      if (twice > value.denominator || (twice === value.denominator && units % 2n !== 0n)) units += numerator < 0n ? -1n : 1n;
    }
  }
  const absolute = units < 0n ? -units : units;
  const whole = (absolute / scale).toString();
  if (whole.length > rounding.maxWholeDigits) refusal("LIMIT", `The rounded formula result exceeds ${rounding.maxWholeDigits} whole digits — reduce the inputs or correct the formula before saving.`);
  const sign = units < 0n ? "-" : "";
  return rounding.scale === 0 ? `${sign}${whole}` : `${sign}${whole}.${(absolute % scale).toString().padStart(rounding.scale, "0")}`;
}

export interface CompiledExpression {
  readonly source: string;
  readonly resultType: ExpressionType;
  readonly dependencies: readonly string[];
  evaluate(inputs: Readonly<Record<string, unknown>>, rounding: ExpressionRounding): {
    readonly value: string | boolean;
    readonly inputs: Readonly<Record<string, string | boolean>>;
  };
}

/** Compile the entire expression before accepting values; unknown or ill-typed inactive branches still refuse. */
export function compileExpression(source: string, definitions: readonly ExpressionInput[]): CompiledExpression {
  if (!Array.isArray(definitions) || definitions.length > EXPRESSION_LIMITS.inputs) refusal("LIMIT", `An expression can declare at most ${EXPRESSION_LIMITS.inputs} inputs — reduce the input list.`);
  const types = new Map<string, ExpressionType>();
  for (const definition of definitions) {
    if (!definition || typeof definition.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(definition.name)
        || (FUNCTIONS as readonly string[]).includes(definition.name) || types.has(definition.name)) {
      refusal("INVALID_INPUT", "Each formula input needs a unique name of at most 64 letters, digits, or underscores, beginning with a letter or underscore; function names are reserved.");
    }
    const type = definition.type;
    if (!type || Array.isArray(type) || !["scalar", "hours", "boolean", "money", "hourly_rate"].includes(type.kind)
        || ((type.kind === "money" || type.kind === "hourly_rate") && (typeof type.currency !== "string" || !/^[A-Z]{3}$/.test(type.currency)))
        || ((type.kind === "scalar" || type.kind === "hours" || type.kind === "boolean") && "currency" in type)) {
      refusal("INVALID_INPUT", `Input ${JSON.stringify(definition.name)} needs a supported unit and, for money or hourly rates, a three-letter currency code.`);
    }
    types.set(definition.name, Object.freeze("currency" in type ? { kind: type.kind, currency: type.currency } : { kind: type.kind }));
  }
  const parser = new Parser(tokenize(source), types);
  const root = parser.parse();
  const dependencies = Object.freeze([...parser.dependencies].sort());
  return Object.freeze({
    source,
    resultType: Object.freeze({ ...root.type }),
    dependencies,
    evaluate(rawInputs: Readonly<Record<string, unknown>>, rounding: ExpressionRounding) {
      if (!rawInputs || typeof rawInputs !== "object" || Array.isArray(rawInputs)) refusal("INVALID_INPUT", "Formula inputs must be a record of declared values — supply each required input.");
      const values = new Map<string, Value>();
      const evidence: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
      for (const name of dependencies) {
        const raw = Object.hasOwn(rawInputs, name) ? rawInputs[name] : undefined;
        if (raw === undefined || raw === null) refusal("INVALID_INPUT", `Formula input ${JSON.stringify(name)} is missing — supply it before calculating; missing values never become zero.`);
        if (types.get(name)!.kind === "boolean") {
          if (typeof raw !== "boolean") refusal("INVALID_INPUT", `Formula input ${JSON.stringify(name)} must be a boolean — send true or false.`);
          values.set(name, raw); evidence[name] = raw;
        } else {
          values.set(name, decimal(raw, `Formula input ${JSON.stringify(name)}`));
          evidence[name] = canonicalDecimal(raw, 18)!;
        }
      }
      const result = evaluate(root, values);
      return Object.freeze({ value: typeof result === "boolean" ? result : rounded(result, rounding), inputs: Object.freeze(evidence) });
    },
  });
}
