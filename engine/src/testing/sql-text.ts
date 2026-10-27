import {
  Column,
  getTableName,
  is,
  Name,
  Param,
  Placeholder,
  SQL,
  StringChunk,
  Subquery,
  Table,
} from "drizzle-orm";

/**
 * Readers for test doubles that receive drizzle `SQL` objects through a fake
 * `execute`. They walk `queryChunks` the way the dialect does, so a double can
 * route on the statement text and read bound values without a database.
 *
 * Literal text comes from `StringChunk`s, whose `value` may be a string or a
 * string array depending on how the fragment was built (`sql` template vs.
 * `sql.raw` / shared chunks). Nested `SQL` (including `sql.join` output),
 * aliased fragments and subqueries are flattened in place; names, columns and
 * tables render as their bare identifiers. Bound values
 * are the primitive interpolations and `Param` objects; an interpolated array
 * stays one value, matching how the caller supplied it.
 */
export interface DrizzleSqlParts {
  /** Statement text with each bound value rendered as `placeholder`. */
  text: string;
  /** Bound values in statement order. */
  params: unknown[];
}

export interface DrizzleSqlTextOptions {
  /** Text emitted where a bound value sits. Defaults to `?`. */
  placeholder?: string;
}

function chunksOf(query: unknown): unknown[] | null {
  if (is(query, SQL)) return query.queryChunks;
  const chunks = (query as { queryChunks?: unknown } | null | undefined)?.queryChunks;
  return Array.isArray(chunks) ? chunks : null;
}

function walk(chunks: readonly unknown[], placeholder: string, out: DrizzleSqlParts): void {
  for (const chunk of chunks) {
    if (is(chunk, StringChunk)) {
      const value: unknown = chunk.value;
      out.text += Array.isArray(value) ? value.join("") : String(value);
      continue;
    }
    const nested = chunksOf(chunk);
    if (nested) {
      walk(nested, placeholder, out);
      continue;
    }
    if (is(chunk, Param)) {
      out.text += placeholder;
      out.params.push(chunk.value);
      continue;
    }
    if (is(chunk, Name)) {
      out.text += chunk.value;
      continue;
    }
    if (is(chunk, Column)) {
      out.text += chunk.name;
      continue;
    }
    if (is(chunk, Table)) {
      out.text += getTableName(chunk);
      continue;
    }
    if (is(chunk, Placeholder)) {
      out.text += placeholder;
      out.params.push(chunk);
      continue;
    }
    if (is(chunk, SQL.Aliased)) {
      walk(chunk.sql.queryChunks, placeholder, out);
      continue;
    }
    if (is(chunk, Subquery)) {
      out.text += "(";
      walk(chunk._.sql.queryChunks, placeholder, out);
      out.text += ")";
      continue;
    }
    out.text += placeholder;
    out.params.push(chunk);
  }
}

/** Statement text and bound values of a drizzle query; empty for anything else. */
export function drizzleSqlParts(
  query: unknown,
  options: DrizzleSqlTextOptions = {},
): DrizzleSqlParts {
  const out: DrizzleSqlParts = { text: "", params: [] };
  const chunks = chunksOf(query);
  if (chunks) walk(chunks, options.placeholder ?? "?", out);
  return out;
}

/** Statement text of a drizzle query, bound values rendered as the placeholder. */
export function drizzleSqlText(query: unknown, options: DrizzleSqlTextOptions = {}): string {
  return drizzleSqlParts(query, options).text;
}

/** Bound values of a drizzle query in statement order. */
export function drizzleSqlParams(query: unknown): unknown[] {
  return drizzleSqlParts(query).params;
}
