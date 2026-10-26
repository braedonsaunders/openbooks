import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { submitAndReleaseIfUngated } from "../../flows/submit.ts";
import { installEngineSeams } from "../../composition/install.ts";
import { seedPayrollBenefitProgram } from "../../testing/benefit-fixtures.ts";
import { seedBenefitIncentivePosting } from "../../testing/benefit-incentive-posting.ts";
import {
  mkSecondSubsidiary,
  seedComponent,
  seedEmployment,
  seedProject,
  setupHarness,
  withHarness,
} from "../../testing/hrm-harness.ts";
import type { ProjectMarginSnapshot } from "./project-margin-settlement.ts";
import { recordSettledAward, submitBenefitAward } from "./awards.ts";
import { errorChainMatches } from "../../testing/error-chain.ts";
import {
  addProgramMembership,
  getBenefitProgram,
  updateBenefitProgram,
  type CreateBenefitProgramQuery,
} from "./programs.ts";
import {
  createAdjustingAward,
  previewIncentiveSettlement,
  settleIncentivePeriod,
  type IncentivePreview,
} from "./settlement.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const SPEC = {
  features: ["hrm", "payroll", "projects", "orders"],
  users: [
    {
      key: "actorId",
      name: "Margin Operator",
      handle: "margin_operator",
      permissions: [
        "hrm.benefits.read",
        "hrm.benefits.manage",
        "gl.read",
        "purchase_orders.read",
        "purchase_orders.create",
      ],
      link: true,
    },
  ],
} as const;
type Harness = Awaited<ReturnType<typeof setupHarness<typeof SPEC>>>;

async function setup(): Promise<Harness> {
  installEngineSeams();
  const h = await setupHarness(SPEC);
  await db.execute(sql`update subsidiaries set base_currency='USD'
    where org_id=${h.org.orgId} and id=${h.org.subsidiaryId}`);
  return h;
}

