import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  ensureFiling,
  finalizeFiling,
  InformationReturnError,
  markFilingFiled,
  recomputeFiling,
  updateFilingRecipient,
  voidFiling,
} from "./information-returns.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// Live-Postgres regression for the filing lifecycle boundary. The transition
// functions used to validate the filing status OUTSIDE any transaction and
// then write unguarded, so a recompute or recipient edit racing a finalize
// could rewrite transmitted evidence, and every route wrote its audit row as a
// separate autocommit statement — a mid-save failure committed the lifecycle
// change without evidence. These tests prove against real PostgreSQL that
// compute/edit cannot cross finalize/file, frozen rows never change in
// storage, and each lifecycle write commits or rolls back together with its
// audit evidence.

/**
 * Seed a `computed` 1099-NEC filing with two included recipients.
 *
 * The finalization boundary re-derives the authoritative cash generation and
 * compares it with the stored compute evidence.  Keep this fixture on that
 * production path: each recipient gets a real posted cash source and the
 * filing is computed through `recomputeFiling`, rather than hand-writing rows
 * that can never pass the stale-evidence check.
 */
async function seedComputedFiling(
  org: SourceFixtureOrg,
  actorId: string,
  taxYear: number,
  opts: { tinLast4?: (string | null)[] } = {},
): Promise<{ filingId: string; recipientIds: string[] }> {
  const tins = opts.tinLast4 ?? ["1234", "5678"];
  const filing = await ensureFiling({
    orgId: org.orgId,
    taxYear,
    formType: "1099-NEC",
    currency: "USD",
    actorId,
  });
  for (let i = 0; i < tins.length; i++) {
    const partyId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${partyId}, ${org.orgId}, 'vendor', ${`Recipient ${taxYear}-${i}`},
              null, true, '{}'::jsonb)`);
    await seedInformationReturnPayment(org, actorId, `${1000 + i}`, `FIXTURE-${taxYear}-${i}`, {
      partyId,
      taxYear,
      tinLast4: tins[i],
    });
  }
  await recomputeFiling({ orgId: org.orgId, filingId: filing.id, actorId });
  const recipients = await db.execute<{ id: string }>(sql`
    select id from information_return_recipients
     where org_id = ${org.orgId} and filing_id = ${filing.id}
     order by party_id`);
  return { filingId: filing.id, recipientIds: recipients.rows.map((row) => row.id) };
}

async function filingRow(
  orgId: string,
  filingId: string,
): Promise<{ status: string; void_reason: string | null; finalized_at: Date | null }> {
  const r = await db.execute<{ status: string; void_reason: string | null; finalized_at: Date | null }>(
    sql`select status, void_reason, finalized_at from information_return_filings
         where org_id = ${orgId} and id = ${filingId}`,
  );
  return r.rows[0]!;
}

type RecipientRow = {
  status: string;
  adjustments: Record<string, string>;
  exclusion_reason: string | null;
  updated_at: Date;
};

/** Rows keyed by recipient id — insertion order is not id order (uuid v7 aside). */
async function recipientRows(orgId: string, filingId: string): Promise<Map<string, RecipientRow>> {
  const r = await db.execute<RecipientRow & { id: string }>(sql`
    select id, status, adjustments, exclusion_reason, updated_at
      from information_return_recipients
     where org_id = ${orgId} and filing_id = ${filingId}`);
  return new Map(r.rows.map((row) => [row.id, row]));
}

async function auditActions(orgId: string, rowId: string): Promise<string[]> {
  const r = await db.execute<{ action: string }>(sql`
    select action from audit_log
     where org_id = ${orgId} and table_name = 'information_return_filings' and row_id = ${rowId}
     order by at, id`);
  return r.rows.map((row) => row.action);
}

async function rejectsInfo(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof InformationReturnError, `expected InformationReturnError, got ${String(e)}`);
    assert.match(e.message, pattern);
    return true;
  });
}

type SourceFixtureOrg = Awaited<ReturnType<typeof createScratchOrg>>;

/** One real posted cash source, with stable ids so lineage can be asserted. */
async function seedInformationReturnPayment(
  org: SourceFixtureOrg,
  actorId: string,
  amount: string,
  suffix: string,
  opts: { partyId?: string; taxYear?: number; tinLast4?: string | null } = {},
): Promise<{ paymentId: string; journalEntryId: string; journalLineIds: string[] }> {
  const partyId = opts.partyId ?? org.vendorId;
  const sourceDate = opts.taxYear === undefined ? org.date : `${opts.taxYear}-07-15`;
  await db.execute(sql`
    insert into vendor_roles
      (org_id, party_id, is_t4a, information_return_form, tin_last4, tin_type,
       created_by, updated_by)
    values
      (${org.orgId}, ${partyId}, true, '1099-NEC', ${opts.tinLast4 === undefined ? "1234" : opts.tinLast4}, 'ein',
       ${actorId}, ${actorId})
    on conflict (party_id) do update set
      is_t4a = true, information_return_form = '1099-NEC',
      tin_last4 = excluded.tin_last4, tin_type = 'ein', updated_by = ${actorId}
    where vendor_roles.org_id = ${org.orgId}
  `);
  const paymentId = randomUUID();
  const journalEntryId = randomUUID();
  const journalLineIds = [randomUUID(), randomUUID()];
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, subtotal, tax_total, total,
         custom, created_by, updated_by)
      values
        (${paymentId}, ${org.orgId}, 'vendor_payment', 'approved',
         ${`IR-SOURCE-${suffix}`}, ${org.subsidiaryId}, ${partyId},
         ${sourceDate}, ${sourceDate}, 'CAD', ${amount}, '0', ${amount},
         ${JSON.stringify({ bankAccountId: org.accounts.bank, allocations: [] })}::jsonb,
         ${actorId}, ${actorId})
    `);
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, source_document_id, origin, created_by, updated_by)
      values
        (${journalEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`IR-SOURCE-${suffix}`}, ${sourceDate}, ${org.periodId},
         'Information-return source fixture', 'draft', ${paymentId}, 'document',
         ${actorId}, ${actorId})
    `);
    await tx.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount,
         currency, txn_amount, fx_rate, party_id, is_open_item, memo)
      values
        (${journalLineIds[0]!}, ${org.orgId}, ${journalEntryId}, 1,
         ${org.accounts.ap}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, 1,
         ${org.vendorId}, true, 'Information-return payment control'),
        (${journalLineIds[1]!}, ${org.orgId}, ${journalEntryId}, 2,
         ${org.accounts.bank}, ${org.subsidiaryId}, ${`-${amount}`}, 'CAD',
         ${`-${amount}`}, 1, null, false, 'Information-return cash source')
    `);
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_at = now(), posted_by = ${actorId}
       where org_id = ${org.orgId} and id = ${journalEntryId}
    `);
    await tx.execute(sql`
      update documents
         set status = 'posted', posted_entry_id = ${journalEntryId},
             posting_period_id = ${org.periodId}
       where org_id = ${org.orgId} and id = ${paymentId}
    `);
  });
  return { paymentId, journalEntryId, journalLineIds };
}

test(
  "finalize rejects a filing whose authoritative cash sources changed after recomputation",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const original = await seedInformationReturnPayment(org, actorId, "1000", "STALE-ORIGINAL");
      const filing = await ensureFiling({
        orgId: org.orgId,
        taxYear: 2026,
        formType: "1099-NEC",
        currency: "CAD",
        actorId,
      });
      await recomputeFiling({ orgId: org.orgId, filingId: filing.id, actorId });
      const before = (await db.execute<{ recipient_snapshot: Record<string, unknown> }>(sql`
        select recipient_snapshot from information_return_recipients
         where org_id = ${org.orgId} and filing_id = ${filing.id}
      `)).rows[0]!.recipient_snapshot;

      const late = await seedInformationReturnPayment(org, actorId, "250", "STALE-LATE");
      await rejectsInfo(
        () => finalizeFiling({ orgId: org.orgId, filingId: filing.id, actorId }),
        /authoritative cash-source evidence changed after computation/,
      );

      const state = await filingRow(org.orgId, filing.id);
      assert.equal(state.status, "computed");
      assert.equal(state.finalized_at, null);
      assert.deepEqual(await auditActions(org.orgId, filing.id), ["compute"]);
      const after = (await db.execute<{ recipient_snapshot: Record<string, unknown> }>(sql`
        select recipient_snapshot from information_return_recipients
         where org_id = ${org.orgId} and filing_id = ${filing.id}
      `)).rows[0]!.recipient_snapshot;
      assert.deepEqual(after, before, "stale refusal must not rewrite the reviewed evidence");
      assert.deepEqual(after.paymentIds, [original.paymentId]);
      assert.equal((after.paymentIds as string[]).includes(late.paymentId), false);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "finalize accepts a current source generation and freezes its exact lineage",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const source = await seedInformationReturnPayment(org, actorId, "1000", "CURRENT");
      const filing = await ensureFiling({
        orgId: org.orgId,
        taxYear: 2026,
        formType: "1099-NEC",
        currency: "CAD",
        actorId,
      });
      const { computation } = await recomputeFiling({
        orgId: org.orgId,
        filingId: filing.id,
        actorId,
      });
      assert.deepEqual(computation.recipients[0]!.paymentIds, [source.paymentId]);

      const before = (await db.execute<{ recipient_snapshot: Record<string, unknown> }>(sql`
        select recipient_snapshot from information_return_recipients
         where org_id = ${org.orgId} and filing_id = ${filing.id}
      `)).rows[0]!.recipient_snapshot;
      assert.deepEqual(before.paymentIds, [source.paymentId]);
      const traces = before.paymentTraces as Array<{
        paymentId: string;
        journalEntryId: string;
        journalLineIds: string[];
      }>;
      assert.equal(traces[0]!.paymentId, source.paymentId);
      assert.equal(traces[0]!.journalEntryId, source.journalEntryId);
      assert.deepEqual(traces[0]!.journalLineIds, [...source.journalLineIds].sort());
      assert.match(String(before.sourceFingerprint), /^[a-f0-9]{64}$/);

      await finalizeFiling({ orgId: org.orgId, filingId: filing.id, actorId });
      assert.equal((await filingRow(org.orgId, filing.id)).status, "finalized");
      assert.deepEqual(await auditActions(org.orgId, filing.id), ["compute", "finalize"]);
      const frozen = (await db.execute<{ recipient_snapshot: Record<string, unknown> }>(sql`
        select recipient_snapshot from information_return_recipients
         where org_id = ${org.orgId} and filing_id = ${filing.id}
      `)).rows[0]!.recipient_snapshot;
      assert.deepEqual(frozen, before);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("the filing lifecycle refuses to cross finalize/file and leaves frozen storage untouched", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const { filingId, recipientIds } = await seedComputedFiling(org, actorId, 2026);
    const before = await recipientRows(org.orgId, filingId);
    assert.equal(before.size, 2);

    await finalizeFiling({ orgId: org.orgId, filingId, actorId });
    assert.equal((await filingRow(org.orgId, filingId)).status, "finalized");

    // Recompute would re-derive what was transmitted: refused.
    await rejectsInfo(
      () => recomputeFiling({ orgId: org.orgId, filingId, actorId }),
      /a finalized filing cannot be recomputed/,
    );
    // Recipient adjustments/exclusions are frozen with it.
    await rejectsInfo(
      () =>
        updateFilingRecipient({
          orgId: org.orgId,
          filingId,
          recipientId: recipientIds[0]!,
          actorId,
          adjustments: { nec1: "-100" },
          adjustmentReason: "late fee correction",
        }),
      /a finalized filing is frozen/,
    );
    await rejectsInfo(
      () =>
        updateFilingRecipient({
          orgId: org.orgId,
          filingId,
          recipientId: recipientIds[1]!,
          actorId,
          status: "excluded",
          exclusionReason: "duplicate",
        }),
      /a finalized filing is frozen/,
    );

    // Storage proof: not one byte of the child rows moved — no shadow write,
    // not even an updated_at bump.
    const after = await recipientRows(org.orgId, filingId);
    const snapshot = (m: Map<string, RecipientRow>) =>
      [...m.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, r]) => ({
          id,
          status: r.status,
          adjustments: r.adjustments,
          exclusion_reason: r.exclusion_reason,
          updated_at: new Date(r.updated_at as unknown as string).getTime(),
        }));
    assert.deepEqual(snapshot(after), snapshot(before));
    // And none of the refusals fabricated audit evidence.
    assert.deepEqual(await auditActions(org.orgId, filingId), ["compute", "finalize"]);

    // Filed is terminal for edits and recompute too.
    await markFilingFiled({ orgId: org.orgId, filingId, channel: "paper", reference: "IRIS-1", actorId });
    await rejectsInfo(
      () => markFilingFiled({ orgId: org.orgId, filingId, channel: "paper", actorId }),
      /only a finalized filing can be recorded as filed/,
    );
    await rejectsInfo(
      () => recomputeFiling({ orgId: org.orgId, filingId, actorId }),
      /a filed filing cannot be recomputed/,
    );
    await rejectsInfo(
      () =>
        updateFilingRecipient({
          orgId: org.orgId,
          filingId,
          recipientId: recipientIds[0]!,
          actorId,
          adjustments: { nec1: "-1" },
          adjustmentReason: "x",
        }),
      /a filed filing is frozen/,
    );
    const filedAfter = await recipientRows(org.orgId, filingId);
    assert.deepEqual(snapshot(filedAfter), snapshot(after));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("finalize gates refuse without writing anything — no freeze, no audit trace", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;

    // A missing TIN blocks the freeze entirely.
    const missingTin = await seedComputedFiling(org, actorId, 2027, { tinLast4: ["1234", null] });
    await rejectsInfo(
      () => finalizeFiling({ orgId: org.orgId, filingId: missingTin.filingId, actorId }),
      /no taxpayer identification number/,
    );
    assert.equal((await filingRow(org.orgId, missingTin.filingId)).status, "computed");
    assert.deepEqual(await auditActions(org.orgId, missingTin.filingId), ["compute"]);

    // No included recipients: nothing to transmit.
    const empty = await seedComputedFiling(org, actorId, 2028);
    await db.execute(sql`
      update information_return_recipients set status = 'excluded', exclusion_reason = 'below threshold'
       where org_id = ${org.orgId} and filing_id = ${empty.filingId}`);
    await rejectsInfo(
      () => finalizeFiling({ orgId: org.orgId, filingId: empty.filingId, actorId }),
      /the filing has no recipients to file/,
    );
    assert.deepEqual(await auditActions(org.orgId, empty.filingId), ["compute"]);

    // A draft filing must be computed first.
    const draft = await ensureFiling({ orgId: org.orgId, taxYear: 2029, formType: "1099-NEC", currency: "USD", actorId });
    await rejectsInfo(
      () => finalizeFiling({ orgId: org.orgId, filingId: draft.id, actorId }),
      /compute the filing before finalizing it/,
    );
    assert.deepEqual(await auditActions(org.orgId, draft.id), []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

for (let round = 0; round < 10; round++) {
  test(`race ${round}: recompute and finalize serialize — the freeze is never rewritten`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const taxYear = 2030 + round;
      const { filingId, recipientIds } = await seedComputedFiling(org, actorId, taxYear);

      const [recompute, freeze] = await Promise.allSettled([
        recomputeFiling({ orgId: org.orgId, filingId, actorId }),
        finalizeFiling({ orgId: org.orgId, filingId, actorId }),
      ]);

      const state = await filingRow(org.orgId, filingId);
      if (freeze.status === "fulfilled") {
        // The freeze won: the recomputation must have been refused, the
        // recipients must be exactly as transmitted, and the state machine
        // must sit at finalized — never knocked back to computed.
        assert.equal(state.status, "finalized");
        assert.ok(recompute.status === "rejected", "recompute succeeded on an already-finalized filing");
        if (recompute.status === "rejected") {
          assert.ok(recompute.reason instanceof InformationReturnError, String(recompute.reason));
        }
        const rows = await recipientRows(org.orgId, filingId);
        assert.deepEqual(
          [...rows.values()].map((r) => [r.status, r.adjustments]),
          [
            ["included", {}],
            ["included", {}],
          ],
        );
        assert.deepEqual(await auditActions(org.orgId, filingId), ["compute", "finalize"]);
      } else {
        // The recomputation won the lock.  Under SERIALIZABLE isolation the
        // finalize snapshot is aborted after waiting on that write, so the
        // caller gets a deterministic retry error and the filing remains
        // computed with its freshly reviewed source evidence.
        assert.equal(freeze.reason instanceof InformationReturnError, true, String(freeze.reason));
        assert.match((freeze.reason as InformationReturnError).message, /changed concurrently/);
        assert.equal(recompute.status, "fulfilled");
        assert.equal(state.status, "computed");
        const rows = await recipientRows(org.orgId, filingId);
        assert.deepEqual([...rows.values()].map((r) => r.status), ["included", "included"]);
        assert.deepEqual(await auditActions(org.orgId, filingId), ["compute", "compute"]);
      }
      void recipientIds;
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });

  test(`race ${round}: recipient edit and finalize serialize — no edit lands after the freeze`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const taxYear = 2040 + round;
      const { filingId, recipientIds } = await seedComputedFiling(org, actorId, taxYear);

      const [edit, freeze] = await Promise.allSettled([
        updateFilingRecipient({
          orgId: org.orgId,
          filingId,
          recipientId: recipientIds[0]!,
          actorId,
          adjustments: { nec1: "-100" },
          adjustmentReason: "refund issued after year end",
        }),
        finalizeFiling({ orgId: org.orgId, filingId, actorId }),
      ]);

      assert.equal(freeze.status, "fulfilled", "finalize must succeed either way");
      const state = await filingRow(org.orgId, filingId);
      assert.equal(state.status, "finalized");
      const rows = await recipientRows(org.orgId, filingId);
      if (edit.status === "fulfilled") {
        // The edit committed before the freeze took the lock: its delta is
        // part of the frozen evidence.
        assert.deepEqual(rows.get(recipientIds[0]!)!.adjustments, { nec1: "-100.0000" });
        assert.equal(rows.get(recipientIds[0]!)!.status, "included");
      } else {
        // The edit lost: refused with zero effect on storage.
        assert.ok(edit.reason instanceof InformationReturnError, String(edit.reason));
        assert.match(edit.reason.message, /frozen/);
        assert.deepEqual(rows.get(recipientIds[0]!)!.adjustments, {});
      }
      // Exactly one audit row per successful unit — the edit's own evidence
      // commits with it or not at all.
      const recipientAudits = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from audit_log
         where org_id = ${org.orgId} and table_name = 'information_return_recipients'
           and row_id = ${recipientIds[0]!}`);
      assert.equal(recipientAudits.rows[0]!.n, edit.status === "fulfilled" ? 1 : 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}

