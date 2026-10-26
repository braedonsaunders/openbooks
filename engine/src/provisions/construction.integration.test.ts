import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, withOrgTransaction } from "../platform/db.ts";
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
import { postEntry } from "../journal/post-entry.ts";
import {
  projectLossPolicyMode,
  unassessedLossContracts,
  unownedContractProjects,
} from "../projects/loss-contracts.ts";

test(
  "governed construction forecasts recognize remaining loss once, refuse stale evidence and honor the Projects gate",
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
        const projectId = randomUUID();
        await withBypassContext(async () => {
          await db.execute(
            sql`insert into projects(id,org_id,code,name,subsidiary_id,contract_value) values (${projectId},${org.orgId},'LOSS-CONTRACT','Fixed-price construction',${org.subsidiaryId},'1000000')`,
          );
          await db.execute(
            sql`insert into project_tasks(org_id,project_id,name,estimated_cost) values (${org.orgId},${projectId},'Construction','1150000')`,
          );
          await db.execute(
            sql`insert into project_loss_policies(org_id,effective_from,mode,reason) values (${org.orgId},'2000-01-01','require','Loss contracts must be assessed before each close')`,
          );
          await db.execute(
            sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values (${org.orgId},${actors.submitterId},'projects.read','grant')`,
          );
        });
        const input: ProvisionProposal = {
          obligation: {
            id: randomUUID(),
            subsidiaryId: org.subsidiaryId,
            bookId: org.bookId,
            name: "Construction expected loss",
            currency: "CAD",
            expenseAccountId: expense,
            liabilityAccountId: liability,
            projectId,
          },
          effectiveOn: org.date,
          reason: "Provide the forecast contract loss in full immediately",
          idempotencyKey: randomUUID(),
          assessment: {
            presentObligation: true,
            outflow: "probable",
            reliablyEstimable: true,
            evidence:
              "Approved fixed-price contract with a supported forecast of direct and allocated costs.",
            discounting: "immaterial",
            discountEvidence: "Work will complete shortly and time value is immaterial.",
            estimate: null,
          },
          construction: {
            remainingCost: "950000",
            terminationAvailable: false,
            terminationCost: null,
            relatedAssetsReviewed: true,
            impairmentEvidence:
              "The controller reviewed related contract assets and no additional impairment is required.",
          },
        };
        const entry = async (number: string, lines: Parameters<typeof postEntry>[1]["lines"]) =>
          postEntry(db, {
            orgId: org.orgId,
            bookId: org.bookId,
            subsidiaryId: org.subsidiaryId,
            entryNumber: number,
            postingDate: org.date,
            periodId: org.periodId,
            origin: "manual",
            currency: "CAD",
            actorId: actors.submitterId,
            lines,
          });
        await entry("CONTRACT-RESULTS", [
          { accountId: expense, amount: "200000", projectId },
          { accountId: org.accounts.revenue, amount: "-200000", projectId },
        ]);
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
        await assert.rejects(
          proposeProvisionAssessment(org.orgId, actors.submitterId, {
            ...input,
            construction: { ...input.construction!, relatedAssetsReviewed: false },
          }),
          /post required impairments/,
        );
        // A forecast above contract value with no assessment in the period is
        // what the loss policy reports at close; applying the assessment clears it.
        const period = (
          await db.execute<{ starts_on: string; ends_on: string }>(
            sql`
        select starts_on::text, ends_on::text from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`,
            "objects",
          )
        )[0]!;
        const lossScope = {
          periodStartsOn: period.starts_on,
          periodEndsOn: period.ends_on,
          bookId: org.bookId,
          subsidiaryIds: [],
        };
        assert.equal(await projectLossPolicyMode(db, org.orgId, "1999-12-31"), "off");
        assert.equal(await projectLossPolicyMode(db, org.orgId, period.ends_on), "require");
        assert.deepEqual(
          (await unassessedLossContracts(db, org.orgId, lossScope)).map((row) => [
            row.code,
            row.contractValue,
            row.estimatedTotalCost,
          ]),
          [["LOSS-CONTRACT", "1000000.0000", "1150000.0000"]],
        );
        const change = await proposeProvisionAssessment(org.orgId, actors.submitterId, input);
        assert.equal(
          await proposeProvisionAssessment(org.orgId, actors.submitterId, input),
          change,
        );
        await approve(change);
        const result = await applyProvisionAssessment(org.orgId, change, actors.submitterId);
        assert.equal(result.liability, "150000.0000");
        assert.equal(result.currentPeriodCharge, "150000.0000");
        assert.deepEqual(
          await unassessedLossContracts(db, org.orgId, lossScope),
          [],
          "an assessment applied in the period satisfies the policy",
        );
        assert.deepEqual(
          await applyProvisionAssessment(org.orgId, change, actors.submitterId),
          result,
        );
        const review = {
          ...input,
          idempotencyKey: randomUUID(),
          construction: { ...input.construction!, remainingCost: "850000" },
        };
        const stale = await proposeProvisionAssessment(org.orgId, actors.submitterId, review);
        await approve(stale);
        await entry("FURTHER-CONTRACT-COST", [
          { accountId: expense, amount: "100000", projectId },
          { accountId: org.accounts.clearing, amount: "-100000" },
        ]);
        await assert.rejects(
          applyProvisionAssessment(org.orgId, stale, actors.submitterId),
          /changed after this proposal/,
        );
        const updated = await proposeProvisionAssessment(org.orgId, actors.submitterId, {
          ...review,
          idempotencyKey: randomUUID(),
        });
        await approve(updated);
        const reduced = await applyProvisionAssessment(org.orgId, updated, actors.submitterId);
        assert.equal(reduced.liability, "50000.0000");
        assert.equal(reduced.currentPeriodCharge, "-100000.0000");
        const exit = await proposeProvisionAssessment(org.orgId, actors.submitterId, {
          ...review,
          idempotencyKey: randomUUID(),
          construction: {
            ...review.construction!,
            terminationAvailable: true,
            terminationCost: "25000",
          },
        });
        await approve(exit);
        assert.equal(
          (await applyProvisionAssessment(org.orgId, exit, actors.submitterId)).liability,
          "25000.0000",
        );
        await withBypassContext(() =>
          db.execute(
            sql`update orgs set settings=jsonb_set(settings,'{features,projects}','false') where id=${org.orgId}`,
          ),
        );
        await assert.rejects(
          submitFinancialChange(org.orgId, stale, actors.submitterId),
          /Company Settings → Features/,
        );
        await assert.rejects(
          applyProvisionAssessment(org.orgId, change, actors.submitterId),
          /Company Settings → Features/,
        );
        await assert.rejects(
          proposeProvisionAssessment(org.orgId, actors.submitterId, {
            ...review,
            idempotencyKey: randomUUID(),
          }),
          /Company Settings → Features/,
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "loss-contract detection follows the project owner and the closing book",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    // Projects created without subsidiaries belong to the unique root entity,
    // so they are detected and can be assessed there. An assessment applied in
    // another book does not satisfy this book's close.
    const org = await createScratchOrg();
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await grantScratchPermissions(org.orgId, actors.approver1Id, ["gl.manage"]);
      const expense = randomUUID(),
        liability = randomUUID(),
        projectId = randomUUID(),
        taxBook = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`update orgs set settings=jsonb_set(jsonb_set(settings,'{reportingFramework}','"ifrs"'),
        '{features}',coalesce(settings->'features','{}'::jsonb)||'{"multiBookAccounting":true}'::jsonb) where id=${org.orgId}`);
        await db.execute(sql`insert into accounts(id,org_id,number,name,type) values
        (${expense},${org.orgId},'PROV-EXP','Provision expense','expense'),
        (${liability},${org.orgId},'PROV-LIAB','Provision liability','liability_current_other')`);
        await db.execute(
          sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${taxBook},${org.orgId},'TAX','Tax book',false,true,true)`,
        );
        await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values
        (${org.orgId},${actors.submitterId},'gl.manage','grant'),(${org.orgId},${actors.submitterId},'gl.post','grant'),
        (${org.orgId},${actors.submitterId},'projects.read','grant')`);
        await seedApprovalFlow(org.orgId, {
          subjectKind: "financial_change",
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "any",
          preventSelfApproval: true,
        });
        await db.execute(
          sql`insert into projects(id,org_id,code,name,contract_value) values (${projectId},${org.orgId},'ROOT-LOSS','Unassigned fixed-price contract','1000000')`,
        );
        await db.execute(
          sql`insert into project_tasks(org_id,project_id,name,estimated_cost) values (${org.orgId},${projectId},'Construction','1150000')`,
        );
      });
      await withOrgContext(org.orgId, async () => {
        const period = (
          await db.execute<{ starts_on: string; ends_on: string }>(
            sql`
        select starts_on::text, ends_on::text from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`,
            "objects",
          )
        )[0]!;
        const lossScope = {
          periodStartsOn: period.starts_on,
          periodEndsOn: period.ends_on,
          bookId: org.bookId,
          subsidiaryIds: [],
        };
        assert.deepEqual(
          (await unassessedLossContracts(db, org.orgId, lossScope)).map((row) => row.code),
          ["ROOT-LOSS"],
        );
        assert.deepEqual(
          (
            await unassessedLossContracts(db, org.orgId, {
              ...lossScope,
              subsidiaryIds: [org.subsidiaryId],
            })
          ).map((row) => row.code),
          ["ROOT-LOSS"],
          "the root-scoped close owns the unassigned project",
        );

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
        const assess = async (bookId: string) => {
          const change = await proposeProvisionAssessment(org.orgId, actors.submitterId, {
            obligation: {
              id: randomUUID(),
              subsidiaryId: org.subsidiaryId,
              bookId,
              name: "Unassigned contract loss",
              currency: "CAD",
              expenseAccountId: expense,
              liabilityAccountId: liability,
              projectId,
            },
            effectiveOn: org.date,
            reason: "Provide the forecast contract loss for this period",
            idempotencyKey: randomUUID(),
            assessment: {
              presentObligation: true,
              outflow: "probable",
              reliablyEstimable: true,
              evidence:
                "Approved fixed-price contract with a supported forecast of direct and allocated costs.",
              discounting: "immaterial",
              discountEvidence: "Work completes shortly and time value is immaterial.",
              estimate: null,
            },
            construction: {
              remainingCost: "1150000",
              terminationAvailable: false,
              terminationCost: null,
              relatedAssetsReviewed: true,
              impairmentEvidence:
                "The controller reviewed related contract assets and no additional impairment is required.",
            },
          });
          await approve(change);
          await applyProvisionAssessment(org.orgId, change, actors.submitterId);
        };
        await assert.rejects(assess(taxBook), /Assign this project to the selected legal entity/);
        assert.equal(
          (
            await db.execute(
              sql`select id from provision_obligations where org_id=${org.orgId}`,
              "objects",
            )
          ).length,
          0,
        );
        assert.equal(
          (
            await db.execute(
              sql`update projects set subsidiary_id=${org.subsidiaryId}
        where org_id=${org.orgId} and id=${projectId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await assess(taxBook);
        assert.deepEqual(
          (await unassessedLossContracts(db, org.orgId, lossScope)).map((row) => row.code),
          ["ROOT-LOSS"],
          "another book's assessment does not satisfy the primary close",
        );
        await assess(org.bookId);
        assert.deepEqual(await unassessedLossContracts(db, org.orgId, lossScope), []);
        assert.deepEqual(await unownedContractProjects(db, org.orgId), []);

        // The native hierarchy refuses ambiguous ownership and preserves the assessed project.
        await assert.rejects(
          withOrgTransaction(org.orgId, () =>
            db.execute(sql`insert into subsidiaries
        (id,org_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
        values (${randomUUID()},${org.orgId},'Second root','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb)`),
          ),
          (error) => {
            const cause =
              error instanceof Error && error.cause instanceof Error ? error.cause : error;
            assert.match(String(cause), /root/i);
            return true;
          },
        );
        assert.deepEqual(
          await db.execute<{ id: string }>(
            sql`select id from subsidiaries
        where org_id=${org.orgId} and parent_id is null`,
            "objects",
          ),
          [{ id: org.subsidiaryId }],
        );
        assert.deepEqual(await unassessedLossContracts(db, org.orgId, lossScope), []);
        assert.deepEqual(await unownedContractProjects(db, org.orgId), []);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
