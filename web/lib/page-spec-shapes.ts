import { z } from "zod";
import { blockSchema, cellSchema } from "@braedonsaunders/appkit-viewspec";

/**
 * The property contract of every ViewSpec block and cell, derived from the
 * same closed schema that validates a stored spec, plus the issue reader that
 * turns its union failures into the field-level message an author can act on.
 *
 * Deliberately NOT `server-only`: the agent vocabulary, the save path and the
 * native app validator all read one contract, so none of them can drift.
 */

type Schema = z.ZodType;
type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  $ref?: string;
  minimum?: number;
  maximum?: number;
};

/** The union members of a (possibly lazy, possibly nested) kind union. */
function kindOptions(schema: Schema): Map<string, Schema> {
  const out = new Map<string, Schema>();
  const visit = (candidate: Schema) => {
    const def = (candidate as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
    if (def.type === "lazy") return visit((def.getter as () => Schema)());
    if (def.type === "union") {
      for (const option of def.options as Schema[]) visit(option);
      return;
    }
    const shape = (def.shape ?? null) as Record<string, Schema> | null;
    const kind = shape?.kind as unknown as { _zod?: { def?: { values?: unknown[] } } } | undefined;
    const literal = kind?._zod?.def?.values?.[0];
    if (typeof literal === "string") out.set(literal, candidate);
  };
  visit(schema);
  return out;
}

const BLOCKS = kindOptions(blockSchema as Schema);
const CELLS = kindOptions(cellSchema as Schema);

const FIELD_REF = "FieldRef";

function isFieldRef(schema: JsonSchema): boolean {
  return (
    schema.type === "object" &&
    !!schema.properties?.$ &&
    Object.keys(schema.properties).length === 1
  );
}

/** One JSON Schema node as a compact TypeScript-like type. */
function typeText(schema: JsonSchema, context: "block" | "cell", depth = 0): string {
  if (schema.$ref) return context === "block" ? "Block" : "Cell";
  if (isFieldRef(schema)) return FIELD_REF;
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const kinds = variants.map((variant) => variant.properties?.kind?.const);
    if (variants.length > 4 && kinds.every((kind) => typeof kind === "string")) {
      return kinds.every((kind) => CELLS.has(kind as string)) ? "Cell" : "Block";
    }
    return [...new Set(variants.map((variant) => typeText(variant, context, depth)))].join(" | ");
  }
  if (schema.type === "array")
    return `${schema.items ? wrap(typeText(schema.items, context, depth)) : "unknown"}[]`;
  if (schema.type === "object") {
    if (!schema.properties) return "object";
    if (depth > 2) return "object";
    const required = new Set(schema.required ?? []);
    const entries = Object.entries(schema.properties).map(
      ([key, value]) =>
        `${key}${required.has(key) ? "" : "?"}: ${typeText(value, context, depth + 1)}`,
    );
    return `{ ${entries.join("; ")} }`;
  }
  if (schema.type === "integer" && schema.minimum !== undefined && schema.maximum !== undefined) {
    return `integer ${schema.minimum}–${schema.maximum}`;
  }
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  return schema.type ?? "unknown";
}

function wrap(text: string): string {
  return text.includes(" | ") ? `(${text})` : text;
}

export interface ShapeDoc {
  /** Property name → compact type, for properties the author must supply. */
  required: Record<string, string>;
  /** Property name → compact type, for properties that may be omitted. */
  optional: Record<string, string>;
}

function shapeDoc(schema: Schema, context: "block" | "cell"): ShapeDoc {
  const json = z.toJSONSchema(schema, {
    unrepresentable: "any",
    cycles: "ref",
    io: "input",
  }) as JsonSchema;
  const required = new Set(json.required ?? []);
  const doc: ShapeDoc = { required: {}, optional: {} };
  for (const [key, value] of Object.entries(json.properties ?? {})) {
    (required.has(key) ? doc.required : doc.optional)[key] = typeText(value, context);
  }
  return doc;
}

