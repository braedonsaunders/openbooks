/// <reference types="node" />

/**
 * Bank statements always carry source evidence: raw_file_ref is mandatory,
 * a recorded source digest must be a lowercase SHA-256, and one account
 * cannot import the same source file twice (the digest is the idempotency
 * key). The governed query view exposes both evidence columns, tenant-scoped.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { runUserSql } from "@openbooks/engine/platform/sqlapi";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/testing/fixtures";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; cause?: unknown };
    if (candidate.code) return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

function refusedWith(code: string, scenario: string) {
  return (error: unknown) => {
    assert.equal(postgresCode(error), code, scenario);
    return true;
  };
}

async function insertStatement(
  orgId: string,
  accountId: string,
  evidence: { rawFileRef: string | null; sha256: string | null },
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into bank_statements (id, org_id, account_id, source, statement_date, raw_file_ref, source_file_sha256)
    values (${id}, ${orgId}, ${accountId}, 'csv', '2026-07-31', ${evidence.rawFileRef}, ${evidence.sha256})`);
  return id;
}

test(
  "bank statements refuse missing or malformed source evidence and duplicate source files",
  { skip: !DB, timeout: 60_000 },
  async () => {
    const org = await createScratchOrg();
    const otherOrg = await createScratchOrg();
    try {
      const digest = "a".repeat(64);
      const bank = org.accounts.bank;
      const secondAccount = org.accounts.clearing;

      await assert.rejects(
        insertStatement(org.orgId, bank, { rawFileRef: null, sha256: null }),
        refusedWith("23502", "a statement without a source reference is refused"),
      );
      await assert.rejects(
        insertStatement(org.orgId, bank, { rawFileRef: "files:upper", sha256: "A".repeat(64) }),
        refusedWith("23514", "a non-canonical digest is refused"),
      );
      await assert.rejects(
        insertStatement(org.orgId, bank, { rawFileRef: "files:short", sha256: "ab12" }),
        refusedWith("23514", "a truncated digest is refused"),
      );

      const hashed = await insertStatement(org.orgId, bank, {
        rawFileRef: `files:${randomUUID()}#sha256=${digest}`,
        sha256: digest,
      });
      await assert.rejects(
        insertStatement(org.orgId, bank, {
          rawFileRef: `files:${randomUUID()}#sha256=${digest}`,
          sha256: digest,
        }),
        refusedWith("23505", "re-importing the same source file into one account is refused"),
      );
      // The digest identifies a file per account and tenant; unhashed sources
      // (pointers to evidence held elsewhere) never collide.
      await insertStatement(org.orgId, secondAccount, {
        rawFileRef: `files:${randomUUID()}`,
        sha256: digest,
      });
      await insertStatement(otherOrg.orgId, otherOrg.accounts.bank, {
        rawFileRef: `files:${randomUUID()}`,
        sha256: digest,
      });
      const unhashed = await insertStatement(org.orgId, bank, {
        rawFileRef: `files:${randomUUID()}`,
        sha256: null,
      });
      await insertStatement(org.orgId, bank, { rawFileRef: `files:${randomUUID()}`, sha256: null });

      const governed = await runUserSql(
        `select id::text as id, raw_file_ref, source_file_sha256
         from bank_statements order by id`,
        { orgId: org.orgId },
      );
      const visible = new Map(
        (
          governed.rows as Array<{
            id: string;
            raw_file_ref: string;
            source_file_sha256: string | null;
          }>
        ).map((row) => [row.id, row]),
      );
      assert.equal(visible.size, 4, "the governed view returns only this tenant's statements");
      assert.equal(visible.get(hashed)?.source_file_sha256, digest);
      assert.equal(visible.get(unhashed)?.source_file_sha256, null);
      assert.match(visible.get(unhashed)?.raw_file_ref ?? "", /^files:/);
    } finally {
      await db.execute(
        sql`delete from bank_statements where org_id in (${org.orgId}, ${otherOrg.orgId})`,
      );
      await dropScratchOrg(otherOrg.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);
