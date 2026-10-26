import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import {
  proposeProvisionAssessment,
  applyProvisionAssessment,
  type ProvisionProposal,
} from "./assessments.ts";
import { ProvisionError } from "./measurement.ts";

// A closed-period refusal must survive the provision domain wrap with its
// locked scope intact: the API boundary can only link the controlled reopen
// request when the typed details reach it, not from message text.
test(
  "a closed-period provision refusal keeps the typed reopen scope",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await grantScratchPermissions(org.orgId, actors.approver1Id, ["gl.manage"]);
      const expense = randomUUID(),
        liability = randomUUID();
      await withBypassContext(async () => {
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{reportingFramework}','"ifrs"') where id=${org.orgId}`,
        );
        await db.execute(sql`insert into accounts(id,org_id,number,name,type) values
        (${expense},${org.orgId},'PROV-EXP','Provision expense','expense'),
        (${liability},${org.orgId},'PROV-LIAB','Provision liability','liability_current_other')`);
        await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values
        (${org.orgId},${actors.submitterId},'gl.manage','grant'),
        (${org.orgId},${actors.submitterId},'gl.post','grant')`);
        await seedApprovalFlow(org.orgId, {
          subjectKind: "financial_change",
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "any",
          preventSelfApproval: true,
        });
      });
      await withOrgContext(org.orgId, async () => {
        const input: ProvisionProposal = {
          obligation: {
            id: randomUUID(),
            subsidiaryId: org.subsidiaryId,
            bookId: org.bookId,
            name: "Defective-work legal claim",
            currency: "CAD",
            expenseAccountId: expense,
            liabilityAccountId: liability,
          },
          effectiveOn: org.date,
          reason: "Accrue the supported probable settlement obligation",
          idempotencyKey: randomUUID(),
          assessment: {
            presentObligation: true,
            outflow: "probable",
            reliablyEstimable: true,
            evidence:
              "Counsel confirms a present legal obligation from defective work and a probable settlement.",
            discounting: "immaterial",
            discountEvidence:
              "Settlement is expected shortly; counsel confirms time value is immaterial.",
            estimate: { method: "best_estimate", amount: "50000" },
          },
        };
        const changeId = await proposeProvisionAssessment(org.orgId, actors.submitterId, input);
        await submitFinancialChange(org.orgId, changeId, actors.submitterId);
        const gate = (
          await db.execute<{ id: string }>(
            sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${changeId} and status='pending'`,
            "objects",
          )
        )[0]!;
        await decideGate({ gateId: gate.id, userId: actors.approver1Id, decision: "approved" });
        await withBypassContext(() =>
          db.execute(sql`insert into period_locks
        (org_id,period_id,book_id,subsidiary_id,module,state,locked_at,reason)
        values (${org.orgId},${org.periodId},${org.bookId},${org.subsidiaryId},'gl','closed',now(),'Completed period close')`),
        );
        const failure = await applyProvisionAssessment(
          org.orgId,
          changeId,
          actors.submitterId,
        ).then(
          () => null,
          (error: unknown) => error,
        );
        assert.ok(failure instanceof ProvisionError);
        assert.match(failure.message, /controlled reopen workflow/);
        assert.deepEqual(failure.details, {
          kind: "period-closed",
          periodId: org.periodId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          module: "gl",
        });
        assert.equal(
          (
            await db.execute<{ status: string }>(
              sql`select status from financial_changes where org_id=${org.orgId} and id=${changeId}`,
              "objects",
            )
          )[0]!.status,
          "approved",
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