let cachedShapes: { blocks: Record<string, ShapeDoc>; cells: Record<string, ShapeDoc> } | null =
  null;

/** Every block and cell kind with its required and optional properties. */
export function specShapes(): {
  blocks: Record<string, ShapeDoc>;
  cells: Record<string, ShapeDoc>;
} {
  if (cachedShapes) return cachedShapes;
  cachedShapes = {
    blocks: Object.fromEntries(
      [...BLOCKS].map(([kind, schema]) => [kind, shapeDoc(schema, "block")]),
    ),
    cells: Object.fromEntries([...CELLS].map(([kind, schema]) => [kind, shapeDoc(schema, "cell")])),
  };
  return cachedShapes;
}

type Issue = {
  code: string;
  path: PropertyKey[];
  message: string;
  errors?: Issue[][];
  values?: unknown[];
  expected?: string;
  keys?: string[];
  input?: unknown;
};

function pathText(path: readonly PropertyKey[]): string {
  return path.map(String).join(".") || "(root)";
}

function kindMismatch(branch: readonly Issue[]): Issue | undefined {
  return branch.find(
    (issue) =>
      issue.code === "invalid_value" && issue.path.length === 1 && issue.path[0] === "kind",
  );
}

/**
 * Field-level messages for a failed ViewSpec parse.
 *
 * Blocks and cells are plain unions, so zod reports a wrong property on a
 * stat tile as `body.0: Invalid input` with every member's failure attached.
 * The member whose `kind` matched is the one the author meant; its issues are
 * the real ones. An unknown kind names the kinds that exist, and a scalar
 * union (`string | FieldRef`) reports "is required" or the accepted forms.
 */
export function explainSpecIssues(
  issues: readonly Issue[],
  base: readonly PropertyKey[] = [],
): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors?.length) {
      const matched = issue.errors.filter((branch) => !kindMismatch(branch));
      const keyed = issue.errors.some((branch) => kindMismatch(branch));
      if (keyed && matched.length === 1) {
        out.push(...explainSpecIssues(matched[0]!, path));
        continue;
      }
      if (keyed && matched.length === 0) {
        const kinds = issue.errors.flatMap(
          (branch) => (kindMismatch(branch)?.values ?? []) as unknown[],
        );
        out.push(
          `${pathText(path)}: unknown kind; use one of ${[...new Set(kinds)].map((kind) => JSON.stringify(kind)).join(", ")}`,
        );
        continue;
      }
      const missing = issue.errors.every(
        (branch) =>
          branch.length === 1 &&
          branch[0]!.code === "invalid_type" &&
          branch[0]!.message.includes("received undefined"),
      );
      if (missing) {
        out.push(`${pathText(path)}: is required`);
        continue;
      }
      const literals = issue.errors.every(
        (branch) => branch.length === 1 && branch[0]!.code === "invalid_value",
      );
      if (literals) {
        const values = issue.errors.flatMap((branch) => branch[0]!.values ?? []);
        out.push(
          `${pathText(path)}: use one of ${values.map((value) => JSON.stringify(value)).join(", ")}`,
        );
        continue;
      }
      const expected = [
        ...new Set(
          issue.errors.flatMap((branch) =>
            branch.flatMap((entry) =>
              entry.expected === "object" && branch.length === 1
                ? ['a field reference {"$": "dot.path"}']
                : entry.expected
                  ? [entry.expected]
                  : [],
            ),
          ),
        ),
      ];
      out.push(
        `${pathText(path)}: ${expected.length ? `expected ${expected.join(" or ")}` : issue.message}`,
      );
      continue;
    }
    if (issue.code === "invalid_type" && issue.message.includes("received undefined")) {
      out.push(`${pathText(path)}: is required`);
      continue;
    }
    out.push(`${pathText(path)}: ${issue.message}`);
  }
  return [...new Set(out)];
}
