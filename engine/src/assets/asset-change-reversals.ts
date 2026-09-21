import { lockAssetTaxLifecycle } from "../organization/asset-tax-fence.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { sql } from "drizzle-orm";
import {
  db,
  withOrg,
  withTransactionSavepoint,
  type SqlExecutor,
} from "../platform/db.ts";
import { assertFinancialChangeAccess } from "../organization/financial-change-access.ts";
import {
  assertFinancialChangeApproved,
  completeFinancialChange,
  existingFinancialChange,
  loadFinancialChange,
  proposeFinancialChange,
} from "../platform/financial-changes.ts";
import { neg } from "../money/money.ts";
import {
  buildScheduleWithRunner,
  reconcileAssetDepreciationStatusWithRunner,
} from "./depreciation.ts";
import { lockAssetRow, postAssetLifecycleEntry } from "./asset-lifecycle.ts";
interface ReversalInput {
  sourceChangeId: string;
  effectiveOn: string;
  reason: string;
  idempotencyKey: string;
}
async function state(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  input: ReversalInput,
) {
  const source = await loadFinancialChange(tx, orgId, input.sourceChangeId);
  if (
    source.domain !== "asset" ||
    !["partial_disposal", "intercompany_transfer"].includes(source.operation) ||
    source.status !== "applied"
  )
    throw new Error("select an applied disposal or transfer to reverse");
  if (input.effectiveOn !== source.effective_on)
    throw new Error(
      "correct an erroneous asset change on its original effective date; a later physical return is a new acquisition or transfer back",
    );
  const required = (source.payload.requiredSubsidiaryIds ?? [
    source.subsidiary_id,
  ]) as string[];
  await assertFinancialChangeAccess(tx, {
    orgId,
    actorId,
    subsidiaryIds: required,
    permission: "assets.manage",
    feature: "fixedAssets",
  });
  const receiver = source.result?.receivingAssetId as string | null;
  for (const id of [source.subject_id, ...(receiver ? [receiver] : [])].sort())
    await lockAssetRow(tx, orgId, id);
  const prior = (
    await tx.execute(
      sql`select 1 from financial_changes where org_id=${orgId} and domain='asset' and operation='reversal' and payload->>'sourceChangeId'=${source.id} and status='applied'`,
    )
  ).rows[0];
  if (prior) throw new Error("this asset change has already been reversed");
  const basis = (
    await tx.execute<{
      asset_id: string;
      book_id: string;
      cost_delta: string;
      accumulated_delta: string;
      salvage_delta: string;
      impairment_released: string;
      created_at: string;
    }>(
      sql`select *,created_at::text from asset_basis_changes where org_id=${orgId} and change_id=${source.id} order by book_id for share`,
    )
  ).rows;
  if (!basis.length)
    throw new Error("the original asset basis evidence is missing");
  // Matches the existing latest-event reversal rule. A return after subsequent
  // use is a new acquisition/transfer at current carrying value, not erasure of
  // the intervening depreciation or ownership chain.
  const boundary = basis[0]!.created_at;
  const later = (
    await tx.execute(
      sql`select 1 from asset_events where org_id=${orgId} and asset_id in(${source.subject_id},${receiver ?? source.subject_id}) and created_at>=${boundary}::timestamptz and financial_change_id is distinct from ${source.id} union all select 1 from depreciation_schedule_lines l join depreciation_schedules s on s.org_id=l.org_id and s.id=l.schedule_id left join journal_entries e on e.org_id=l.org_id and e.id=l.journal_entry_id where s.org_id=${orgId} and s.asset_id in(${source.subject_id},${receiver ?? source.subject_id}) and (e.created_at>=${boundary}::timestamptz or l.non_gl_recognized_at>=${boundary}::timestamptz) limit 1`,
    )
  ).rows[0];
  if (later)
    throw new Error(
      "the asset has subsequent financial history; retain it and record the returned component as a new acquisition, or an approved transfer back from the receiving company",
    );
  const assets = (
    await tx.execute<Record<string, unknown>>(
      sql`select *,updated_at::text from fixed_assets where org_id=${orgId} and id in(${source.subject_id},${receiver ?? source.subject_id}) order by id`,
    )
  ).rows;
  const entryIds = source.result?.entryIds as string[];
  const journals = (
    await tx.execute<{
      id: string;
      book_id: string;
      period_id: string;
      subsidiary_id: string;
      status: string;
      origin: "disposal" | "depreciation" | "intercompany";
      base_currency: string;
      department_id: string | null;
      project_id: string | null;
      location_id: string | null;
    }>(
      sql`select e.id,e.book_id,e.period_id,e.subsidiary_id,e.status,e.origin,s.base_currency,a.department_id,a.project_id,a.location_id from journal_entries e join subsidiaries s on s.org_id=e.org_id and s.id=e.subsidiary_id join fixed_assets a on a.org_id=e.org_id and a.subsidiary_id=e.subsidiary_id and a.id in(${source.subject_id},${receiver ?? source.subject_id}) where e.org_id=${orgId} and e.id in(select jsonb_array_elements_text(${JSON.stringify(entryIds)}::jsonb)::uuid) order by e.id for share of e,s`,
    )
  ).rows;
  if (
    journals.length !== entryIds.length ||
    journals.some((j) => j.status !== "posted")
  )
    throw new Error(
      "the source journals are no longer an intact unreversed generation",
    );
  const lines = (
    await tx.execute<{
      entry_id: string;
      account_id: string;
      amount: string;
      currency: string;
      txn_amount: string;
      fx_rate: string;
    }>(
      sql`select entry_id,account_id,amount::text,currency,txn_amount::text,fx_rate::text from journal_lines where org_id=${orgId} and entry_id in(select jsonb_array_elements_text(${JSON.stringify(entryIds)}::jsonb)::uuid) order by entry_id,line_number`,
    )
  ).rows;
  const events = (
    await tx.execute<{
      id: string;
      asset_id: string;
      book_id: string;
      journal_entry_id: string | null;
    }>(
      sql`select id,asset_id,book_id,journal_entry_id from asset_events where org_id=${orgId} and financial_change_id=${source.id} order by id for share`,
    )
  ).rows;
  if (!events.length || events.some((e) => !e.book_id))
    throw new Error("the source asset event book evidence is missing");
  const transfers = (
    await tx.execute(
      sql`select * from asset_transfer_bases where org_id=${orgId} and change_id=${source.id} order by book_id for share`,
    )
  ).rows;
  return {
    source,
    basis,
    assets,
    journals,
    lines,
    transfers,
    events,
    required,
    receiver,
  };
}
export async function proposeAssetReversal(
  orgId: string,
  sourceChangeId: string,
  actorId: string,
  input: Omit<ReversalInput, "sourceChangeId">,
): Promise<string> {
  if (input.reason.trim().length < 8 || input.reason.trim().length > 500)
    throw new Error(
      "a reversal reason between 8 and 500 characters is required",
    );
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const payload = { ...input, sourceChangeId },
        source = await loadFinancialChange(db, orgId, sourceChangeId),
        required = (source.payload.requiredSubsidiaryIds ?? [
          source.subsidiary_id,
        ]) as string[];
      await assertFinancialChangeAccess(db, {
        orgId,
        actorId,
        subsidiaryIds: required,
        permission: "assets.manage",
        feature: "fixedAssets",
      });
      const args = {
        orgId,
        subsidiaryId: source.subsidiary_id,
        domain: "asset" as const,
        subjectId: source.subject_id,
        operation: "reversal",
        effectiveOn: input.effectiveOn,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        actorId,
        payload: { ...payload, requiredSubsidiaryIds: required },
      };
      const prior = await existingFinancialChange(db, args);
      if (prior) return prior;
      const before = await state(db, orgId, actorId, payload);
      return proposeFinancialChange(db, { ...args, beforeState: before });
    }),
  );
}
export async function applyAssetReversal(
  orgId: string,
  changeId: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const change = await loadFinancialChange(db, orgId, changeId);
      if (change.domain !== "asset" || change.operation !== "reversal")
        throw new Error("this is not an asset change reversal");
      await assertFinancialChangeAccess(db, {
        orgId,
        actorId,
        subsidiaryIds: change.payload.requiredSubsidiaryIds as string[],
        permission: "assets.manage",
        feature: "fixedAssets",
      });
      if (change.status === "applied") return change.result!;
      await lockAssetTaxLifecycle(
        db,
        orgId,
        change.payload.requiredSubsidiaryIds as string[],
      );
      const input = change.payload as unknown as ReversalInput,
        now = await state(db, orgId, actorId, input);
      assertFinancialChangeApproved(change, {
        domain: "asset",
        subjectId: now.source.subject_id,
        beforeState: now,
      });
      const approverScope = await actorAllowedSubsidiaryIds(
        db,
        orgId,
        change.approved_by!,
      );
      if (
        approverScope &&
        (change.payload.requiredSubsidiaryIds as string[]).some(
          (id) => !approverScope.has(id),
        )
      )
        throw new Error(
          "the approver no longer covers every legal entity; obtain a new scoped approval",
        );
      const entryIds: string[] = [];
      const reversingEntries = new Map<string, string>();
      for (const entry of now.journals) {
        const id = await postAssetLifecycleEntry(db, {
          orgId,
          actorId,
          bookId: entry.book_id,
          periodId: entry.period_id,
          date: input.effectiveOn,
          number: `AST-REV-${changeId}-${entry.id}`,
          memo: `Reversal: ${input.reason}`,
          asset: entry,
          currency: entry.base_currency,
          origin: entry.origin,
          reversesEntryId: entry.id,
          lines: now.lines
            .filter((l) => l.entry_id === entry.id)
            .map((l) => ({
              accountId: l.account_id,
              amount: neg(l.amount),
              currency: l.currency,
              txnAmount: neg(l.txn_amount),
              fxRate: l.fx_rate,
            })),
        });
        if (!id)
          throw new Error("the source asset journal reversal was not posted");
        entryIds.push(id);
        reversingEntries.set(entry.id, id);
        const changed = await db.execute(
          sql`update journal_entries set status='reversed',updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${entry.id} and status='posted' returning id`,
        );
        if (changed.rows.length !== 1)
          throw new Error(
            "source asset journal could not be linked to its reversal",
          );
      }
      for (const event of now.events) {
        const journal = event.journal_entry_id
          ? reversingEntries.get(event.journal_entry_id)
          : null;
        if (event.journal_entry_id && !journal)
          throw new Error(
            "asset reversal event is missing its correcting journal",
          );
        const recorded = await db.execute(
          sql`insert into asset_events(org_id,asset_id,book_id,kind,occurred_on,journal_entry_id,financial_change_id,reverses_event_id,reversal_reason,memo,created_by,updated_by) values(${orgId},${event.asset_id},${event.book_id},'reversed',${input.effectiveOn},${journal ?? null},${changeId},${event.id},${input.reason.trim()},'Approved asset change correction',${actorId},${actorId}) returning id`,
        );
        if (recorded.rows.length !== 1)
          throw new Error("asset reversal event was not recorded");
      }
      for (const basis of now.basis) {
        const original = (
          now.source.before_state.previews as {
            bookId: string;
            unitsBefore: string | null;
            depreciableBefore: string;
          }[]
        ).find((p) => p.bookId === basis.book_id)!;
        await db.execute(
          sql`insert into asset_basis_changes(org_id,asset_id,book_id,change_id,effective_on,cost_delta,accumulated_delta,salvage_delta,impairment_released,units_remaining,depreciable_after,created_by) values(${orgId},${basis.asset_id},${basis.book_id},${changeId},${input.effectiveOn},${neg(basis.cost_delta)},${neg(basis.accumulated_delta)},${neg(basis.salvage_delta)},${neg(basis.impairment_released)},${original.unitsBefore},${original.depreciableBefore},${actorId})`,
        );
      }
      const restored = await db.execute(
        sql`update fixed_assets set status='in_service',updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${now.source.subject_id} returning id`,
      );
      if (restored.rows.length !== 1)
        throw new Error("source asset could not be restored");
      if (now.receiver) {
        const retired = await db.execute(
          sql`update fixed_assets set status='written_off',updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${now.receiver} returning id`,
        );
        if (retired.rows.length !== 1)
          throw new Error("reversed receiving asset could not be retired");
      }
      if (now.transfers.length) {
        const updated = await db.execute(
          sql`update asset_transfer_bases set reversed_by_change_id=${changeId},reversed_on=${input.effectiveOn} where org_id=${orgId} and change_id=${now.source.id} and reversed_by_change_id is null returning id`,
        );
        if (updated.rows.length !== now.transfers.length)
          throw new Error(
            "transfer consolidation lineage could not be reversed",
          );
      }
      for (const basis of now.basis) {
        const built = await buildScheduleWithRunner(
          db,
          now.source.subject_id,
          orgId,
          actorId,
          basis.book_id,
        );
        if (built.skippedMonths.length)
          throw new Error(
            `create accounting periods through ${built.skippedMonths.at(-1)} before reversing this asset change`,
          );
      }
      await reconcileAssetDepreciationStatusWithRunner(
        db,
        orgId,
        actorId,
        now.source.subject_id,
      );
      const result = {
        assetId: now.source.subject_id,
        sourceChangeId: now.source.id,
        entryIds,
      };
      await completeFinancialChange(db, orgId, changeId, actorId, result);
      return result;
    }),
  );
}
