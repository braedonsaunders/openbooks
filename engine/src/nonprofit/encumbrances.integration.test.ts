import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../composition/install.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { clearBalancingLegProviders, registerBalancingLegProvider } from "../journal/balancing-hooks.ts";
import { postEntry, type PostEntryInput } from "../journal/post-entry.ts";
import { reverseProjectGlEntry } from "../journal/origin-entry.ts";
import { db, withBypass, withBypassContext, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { budgetaryControlProvider, budgetaryControlWarnings, closeEncumbrance, createEncumbrance, encumbranceOpenBalance, linkEncumbranceDocumentLine, readBudgetCellFigures } from "./encumbrances.ts";
import { NonprofitError, NonprofitPostingError } from "./errors.ts";
import { provisionFundAccounting } from "./provision.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function posting(org: ScratchOrg & { fundId: string }, entryNumber: string, amount: string, bookId = org.bookId): PostEntryInput {
  const fund = org.fundId;
  return {
    orgId: org.orgId, bookId, subsidiaryId: org.subsidiaryId, entryNumber,
    postingDate: org.date, periodId: org.periodId, origin: "manual", currency: "CAD",
    lines: [
      { accountId: org.accounts.cogs, amount, subsidiaryId: org.subsidiaryId, currency: "CAD", extraDims: { fund } },
      { accountId: org.accounts.bank, amount: "-" + amount, subsidiaryId: org.subsidiaryId, currency: "CAD", extraDims: { fund } },
    ],
  };
}

async function tenantPost(input: PostEntryInput, replay = false, requestId?: string, actorId?: string) {
  return withOrgContext(input.orgId, () => db.transaction(async (tx) => {
    if (replay) {
      await tx.execute(sql`
        select set_config('openbooks.connector_replay', 'on', true),
               set_config('openbooks.connector_replay_request', ${requestId!}, true),
               set_config('openbooks.connector_replay_actor', ${actorId!}, true)
      `);
    }
    return postEntry(tx, input);
  }));
}

