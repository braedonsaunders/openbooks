import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Universal lists sort by keys that tie constantly (date, status, party
// name). Without a unique tiebreaker Postgres may return tied rows in any
// order, so pages reshuffle between visits and rows duplicate or drop across
// page boundaries. Both list components must order through the shared total-
// order clauses below. Only server seams are stubbed; the SQL builders are
// real and rendered with the Postgres dialect.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "@openbooks/engine/src/db.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export const db={execute:async()=>({rows:[]})};export const withBypassContext=(org,fn)=>fn();export function withOrgContext(org,fn){return fn()}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { listOrderClause } = (await import("./sources.ts")) as typeof import("./sources.ts");
const { entityListSource, entityOrderClause } = (await import("./entity-sources.ts")) as typeof import("./entity-sources.ts");
hooks.deregister();

const dialect = new PgDialect();
const textOf = (fragment: ReturnType<typeof listOrderClause>): string =>
  dialect.sqlToQuery(sql`order by ${fragment}`).sql;

test("document lists pin every page with the unique document id", () => {
  assert.match(
    textOf(listOrderClause(sql`d.document_date`, "desc")),
    /d\.document_date"?\s+desc nulls last, d\.id desc/,
  );
  assert.match(
    textOf(listOrderClause(sql`d.document_date`, "asc")),
    /d\.document_date"?\s+asc nulls last, d\.id asc/,
  );
});

test("entity lists pin every page with the source row id", () => {
  const vendor = entityListSource("vendor");
  assert.ok(vendor, "vendor entity source exists");
  assert.match(
    textOf(entityOrderClause(vendor, sql`p.display_name`, "asc")),
    /p\.display_name"?\s+asc nulls last, "?p"?\.id asc/,
  );
  assert.match(
    textOf(entityOrderClause(vendor, sql`p.display_name`, "desc")),
    /p\.display_name"?\s+desc nulls last, "?p"?\.id desc/,
  );
});

test("both universal list components order through the shared clauses", () => {
  const documents = readFileSync(new URL("../../components/record-list-view.tsx", import.meta.url), "utf8");
  assert.match(documents, /listOrderClause\(\s*orderExpr/);
  const entities = readFileSync(new URL("../../components/entity-list-view.tsx", import.meta.url), "utf8");
  assert.match(entities, /entityOrderClause\(\s*source/);
});
