import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { PostingError } from "../journal/posting-contracts.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface TransferredApplication {
  priorApplicationId: string;
  replacementApplicationId: string;
  priorFromLineId: string;
  replacementFromLineId: string;
  priorToLineId: string;
  replacementToLineId: string;
}

interface CorrectionLine {
  id: string;
  isOpenItem?: boolean | null | undefined;
  accountId: string;
  partyId?: string | null | undefined;
  subsidiaryId?: string | null | undefined;
  currency: string;
  amount: string;
  txnAmount?: string | null | undefined;
}

/**
 * Application transfer for an append-only source correction. Applications
 * are append-preserved settlement evidence: the correction moves the
 * document's open-item line, so each live application is retained through
 * its one legal unapply transition and an equivalent application is
 * appended to the replacement endpoint. Extracted from posting-replay.ts so
 * both the replay operation and this transfer stay focused modules.
 */
export async function transferCorrectionApplications(
  tx: Tx,
  opts: {
    orgId: string;
    documentId: string;
    documentNumber: string;
    /** Lines of the original (reversed) entry. */
    existing: CorrectionLine[];
    /** Replacement kernel lines with their posted ids joined. */
    replacementLines: CorrectionLine[];
    activeApplications: Array<typeof schema.applications.$inferSelect>;
    actorId: string;
    requestId: string;
    reason: string;
  },
): Promise<TransferredApplication[]> {
  const { orgId, documentNumber, existing, replacementLines, activeApplications } = opts;
  const priorLineIds = new Set(existing.map((line) => line.id));
  const transferredApplications: TransferredApplication[] = [];
  const replacementEndpoint = (lineId: string): string => {
    if (!priorLineIds.has(lineId)) return lineId;
    const prior = existing.find((line) => line.id === lineId)!;
    const exact = replacementLines.filter(
      (line) =>
        line.isOpenItem &&
        line.accountId === prior.accountId &&
        line.partyId === prior.partyId &&
        line.subsidiaryId === prior.subsidiaryId &&
        line.currency === prior.currency,
    );
    const candidates = exact.length
      ? exact
      : replacementLines.filter(
          (line) =>
            line.isOpenItem &&
            line.partyId === prior.partyId &&
            line.subsidiaryId === prior.subsidiaryId &&
            line.currency === prior.currency,
        );
    if (candidates.length !== 1) {
      throw new PostingError(
        `cannot transfer application endpoint ${lineId}: expected one replacement open-item line, found ${candidates.length}`,
      );
    }
    return candidates[0]!.id;
  };
  // Settlement evidence moves verbatim onto the replacement endpoints, and the
  // database re-validates every transferred application at commit
  // (app_validate_endpoints plus the deferred app_check_open). A deferred
  // refusal surfaces as a raw driver error after the reversal and replacement
  // are already written, so prove the transfer fits FIRST — the same endpoint
  // sharing and open-capacity arithmetic the triggers enforce — and refuse
  // with an attributable error, the way a void with live applications does.
  // The whole correction still rolls back atomically; the operator unapplies
  // the settlements, corrects, and re-applies.
  if (activeApplications.length > 0) {
    const outsideIds = [
      ...new Set(
        activeApplications.flatMap((application) => [
          application.fromLineId,
          application.toLineId,
        ]),
      ),
    ].filter((id) => !priorLineIds.has(id));
    const outsideRows =
      outsideIds.length === 0
        ? []
        : await tx
            .select()
            .from(schema.journalLines)
            .where(
              and(
                eq(schema.journalLines.orgId, orgId),
                inArray(schema.journalLines.id, outsideIds),
              ),
            );
    const outsideById = new Map(outsideRows.map((line) => [line.id, line]));
    const replacementById = new Map(
      replacementLines.map((line) => [line.id, line]),
    );
    const endpointOf = (lineId: string) => {
      const replacementId = replacementEndpoint(lineId);
      const line =
        replacementById.get(replacementId) ?? outsideById.get(replacementId);
      if (!line) {
        throw new PostingError(
          `cannot transfer application endpoint ${lineId}: the settlement line is missing`,
        );
      }
      return line;
    };
    const magnitude = (value: string): bigint => {
      const units = toUnits(value);
      return units < 0n ? -units : units;
    };
    const transferredLoad = new Map<
      string,
      { toAmount: bigint; toTxn: bigint; fromAmount: bigint; fromTxn: bigint }
    >();
    const loadOf = (id: string) => {
      const load = transferredLoad.get(id) ?? {
        toAmount: 0n,
        toTxn: 0n,
        fromAmount: 0n,
        fromTxn: 0n,
      };
      transferredLoad.set(id, load);
      return load;
    };
    const remappedIds = new Set<string>();
    for (const application of activeApplications) {
      const from = endpointOf(application.fromLineId);
      const to = endpointOf(application.toLineId);
      if (priorLineIds.has(application.fromLineId)) remappedIds.add(from.id);
      if (priorLineIds.has(application.toLineId)) remappedIds.add(to.id);
      if (!from.isOpenItem || !to.isOpenItem) {
        throw new PostingError(
          `source correction of ${documentNumber} cannot transfer application ${application.id}: a replacement endpoint is not an open item — unapply the settlements before correcting`,
        );
      }
      if (
        from.accountId !== to.accountId ||
        (from.partyId ?? null) !== (to.partyId ?? null) ||
        from.subsidiaryId !== to.subsidiaryId
      ) {
        throw new PostingError(
          `source correction of ${documentNumber} cannot transfer application ${application.id}: the replacement endpoints no longer share one account, party, and subsidiary — unapply the settlements before correcting`,
        );
      }
      const fromSign = toUnits(from.amount) > 0n;
      if ((toUnits(to.amount) > 0n) === fromSign) {
        throw new PostingError(
          `source correction of ${documentNumber} cannot transfer application ${application.id}: the replacement endpoints no longer have opposite debit/credit signs — unapply the settlements before correcting`,
        );
      }
      const toLoad = loadOf(to.id);
      toLoad.toAmount += magnitude(application.amount);
      toLoad.toTxn += magnitude(application.targetTransactionAmount);
      const fromLoad = loadOf(from.id);
      fromLoad.fromAmount += magnitude(application.sourceAmount);
      fromLoad.fromTxn += magnitude(application.sourceTransactionAmount);
    }
    for (const id of remappedIds) {
      // Endpoints outside the corrected entry keep their lines and shed load,
      // so only remapped endpoints can newly overflow.
      const line = replacementById.get(id)!;
      const load = loadOf(id);
      const capacity = magnitude(line.amount);
      const txnCapacity = magnitude(line.txnAmount ?? line.amount);
      const breach =
        load.toAmount > capacity
          ? `${fromUnits(load.toAmount)} applied exceeds the replacement line's open ${fromUnits(capacity)}`
          : load.fromAmount > capacity
            ? `${fromUnits(load.fromAmount)} applied exceeds the replacement line's open ${fromUnits(capacity)}`
            : load.toTxn > txnCapacity || load.fromTxn > txnCapacity
              ? `the transferred settlement exceeds the replacement line's transaction amount`
              : null;
      if (breach) {
        throw new PostingError(
          `source correction of ${documentNumber} cannot transfer its live applications onto the corrected entry: ${breach} — unapply the settlements before correcting`,
        );
      }
    }
  }
  const correctedAt = new Date();
  for (const application of activeApplications) {
    const fromLineId = replacementEndpoint(application.fromLineId);
    const toLineId = replacementEndpoint(application.toLineId);
    const released = await tx
      .update(schema.applications)
      .set({
        unappliedAt: correctedAt,
        updatedAt: correctedAt,
        updatedBy: opts.actorId,
      })
      .where(
        and(
          eq(schema.applications.id, application.id),
          eq(schema.applications.orgId, orgId),
          sql`${schema.applications.unappliedAt} is null`,
        ),
      )
      .returning({ id: schema.applications.id });
    if (released.length !== 1) {
      throw new PostingError(
        `application ${application.id} changed during source correction`,
      );
    }
    const replacementApplication = (await tx
      .insert(schema.applications)
      .values({
        orgId: application.orgId,
        fromLineId,
        toLineId,
        amount: application.amount,
        sourceAmount: application.sourceAmount,
        sourceTransactionAmount: application.sourceTransactionAmount,
        sourceTransactionCurrency: application.sourceTransactionCurrency,
        targetTransactionAmount: application.targetTransactionAmount,
        targetTransactionCurrency: application.targetTransactionCurrency,
        settlementRate: application.settlementRate,
        settlementRateSource: application.settlementRateSource,
        settlementRateReference: application.settlementRateReference,
        settlementFxRateId: application.settlementFxRateId,
        appliedOn: application.appliedOn,
        fxGainLossEntryId: application.fxGainLossEntryId,
        createdBy: opts.actorId,
        updatedBy: opts.actorId,
      })
      .returning({ id: schema.applications.id }))[0]!;
    transferredApplications.push({
      priorApplicationId: application.id,
      replacementApplicationId: replacementApplication.id,
      priorFromLineId: application.fromLineId,
      replacementFromLineId: fromLineId,
      priorToLineId: application.toLineId,
      replacementToLineId: toLineId,
    });
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (
          ${orgId}, 'applications', ${application.id}, 'update',
          ${JSON.stringify({
            mode: "append_only_source_correction",
            reason: opts.reason,
            replacementApplicationId: replacementApplication.id,
            before: { unappliedAt: null },
            after: { unappliedAt: correctedAt.toISOString() },
          })}::jsonb,
          ${opts.actorId}, ${opts.requestId}
        ),
        (
          ${orgId}, 'applications', ${replacementApplication.id}, 'insert',
          ${JSON.stringify({
            mode: "append_only_source_correction",
            reason: opts.reason,
            priorApplicationId: application.id,
            fromLineId,
            toLineId,
          })}::jsonb,
          ${opts.actorId}, ${opts.requestId}
        )
    `);
  }
  return transferredApplications;
}