async function seedBudget(org: ScratchOrg & { fundId: string }, actorId: string, amount: string): Promise<string> {
  const scenarioId = randomUUID();
  const year = (await withOrgContext(org.orgId, () => db.execute<{ fiscalYear: number }>(sql`
    select fiscal_year as "fiscalYear" from accounting_periods
     where org_id = ${org.orgId} and id = ${org.periodId}
  `))).rows[0]!.fiscalYear;
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into budget_scenarios
        (id, org_id, book_id, fiscal_year, name, kind, status, created_by, updated_by)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, ${year}, 'Annual operating plan',
        'budget', 'draft', ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into budget_lines
        (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, extra_dims, created_by, updated_by)
      values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId},
        ${org.subsidiaryId}, ${amount}, ${JSON.stringify({ fund: org.fundId })}::jsonb, ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into budget_lines
        (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, extra_dims, created_by, updated_by)
      values (${org.orgId}, ${scenarioId}, ${org.accounts.adjustment}, ${org.periodId},
        ${org.subsidiaryId}, '100.0000', ${JSON.stringify({ fund: org.fundId })}::jsonb, ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      update budget_scenarios set status = 'pending_approval', revision = revision + 1,
             submitted_at = now(), submitted_by = ${actorId}
       where id = ${scenarioId} and org_id = ${org.orgId}
    `);
    await db.execute(sql`
      update budget_scenarios set status = 'approved', revision = revision + 1,
             approved_at = now(), approved_by = ${actorId}
       where id = ${scenarioId} and org_id = ${org.orgId}
    `);
  });
  return scenarioId;
}

test("commitments and budget control preserve posting policy and derived balances", { skip: !DB }, async () => {
  const scratch = await withBypass(() => createScratchOrg());
  const org = scratch as ScratchOrg & { fundId: string };
  clearBalancingLegProviders();
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Budget Controller", "admin"));
    await assert.rejects(
      createEncumbrance({
        orgId: org.orgId, accountId: org.accounts.cogs, subsidiaryId: org.subsidiaryId,
        sourceKind: "manual", amount: "10.0000",
      }),
      (error) => error instanceof NonprofitError && error.code === "feature_off" &&
        error.message.includes("encumbrances") && error.remedy.includes("Company Settings → Features"),
    );
    await withOrgContext(org.orgId, async () => {
      const changed = await db.execute<{ id: string }>(sql`
        update orgs set settings = jsonb_set(
          coalesce(settings, '{}'::jsonb), '{features}',
          coalesce(settings->'features', '{}'::jsonb) ||
            '{"nonprofit":true,"fundAccounting":true,"budgets":true,"encumbrances":true}'::jsonb,
          true
        ) where id = ${org.orgId} returning id
      `);
      assert.equal(changed.rows.length, 1);
    });
    const fund = await provisionFundAccounting({
      orgId: org.orgId,
      defaultFund: { code: "OPERATING", name: "Operating Fund" },
      classifications: { OPERATING: { kind: "operating", restrictionClass: "without_donor_restrictions" } },
      actorId,
    });
    org.fundId = fund.defaultFundId;
    const scenarioId = await seedBudget(org, actorId, "1000.0000");
    await withOrgContext(org.orgId, () => db.execute(sql`
      update funds set budgetary_control = 'hard' where org_id = ${org.orgId} and id = ${org.fundId}
    `));
    installEngineSeams();
    registerBalancingLegProvider("budgetary-control", budgetaryControlProvider);

    const replayConnectionId = randomUUID();
    const replayRequestId = randomUUID();
    const replayAuthorizationId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into connections
          (id, org_id, source, display_name, status, config, mirror_enabled, mirror_schedule,
           posted_change_policy, posted_change_authorized_by, posted_change_authorized_at,
           created_by, updated_by)
        values (${replayConnectionId}, ${org.orgId}, 'source_erp', 'Historical replay fixture',
          'active', '{}'::jsonb, true, 'daily', 'append_only_automatic',
          ${actorId}, now() - interval '1 minute', ${actorId}, ${actorId})
      `);
      await db.execute(sql`
        insert into sync_runs (id, org_id, connection_id, source, kind, status, triggered_by)
        values (${replayRequestId}, ${org.orgId}, ${replayConnectionId}, 'source_erp',
          'incremental', 'running', ${actorId})
      `);
      await db.execute(sql`
        insert into connector_replay_authorizations
          (id, org_id, connection_id, authorized_by, authorized_at, expires_at,
           period_from_id, period_to_id, reason, created_by, updated_by)
        values (${replayAuthorizationId}, ${org.orgId}, ${replayConnectionId}, ${actorId},
          now() - interval '1 minute', now() + interval '15 minutes',
          ${org.periodId}, ${org.periodId},
          'Correct an upstream historical transaction', ${actorId}, ${actorId})
      `);
      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state,
           locked_at, locked_by, reason, created_by, updated_by)
        values (${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'gl', 'closed',
          now(), ${actorId}, 'Controller test close', ${actorId}, ${actorId})
      `);
    });
    const replayInput: PostEntryInput = {
      ...posting(org, "BUDGET-REPLAY-PAIR", "1001.0000"),
      closeModules: ["gl"],
      allowImportedLocks: true,
    };
    const secondaryBookId = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${secondaryBookId}, ${org.orgId}, 'SEC', 'Secondary', false, true, true)
    `));
    const postingCases = [
      { name: "the same primary posting without historical replay evidence", input: replayInput, replay: false, expected: "refused" },
      { name: "the same posting with authenticated historical replay evidence", input: replayInput, replay: true, expected: "posted" },
      { name: "a secondary-book posting over the primary appropriation", input: posting(org, "SECONDARY-CONTROL-PASS", "1001.0000", secondaryBookId), replay: false, expected: "posted" },
    ] as const;
    for (const row of postingCases) {
      if (row.expected === "refused") {
        await assert.rejects(
          tenantPost(row.input, row.replay, replayRequestId, actorId),
          (error) => error instanceof NonprofitPostingError && error.code === "budget_exceeded" &&
            error.status === 422 && error.message.includes(scenarioId) &&
            error.message.includes("5000 Cost of Goods Sold") &&
            error.message.includes("OPERATING Operating Fund") && error.message.includes("Main Co") &&
            error.message.includes("1.0000") && error.remedy.includes("approval flow") &&
            error.remedy.includes("link this actual to the named encumbrance"),
          row.name,
        );
      } else {
        const posted = await tenantPost(row.input, row.replay, replayRequestId, actorId);
        assert.equal(posted.lines.length, 2, row.name);
      }
    }
    await withBypassContext(() => db.execute(sql`
      update period_locks set state = 'open'
       where org_id = ${org.orgId} and period_id = ${org.periodId}
         and book_id = ${org.bookId} and module = 'gl'
    `));

    await withOrgContext(org.orgId, () => db.execute(sql`
      update funds set budgetary_control = 'advisory' where org_id = ${org.orgId} and id = ${org.fundId}
    `));
    const advisory = await tenantPost(posting(org, "ADVISORY-CONTROL-PASS", "120.0000"));
    const warnings = await withOrgContext(org.orgId, () => budgetaryControlWarnings(db, org.orgId, advisory.entryId));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.amountOver, "121.0000");
    const figures = await withOrgContext(org.orgId, () => readBudgetCellFigures(db, {
      orgId: org.orgId, bookId: null, postingDate: org.date,
      cell: { accountId: org.accounts.cogs, subsidiaryId: org.subsidiaryId, fundId: org.fundId,
        extraDims: { fund: org.fundId } },
    }));
    assert.equal(figures?.scenarioId, scenarioId);
    assert.equal(figures?.actuals, "1121.0000");
    assert.equal(figures?.available, "-121.0000");

    const expense = await tenantPost(posting(org, "REVERSED-BUDGET-ACTUAL", "25.0000"));
    const afterExpense = await withOrgContext(org.orgId, () => readBudgetCellFigures(db, {
      orgId: org.orgId, bookId: null, postingDate: org.date,
      cell: { accountId: org.accounts.cogs, subsidiaryId: org.subsidiaryId, fundId: org.fundId,
        extraDims: { fund: org.fundId } },
    }));
    assert.equal(afterExpense?.actuals, "1146.0000");
    const reversalId = await withOrgTransaction(org.orgId, () => reverseProjectGlEntry(
      org.orgId, actorId, expense.entryId, "Correct the budget actual", org.date,
    ));
    assert.ok(reversalId);
    const afterReversal = await withOrgContext(org.orgId, () => readBudgetCellFigures(db, {
      orgId: org.orgId, bookId: null, postingDate: org.date,
      cell: { accountId: org.accounts.cogs, subsidiaryId: org.subsidiaryId, fundId: org.fundId,
        extraDims: { fund: org.fundId } },
    }));
    assert.equal(afterReversal?.actuals, figures?.actuals);

    await withOrgContext(org.orgId, () => db.execute(sql`
      update funds set budgetary_control = 'hard' where org_id = ${org.orgId} and id = ${org.fundId}
    `));
    const commitment = await createEncumbrance({
      orgId: org.orgId, accountId: org.accounts.adjustment, subsidiaryId: org.subsidiaryId,
      sourceKind: "manual", amount: "75.0000", extraDims: { fund: org.fundId }, actorId,
    });
    await assert.rejects(
      closeEncumbrance({ orgId: org.orgId, encumbranceId: commitment.id, reason: "Close unused commitment", actorId }),
      (error) => error instanceof NonprofitError && error.code === "encumbrance_open_balance" &&
        error.message.includes("75.0000"),
    );
    const documentId = randomUUID();
    const documentLineId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, subtotal, tax_total, total, created_by)
        values (${documentId}, ${org.orgId}, 'journal', 'draft', ${"ENC-ACTUAL-" + documentId},
          ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', 75, 0, 75, ${actorId})
      `);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, subsidiary_id, amount,
           quantity, unit_price, tax_amount, tax_input_amount, extra_dims)
        values
          (${documentLineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.adjustment}, ${org.subsidiaryId},
           75, 1, 75, 0, 0, ${JSON.stringify({ fund: org.fundId })}::jsonb),
          (${randomUUID()}, ${org.orgId}, ${documentId}, 2, ${org.accounts.bank}, ${org.subsidiaryId},
           -75, 1, -75, 0, 0, ${JSON.stringify({ fund: org.fundId })}::jsonb)
      `);
      const approved = await db.execute<{ id: string }>(sql`
        update documents set status = 'approved' where org_id = ${org.orgId} and id = ${documentId} returning id
      `);
      assert.equal(approved.rows.length, 1);
    });
    await linkEncumbranceDocumentLine({ orgId: org.orgId, encumbranceId: commitment.id, documentLineId, actorId });
    assert.equal((await withOrgContext(org.orgId, () => encumbranceOpenBalance(db, org.orgId, commitment.id))).openBalance, "75.0000");
    await withOrgContext(org.orgId, () => postDocument(documentId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }, { deferEffects: true }));
    assert.equal((await withOrgContext(org.orgId, () => encumbranceOpenBalance(db, org.orgId, commitment.id))).openBalance, "0.0000");
    const voided = await withOrgContext(org.orgId, () => requestDocumentVoid({
      documentId, orgId: org.orgId, actorId: actorId!, reason: "Correct the linked actual",
      reversalDate: org.date,
    }));
    assert.equal(voided.status, "voided");
    assert.equal((await withOrgContext(org.orgId, () => encumbranceOpenBalance(db, org.orgId, commitment.id))).openBalance, "75.0000");
  } finally {
    clearBalancingLegProviders();
    await dropScratchOrg(org.orgId);
  }
});
