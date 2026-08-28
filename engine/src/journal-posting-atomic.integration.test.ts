import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext, withOrgTransaction } from "./db.ts";
import { toUnits } from "./money.ts";
import { submitAndReleaseIfUngated } from "./flows/submit.ts";
import { postDocument } from "./posting.ts";
import {
  mergeBeforePostCustomMutation,
  runBulkScript,
  runScheduledScript,
  runScript,
} from "./scripting.ts";
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

test("before_post custom mutations reject posting controls but preserve safe metadata", async () => {
  const ctx = {
    trigger: "before_post",
    document: { custom: { controlAccountId: "approved-control", note: "original" } },
    org: { id: "org", name: "Test org", baseCurrency: "CAD" },
  };
  const protectedResult = await runScript(
    `function main(ctx) { return { set: { custom: { controlAccountId: "attacker-control" } } }; }`,
    ctx,
    2_000,
  );
  assert.equal(protectedResult.status, "error");
  assert.match(protectedResult.abortReason ?? "", /protected posting custom field/);

  const safeResult = await runScript(
    `function main(ctx) { return { set: { custom: { note: "reviewed", source: "script" } } }; }`,
    ctx,
    2_000,
  );
  assert.equal(safeResult.status, "ok");
  assert.deepEqual(safeResult.set?.custom, { note: "reviewed", source: "script" });
  assert.deepEqual(
    mergeBeforePostCustomMutation(ctx.document.custom, safeResult.set?.custom),
    {
      controlAccountId: "approved-control",
      note: "reviewed",
      source: "script",
    },
  );
});

test(
  "queued scheduled and bulk jobs re-check active trigger state before execution",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const scheduledId = randomUUID();
      const bulkId = randomUUID();
      const source = "function main(ctx) { throw new Error('stale source executed'); }";
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{features,scripts}', 'true'::jsonb)
           where id = ${org.orgId}
        `);
        await db.execute(sql`
          insert into user_scripts
            (id, org_id, name, trigger_point, cron, source, timeout_ms, is_active)
          values
            (${scheduledId}, ${org.orgId}, 'disabled scheduled', 'scheduled', '* * * * *', ${source}, 2000, false),
            (${bulkId}, ${org.orgId}, 'disabled bulk', 'bulk', null, ${source}, 2000, false)
        `);
      });

      await assert.rejects(
        withOrgContext(org.orgId, () => runScheduledScript(scheduledId, org.orgId)),
        /script not found/,
      );
      await assert.rejects(
        withOrgContext(org.orgId, () => runBulkScript(bulkId, org.orgId)),
        /script not found/,
      );

      // A queued payload can also outlive an administrator changing its kind;
      // the pickup query must not execute it under the stale dispatch kind.
      await withOrgContext(org.orgId, () =>
        db.execute(sql`
          update user_scripts
             set is_active = true, trigger_point = 'bulk'
           where id = ${scheduledId} and org_id = ${org.orgId}
        `),
      );
      await assert.rejects(
        withOrgContext(org.orgId, () => runScheduledScript(scheduledId, org.orgId)),
        /script not found/,
      );
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

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

test(
  "an approved document cannot have its posting control rewritten by before_post",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Control poster", "admin"),
      );
      const documentId = randomUUID();
      const scriptId = randomUUID();
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{features,scripts}', 'true'::jsonb)
           where id = ${org.orgId}
        `);
        await db.execute(sql`
          insert into user_scripts
            (id, org_id, name, trigger_point, document_kind, source, timeout_ms, sort_order, is_active)
          values (
            ${scriptId}, ${org.orgId}, 'rewrite control', 'before_post', 'customer_invoice',
            ${'function main(ctx) { return { set: { custom: { controlAccountId: "' + org.accounts.bank + '" } } }; }'},
            2000, 100, true
          )
        `);
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, status, document_number, subsidiary_id, party_id,
             document_date, posting_date, currency, subtotal, tax_total, total,
             custom, created_by)
          values (
            ${documentId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-SCRIPT-CONTROL',
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date}, 'CAD',
            '10', '0', '10',
            ${JSON.stringify({ controlAccountId: org.accounts.ar, marker: "original" })}::jsonb,
            ${actorId}
          )
        `);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, subsidiary_id,
             amount, quantity, unit_price, tax_amount, tax_input_amount)
          values
            (${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, ${org.subsidiaryId},
             '10', '1', '10', '0', '10')
        `);
        await db.execute(sql`
          update documents
             set status = 'approved'
           where id = ${documentId} and org_id = ${org.orgId}
        `);
      });

      await assert.rejects(
        withOrgTransaction(org.orgId, () =>
          postDocument(documentId, postingControlDeps(org), { deferEffects: true }),
        ),
        /protected posting custom field/,
      );
      const state = await withOrgContext(org.orgId, () =>
        db.execute<{ status: string; custom: Record<string, unknown>; entryCount: number }>(sql`
          select status, custom,
                 (select count(*)::int from journal_entries
                   where source_document_id = ${documentId}) as "entryCount"
            from documents
           where id = ${documentId} and org_id = ${org.orgId}
        `),
      );
      assert.deepEqual(state.rows[0], {
        status: "approved",
        custom: { controlAccountId: org.accounts.ar, marker: "original" },
        entryCount: 0,
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

/**
 * Regression: a multi-line foreign-currency document could never post.
 * applySubsidiaries converts each line independently — mulRate rounds every
 * line to four decimals on its own — so a balanced EUR entry whose exact
 * conversions sum to zero still rounds to lines that miss zero by a
 * ten-thousandth, and an ordinary single-subsidiary document injects no
 * intercompany legs to absorb it. assertFinalKernelBalance therefore rejected
 * the entry before any ledger write, blocking the whole multi-currency
 * deployment class. The kernel now folds that per-line rounding residual onto
 * the final line of the origin subsidiary (the same convention the intercompany
 * balancer applies to its own due-to/from legs), so the committed entry
 * balances exactly while every transaction-currency amount, rate and currency
 * rides untouched — and the adjustment is a pure function of the ordered
 * lines, so regeneration reproduces it and reversals negate it exactly.
 */
test(
  "a multi-line EUR journal whose per-line conversions round apart posts balanced",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "FX poster", "admin"),
      );
      // 100 + 100 − 200 EUR converts to exactly zero, but per-line half-up
      // rounding at 0.3333333333 yields 33.3333 + 33.3333 − 66.6667 = −0.0001.
      const documentId = randomUUID();
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, status, document_number, subsidiary_id,
             document_date, posting_date, currency, fx_rate, subtotal,
             tax_total, total, created_by)
          values (
            ${documentId}, ${org.orgId}, 'journal', 'draft', 'JE-FX-RESIDUAL',
            ${org.subsidiaryId}, ${org.date}, ${org.date}, 'EUR',
            '0.3333333333', '200', '0', '200', ${actorId}
          )
        `);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, description,
             amount, quantity, unit_price, tax_amount)
          values
            (${org.orgId}, ${documentId}, 1, ${org.accounts.bank},
             'EUR debit one', '100', '1', '100', '0'),
            (${org.orgId}, ${documentId}, 2, ${org.accounts.cogs},
             'EUR debit two', '100', '1', '100', '0'),
            (${org.orgId}, ${documentId}, 3, ${org.accounts.revenue},
             'EUR credit', '-200', '1', '-200', '0')
        `);
        await db.execute(sql`
          update documents
             set status = 'approved', submitted_by = ${actorId}, submitted_at = now()
           where id = ${documentId} and org_id = ${org.orgId}
        `);
      });

      const entryId = await withOrgTransaction(org.orgId, async () =>
        postDocument(documentId, postingControlDeps(org), { deferEffects: true }),
      );

      const lines = await withOrgContext(org.orgId, () =>
        db.execute<{
          amount: string;
          txn_amount: string;
          fx_rate: string;
          currency: string;
          subsidiary_id: string;
        }>(sql`
          select amount::text as amount, txn_amount::text as txn_amount,
                 fx_rate::text as fx_rate, currency,
                 subsidiary_id::text as subsidiary_id
            from journal_lines
           where org_id = ${org.orgId} and entry_id = ${entryId}
           order by line_number
        `),
      );
      // The final line absorbed the −0.0001 residual; nothing else moved.
      assert.deepEqual(
        lines.rows.map((l) => l.amount),
        ["33.3333", "33.3333", "-66.6666"],
      );
      assert.equal(
        lines.rows.reduce((acc, l) => acc + toUnits(l.amount), 0n),
        0n,
        "the committed entry must balance to the ten-thousandth",
      );
      // The transaction-currency economics are untouched by the absorption.
      assert.deepEqual(
        lines.rows.map((l) => l.txn_amount),
        ["100.0000", "100.0000", "-200.0000"],
      );
      assert.deepEqual(lines.rows.map((l) => l.fx_rate), [
        "0.3333333333",
        "0.3333333333",
        "0.3333333333",
      ]);
      assert.deepEqual([...new Set(lines.rows.map((l) => l.currency))], ["EUR"]);
      assert.deepEqual(
        [...new Set(lines.rows.map((l) => l.subsidiary_id))],
        [org.subsidiaryId],
      );
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

