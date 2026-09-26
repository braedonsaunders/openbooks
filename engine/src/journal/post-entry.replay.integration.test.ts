import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { postEntry } from "./post-entry.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "closed-period connector replay needs a live authorization row and cites it in audit",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Replay Grant Controller", "admin");
    const connectionId = randomUUID();
    const requestId = randomUUID();
    const tag = randomUUID().slice(0, 8);
    const replayPost = (tx: SqlExecutor, entryNumber: string) =>
      postEntry(tx, {
        orgId: org.orgId,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        entryNumber,
        postingDate: org.date,
        periodId: org.periodId,
        memo: `Connector replay of ${entryNumber}`,
        origin: "migration",
        currency: "CAD",
        actorId,
        requestId,
        closeModules: ["gl"],
        allowImportedLocks: true,
        lines: [
          { accountId: org.accounts.bank, amount: "-10" },
          { accountId: org.accounts.cogs, amount: "10" },
        ],
      });
    const replayAttempt = (entryNumber: string) =>
      withOrgContext(org.orgId, () => db.transaction(async (tx) => {
        await tx.execute(sql`
          select
            set_config('openbooks.connector_replay', 'on', true),
            set_config('openbooks.connector_replay_request', ${requestId}, true),
            set_config('openbooks.connector_replay_actor', ${actorId}, true)
        `);
        return replayPost(tx, entryNumber);
      }));
    const strayCount = async (entryNumber: string) =>
      (await withOrgContext(org.orgId, () => db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_entries
         where org_id = ${org.orgId} and entry_number = ${entryNumber}`))).rows[0]?.n ?? -1;
    try {
      await withBypassContext(() => db.execute(sql`
        insert into connections
          (id, org_id, source, display_name, status, config, mirror_enabled,
           mirror_schedule, posted_change_policy,
           posted_change_authorized_by, posted_change_authorized_at,
           created_by, updated_by)
        values (${connectionId}, ${org.orgId}, 'source_erp', 'Replay grant fixture',
          'active', '{}'::jsonb, true, 'daily', 'append_only_automatic',
          ${actorId}, now() - interval '1 minute', ${actorId}, ${actorId})`));
      await withBypassContext(() => db.execute(sql`
        insert into sync_runs (id, org_id, connection_id, source, kind, status, triggered_by)
        values (${requestId}, ${org.orgId}, ${connectionId}, 'source_erp', 'incremental', 'running', ${actorId})`));
      await withBypassContext(() => db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state,
           locked_at, locked_by, reason, created_by, updated_by)
        values (${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'gl', 'closed',
          now(), ${actorId}, 'Controller test close', ${actorId}, ${actorId})`));

      // No grant row: the flag alone refuses and leaves no draft behind.
      const refusedNumber = `REPLAY-NO-GRANT-${tag}`;
      await assert.rejects(
        replayAttempt(refusedNumber),
        /not covered by a replay authorization.*record a connector replay authorization/,
      );
      assert.equal(await strayCount(refusedNumber), 0);

      // An expired grant refuses with its own remedy, still posting nothing.
      const grantId = randomUUID();
      await withBypassContext(() => db.execute(sql`
        insert into connector_replay_authorizations
          (id, org_id, connection_id, authorized_by, authorized_at, expires_at,
           period_from_id, period_to_id, reason, created_by, updated_by)
        values (${grantId}, ${org.orgId}, ${connectionId}, ${actorId},
          now() - interval '2 minutes', now() - interval '1 minute',
          ${org.periodId}, ${org.periodId},
          'Upstream corrected its closed-period invoice', ${actorId}, ${actorId})`));
      const expiredNumber = `REPLAY-EXPIRED-${tag}`;
      await assert.rejects(replayAttempt(expiredNumber), /expired.*record a fresh authorization/);
      assert.equal(await strayCount(expiredNumber), 0);

      // A live grant admits the post and cites itself in the posting audit.
      await withBypassContext(() => db.execute(sql`
        update connector_replay_authorizations
           set expires_at = now() + interval '15 minutes'
         where id = ${grantId} and org_id = ${org.orgId}`));
      const admittedNumber = `REPLAY-ADMITTED-${tag}`;
      const posted = await replayAttempt(admittedNumber);
      const audit = (await withOrgContext(org.orgId, () => db.execute<{
        mode: string; authorization_id: string; connection_id: string; locks_preserved: boolean;
      }>(sql`
        select changes->'historicalReplay'->>'mode' as mode,
               changes->'historicalReplay'->>'authorizationId' as authorization_id,
               changes->'historicalReplay'->>'connectionId' as connection_id,
               (changes->'historicalReplay'->>'periodLocksPreserved')::boolean as locks_preserved
          from audit_log
         where org_id = ${org.orgId} and row_id = ${posted.entryId}`)));
      assert.deepEqual(audit.rows, [{
        mode: "authenticated_connector_historical_replay",
        authorization_id: grantId,
        connection_id: connectionId,
        locks_preserved: true,
      }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
