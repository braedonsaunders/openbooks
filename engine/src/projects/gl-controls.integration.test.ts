import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { setPeriodLockState } from "../close/period-locks.ts";
import { db } from "../platform/db.ts";
import {
  postProjectGlEntry,
  reverseProjectGlEntry,
} from "./recognition.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (pattern.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

test(
  "project GL posting and reversal require an open period, actor, reason, and exact permanent mirror",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state, reason)
        values
          (${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId},
           'gl', 'closed', 'Project GL control test')
      `);
      const post = () =>
        postProjectGlEntry({
          orgId: org.orgId,
          actorId,
          origin: "manual",
          entryNumber: "PROJECT-CONTROL-001",
          postingDate: org.date,
          memo: "Project control test",
          subsidiaryId: org.subsidiaryId,
          currency: "CAD",
          lines: [
            {
              accountId: org.accounts.adjustment,
              amount: "10",
            },
            {
              accountId: org.accounts.clearing,
              amount: "-10",
            },
          ],
        });
      await assert.rejects(post(), (error) =>
        errorChainMatches(error, /GL period .* is closed/),
      );

      await db.execute(sql`
        update period_locks
           set state = 'open', reopen_expires_at = now() + interval '1 hour'
         where org_id = ${org.orgId}
           and period_id = ${org.periodId}
           and book_id = ${org.bookId}
           and subsidiary_id = ${org.subsidiaryId}
           and module = 'gl'
      `);
      const sourceId = await post();
      assert.ok(sourceId);

      await assert.rejects(
        reverseProjectGlEntry(
          org.orgId,
          actorId,
          sourceId,
          "bad",
          org.date,
        ),
        /reversal reason/,
      );
      await db.execute(sql`
        update period_locks
           set state = 'closed', reopen_expires_at = null
         where org_id = ${org.orgId}
           and period_id = ${org.periodId}
           and book_id = ${org.bookId}
           and subsidiary_id = ${org.subsidiaryId}
           and module = 'gl'
      `);
      await assert.rejects(
        reverseProjectGlEntry(
          org.orgId,
          actorId,
          sourceId,
          "Controller approved project correction",
          org.date,
        ),
        (error) => errorChainMatches(error, /GL period .* is closed/),
      );

      await db.execute(sql`
        update period_locks
           set state = 'open', reopen_expires_at = now() + interval '1 hour'
         where org_id = ${org.orgId}
           and period_id = ${org.periodId}
           and book_id = ${org.bookId}
           and subsidiary_id = ${org.subsidiaryId}
           and module = 'gl'
      `);
      const reversalId = await reverseProjectGlEntry(
        org.orgId,
        actorId,
        sourceId,
        "Controller approved project correction",
        org.date,
      );
      assert.ok(reversalId);
      const lineage = (await db.execute<{
          source_status: string;
          reversal_status: string;
          reverses_entry_id: string;
          audit_events: number;
          exact_lines: number;
          source_lines: number;
        }>(sql`
        select source.status as source_status,
               reversal.status as reversal_status,
               reversal.reverses_entry_id,
               (
                 select count(*)::int
                   from audit_log
                  where org_id = ${org.orgId}
                    and table_name = 'journal_entries'
                    and row_id in (${sourceId}, ${reversalId})
                    and request_id in ('project_gl_post', 'project_gl_reversal')
               ) as audit_events,
               (
                 select count(*)::int
                   from journal_lines source_line
                   join journal_lines reversal_line
                     on reversal_line.entry_id = ${reversalId}
                    and reversal_line.line_number = source_line.line_number
                    and reversal_line.account_id = source_line.account_id
                    and reversal_line.amount = -source_line.amount
                    and reversal_line.txn_amount = -source_line.txn_amount
                  where source_line.entry_id = ${sourceId}
               ) as exact_lines,
               (
                 select count(*)::int
                   from journal_lines
                  where entry_id = ${sourceId}
               ) as source_lines
          from journal_entries source
          join journal_entries reversal on reversal.id = ${reversalId}
         where source.id = ${sourceId}
      `));
      assert.deepEqual(lineage.rows[0], {
        source_status: "reversed",
        reversal_status: "posted",
        reverses_entry_id: sourceId,
        audit_events: 2,
        exact_lines: 2,
        source_lines: 2,
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

for (const mode of ["secondary posting", "secondary forecast", "primary forecast"] as const) {
  test(`project GL refuses implicit ${mode} book selection`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const alternate = randomUUID();
      await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
        values(${alternate},${org.orgId},'AAA-ALTERNATE','Alternate book',false,true,${mode !== "secondary forecast"})`);
      await db.execute(sql`update accounting_books set is_active=${mode === "primary forecast"},posts_gl=${mode !== "primary forecast"}
        where org_id=${org.orgId} and id=${org.bookId}`);
      const post = () => postProjectGlEntry({
        orgId: org.orgId, actorId, origin: "manual", entryNumber: "PROJECT-BOOK-POLICY",
        postingDate: org.date, memo: "Project book policy", subsidiaryId: org.subsidiaryId,
        currency: "CAD", lines: [
          { accountId: org.accounts.adjustment, amount: "10" },
          { accountId: org.accounts.clearing, amount: "-10" },
        ],
      });
      await assert.rejects(post, /no active primary GL book/);
      const count = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_entries where org_id=${org.orgId}`)).rows[0]!.n;
      assert.equal(count, 0);
      await db.execute(sql`update accounting_books set is_active=true,posts_gl=true where org_id=${org.orgId} and id=${org.bookId}`);
      const id = await post();
      const entry = (await db.execute<{ book_id: string }>(sql`
        select book_id from journal_entries where org_id=${org.orgId} and id=${id}`)).rows[0]!;
      assert.equal(entry.book_id, org.bookId, "the explicit primary wins over the earlier-sorting alternate");
    } finally { await dropScratchOrg(org.orgId); }
  });
}

for (const policy of ["account", "project"] as const) {
  test(`project GL enforces ${policy} legal-entity restrictions`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const branchId = randomUUID(), projectId = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${branchId},${org.orgId},${org.subsidiaryId},'Project branch','CAD','CA')`);
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
        values(${projectId},${org.orgId},${policy === "project" ? branchId : org.subsidiaryId},'PROJECT-SCOPE',
               'Project scope',${org.customerId},'active',true,'{}'::jsonb)`);
      if (policy === "account") await db.execute(sql`update accounts set subsidiary_id=${branchId},subsidiary_include_children=false
        where org_id=${org.orgId} and id=${org.accounts.adjustment}`);
      const post = (subsidiaryId: string) => postProjectGlEntry({
        orgId: org.orgId, actorId, origin: "manual", entryNumber: "PROJECT-ENTITY-POLICY",
        postingDate: org.date, memo: "Project entity policy", subsidiaryId, currency: "CAD",
        lines: [
          { accountId: org.accounts.adjustment, amount: "10", projectId },
          { accountId: org.accounts.clearing, amount: "-10" },
        ],
      });
      await assert.rejects(post(org.subsidiaryId), /restricted to another subsidiary/);
      const count = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_entries where org_id=${org.orgId}`)).rows[0]!.n;
      assert.equal(count, 0);
      await db.execute(sql`update accounts set subsidiary_id=${org.subsidiaryId},subsidiary_include_children=true
        where org_id=${org.orgId} and id=${org.accounts.adjustment}`);
      await db.execute(sql`update projects set subsidiary_id=${org.subsidiaryId},subsidiary_include_children=true
        where org_id=${org.orgId} and id=${projectId}`);
      assert.ok(await post(branchId), "valid parent-to-child configuration remains usable");
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test(
  "project GL refuses impossible calendar dates at the domain boundary",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const entry = (postingDate: string) => postProjectGlEntry({
        orgId: org.orgId, actorId, origin: "manual", entryNumber: "PROJECT-DATE-CONTROL",
        postingDate, memo: "Project date control", subsidiaryId: org.subsidiaryId,
        currency: "CAD", lines: [
          { accountId: org.accounts.adjustment, amount: "10" },
          { accountId: org.accounts.clearing, amount: "-10" },
        ],
      });
      // February 30 passes a naive Date.parse guard (V8 rolls it into
      // March) but is not a calendar day: it must fail closed here, before
      // any journal row exists, not as a 22008 from PostgreSQL.
      await assert.rejects(entry("2026-02-30"), /postingDate must be a valid YYYY-MM-DD date/);
      const posted = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_entries where org_id=${org.orgId}`)).rows[0]!.n;
      assert.equal(posted, 0);
      const sourceId = await entry(org.date);
      assert.ok(sourceId);
      await assert.rejects(
        reverseProjectGlEntry(org.orgId, actorId, sourceId, "Controller approved project correction", "2026-02-30"),
        /reversalDate must be a valid YYYY-MM-DD date/,
      );
      const status = (await db.execute<{ status: string }>(sql`
        select status from journal_entries where org_id=${org.orgId} and id=${sourceId}`)).rows[0]!.status;
      assert.equal(status, "posted");
      const reversalId = await reverseProjectGlEntry(org.orgId, actorId, sourceId, "Controller approved project correction", org.date);
      assert.ok(reversalId, "a real calendar date still reverses");
    } finally { await dropScratchOrg(org.orgId); }
  },
);

/**
 * One period gate for project GL (fleet 8, P7): postProjectGlEntry and its
 * reversal route through assertPeriodModulesOpen instead of raw
 * period_module_is_closed SQL. Policy is preserved — project journals and
 * their reversals are new local activity, not historical replay, so a
 * source-owned imported lock refuses exactly like a user lock. Each path
 * below pins both lock flavors.
 */

const IMPORTED_REASON = "close.importedPeriodLockReason";

/** User-owned close, through the same lock writer the close flow uses. */
async function closeGlForUser(org: ScratchOrg, actorId: string): Promise<void> {
  await setPeriodLockState({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    module: "gl",
    state: "closed",
    actorId,
    reason: "fleet8 f2: user-owned GL close",
  });
}

/**
 * Source-owned close, mirroring exactly what the migration mirror lands
 * (engine/src/sync/migrate.ts): every module locked with the imported reason.
 */
async function closeAllImported(org: ScratchOrg): Promise<void> {
  for (const module of ["ar", "ap", "banking", "assets", "tax", "gl"] as const) {
    await db.execute(sql`
      insert into period_locks
        (org_id, period_id, book_id, module, state, locked_at, reason)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${module},
              'closed', now(), ${IMPORTED_REASON})
      on conflict (org_id, period_id, book_id, subsidiary_id, module)
      do update set state = excluded.state,
        locked_at = excluded.locked_at,
        reason = excluded.reason,
        reopen_expires_at = null,
        version = period_locks.version + 1,
        updated_at = now()`);
  }
}

async function journalCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}`));
  return r.rows[0]!.n;
}

