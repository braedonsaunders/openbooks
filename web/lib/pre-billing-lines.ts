import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { add, cmp } from "@openbooks/engine/money/money";
import {
  documentRevisionCounterSql,
  isDocumentRevisionToken,
} from "@openbooks/engine/records/revision";
import { lockProjectForScope, ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import {
  PreBillingError,
  type PreBillingSourceType,
  type PrebillStatus,
  type SubsidiaryScope,
  type UpdatePrebillLineInput,
  appendEvent,
  assertPreBillingEnabledTx,
  audit,
  currentPolicyIsNte,
  evidenceList,
  loadProjectPolicy,
  persistMoney,
  refreshTotals,
  remainingContractCapacity,
} from "./pre-billing-core";

export async function updatePrebillLine(
  orgId: string,
  actorId: string,
  prebillId: string,
  lineId: string,
  input: UpdatePrebillLineInput,
  scope: SubsidiaryScope = null,
  options: { expectedRevision: string },
) {
  const proposed = persistMoney(input.proposedBillAmount, "Proposed bill amount");
  const evidence = evidenceList(input.adjustmentEvidence);
  // Mandatory optimistic-concurrency evidence (same contract as document and
  // payment edits): two tabs adjusting one line must 409 instead of silently
  // overwriting each other's billed amounts.
  if (!isDocumentRevisionToken(options.expectedRevision)) {
    throw new PreBillingError(
      "A current line revision is required; reload the worksheet and try again",
      409,
    );
  }
  return db.transaction(async (tx) => {
    await assertPreBillingEnabledTx(tx, orgId);
    const current = await tx.execute<{
      proposed: string;
      original: string;
      status: PrebillStatus;
      project_id: string;
      period_end: string;
      custom: { policy?: { totalPriceMethod?: string } };
      other_proposed: string;
      revision: string;
    }>(
      sql`
      select line.proposed_bill_amount::text as proposed, line.original_bill_amount::text as original,
             worksheet.status, worksheet.project_id, worksheet.period_end::text as period_end,
             worksheet.custom,
             ${documentRevisionCounterSql(sql`line.revision_seq`)} as revision,
             coalesce((select sum(other.proposed_bill_amount) from prebill_lines other
                        where other.org_id = line.org_id and other.prebill_id = line.prebill_id
                          and other.id <> line.id and other.disposition = 'bill'), 0)::text as other_proposed
        from prebill_lines line
        join prebills worksheet on worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
        join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
       where line.org_id = ${orgId} and line.prebill_id = ${prebillId} and line.id = ${lineId}
         ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
       for update of line, worksheet
    `,
      "objects",
    );
    const before = current[0];
    if (!before) throw new PreBillingError("Prebill line not found", 404);
    // Pin the project for the rest of this transaction and recheck scope
    // under the lock: the line/worksheet lock above does not stop a
    // concurrent A→B rehome from moving this edit onto B's project.
    try {
      await lockProjectForScope(tx, orgId, before.project_id, scope);
    } catch (error) {
      if (error instanceof ScopeNotFoundError)
        throw new PreBillingError("Prebill line not found", 404);
      throw error;
    }
    if (before.status !== "draft") throw new PreBillingError("Only a draft prebill can be edited");
    if (before.revision !== options.expectedRevision) {
      throw new PreBillingError(
        "This line changed after you opened it; reload the worksheet and reapply your adjustment",
        409,
      );
    }
    if (
      (cmp(before.original, "0") >= 0 && cmp(proposed, "0") < 0) ||
      (cmp(before.original, "0") < 0 && cmp(proposed, "0") > 0)
    ) {
      throw new PreBillingError("A billing adjustment cannot reverse the source line sign");
    }
    const changed = cmp(proposed, before.original) !== 0;
    const reason = input.adjustmentReason?.trim() || null;
    if (changed && !reason)
      throw new PreBillingError("A reason is required for a write-up or write-down");
    if (changed && evidence.length === 0)
      throw new PreBillingError("Evidence is required for a write-up or write-down");
    if (
      before.custom?.policy?.totalPriceMethod === "not_to_exceed" ||
      (await currentPolicyIsNte(tx, orgId, before.project_id, before.period_end))
    ) {
      // Lock the project and recheck scope in the same transaction: an
      // unlocked re-read would authorize a stale subsidiary when a
      // concurrent A→B rehome lands between the line lock above and this
      // policy read.
      const policy = await loadProjectPolicy(tx, orgId, before.project_id, true, scope);
      const capacity = await remainingContractCapacity(
        tx,
        orgId,
        policy,
        before.period_end,
        prebillId,
      );
      if (capacity != null && cmp(add(before.other_proposed, proposed), capacity) > 0) {
        throw new PreBillingError(
          `Proposed billing exceeds the remaining not-to-exceed capacity of ${capacity}`,
        );
      }
    }
    await tx.execute(sql`
      update prebill_lines
         set proposed_bill_amount = ${proposed},
             adjustment_amount = ${proposed}::numeric - original_bill_amount,
             adjustment_reason = ${changed ? reason : null},
             adjustment_evidence = ${JSON.stringify(changed ? evidence : [])}::jsonb,
             updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
             updated_by = ${actorId}
       where org_id = ${orgId} and prebill_id = ${prebillId} and id = ${lineId}
    `);
    await refreshTotals(tx, orgId, prebillId, actorId);
    await appendEvent(tx, orgId, prebillId, actorId, "line_updated", {
      lineId,
      before: before.proposed,
      after: proposed,
      reason: changed ? reason : null,
      evidence: changed ? evidence : [],
    });
    await audit(tx, orgId, "prebill_lines", lineId, actorId, {
      before: { proposed: before.proposed },
      after: { proposed },
    });
    return { id: lineId, proposedBillAmount: proposed };
  });
}

export async function holdPrebillLine(
  orgId: string,
  actorId: string,
  prebillId: string,
  lineId: string,
  reason: string,
  evidence: string[] = [],
  scope: SubsidiaryScope = null,
) {
  const cleanReason = reason.trim();
  if (!cleanReason) throw new PreBillingError("A hold reason is required");
  const cleanEvidence = evidenceList(evidence);
  return db.transaction(async (tx) => {
    await assertPreBillingEnabledTx(tx, orgId);
    const target = (
      await tx.execute<{ project_id: string }>(
        sql`
      select worksheet.project_id
        from prebill_lines line
        join prebills worksheet on worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
       where line.org_id = ${orgId} and line.prebill_id = ${prebillId} and line.id = ${lineId}
    `,
        "objects",
      )
    )[0];
    if (!target) throw new PreBillingError("Prebill line not found", 404);
    try {
      await lockProjectForScope(tx, orgId, target.project_id, scope);
    } catch (error) {
      if (error instanceof ScopeNotFoundError)
        throw new PreBillingError("Prebill line not found", 404);
      throw error;
    }
    const row = await tx.execute<{
      source_type: PreBillingSourceType;
      source_id: string;
      project_id: string;
      status: PrebillStatus;
    }>(
      sql`
      select line.source_type, coalesce(line.time_entry_id, line.document_line_id) as source_id,
             line.project_id, worksheet.status
        from prebill_lines line
        join prebills worksheet on worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
        join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
       where line.org_id = ${orgId} and line.prebill_id = ${prebillId} and line.id = ${lineId}
         ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
       for update of line, worksheet
    `,
      "objects",
    );
    const source = row[0];
    if (!source) throw new PreBillingError("Prebill line not found", 404);
    if (source.status !== "draft") throw new PreBillingError("Only a draft prebill can be changed");
    const existing = await tx.execute<{ id: string }>(
      sql`
      select id from prebill_holds
       where org_id = ${orgId} and source_type = ${source.source_type}
         and source_id = ${source.source_id} and released_at is null
       for update
    `,
      "objects",
    );
    let holdId = existing[0]?.id;
    if (!holdId) {
      const inserted = await tx.execute<{ id: string }>(
        sql`
        insert into prebill_holds (
          org_id, project_id, source_type, source_id, reason, evidence, held_by,
          created_by, updated_by
        ) values (
          ${orgId}, ${source.project_id}, ${source.source_type}, ${source.source_id},
          ${cleanReason}, ${JSON.stringify(cleanEvidence)}::jsonb, ${actorId}, ${actorId}, ${actorId}
        ) returning id
      `,
        "objects",
      );
      holdId = inserted[0]!.id;
    }
    await tx.execute(sql`
      update prebill_lines set disposition = 'hold', updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${lineId}
    `);
    await refreshTotals(tx, orgId, prebillId, actorId);
    await appendEvent(tx, orgId, prebillId, actorId, "hold_created", {
      lineId,
      holdId,
      reason: cleanReason,
      evidence: cleanEvidence,
    });
    return { id: holdId };
  });
}

export async function releasePrebillHold(
  orgId: string,
  actorId: string,
  holdId: string,
  reason: string,
  scope: SubsidiaryScope = null,
) {
  const releaseReason = reason.trim();
  if (!releaseReason) throw new PreBillingError("A release reason is required");
  return db.transaction(async (tx) => {
    await assertPreBillingEnabledTx(tx, orgId);
    // Read only enough to find the project's serialization fence. The hold
    // stays unlocked until the project row is locked, so a concurrent rehome
    // cannot pass between authorization and release.
    const target = (
      await tx.execute<{ project_id: string }>(
        sql`
      select project_id from prebill_holds
       where org_id = ${orgId} and id = ${holdId} and released_at is null
    `,
        "objects",
      )
    )[0];
    if (!target) throw new PreBillingError("Active hold not found", 404);
    try {
      await lockProjectForScope(tx, orgId, target.project_id, scope);
    } catch (error) {
      if (error instanceof ScopeNotFoundError)
        throw new PreBillingError("Active hold not found", 404);
      throw error;
    }
    const released = await tx.execute<{ source_type: PreBillingSourceType; source_id: string }>(
      sql`
      update prebill_holds
         set released_at = now(), released_by = ${actorId}, release_reason = ${releaseReason},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${holdId} and project_id = ${target.project_id}
         and released_at is null
       returning source_type, source_id
    `,
      "objects",
    );
    const source = released[0];
    if (!source) throw new PreBillingError("Active hold not found", 404);
    const prebillRows = await tx.execute<{ prebill_id: string }>(
      sql`
      update prebill_lines line
         set disposition = 'bill', updated_at = now(), updated_by = ${actorId}
        from prebills worksheet
       where line.org_id = ${orgId}
         and worksheet.org_id = line.org_id and worksheet.id = line.prebill_id
         and worksheet.project_id = ${target.project_id}
         and worksheet.status = 'draft'
         and line.source_type = ${source.source_type}
         and coalesce(line.time_entry_id, line.document_line_id) = ${source.source_id}
       returning line.prebill_id
    `,
      "objects",
    );
    for (const row of prebillRows) {
      await refreshTotals(tx, orgId, row.prebill_id, actorId);
      await appendEvent(tx, orgId, row.prebill_id, actorId, "hold_released", {
        holdId,
        reason: releaseReason,
      });
    }
    await audit(tx, orgId, "prebill_holds", holdId, actorId, {
      after: { releasedAt: "now", releaseReason },
    });
    return { id: holdId };
  });
}
