import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext, withOrgTransaction } from "./db.ts";
import { submitAndReleaseIfUngated } from "./flows/submit.ts";
import { postDocument } from "./posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Seed a balanced two-line draft journal and return its id. */
async function seedBalancedDraftJournal(
  org: ScratchOrg,
  documentNumber: string,
  createdBy: string,
): Promise<string> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id,
       document_date, currency, subtotal, tax_total, total, created_by)
    values (
      ${documentId}, ${org.orgId}, 'journal', 'draft', ${documentNumber},
      ${org.subsidiaryId}, ${org.date}, 'CAD', '10', '0', '10', ${createdBy}
    )
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, subsidiary_id,
       amount, quantity, unit_price, tax_amount, tax_input_amount)
    values
      (${org.orgId}, ${documentId}, 1, ${org.accounts.bank}, ${org.subsidiaryId},
       '10', '1', '10', '0', '10'),
      (${org.orgId}, ${documentId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId},
       '-10', '1', '-10', '0', '-10')
  `);
  return documentId;
}

function postingControlDeps(org: { accounts: { ar: string; ap: string; bank: string } }) {
  return {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  };
}

test(
  "a failed draft journal post rolls its approval release back atomically",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Journal poster", "admin"),
      );
      const documentId = randomUUID();
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, status, document_number, subsidiary_id,
             document_date, currency, subtotal, tax_total, total, created_by)
          values (
            ${documentId}, ${org.orgId}, 'journal', 'draft', 'JE-ATOMIC-1',
            ${org.subsidiaryId}, ${org.date}, 'CAD', '10', '0', '10', ${actorId}
          )
        `);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, subsidiary_id,
             amount, quantity, unit_price, tax_amount, tax_input_amount)
          values
            (${org.orgId}, ${documentId}, 1, ${org.accounts.bank}, ${org.subsidiaryId},
             '10', '1', '10', '0', '10'),
            (${org.orgId}, ${documentId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId},
             '-10', '1', '-10', '0', '-10')
        `);
        await db.execute(sql`
          insert into period_locks
            (org_id, period_id, book_id, subsidiary_id, module, state,
             locked_at, locked_by, reason, created_by, updated_by)
          values (
            ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId},
            'gl', 'closed', now(), ${actorId}, 'Atomic post regression',
            ${actorId}, ${actorId}
          )
        `);
      });

      await assert.rejects(
        withOrgTransaction(org.orgId, async () => {
          const released = await submitAndReleaseIfUngated(
            "journal",
            documentId,
            actorId,
          );
          assert.equal(released.autoApproved, true);
          await postDocument(
            documentId,
            {
              control: {
                ar: org.accounts.ar,
                ap: org.accounts.ap,
                bank: org.accounts.bank,
              },
            },
            { deferEffects: true },
          );
        }),
        /period .*closed|closed.*period/i,
      );

      const state = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
            status: string;
            submitted_at: string | null;
            posted_entry_id: string | null;
            entry_count: number;
          }>(sql`
          select status, submitted_at, posted_entry_id,
                 (select count(*)::int from journal_entries
                    where source_document_id = ${documentId}) as entry_count
            from documents where id = ${documentId}
        `)),
      );
      assert.deepEqual(state.rows[0], {
        status: "draft",
        submitted_at: null,
        posted_entry_id: null,
        entry_count: 0,
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

/**
 * Atomic script effects. A before_post script runs inside whatever database
 * transaction the caller owns (the same boundary that makes flows and effect
 * claims atomic), so its whitelisted header mutation and its script_runs
 * evidence commit with the posting — or roll back with it. A failed post can
 * never leave a half-applied scripted mutation behind on an unposted
 * document.
 */
test("before_post script effects are atomic with the posting transaction", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() =>
      createScratchUser(org.orgId, "Journal poster", "admin"),
    );
    // Enable tenant scripting and register one before_post mutation script.
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features,scripts}', 'true')
         where id = ${org.orgId}
      `);
      await db.execute(sql`
        insert into user_scripts
          (org_id, name, trigger_point, document_kind, source, timeout_ms, sort_order, is_active)
        values (
          ${org.orgId}, 'stamp memo', 'before_post', 'journal',
          ${'function main(ctx) { return { set: { memo: "scripted-memo" } }; }'},
          2000, 100, true
        )
      `);
    });

    // Rollback side: the script runs, then the post fails on a closed period.
    const failingDoc = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-SCRIPT-RB", actorId),
    );
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state,
           locked_at, locked_by, reason, created_by, updated_by)
        values (
          ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId},
          'gl', 'closed', now(), ${actorId}, 'Script atomicity rollback probe',
          ${actorId}, ${actorId}
        )
      `);
    });
    await assert.rejects(
      withOrgTransaction(org.orgId, async () => {
        await submitAndReleaseIfUngated("journal", failingDoc, actorId);
        await postDocument(failingDoc, postingControlDeps(org), { deferEffects: true });
      }),
      /period .*closed|closed.*period/i,
    );
    const rolledBack = await withOrgContext(org.orgId, async () =>
      (await db.execute<{ memo: string | null; script_runs: number }>(sql`
        select d.memo,
               (select count(*)::int from script_runs r
                 where r.target_id = ${failingDoc}) as script_runs
          from documents d where d.id = ${failingDoc}
      `)),
    );
    assert.deepEqual(rolledBack.rows[0], {
      memo: null,
      script_runs: 0,
    }, "the failed post must not leave the script mutation or its evidence behind");

    // Reopen the period so the commit side can post.
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`
        delete from period_locks
         where org_id = ${org.orgId} and reason = 'Script atomicity rollback probe'
      `);
    });

    // Commit side: the same script commits its mutation WITH the posting.
    const okDoc = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-SCRIPT-OK", actorId),
    );
    await withOrgTransaction(org.orgId, async () => {
      await submitAndReleaseIfUngated("journal", okDoc, actorId);
      await postDocument(okDoc, postingControlDeps(org), { deferEffects: true });
    });
    const committed = await withOrgContext(org.orgId, async () =>
      (await db.execute<{ memo: string | null; status: string; script_runs: number }>(sql`
        select d.memo, d.status,
               (select count(*)::int from script_runs r
                 where r.target_id = ${okDoc}) as script_runs
          from documents d where d.id = ${okDoc}
      `)),
    );
    assert.deepEqual(committed.rows[0], {
      memo: "scripted-memo",
      status: "posted",
      script_runs: 1,
    }, "a committed post carries the script mutation and its evidence");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
