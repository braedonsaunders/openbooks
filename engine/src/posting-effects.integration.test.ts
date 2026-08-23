import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  listFailedPostingEffects,
  MAX_POSTING_EFFECTS_ATTEMPTS,
  processDuePostingEffects,
  replayTerminalPostingEffect,
} from "./posting-effects.ts";
import {
  POSTING_EFFECTS_WORKER_IDENTITY,
  TERMINAL_FAILURE_LOG_EVENT,
} from "./terminal-failure.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("attempt ceiling terminalizes posting effects and authorized replay preserves audit evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = randomUUID();
  const documentId = randomUUID();
  const entryId = randomUUID();
  const effectId = randomUUID();
  const terminalAt = new Date("2026-07-20T12:00:00.000Z");
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    await db.transaction(async (tx) => {
      const role = await tx.execute<{ id: string }>(sql`
        insert into app_roles (org_id, key, name, is_built_in, permissions)
        values (${org.orgId}, 'posting-effects-operator', 'Posting Effects Operator', false, '[]'::jsonb)
        returning id
      `);
      await tx.execute(sql`
        insert into users (id, org_id, email, name, password_hash, is_active)
        values (${actorId}, ${org.orgId}, ${`posting-effects-${actorId.slice(0, 8)}@test.local`},
                'Posting Effects Operator', 'x', true)
      `);
      await tx.execute(sql`
        insert into role_assignments (org_id, user_id, role_id)
        values (${org.orgId}, ${actorId}, ${role.rows[0]!.id})
      `);
    });
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
              ${`POSTFX-${entryId}`}, ${org.date}, ${org.periodId}, 'draft', 'document')
    `);
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, document_date, currency, status, custom)
      values (${documentId}, ${org.orgId}, 'customer_invoice', ${`INV-${documentId}`},
              ${org.date}, 'CAD', 'draft', '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into posting_effects
        (id, org_id, document_id, kind, entry_id, posting_date, actor_id,
         status, attempt_count, next_attempt_at)
      values (${effectId}, ${org.orgId}, ${documentId}, 'customer_invoice', ${entryId},
              ${org.date}, ${actorId}, 'failed', ${MAX_POSTING_EFFECTS_ATTEMPTS - 1},
              '2000-01-01T00:00:00Z')
    `);

    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const result = await processDuePostingEffects(terminalAt, 1, async () => {
      throw new Error("inventory projection remained inconsistent");
    });
    console.log = originalLog;
    assert.deepEqual(result, { processed: 1, succeeded: 0, failed: 1 });

    const failed = await listFailedPostingEffects(org.orgId);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.id, effectId);
    assert.equal(failed[0]!.status, "terminal_failed");
    assert.equal(failed[0]!.attemptCount, MAX_POSTING_EFFECTS_ATTEMPTS);
    assert.equal(failed[0]!.terminalFailureReason, "inventory projection remained inconsistent");
    assert.equal(new Date(failed[0]!.terminalFailedAt!).toISOString(), terminalAt.toISOString());
    assert.equal(failed[0]!.terminalFailedBy, POSTING_EFFECTS_WORKER_IDENTITY);
    assert.equal(
      logs.filter((line) => line.includes(TERMINAL_FAILURE_LOG_EVENT) && line.includes(effectId)).length,
      1,
      "the terminal transition emits exactly one operator signal",
    );

    const terminalAudit = await db.execute<{ event: string; reason: string }>(sql`
      select changes->>'event' as event, changes->'after'->>'reason' as reason
        from audit_log
       where org_id=${org.orgId} and table_name='posting_effects' and row_id=${effectId}
         and request_id='posting_effects_terminal_failure'
    `);
    assert.deepEqual(terminalAudit.rows, [{
      event: "posting_effects_terminal_failure",
      reason: "inventory projection remained inconsistent",
    }]);

    const replayAt = new Date("2026-07-20T13:00:00.000Z");
    await replayTerminalPostingEffect({
      orgId: org.orgId,
      id: effectId,
      actorId,
      reason: "Controller verified the inventory configuration and approved a deterministic replay.",
      now: replayAt,
    });
    assert.deepEqual(await listFailedPostingEffects(org.orgId), []);
    const replayed = await db.execute<{
      status: string;
      attempt_count: number;
      terminal_failure_reason: string | null;
    }>(sql`
      select status, attempt_count, terminal_failure_reason
        from posting_effects where id=${effectId} and org_id=${org.orgId}
    `);
    assert.deepEqual(replayed.rows, [{ status: "pending", attempt_count: 0, terminal_failure_reason: null }]);

    const replayAudit = await db.execute<{ event: string; actor_id: string; reason: string }>(sql`
      select changes->>'event' as event, actor_id, changes->>'reason' as reason
        from audit_log
       where org_id=${org.orgId} and table_name='posting_effects' and row_id=${effectId}
         and request_id='posting_effects_replay'
    `);
    assert.deepEqual(replayAudit.rows, [{
      event: "posting_effects_replay_authorized",
      actor_id: actorId,
      reason: "Controller verified the inventory configuration and approved a deterministic replay.",
    }]);

    const replayResult = await processDuePostingEffects(replayAt, 1, async () => {});
    assert.deepEqual(replayResult, { processed: 1, succeeded: 1, failed: 0 });
  } finally {
    console.log = originalLog;
    await dropScratchOrg(org.orgId);
  }
});
