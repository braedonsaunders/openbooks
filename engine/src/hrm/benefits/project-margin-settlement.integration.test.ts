import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { installEngineSeams } from "../../composition/install.ts";
import { seedPayrollBenefitProgram } from "../../testing/benefit-fixtures.ts";
import { seedBenefitIncentivePosting } from "../../testing/benefit-incentive-posting.ts";
import { seedComponent, seedEmployment, seedProject, setupHarness, withHarness } from "../../testing/hrm-harness.ts";
import type { ProjectMarginSnapshot } from "./project-margin-settlement.ts";
import { addProgramMembership } from "./programs.ts";
import { previewIncentiveSettlement, type IncentivePreview } from "./settlement.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const SPEC = {
  features: ["hrm", "payroll", "projects"],
  users: [{ key: "actorId", name: "Margin Operator", handle: "margin_operator",
    permissions: ["hrm.benefits.read", "hrm.benefits.manage", "gl.read"], link: true }],
} as const;
type Harness = Awaited<ReturnType<typeof setupHarness<typeof SPEC>>>;

async function setup(): Promise<Harness> {
  installEngineSeams();
  const h = await setupHarness(SPEC);
  await db.execute(sql`update subsidiaries set base_currency='USD'
    where org_id=${h.org.orgId} and id=${h.org.subsidiaryId}`);
  return h;
}

async function purchaseCommitment(h: Harness, projectId: string, date: string, amount: string): Promise<void> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id,org_id,subsidiary_id,party_id,kind,document_number,document_date,currency,status,subtotal,tax_total,total)
    values (${documentId},${h.org.orgId},${h.org.subsidiaryId},${h.org.vendorId},'purchase_order',
      ${documentId},${date}::date,'USD','approved',${amount},0,${amount})`);
  await db.execute(sql`
    insert into document_lines (org_id,document_id,line_number,item_id,project_id,quantity,unit_price,amount)
    values (${h.org.orgId},${documentId},1,${h.org.items.service},${projectId},1,${amount},${amount})`);
}

function projectSnapshot(preview: IncentivePreview): ProjectMarginSnapshot {
  assert.equal(preview.measured.metric, "project_margin");
  assert.ok("projects" in preview.measured);
  return preview.measured as ProjectMarginSnapshot;
}

test("project-margin preview retains its cutoff when later revenue, costs and commitments arrive", { skip: !DB }, () =>
  withHarness(setup, async h => {
    const component = await seedComponent(h.org.orgId, { kind: "earning", code: "MARGIN" });
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Project Manager" });
    const projectId = await seedProject(h.org.orgId, "Margin source project");
    await db.execute(sql`update projects set starts_on='2026-01-01',manager_id=${worker.workerPartyId},
      subsidiary_id=${h.org.subsidiaryId} where org_id=${h.org.orgId} and id=${projectId}`);
    const program = await seedPayrollBenefitProgram({ orgId:h.org.orgId,actorId:h.actorId,
      subsidiaryId:h.org.subsidiaryId,componentId:component,currency:"USD" }, {
      code:"PROJECT_MARGIN",name:"Project margin",family:"incentive",approvalMode:"none",
      metric:"project_margin",metricScope:"company",valuation:"percent",allocation:"responsibility",
      percentRate:"5",lossPercentRate:"10",frequency:"monthly",periodBasis:"calendar",
      includeOpenCommitments:true,sourceAccountIds:[h.org.accounts.revenue,h.org.accounts.cogs],
    }, { activate:false });
    await addProgramMembership({ orgId:h.org.orgId,actorId:h.actorId,programId:program.id,
      employmentId:worker.employmentId,effectiveFrom:"2026-01-01" });
    // Native activation freezes the source policy before previewing.
    const { activateBenefitProgram } = await import("./programs.ts");
    await activateBenefitProgram({ orgId:h.org.orgId,actorId:h.actorId,programId:program.id });
    const posting = (date: string, account: string, amount: string, balancing: string) =>
      seedBenefitIncentivePosting(h, [
        { account,amount,project:projectId },{ account:h.org.accounts.bank,amount:balancing },
      ], { date,currency:"USD" });
    await posting("2026-07-10",h.org.accounts.revenue,"-10000","10000");
    await posting("2026-07-10",h.org.accounts.cogs,"2000","-2000");
    await purchaseCommitment(h,projectId,"2026-07-12","1000");
    const query = { orgId:h.org.orgId,actorId:h.actorId,programId:program.id,
      periodFrom:"2026-07-01",periodTo:"2026-07-31",asOf:"2026-07-20" };
    const baseline = await previewIncentiveSettlement(query);
    assert.equal(baseline.computation.totalAwarded,"350.0000");
    const original = projectSnapshot(baseline);
    assert.equal(original.asOf,query.asOf);
    assert.equal(original.projects.length,1);
    assert.equal(original.projects[0]!.margin,"7000.0000");

    await posting("2026-07-25",h.org.accounts.revenue,"-1000","1000");
    await posting("2026-07-25",h.org.accounts.cogs,"5000","-5000");
    await posting("2026-07-28",h.org.accounts.cogs,"-1000","1000");
    await purchaseCommitment(h,projectId,"2026-07-25","2000");
    const retained = await previewIncentiveSettlement(query);
    assert.equal(retained.computation.totalAwarded,"350.0000");
    assert.deepEqual(projectSnapshot(retained),original,"future dated sources do not reinterpret the earlier measure");

    const later = await previewIncentiveSettlement({ ...query,asOf:"2026-07-31" });
    const advanced = projectSnapshot(later);
    assert.equal(advanced.asOf,"2026-07-31");
    assert.equal(advanced.projects[0]!.revenue,"11000.0000");
    assert.equal(advanced.projects[0]!.cost,"6000.0000");
    assert.equal(advanced.projects[0]!.commitments,"3000.0000");
    assert.equal(advanced.projects[0]!.margin,"2000.0000");
    assert.equal(later.computation.totalAwarded,"100.0000");
    assert.notEqual(advanced.digest,original.digest);
    const awards = (await db.execute<{ count:number }>(sql`select count(*)::int as count
      from hrm_benefit_awards where org_id=${h.org.orgId} and program_id=${program.id}`)).rows[0];
    assert.equal(awards?.count,0,"both native previews leave award history untouched");
  }));
