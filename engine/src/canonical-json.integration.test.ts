import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { canonicalJson } from "./canonical-json.ts";
import { db } from "./db.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "canonical evidence hash reproduces after a PostgreSQL jsonb round trip",
  { skip: !DB },
  async () => {
    const snapshot = {
      format: "openbooks.close-binder.v1",
      run: { status: "published", id: "run-1", period: { end: "2026-07-31", start: "2026-07-01" } },
      tasks: [
        { key: "review", status: "complete" },
        { key: "publish", status: "complete" },
      ],
    };
    const result = (await db.execute(sql`
      select ${JSON.stringify(snapshot)}::jsonb as snapshot
    `)) as unknown as { rows: Array<{ snapshot: unknown }> };
    const digest = (value: unknown) =>
      createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
    assert.equal(digest(result.rows[0]!.snapshot), digest(snapshot));
  },
);
