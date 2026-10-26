import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
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
  provisionEditorOptions,
  type ProvisionProposal,
} from "./assessments.ts";
import { measureProvision } from "./measurement.ts";

const RUNTIME_DB = process.env.OPENBOOKS_RUNTIME_DB_URL;

test(
  "independent provision assessments recognize and remeasure one tenant liability without duplicate or stale posting",
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
        const approve = async (id: string) => {
          await submitFinancialChange(org.orgId, id, actors.submitterId);
          const gate = (
            await db.execute<{ id: string }>(
              sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${id} and status='pending'`,
              "objects",
            )
          )[0]!;
          await decideGate({ gateId: gate.id, userId: actors.approver1Id, decision: "approved" });
        };
        const contingent = await proposeProvisionAssessment(org.orgId, actors.submitterId, {
          ...input,
          idempotencyKey: randomUUID(),
          assessment: { ...input.assessment, outflow: "possible", estimate: null },
        });
        await approve(contingent);
        const disclosed = await applyProvisionAssessment(org.orgId, contingent, actors.submitterId);
        assert.equal(disclosed.liability, "0.0000");
        assert.equal(disclosed.disclosureRequired, true);
        assert.equal(disclosed.entryId, null);
        const first = await proposeProvisionAssessment(org.orgId, actors.submitterId, input);
        assert.equal(await proposeProvisionAssessment(org.orgId, actors.submitterId, input), first);
        await assert.rejects(
          applyProvisionAssessment(org.orgId, first, actors.submitterId),
          /approval policy/,
        );
        await approve(first);
        const initial = await applyProvisionAssessment(org.orgId, first, actors.submitterId);
        assert.equal(initial.liability, "50000.0000");
        assert.equal(initial.currentPeriodCharge, "50000.0000");
        assert.deepEqual(
          await applyProvisionAssessment(org.orgId, first, actors.submitterId),
          initial,
        );
        const review = await proposeProvisionAssessment(org.orgId, actors.submitterId, {
          ...input,
          idempotencyKey: randomUUID(),
          reason: "Revise the claim estimate after updated counsel evidence",
          assessment: {
            ...input.assessment,
            estimate: { method: "best_estimate", amount: "65000" },
          },
        });
        const stale = await proposeProvisionAssessment(org.orgId, actors.submitterId, {
          ...input,
          idempotencyKey: randomUUID(),
          reason: "Alternative assessment prepared against the same opening liability",
        });
        await approve(review);
        await approve(stale);
        const updated = await applyProvisionAssessment(org.orgId, review, actors.submitterId);
        assert.equal(updated.liability, "65000.0000");
        assert.equal(updated.currentPeriodCharge, "15000.0000");
        await assert.rejects(
          applyProvisionAssessment(org.orgId, stale, actors.submitterId),
          /changed after this proposal/,
        );
        const posted = (
          await db.execute<{ count: number; amount: string; balanced: boolean }>(
            sql`
        select count(distinct entry.id)::int as count, sum(-line.amount) filter(where line.account_id=${liability})::text as amount,
          sum(line.amount)=0 as balanced from journal_entries entry join journal_lines line on line.org_id=entry.org_id and line.entry_id=entry.id
         where entry.org_id=${org.orgId} and entry.origin='provision' and entry.status='posted'
      `,
            "objects",
          )
        )[0]!;
        assert.equal(posted.count, 2);
        assert.equal(posted.amount, "65000.0000");
        assert.equal(posted.balanced, true);
        const range = {
          ...input.assessment,
          estimate: {
            method: "no_better_estimate_range" as const,
            minimum: "50000",
            maximum: "65000",
          },
        };
        assert.equal(measureProvision("us_gaap", range).liability, "50000.0000");
        assert.throws(() => measureProvision("ifrs", range), /supported best estimate/);
        assert.equal(
          measureProvision("ifrs", {
            ...range,
            estimate: { ...range.estimate, method: "uniform_range" },
          }).liability,
          "57500.0000",
        );
        assert.throws(
          () =>
            measureProvision("us_gaap", {
              ...input.assessment,
              estimate: {
                method: "expected_value",
                outcomes: [{ amount: "50000", probability: "1" }],
              },
            }),
          /rather than weighting possible losses/,
        );
        const unchanged = await proposeProvisionAssessment(org.orgId, actors.submitterId, {
          ...input,
          idempotencyKey: randomUUID(),
          assessment: {
            ...input.assessment,
            estimate: { method: "best_estimate", amount: "65000" },
          },
        });
        await approve(unchanged);
        await withBypassContext(() =>
          db.execute(sql`insert into period_locks
        (org_id,period_id,book_id,subsidiary_id,module,state,locked_at,reason)
        values (${org.orgId},${org.periodId},${org.bookId},${org.subsidiaryId},'gl','closed',now(),'Completed period close')`),
        );
        await assert.rejects(
          applyProvisionAssessment(org.orgId, unchanged, actors.submitterId),
          /controlled reopen workflow/,
        );
        assert.equal(
          (
            await db.execute<{ status: string }>(
              sql`select status from financial_changes where org_id=${org.orgId} and id=${unchanged}`,
              "objects",
            )
          )[0]!.status,
          "approved",
        );
        // Tenant isolation holds at the storage fence, so prove it through the
        // login production traffic uses. PostgreSQL does not apply row
        // security (forced included) to the harness superuser login, so a raw
        // cross-organization read through the pool sees every row and proves
        // nothing — the runtime login is the role the policy constrains.
        if (RUNTIME_DB) {
          const probe = new pg.Client({ connectionString: RUNTIME_DB });
          try {
            await probe.connect();
            await probe.query(
              `select set_config('app.current_org', $1, false), set_config('app.bypass_rls', 'off', false)`,
              [randomUUID()],
            );
            const hidden = await probe.query(`select id from provision_obligations where id = $1`, [
              input.obligation.id,
            ]);
            assert.deepEqual(hidden.rows, [], "another organization must not see this obligation");
            await probe.query(
              `select set_config('app.current_org', $1, false), set_config('app.bypass_rls', 'off', false)`,
              [org.orgId],
            );
            const seen = await probe.query<{ id: string }>(
              `select id from provision_obligations where id = $1`,
              [input.obligation.id],
            );
            assert.deepEqual(
              seen.rows.map((row) => row.id),
              [input.obligation.id],
              "the owning organization must still see it",
            );
          } finally {
            await probe.end().catch(() => {});
          }
        }
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "provision accounts are limited to subsidiaries admitted by their account restriction",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await grantScratchPermissions(org.orgId, actors.approver1Id, ["gl.manage"]);
      const subA = randomUUID(),
        subB = randomUUID(),
        expense = randomUUID(),
        liability = randomUUID();
      await withBypassContext(async () => {
        await db.execute(
          sql`update orgs set settings=settings || '{"reportingFramework":"ifrs"}'::jsonb where id=${org.orgId}`,
        );
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active) values
        (${subA},${org.orgId},${org.subsidiaryId},'Provision A','CAD','CA',true),
        (${subB},${org.orgId},${org.subsidiaryId},'Provision B','CAD','CA',true)`);
        await db.execute(sql`insert into accounts(id,org_id,number,name,type,subsidiary_id,subsidiary_include_children) values
        (${expense},${org.orgId},'PROV-SCOPED-EXP','Restricted provision expense','expense',${subB},false),
        (${liability},${org.orgId},'PROV-SCOPED-LIAB','Shared provision liability','liability_current_other',null,true)`);
        await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values
        (${org.orgId},${actors.submitterId},'gl.manage','grant')`);
      });
      await withOrgContext(org.orgId, async () => {
        const choices = await provisionEditorOptions(org.orgId, actors.submitterId);
        const restricted = choices.accounts.find((account) => account.id === expense);
        assert.ok(restricted, "an account assigned to a visible subsidiary remains available");
        assert.deepEqual(
          restricted.subsidiaryIds,
          [subB],
          "the option declares only the legal entity admitted by the account restriction",
        );
        const input: ProvisionProposal = {
          obligation: {
            id: randomUUID(),
            subsidiaryId: subA,
            bookId: org.bookId,
            name: "Cross-subsidiary claim",
            currency: "CAD",
            expenseAccountId: expense,
            liabilityAccountId: liability,
          },
          effectiveOn: org.date,
          reason: "Record a supported legal settlement obligation",
          idempotencyKey: randomUUID(),
          assessment: {
            presentObligation: true,
            outflow: "probable",
            reliablyEstimable: true,
            evidence: "Counsel confirms a present legal obligation and probable settlement.",
            discounting: "immaterial",
            discountEvidence: "The expected settlement date is near.",
            estimate: { method: "best_estimate", amount: "50000" },
          },
        };
        await assert.rejects(
          proposeProvisionAssessment(org.orgId, actors.submitterId, input),
          /available to the selected legal entity/,
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