async function purchaseCommitment(
  h: Harness,
  projectId: string,
  date: string,
  amount: string,
): Promise<void> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id,org_id,subsidiary_id,party_id,kind,document_number,document_date,currency,status,subtotal,tax_total,total,created_by,updated_by)
    values (${documentId},${h.org.orgId},${h.org.subsidiaryId},${h.org.vendorId},'purchase_order',
      ${documentId},${date}::date,'USD','draft',${amount},0,${amount},${h.actorId},${h.actorId})`);
  await db.execute(sql`
    insert into document_lines (org_id,document_id,line_number,item_id,project_id,quantity,unit_price,amount)
    values (${h.org.orgId},${documentId},1,${h.org.items.service},${projectId},1,${amount},${amount})`);
  const release = await submitAndReleaseIfUngated("purchase_order", documentId, h.actorId);
  assert.equal(release.autoApproved, true);
  assert.equal(release.gated, false);
  assert.equal(release.flowError, null);
  assert.equal(release.gated, false);
  const stored = await db.execute<{ status: string }>(
    sql`select status from documents
    where org_id=${h.org.orgId} and id=${documentId}`,
    "objects",
  );
  assert.equal(stored.length, 1);
  assert.equal(
    stored[0]!.status,
    "approved",
    "commitments enter the measure only after native release",
  );
}

function projectSnapshot(preview: IncentivePreview): ProjectMarginSnapshot {
  assert.equal(preview.measured.metric, "project_margin");
  assert.ok("projects" in preview.measured);
  return preview.measured as ProjectMarginSnapshot;
}

async function seedMargin(
  h: Harness,
  asOf = "2026-07-20",
  terms: Partial<CreateBenefitProgramQuery> = {},
) {
  const component = await seedComponent(h.org.orgId, { kind: "earning", code: "MARGIN" });
  const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
    displayName: "Project Manager",
  });
  const projectId = await seedProject(h.org.orgId, "Margin source project");
  await db.execute(sql`update projects set starts_on='2026-01-01',manager_id=${worker.workerPartyId},
      subsidiary_id=${h.org.subsidiaryId} where org_id=${h.org.orgId} and id=${projectId}`);
  const program = await seedPayrollBenefitProgram(
    {
      orgId: h.org.orgId,
      actorId: h.actorId,
      subsidiaryId: h.org.subsidiaryId,
      componentId: component,
      currency: "USD",
    },
    {
      code: "PROJECT_MARGIN",
      name: "Project margin",
      family: "incentive",
      metric: "project_margin",
      metricScope: "company",
      valuation: "percent",
      allocation: "responsibility",
      percentRate: "5",
      lossPercentRate: "10",
      frequency: "monthly",
      periodBasis: "calendar",
      includeOpenCommitments: true,
      sourceAccountIds: [h.org.accounts.revenue, h.org.accounts.cogs],
      ...terms,
    },
    { activate: false },
  );
  await addProgramMembership({
    orgId: h.org.orgId,
    actorId: h.actorId,
    programId: program.id,
    employmentId: worker.employmentId,
    effectiveFrom: "2026-01-01",
  });
  // Native activation freezes the source policy before previewing.
  const { activateBenefitProgram } = await import("./programs.ts");
  await activateBenefitProgram({ orgId: h.org.orgId, actorId: h.actorId, programId: program.id });
  const posting = (date: string, account: string, amount: string, balancing: string) =>
    seedBenefitIncentivePosting(
      h,
      [
        { account, amount, project: projectId },
        { account: h.org.accounts.bank, amount: balancing },
      ],
      { date, currency: "USD" },
    );
  await posting("2026-07-10", h.org.accounts.revenue, "-10000", "10000");
  await posting("2026-07-10", h.org.accounts.cogs, "2000", "-2000");
  await purchaseCommitment(h, projectId, "2026-07-12", "1000");
  const query = {
    orgId: h.org.orgId,
    actorId: h.actorId,
    programId: program.id,
    periodFrom: "2026-07-01",
    periodTo: "2026-07-31",
    asOf,
  };
  return { query, posting, program, projectId, worker };
}

test(
  "project-margin preview retains its cutoff when later revenue, costs and commitments arrive",
  { skip: !DB },
  () =>
    withHarness(setup, async (h) => {
      const { query, posting, program, projectId } = await seedMargin(h);
      const baseline = await previewIncentiveSettlement(query);
      assert.equal(baseline.computation.totalAwarded, "350.0000");
      const original = projectSnapshot(baseline);
      assert.equal(original.asOf, query.asOf);
      assert.equal(original.projects.length, 1);
      assert.equal(original.projects[0]!.margin, "7000.0000");

      await posting("2026-07-25", h.org.accounts.revenue, "-1000", "1000");
      await posting("2026-07-25", h.org.accounts.cogs, "5000", "-5000");
      await posting("2026-07-28", h.org.accounts.cogs, "-1000", "1000");
      await purchaseCommitment(h, projectId, "2026-07-25", "2000");
      const retained = await previewIncentiveSettlement(query);
      assert.equal(retained.computation.totalAwarded, "350.0000");
      assert.deepEqual(
        projectSnapshot(retained),
        original,
        "future dated sources do not reinterpret the earlier measure",
      );

      const later = await previewIncentiveSettlement({ ...query, asOf: "2026-07-31" });
      const advanced = projectSnapshot(later);
      assert.equal(advanced.asOf, "2026-07-31");
      assert.equal(advanced.projects[0]!.revenue, "11000.0000");
      assert.equal(advanced.projects[0]!.cost, "6000.0000");
      assert.equal(advanced.projects[0]!.commitments, "3000.0000");
      assert.equal(advanced.projects[0]!.margin, "2000.0000");
      assert.equal(later.computation.totalAwarded, "100.0000");
      assert.notEqual(advanced.digest, original.digest);
      const awards = (
        await db.execute<{ count: number }>(
          sql`select count(*)::int as count
      from hrm_benefit_awards where org_id=${h.org.orgId} and program_id=${program.id}`,
          "objects",
        )
      )[0];
      assert.equal(awards?.count, 0, "both native previews leave award history untouched");
    }),
);

for (const legacy of [false, true]) {
  test(
    `project-margin ${legacy ? "legacy" : "cutoff"} settlement retries preserve awards and refuse changed sources`,
    { skip: !DB },
    () =>
      withHarness(setup, async (h) => {
        const { query, posting, program, worker } = await seedMargin(h, "2026-07-31");
        const preview = await previewIncentiveSettlement(query);
        let awardId: string;
        if (legacy) {
          const margin = projectSnapshot(preview);
          const body = {
            metric: "project_margin",
            scope: "company",
            projects: margin.projects,
            ...(margin.carryForward ? { carryForward: margin.carryForward } : {}),
          };
          const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
          const measurement = {
            ...preview.sourceSnapshot,
            projectMargin: { ...body, digest },
            digest,
          };
          // Seed the original representation through native issuance, without editing history.
          const award = await recordSettledAward({
            orgId: h.org.orgId,
            actorId: h.actorId,
            programId: program.id,
            employmentId: worker.employmentId,
            periodFrom: query.periodFrom,
            periodTo: query.periodTo,
            value: "350.0000",
            currency: "USD",
            sourceKey: `${preview.sourceKeyPrefix}:${worker.employmentId}`,
            evidence: {
              kind: "incentive-settlement",
              programRevision: preview.programRevision,
              computation: { value: "350.0000", capped: false },
            },
            settlementMeasurement: measurement,
          });
          awardId = award.id;
        } else {
          const first = await settleIncentivePeriod(query);
          assert.equal(first.awards.length, 1);
          awardId = first.awards[0]!.id;
        }
        const readHistory = async () =>
          (
            await db.execute<{ history: unknown }>(
              sql`
        select jsonb_agg(to_jsonb(a) order by a.id) as history from hrm_benefit_awards a
        where a.org_id=${h.org.orgId} and a.program_id=${program.id}`,
              "objects",
            )
          )[0]!.history;
        const before = await readHistory();
        const retried = await settleIncentivePeriod(query);
        assert.deepEqual(
          retried.awards.map((a) => a.id),
          [awardId],
        );
        assert.deepEqual(
          await readHistory(),
          before,
          "same-span retry makes no new award or history write",
        );
        const stored = await db.execute<{
          id: string;
          source_snapshot: {
            measurement: { settlement: { projectMargin: ProjectMarginSnapshot; digest: string } };
          };
        }>(
          sql`
        select id,source_snapshot from hrm_benefit_awards
        where org_id=${h.org.orgId} and program_id=${program.id} and id=${awardId}`,
          "objects",
        );
        assert.equal(
          stored.length,
          1,
          "retained protected award evidence exists in the same organization",
        );
        assert.equal(stored[0]!.id, awardId);
        const retained = stored[0]!.source_snapshot.measurement.settlement;
        assert.equal(Object.hasOwn(retained.projectMargin, "asOf"), !legacy);
        assert.equal(retained.digest, retained.projectMargin.digest);
        if (!legacy) assert.equal(retained.projectMargin.asOf, query.asOf);

        // A later dated source is outside this cutoff and cannot change the retry.
        await posting("2026-08-05", h.org.accounts.cogs, "500", "-500");
        assert.deepEqual(
          (await settleIncentivePeriod(query)).awards.map((a) => a.id),
          [awardId],
        );
        assert.deepEqual(await readHistory(), before);
        // An additional financial source inside the cutoff must still refuse.
        await posting("2026-07-15", h.org.accounts.cogs, "100", "-100");
        await assert.rejects(
          () => settleIncentivePeriod(query),
          (error) => errorChainMatches(error, /already settled .* different facts/),
        );
        assert.deepEqual(
          await readHistory(),
          before,
          "changed facts cannot rewrite retained awards",
        );
      }),
  );
}

test(
  "global-project margin excludes another legal entity's cost, commitments and later revenue",
  { skip: !DB },
  () =>
    withHarness(setup, async (h) => {
      const { query, projectId } = await seedMargin(h, "2026-08-10");
      const global = await db.execute(
        sql`update projects set subsidiary_id=null
      where org_id=${h.org.orgId} and id=${projectId} returning id`,
        "objects",
      );
      assert.equal(global.length, 1);
      const baseline = await previewIncentiveSettlement(query);
      assert.equal(baseline.computation.totalAwarded, "350.0000");
      const original = projectSnapshot(baseline);
      const otherEntity = await mkSecondSubsidiary(h.org.orgId, h.org.subsidiaryId, {
        currency: "USD",
        country: "US",
      });
      await seedBenefitIncentivePosting(
        h,
        [
          { account: h.org.accounts.cogs, amount: "500", project: projectId },
          { account: h.org.accounts.bank, amount: "-500" },
        ],
        { date: "2026-07-11", currency: "USD", subsidiary: otherEntity },
      );
      await purchaseCommitment(
        { ...h, org: { ...h.org, subsidiaryId: otherEntity } },
        projectId,
        "2026-07-12",
        "1200",
      );
      const afterCosts = await previewIncentiveSettlement(query);
      assert.equal(afterCosts.computation.totalAwarded, "350.0000");
      assert.deepEqual(
        projectSnapshot(afterCosts),
        original,
        "foreign cost and purchase commitments do not change employer margin",
      );
      await seedBenefitIncentivePosting(
        h,
        [
          { account: h.org.accounts.revenue, amount: "-9000", project: projectId },
          { account: h.org.accounts.bank, amount: "9000" },
        ],
        { date: "2026-08-05", currency: "USD", subsidiary: otherEntity },
      );
      const afterRevenue = await previewIncentiveSettlement(query);
      assert.equal(afterRevenue.computation.totalAwarded, "350.0000");
      assert.deepEqual(
        projectSnapshot(afterRevenue),
        original,
        "foreign later revenue cannot postpone the employer's eligible project",
      );
      const settled = await settleIncentivePeriod(query);
      assert.equal(settled.preview.computation.totalAwarded, "350.0000");
      assert.equal(settled.awards.length, 1);
      const retried = await settleIncentivePeriod(query);
      assert.equal(retried.awards[0]!.id, settled.awards[0]!.id);
    }),
);

test(
  "new margin awards retain complete economic policy while dated changes and adjustments preserve original evidence",
  { skip: !DB },
  () =>
    withHarness(setup, async (h) => {
      const { query, program } = await seedMargin(h, "2026-07-31", {
        projectProfitCap: "1000",
        projectLossCap: "2000",
        poolRounding: "pool",
      });
      const first = await settleIncentivePeriod(query);
      assert.equal(first.awards.length, 1);
      const award = first.awards[0]!;
      assert.equal(award.value, "350.0000");
      const approved = await submitBenefitAward({
        orgId: h.org.orgId,
        actorId: h.actorId,
        awardId: award.id,
      });
      assert.equal(
        approved.status,
        "approved",
        "The pinned no-approval policy uses the supported submission lifecycle",
      );

      type Retained = {
        id: string;
        program_snapshot: Record<string, unknown>;
        source_snapshot: Record<string, unknown>;
      };
      const read = async (id: string) => {
        const rows = await db.execute<Retained>(
          sql`select id,program_snapshot,source_snapshot from hrm_benefit_awards
   where org_id=${h.org.orgId} and id=${id}`,
          "objects",
        );
        assert.equal(rows.length, 1);
        return rows[0]!;
      };
      const original = await read(award.id);
      const policy = await getBenefitProgram(db, h.org.orgId, h.actorId, program.id);
      const terms = [
        "scopeCustomerIds",
        "scopeDepartmentIds",
        "unassignedTime",
        "scopeExcludedProjectIds",
        "lossPercentRate",
        "projectProfitCap",
        "projectLossCap",
        "poolRounding",
        "includeOpenCommitments",
        "hourClassifications",
        "eligibility",
      ] as const;
      for (const key of terms) {
        assert.ok(
          Object.hasOwn(original.program_snapshot, key),
          `Retained policy must distinguish missing from ${key}'s actual value`,
        );
        assert.deepEqual(original.program_snapshot[key], policy[key]);
      }
      assert.equal(original.program_snapshot.lossPercentRate, "10.0000");
      assert.equal(original.program_snapshot.projectProfitCap, "1000.0000");
      assert.equal(original.program_snapshot.projectLossCap, "2000.0000");
      assert.equal(original.program_snapshot.poolRounding, "pool");
      assert.equal(original.program_snapshot.includeOpenCommitments, true);
      assert.deepEqual(
        (await settleIncentivePeriod(query)).awards.map((item) => item.id),
        [award.id],
      );
      assert.deepEqual(await read(award.id), original);
      await updateBenefitProgram({
        orgId: h.org.orgId,
        actorId: h.actorId,
        programId: program.id,
        lossPercentRate: "20",
        projectProfitCap: "500",
        projectLossCap: "1000",
        poolRounding: "share",
        includeOpenCommitments: false,
        changeEffectiveFrom: "2026-08-01",
        reason: "Declare later project economics",
      });
      const changed = await getBenefitProgram(db, h.org.orgId, h.actorId, program.id);
      assert.equal(changed.lossPercentRate, "20.0000");
      assert.equal(changed.includeOpenCommitments, false);
      assert.deepEqual(
        (await settleIncentivePeriod(query)).awards.map((item) => item.id),
        [award.id],
      );
      assert.deepEqual(await read(award.id), original);
      const adjustmentInput = {
        orgId: h.org.orgId,
        actorId: h.actorId,
        awardId: award.id,
        correctionId: randomUUID(),
        value: "10.00",
        reason: "Declared original-period adjustment",
      };
      const adjustment = await createAdjustingAward(adjustmentInput);
      assert.equal(adjustment.value, "10.0000");
      assert.equal(adjustment.adjustsAwardId, award.id);
      const retainedAdjustment = await read(adjustment.id);
      assert.deepEqual(
        retainedAdjustment.program_snapshot,
        original.program_snapshot,
        "An adjustment copies the retained original policy, including loss and cost terms",
      );
      assert.deepEqual(
        retainedAdjustment.source_snapshot,
        original.source_snapshot,
        "Current policy and new evidence cannot reinterpret the original source",
      );
      assert.equal(
        (await createAdjustingAward(adjustmentInput)).id,
        adjustment.id,
        "The same native correction request returns the original adjustment",
      );
      await assert.rejects(
        createAdjustingAward({ ...adjustmentInput, value: "11.00" }),
        /this correction request was already recorded with different details/,
      );
      await assert.rejects(
        createAdjustingAward({ ...adjustmentInput, reason: "Changed original-period adjustment" }),
        /this correction request was already recorded with different details/,
      );
      assert.deepEqual(await read(adjustment.id), retainedAdjustment);
      assert.deepEqual(await read(award.id), original);
      assert.equal(
        (
          await db.execute<{ n: number }>(
            sql`select count(*)::int n from hrm_benefit_awards
  where org_id=${h.org.orgId} and program_id=${program.id}`,
            "objects",
          )
        )[0]!.n,
        2,
        "Retry creates no duplicate correction or replacement of original history",
      );
    }),
);
