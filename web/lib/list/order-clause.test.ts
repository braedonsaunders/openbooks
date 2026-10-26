import assert from "node:assert/strict";
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
    if (specifier === "@openbooks/engine/platform/db") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export const db={execute:async(_query, mode)=>Promise.resolve({rows:[]}).then((result) => (mode === 'objects' ? result.rows : result))};export const withBypassContext=(org,fn)=>fn();export function withOrgContext(org,fn){return fn()};export function ambientTenantOrgId(){return null};export function currentRequestOrgResolver(){return null};export function registerRequestOrgResolver(){};export function withBypass(fn){return fn()}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { listOrderClause } = (await import("./sources.ts")) as typeof import("./sources.ts");
const { entityListSource, entityOrderClause } =
  (await import("./entity-sources.ts")) as typeof import("./entity-sources.ts");
hooks.deregister();

const dialect = new PgDialect();
const textOf = (fragment: ReturnType<typeof listOrderClause>): string =>
  dialect.sqlToQuery(sql`order by ${fragment}`).sql;

test("tied document dates are ordered by the unique document id", () => {
  assert.match(
    textOf(listOrderClause(sql`d.document_date`, "desc")),
    /d\.document_date"?\s+desc nulls last, d\.id desc/,
  );
  assert.match(
    textOf(listOrderClause(sql`d.document_date`, "asc")),
    /d\.document_date"?\s+asc nulls last, d\.id asc/,
  );
});

test("tied entity labels are ordered by the source row id", () => {
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