test("every successful transition writes exactly one audit row, in one unit with the lifecycle write", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const { filingId } = await seedComputedFiling(org, actorId, 2050);

    await finalizeFiling({ orgId: org.orgId, filingId, actorId });
    await markFilingFiled({ orgId: org.orgId, filingId, channel: "iris", reference: "REF-9", actorId });
    // A filed return is permanent evidence — the storage contract pins
    // filed_at to the filed status, so the record cannot be reopened.
    await rejectsInfo(
      () => voidFiling({ orgId: org.orgId, filingId, actorId, reason: "superseded" }),
      /a filed return is permanent evidence/,
    );
    await rejectsInfo(
      () => voidFiling({ orgId: org.orgId, filingId, actorId, reason: "   " }),
      /voiding a filing needs a reason/,
    );

    // Voiding applies up to (but never after) the transmission.
    const unfrozen = await seedComputedFiling(org, actorId, 2053);
    await finalizeFiling({ orgId: org.orgId, filingId: unfrozen.filingId, actorId });
    await voidFiling({
      orgId: org.orgId,
      filingId: unfrozen.filingId,
      actorId,
      reason: "superseded by corrected return",
    });
    await rejectsInfo(
      () => voidFiling({ orgId: org.orgId, filingId: unfrozen.filingId, actorId, reason: "again" }),
      /already void/,
    );

    const state = await filingRow(org.orgId, filingId);
    assert.equal(state.status, "filed");
    const voided = await filingRow(org.orgId, unfrozen.filingId);
    assert.equal(voided.status, "void");
    assert.equal(voided.void_reason, "superseded by corrected return");
    // One row per successful transition per filing, in order — refusals above
    // added nothing.
    assert.deepEqual(await auditActions(org.orgId, filingId), ["compute", "finalize", "file"]);
    assert.deepEqual(await auditActions(org.orgId, unfrozen.filingId), ["compute", "finalize", "void"]);
    const actors = await db.execute<{ action: string; actor_id: string }>(sql`
      select action, actor_id from audit_log
       where org_id = ${org.orgId} and table_name = 'information_return_filings' and row_id = ${filingId}
       order by at, id`);
    assert.ok(actors.rows.every((r) => r.actor_id === actorId));

    // A real recompute run (empty ledger → zero recipients) lands the
    // `compute` evidence atomically; the blocked finalize adds nothing.
    const fresh = await ensureFiling({ orgId: org.orgId, taxYear: 2051, formType: "1099-MISC", currency: "USD", actorId });
    const { computation } = await recomputeFiling({ orgId: org.orgId, filingId: fresh.id, actorId });
    assert.equal(computation.recipients.length, 0);
    assert.equal((await filingRow(org.orgId, fresh.id)).status, "computed");
    const miscAudit = await db.execute<{ action: string; changes: Record<string, unknown> }>(sql`
      select action, changes from audit_log
       where org_id = ${org.orgId} and table_name = 'information_return_filings' and row_id = ${fresh.id}
       order by at, id`);
    assert.deepEqual(miscAudit.rows.map((r) => r.action), ["compute"]);
    assert.equal((miscAudit.rows[0]!.changes.after as { recipients: number }).recipients, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("recipient edits keep the API contract: signed deltas over computed figures, reasons mandatory, validation strict", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const { filingId, recipientIds } = await seedComputedFiling(org, actorId, 2052);
    const target = recipientIds[0]!;
    const call = (over: Partial<Parameters<typeof updateFilingRecipient>[0]> = {}) =>
      updateFilingRecipient({ orgId: org.orgId, filingId, recipientId: target, actorId, ...over });

    await rejectsInfo(() => call({ adjustments: { nec99: "5" }, adjustmentReason: "x" }), /nec99 is not a box on 1099-NEC/);
    await rejectsInfo(() => call({ adjustments: { nec1: "not-a-number" }, adjustmentReason: "x" }), /nec1: not a valid amount/);
    await rejectsInfo(
      () => call({ adjustments: { nec1: "12.34567" }, adjustmentReason: "x" }),
      /nec1: not a valid amount/,
    );
    await rejectsInfo(() => call({ adjustments: { nec1: "-100" } }), /an adjustment needs a reason/);
    await rejectsInfo(() => call({ status: "excluded" }), /excluding a recipient needs a reason/);

    // Zero-value adjustments carry no evidence burden and store nothing.
    await updateFilingRecipient({ orgId: org.orgId, filingId, recipientId: target, actorId, adjustments: { nec1: "0.0000" } });
    let rows = await recipientRows(org.orgId, filingId);
    assert.deepEqual(rows.get(target)!.adjustments, {});
    assert.equal(
      (
        await db.execute<{ n: number }>(sql`
          select count(*)::int as n from audit_log
           where org_id = ${org.orgId} and row_id = ${target}`)
      ).rows[0]!.n,
      0,
    );

    // A real adjustment persists the exact signed delta plus its reason, and
    // one audit row records before → after together with the write.
    await call({ adjustments: { nec1: "-250.5" }, adjustmentReason: "duplicate cheque recovered" });
    rows = await recipientRows(org.orgId, filingId);
    assert.deepEqual(rows.get(target)!.adjustments, { nec1: "-250.5000" });
    const audits = await db.execute<{ changes: { before: unknown; after: unknown } }>(sql`
      select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'information_return_recipients' and row_id = ${target}
       order by at, id`);
    assert.equal(audits.rows.length, 1);
    assert.deepEqual(audits.rows[0]!.changes.before, { status: "included", adjustments: {} });
    assert.deepEqual(audits.rows[0]!.changes.after, { status: "included", adjustments: { nec1: "-250.5000" } });

    // Excluding keeps the mandatory reason on the row, next to its audit.
    await call({ status: "excluded", exclusionReason: "deceased, estate paid final bill" });
    rows = await recipientRows(org.orgId, filingId);
    assert.equal(rows.get(target)!.status, "excluded");
    assert.equal(rows.get(target)!.exclusion_reason, "deceased, estate paid final bill");

    // Unknown recipient / filing ids fail closed with nothing written.
    await rejectsInfo(
      () =>
        updateFilingRecipient({
          orgId: org.orgId,
          filingId,
          recipientId: randomUUID(),
          actorId,
          status: "excluded",
          exclusionReason: "x",
        }),
      /recipient not found/,
    );
    await rejectsInfo(
      () => voidFiling({ orgId: org.orgId, filingId: randomUUID(), actorId, reason: "x" }),
      /not found/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