/**
 * Control for the FX-residual absorption: when every line converts exactly
 * there is no residual, so the stored functional amounts are the pure per-line
 * conversions and nothing is adjusted.
 */
test(
  "an exact-rate foreign-currency journal posts with untouched per-line conversions",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "FX poster", "admin"),
      );
      const documentId = randomUUID();
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, status, document_number, subsidiary_id,
             document_date, posting_date, currency, fx_rate, subtotal,
             tax_total, total, created_by)
          values (
            ${documentId}, ${org.orgId}, 'journal', 'draft', 'JE-FX-EXACT',
            ${org.subsidiaryId}, ${org.date}, ${org.date}, 'EUR',
            '1.2500000000', '150', '0', '150', ${actorId}
          )
        `);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, description,
             amount, quantity, unit_price, tax_amount)
          values
            (${org.orgId}, ${documentId}, 1, ${org.accounts.bank},
             'EUR debit one', '100', '1', '100', '0'),
            (${org.orgId}, ${documentId}, 2, ${org.accounts.cogs},
             'EUR debit two', '50', '1', '50', '0'),
            (${org.orgId}, ${documentId}, 3, ${org.accounts.revenue},
             'EUR credit', '-150', '1', '-150', '0')
        `);
        await db.execute(sql`
          update documents
             set status = 'approved', submitted_by = ${actorId}, submitted_at = now()
           where id = ${documentId} and org_id = ${org.orgId}
        `);
      });

      const entryId = await withOrgTransaction(org.orgId, async () =>
        postDocument(documentId, postingControlDeps(org), { deferEffects: true }),
      );

      const lines = await withOrgContext(org.orgId, () =>
        db.execute<{ amount: string; txn_amount: string }>(sql`
          select amount::text as amount, txn_amount::text as txn_amount
            from journal_lines
           where org_id = ${org.orgId} and entry_id = ${entryId}
           order by line_number
        `),
      );
      assert.deepEqual(
        lines.rows.map((l) => l.amount),
        ["125.0000", "62.5000", "-187.5000"],
      );
      assert.deepEqual(
        lines.rows.map((l) => l.txn_amount),
        ["100.0000", "50.0000", "-150.0000"],
      );
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
