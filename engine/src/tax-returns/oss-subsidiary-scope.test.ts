import assert from "node:assert/strict";
import test from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SqlExecutor } from "../platform/db.ts";
import {
  computeDistanceTurnover,
  findSupplyEvidenceConflicts,
} from "../tax/cross-border-monitor.ts";
import { CrossBorderTaxError } from "../tax/cross-border-place-of-supply.ts";
import { computeOssReturn } from "./oss-return.ts";

const dialect = new PgDialect();
const registration = {
  id: "registration-1",
  subsidiaryId: "subsidiary-a",
  identificationState: "IE",
  registrationNumber: "IE1234567A",
};

function recordedRunner(replies: Record<string, unknown>[][]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const runner = {
    async execute(query: SQL, mode?: string) {
      const inMode = <T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result;
      const compiled = dialect.sqlToQuery(query);
      queries.push({ sql: compiled.sql, params: compiled.params });
      const rows = replies.shift();
      assert.ok(rows, `unexpected query: ${compiled.sql}`);
      return inMode({ rows });
    },
  } as unknown as SqlExecutor;
  return { runner, queries };
}

const quarter = { scheme: "union" as const, from: "2026-07-01", to: "2026-09-30" };

test("OSS return supply and void corrections use the selected registration subsidiary", async () => {
  const { runner, queries } = recordedRunner([[registration], [], []]);
  const result = await computeOssReturn(runner, "org-1", quarter);
  const documentReads = queries.filter(({ sql }) => /from documents d/.test(sql));

  assert.equal(result.lines.length, 0);
  assert.equal(documentReads.length, 2);
  for (const query of documentReads) {
    assert.match(query.sql, /d\.subsidiary_id is not distinct from \$/);
    assert.ok(query.params.includes("subsidiary-a"));
  }
  assert.match(queries[0]!.sql, /effective_from is not null/);
});

test("distance turnover requires and uses the active Union OSS registration subsidiary", async () => {
  const { runner, queries } = recordedRunner([[{ subsidiaryId: "subsidiary-a" }], []]);
  const result = await computeDistanceTurnover(runner, "org-1", 2026, "2026-09-30");

  assert.equal(result.totalEur, "0.0000");
  assert.match(queries[1]!.sql, /d\.subsidiary_id is not distinct from \$/);
  assert.ok(queries[1]!.params.includes("subsidiary-a"));
});

test("distance turnover refuses when the Union registration is missing", async () => {
  const { runner } = recordedRunner([[]]);
  await assert.rejects(
    computeDistanceTurnover(runner, "org-1", 2026, "2026-09-30"),
    (error: unknown) =>
      error instanceof CrossBorderTaxError &&
      /configure exactly one active Union OSS registration/.test(error.message),
  );
});

test("supply evidence conflicts are limited to active OSS registration subsidiaries", async () => {
  const { runner, queries } = recordedRunner([[]]);
  assert.deepEqual(await findSupplyEvidenceConflicts(runner, "org-1"), []);
  assert.match(
    queries[0]!.sql,
    /registration\.subsidiary_id is not distinct from d\.subsidiary_id/,
  );
  assert.match(queries[0]!.sql, /registration\.scheme in \('union', 'non_union', 'ioss'\)/);
});
