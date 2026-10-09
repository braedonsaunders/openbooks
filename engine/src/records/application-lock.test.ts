import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { lockApplicationEvidenceWithQuery } from "./application-lock.ts";

test("complete settlement graphs retain ordered endpoint locks without expanding SQL parameters", async () => {
  const orgId = "00000000-0000-4000-8000-000000000001";
  const ids = Array.from({ length: 160_000 }, (_, i) =>
    `10000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`);
  const dialect = new PgDialect();
  const phases: string[] = [];
  const result = await lockApplicationEvidenceWithQuery(async (statement) => {
    const query = dialect.sqlToQuery(statement);
    assert.equal(query.params.length, 2);
    assert.equal(query.params[0], orgId);
    assert.deepEqual(query.params[1], ids);
    assert.match(query.sql, /= any\(\$2::uuid\[\]\)/);
    if (query.sql.includes('select line.id')) {
      phases.push("discover");
      return { rows: ids.map(id => ({ lineId: id, entryId: id, documentId: id })) };
    }
    assert.match(query.sql, /order by id\s+for update nowait/);
    if (query.sql.includes("from documents")) phases.push("documents");
    else if (query.sql.includes("from journal_entries")) phases.push("entries");
    else phases.push("lines");
    return { rows: ids.map(id => ({ id, entryId: id })) };
  }, orgId, [...ids].reverse(), [], [], { nowait: true });
  assert.deepEqual(phases, ["discover", "documents", "entries", "lines"]);
  assert.deepEqual(result, { documentIds: ids, entryIds: ids, lineIds: ids });
});