function postArgs(
  org: ScratchOrg,
  actorId: string,
  entryNumber: string,
): Parameters<typeof postProjectGlEntry>[0] {
  return {
    orgId: org.orgId,
    actorId,
    origin: "manual",
    entryNumber,
    postingDate: org.date,
    memo: "Gate probe project journal",
    subsidiaryId: org.subsidiaryId,
    currency: "CAD",
    lines: [
      { accountId: org.accounts.adjustment, amount: "10" },
      { accountId: org.accounts.clearing, amount: "-10" },
    ],
  };
}

test("open period: project GL still posts (setup can post, refusal is load-bearing)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const entryId = await postProjectGlEntry(postArgs(org, actorId, "F2-PROJ-OPEN"));
    assert.ok(entryId, "expected a posted entry id");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project GL posting refuses a user-closed period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await closeGlForUser(org, actorId);
    const before = await journalCount(org.orgId);
    await assert.rejects(
      postProjectGlEntry(postArgs(org, actorId, "F2-PROJ-USER")),
      /the GL period covering .* is closed/,
      "a project journal into a user-closed period must be refused",
    );
    assert.equal(await journalCount(org.orgId), before, "refused posting left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project GL posting refuses a source-owned imported lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await closeAllImported(org);
    const before = await journalCount(org.orgId);
    await assert.rejects(
      postProjectGlEntry(postArgs(org, actorId, "F2-PROJ-IMPORTED")),
      /the GL period covering .* is closed/,
      "a project journal into an imported lock must be refused: it is new activity, not replay",
    );
    assert.equal(await journalCount(org.orgId), before, "refused posting left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project GL reversal refuses a user-closed period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const entryId = await postProjectGlEntry(postArgs(org, actorId, "F2-PROJ-REV-USER"));
    assert.ok(entryId);
    await closeGlForUser(org, actorId);
    await assert.rejects(
      reverseProjectGlEntry(org.orgId, actorId, entryId!, "Gate probe reversal of a closed-period entry", org.date),
      /the GL period covering .* is closed/,
      "a reversal into a user-closed period must be refused",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project GL reversal refuses a source-owned imported lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const entryId = await postProjectGlEntry(postArgs(org, actorId, "F2-PROJ-REV-IMPORTED"));
    assert.ok(entryId);
    await closeAllImported(org);
    await assert.rejects(
      reverseProjectGlEntry(org.orgId, actorId, entryId!, "Gate probe reversal into an imported lock", org.date),
      /the GL period covering .* is closed/,
      "a reversal into an imported lock must be refused: reversals are not replay",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project GL reversal preserves original FX and complete line evidence", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Reversal evidence", "admin");
    const entryId = randomUUID();
    await db.transaction(async (tx) => {
      const segmentId = randomUUID(), valueId = randomUUID();
      await tx.execute(sql`insert into segment_definitions(id,org_id,key,name,plural_name)
        values(${segmentId},${org.orgId},'cost_pool','Cost pool','Cost pools')`);
      await tx.execute(sql`insert into segment_values(id,org_id,segment_id,name)
        values(${valueId},${org.orgId},${segmentId},'North')`);
      await tx.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,
        posting_date,period_id,status,origin,created_by,updated_by)
        values(${entryId},${org.orgId},${org.bookId},${org.subsidiaryId},'PROJECT-FX-MIRROR',
          ${org.date},${org.periodId},'draft','manual',${actor},${actor})`);
      await tx.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,
        amount,currency,txn_amount,fx_rate,location_id,party_id,quantity,unit,custom,extra_dims,memo)
        values
        (${org.orgId},${entryId},3,${org.accounts.adjustment},${org.subsidiaryId},
          125,'USD',100,1.25,${org.locationId},${org.vendorId},2.5,'hours',
          '{"evidence":"original-cost"}'::jsonb,${JSON.stringify({ cost_pool: valueId })}::jsonb,'Original evidence'),
        (${org.orgId},${entryId},7,${org.accounts.bank},${org.subsidiaryId},
          -125,'USD',-100,1.25,null,null,null,null,'{}'::jsonb,'{}'::jsonb,'Cash funding')`);
      await tx.execute(sql`update journal_entries set status='posted',posted_at=now(),posted_by=${actor}
        where org_id=${org.orgId} and id=${entryId}`);
    });
    const reversalId = await reverseProjectGlEntry(org.orgId, actor, entryId, "Correct entire original evidence", org.date);
    assert.ok(reversalId);
    const evidence = (await db.execute<{ exact: number; count: number }>(sql`
      select count(*)::int as count,count(*) filter(where
        r.amount=-s.amount and r.txn_amount=-s.txn_amount
        and r.quantity is not distinct from -s.quantity
        and (to_jsonb(r)-array['id','entry_id','amount','txn_amount','quantity']::text[])
          =(to_jsonb(s)-array['id','entry_id','amount','txn_amount','quantity']::text[]))::int as exact
      from journal_lines s join journal_lines r on r.org_id=s.org_id and r.line_number=s.line_number
        and r.entry_id=${reversalId}
      where s.org_id=${org.orgId} and s.entry_id=${entryId}`)).rows[0]!;
    assert.deepEqual(evidence, { count: 2, exact: 2 });
    const again = await reverseProjectGlEntry(org.orgId, actor, entryId, "Repeat same controlled reversal", org.date);
    assert.equal(again, null);
    const totals = (await db.execute<{ amount: string; txn: string; quantity: string }>(sql`
      select sum(amount)::text as amount,sum(txn_amount)::text as txn,sum(quantity)::text as quantity
      from journal_lines where org_id=${org.orgId} and entry_id in(${entryId},${reversalId})
        and location_id=${org.locationId}`)).rows[0]!;
    assert.deepEqual(totals, { amount: "0.0000", txn: "0.0000", quantity: "0.0000" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

