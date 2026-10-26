import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { routeSubjectSubmission } from "@openbooks/engine/flows/submission-policy";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { BANK_ACCOUNT_SUBJECT_KIND } from "@openbooks/engine/flows/bank-accounts-adapter";
import { defineRoute } from "../../../../../../lib/api/route";
import { isUuid } from "../../../../../../lib/list-params";
import {
  authorizePartyBankWrite,
  denyLockedOutsidePartyScope,
  denyOutsidePartyScope,
} from "../party-scope";
import { notFound } from "@/lib/api/responses";

/**
 * A submit refusal raised INSIDE the submit transaction so the dispatch rolls
 * back with it. Returning a 422 from inside withOrgTransaction would COMMIT
 * whatever the dispatch opened — a sibling flow's live gates would survive
 * the refusal and could later release the record. The outer catch maps this
 * to the 422 the surface renders.
 */

class BankAccountSubmitError extends Error {}

export const runtime = "nodejs";

/** Submit the current pending bank details through tenant Flow routing. */
export const POST = defineRoute({
  // Same WHO as the bank writes: master data everywhere, HR/payroll for an
  // employee's own direct-deposit record. Submission only (re-)drives the
  // approval flow; deciding stays in the approvals centre.
  authorize: authorizePartyBankWrite,
  feature: {
    none: "Party bank detail submission is governed by party permissions and approval flows.",
  },
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
    const { user } = gate;
    const { id: partyId } = params;

    const accountId = new URL(req.url).searchParams.get("accountId") ?? "";
    if (!isUuid(partyId) || !isUuid(accountId)) {
      return NextResponse.json({ error: "bad ids" }, { status: 400 });
    }
    const partyDenied = await denyOutsidePartyScope(gate, partyId);
    if (partyDenied) return partyDenied;

    // Lock the row through dispatch: two simultaneous submits serialize here,
    // and the loser sees the winner's live gate and refuses instead of
    // double-driving the flow.
    return withOrgTransaction(user.orgId, async () => {
      const lockedDenied = await denyLockedOutsidePartyScope(db, gate, partyId);
      if (lockedDenied) return lockedDenied;
      const existing = await db.execute<{
        approvalStatus: string;
        retiredAt: string | null;
      }>(
        sql`
      select approval_status as "approvalStatus", retired_at as "retiredAt"
        from party_bank_accounts
       where id = ${accountId} and party_id = ${partyId} and org_id = ${user.orgId}
       for update
    `,
        "objects",
      );
      if (existing.length === 0) return notFound("record");
      const account = existing[0]!;
      if (account.retiredAt) {
        return NextResponse.json(
          { error: "retired bank details cannot be submitted for approval" },
          { status: 422 },
        );
      }
      if (account.approvalStatus !== "pending") {
        return NextResponse.json(
          {
            error: "only bank details awaiting approval can be submitted for approval",
          },
          { status: 422 },
        );
      }
      // Live gates own the record — deciding happens in the approvals centre.
      const live = await db.execute<{ id: string }>(
        sql`
      select id from flow_gates
       where org_id = ${user.orgId}
         and subject_kind = ${BANK_ACCOUNT_SUBJECT_KIND}
         and subject_id = ${accountId}
         and status in ('pending', 'escalated')
       limit 1
    `,
        "objects",
      );
      if (live[0]) {
        return NextResponse.json(
          {
            error:
              "these bank details are already awaiting approval — decide them in the approvals centre",
          },
          { status: 409 },
        );
      }
      const latest = (
        await db.execute<{ id: string; status: string }>(
          sql`
      select id, status from flow_runs
       where org_id = ${user.orgId}
         and subject_kind = ${BANK_ACCOUNT_SUBJECT_KIND}
         and subject_id = ${accountId}
       order by started_at desc
       limit 1
    `,
          "objects",
        )
      )[0];
      // A submit only (re-)drives a record whose runs are all terminal. A
      // failed latest run belongs to the retry path (same run row, resumed
      // idempotently); a running/waiting run is already driving the record.
      if (latest && latest.status !== "completed" && latest.status !== "cancelled") {
        if (latest.status === "failed") {
          return NextResponse.json(
            {
              error: "these bank details have a failed approval run — retry that run instead",
            },
            { status: 409 },
          );
        }
        return NextResponse.json(
          {
            error: "an approval run is already in flight for these bank details",
          },
          { status: 409 },
        );
      }

      const routed = await routeSubjectSubmission({
        orgId: user.orgId,
        actorId: user.id,
        subjectKind: BANK_ACCOUNT_SUBJECT_KIND,
        subjectId: accountId,
        event: { kind: "on_create", source: "ui" },
      });
      const flows = routed.dispatch;
      // Approvals are optional Flows: with no enabled flow listening, an
      // explicit submit applies the details directly (audited) instead of
      // refusing and leaving the row pending with no run and no gate. This is
      // also the recovery for records stranded pending before any flow
      // existed: the operator submits, and with nothing to govern them the
      // details activate.
      if (routed.policy.kind === "ungated") {
        const today = await businessToday(user.orgId);
        const applied = await db.execute(
          sql`
        update party_bank_accounts
           set approval_status = 'approved', approved_at = ${today},
               approved_by = ${user.id}, is_active = true,
               updated_at = now(), updated_by = ${user.id}
         where id = ${accountId} and party_id = ${partyId} and org_id = ${user.orgId}
           and approval_status = 'pending' and retired_at is null
         returning id`,
          "objects",
        );
        if (!applied[0]) {
          throw new BankAccountSubmitError(
            "these bank details changed while submitting — reload and submit again",
          );
        }
        await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${user.orgId}, 'party_bank_accounts', ${accountId}, 'approve',
          ${JSON.stringify({
            mode: "ungated",
            outcome: "approved",
            submissionId: routed.submissionId,
            policy: routed.policy,
          })}::jsonb,
          ${user.id}, ${req.headers.get("X-Request-Id")}
        )
      `);
        return NextResponse.json({
          id: accountId,
          approvalStatus: "approved",
          directApplied: true,
        });
      }
      const runId = flows.runs[0]?.runId ?? null;
      await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${user.orgId}, 'party_bank_accounts', ${accountId}, 'update',
        ${JSON.stringify({
          mode: "bank_detail_submitted_to_flow",
          runId,
          gatesCreated: flows.gatesCreated,
        })}::jsonb,
        ${user.id}, 'ui'
      )
    `);
      return NextResponse.json({
        id: accountId,
        approvalStatus: "pending",
        runId,
        gatesCreated: flows.gatesCreated,
      });
    }).catch((e) => {
      if (e instanceof BankAccountSubmitError) {
        return apiErrorResponse(e, { safeStatus: 422 });
      }
      throw e;
    });
  },
});
