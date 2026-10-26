import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { defaultPostingSubsidiaryId, loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  RevenueRecognitionFeatureOffError,
  RevenueRecognitionError,
} from "./recognition-transaction-price.ts";
import { lockObligationContract } from "./recognition-schedule-build.ts";
import { recognitionDate } from "./recognition-dates.ts";

export interface RecognitionControlInput {
  action: "hold" | "release" | "deliver";
  reason: string;
  expectedRevision: number;
  effectiveOn?: string;
  evidence?: string;
}

/** Contract mutex serializes hold/release and delivery against journal posting
 * and contract amendments. Delivery evidence is append-only; cancellation and
 * correction use the existing governed revenue workflows. */
export async function controlRecognition(
  orgId: string,
  actorId: string,
  obligationId: string,
  input: RecognitionControlInput,
) {
  if (!input.reason || input.reason.trim().length < 8)
    throw new RevenueRecognitionError("Enter a review reason of at least eight characters");
  if (!["hold", "release", "deliver"].includes(input.action))
    throw new RevenueRecognitionError("Unknown recognition control");
  if (input.action === "deliver") {
    recognitionDate(input.effectiveOn ?? "", "delivery date");
    if (!input.evidence || input.evidence.trim().length < 8)
      throw new RevenueRecognitionError("Delivery requires acceptance or fulfillment evidence");
  }
  return withOrgTransaction(orgId, () =>
    db.transaction(async (tx) => {
      await lockObligationContract(tx, orgId, obligationId);
      const fallback = defaultPostingSubsidiaryId(await loadSubsidiaryContext(tx, orgId));
      const row = (
        await tx.execute<{
          id: string;
          subsidiary_id: string | null;
          status: string;
          recognition_held: boolean;
          control_revision: number;
          delivered_on: string | null;
        }>(
          sql`
      select o.id, coalesce(c.subsidiary_id,dl.subsidiary_id,d.subsidiary_id,p.subsidiary_id,${fallback}) as subsidiary_id, o.status, o.hold_reason, o.recognition_held, o.control_revision, o.delivered_on::text
      from performance_obligations o join revenue_contracts c on c.id=o.contract_id and c.org_id=o.org_id
      left join document_lines dl on dl.org_id=o.org_id and dl.id=o.document_line_id
      left join documents d on d.org_id=dl.org_id and d.id=dl.document_id
      left join projects p on p.org_id=c.org_id and p.id=c.project_id
      where o.org_id=${orgId} and o.id=${obligationId} for update of o
    `,
          "objects",
        )
      )[0];
      if (!row || !row.subsidiary_id) throw new ScopeNotFoundError();
      await lockActorCommandAuthority(tx, orgId, actorId, row.subsidiary_id, "ar.post");
      if (!(await lockAndCheckOrgFeature(tx, orgId, "revenueRecognition")))
        throw new RevenueRecognitionFeatureOffError();
      if (row.status === "cancelled")
        throw new RevenueRecognitionError(
          "Cancelled obligations cannot change recognition controls",
        );
      if (row.control_revision !== input.expectedRevision)
        throw new RevenueRecognitionError(
          "Recognition control changed; reopen the contract before retrying",
        );
      if (
        (input.action === "hold" && row.recognition_held) ||
        (input.action === "release" && !row.recognition_held) ||
        (input.action === "deliver" && row.delivered_on)
      ) {
        throw new RevenueRecognitionError(
          "The requested recognition transition has already occurred; reopen the contract",
        );
      }
      const next = (
        await tx.execute(
          sql`
      update performance_obligations set recognition_held=${input.action === "hold" ? true : input.action === "release" ? false : row.recognition_held},
        hold_reason=${input.action === "hold" ? input.reason.trim() : input.action === "release" ? null : sql`hold_reason`},
        delivered_on=${input.action === "deliver" ? input.effectiveOn : row.delivered_on},
        control_revision=control_revision+1, updated_at=now(), updated_by=${actorId}
      where org_id=${orgId} and id=${obligationId} and control_revision=${input.expectedRevision} returning id
    `,
          "objects",
        )
      )[0];
      if (!next)
        throw new RevenueRecognitionError(
          "Recognition control could not be saved; reopen the contract",
        );
      const event = (
        await tx.execute(
          sql`
      insert into recognition_control_events (org_id,obligation_id,actor_id,action,reason,effective_on,evidence,before_state,after_state)
      select ${orgId},o.id,${actorId},${input.action},${input.reason.trim()},${input.effectiveOn ?? null},${input.evidence ?? null},${JSON.stringify(row)}::jsonb,
        jsonb_build_object('recognitionHeld',o.recognition_held,'holdReason',o.hold_reason,'deliveredOn',o.delivered_on,'revision',o.control_revision)
      from performance_obligations o where o.id=${obligationId} and o.org_id=${orgId} returning id
    `,
          "objects",
        )
      )[0];
      if (!event) throw new RevenueRecognitionError("Recognition evidence could not be recorded");
      return { id: obligationId, revision: row.control_revision + 1 };
    }),
  );
}
