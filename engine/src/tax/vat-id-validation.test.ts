import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { VatValidationError } from "../connectors/vat-validation.ts";
import { validatePartyTaxId } from "./vat-id-validation.ts";
import { CrossBorderTaxError } from "./cross-border-place-of-supply.ts";

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

const dialect = new PgDialect();

/** Minimal database double: canned rows per query shape, recording writes. */
function stubExecutor(routes: Array<{ match: RegExp; rows: Record<string, unknown>[] }>): {
  tx: SqlExecutor;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const tx = {
    execute: async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      queries.push({ sql: compiled.sql, params: compiled.params });
      for (const route of routes) {
        if (route.match.test(compiled.sql)) return { rows: route.rows };
      }
      throw new Error(`unstubbed query: ${compiled.sql.slice(0, 120)}`);
    },
  } as unknown as SqlExecutor;
  return { tx, queries };
}

const ROW = {
  id: "row-1",
  partyId: "party-1",
  scheme: "vies",
  value: "DE123456789",
  status: "valid",
};

function rowRoutes(extra: Record<string, unknown>[] = [{ "1": 1 }]) {
  return [
    { match: /from party_tax_ids/, rows: [{ ...ROW }] },
    { match: /update party_tax_ids/, rows: extra },
    { match: /insert into audit_log/, rows: [{ id: "audit-1" }] },
  ];
}

describe("validatePartyTaxId", () => {
  test("a valid authority answer persists the verdict with its consultation number", async () => {
    const { tx, queries } = stubExecutor(rowRoutes());
    const transport = (async () =>
      new Response(
        JSON.stringify({ countryCode: "DE", vatNumber: "123456789", valid: true, consultationNumber: "W1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const outcome = await validatePartyTaxId(tx, "org-1", "row-1", {
      transport,
      actorId: "actor-1",
      today: "2026-10-05",
    });
    assert.equal(outcome.status, "valid");
    assert.equal(outcome.consultationNumber, "W1");
    assert.equal(outcome.revalidateAfter, "2027-01-03");
    const update = queries.find((query) => /update party_tax_ids/.test(query.sql));
    assert.ok(update);
    assert.ok(queries.some((query) => /insert into audit_log/.test(query.sql)));
  });

  test("an authority outage keeps the row unverified and raises the failure", async () => {
    const { tx } = stubExecutor(rowRoutes());
    const transport = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    await assert.rejects(
      () => validatePartyTaxId(tx, "org-1", "row-1", { transport, today: "2026-10-05" }),
      VatValidationError,
    );
  });

  test("a missing row refuses instead of reporting success", async () => {
    const { tx } = stubExecutor([{ match: /from party_tax_ids/, rows: [] }]);
    await assert.rejects(() => validatePartyTaxId(tx, "org-1", "row-1", {}), CrossBorderTaxError);
  });

  test("a lost update refuses instead of reporting success", async () => {
    const { tx } = stubExecutor(rowRoutes([]));
    const transport = (async () =>
      new Response(JSON.stringify({ valid: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    await assert.rejects(
      () => validatePartyTaxId(tx, "org-1", "row-1", { transport, today: "2026-10-05" }),
      CrossBorderTaxError,
    );
  });
});
