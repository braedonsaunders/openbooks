import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { defaultContinuousCloseDetectors } from "./continuous-close-config.ts";
import { db } from "./db.ts";
import { projectsFindings } from "./agents/projects.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

/**
 * Live-PostgreSQL proofs for the project-margin pack (background agent pack
 * B): negative margin from the ranking read graph with a crossed-into-red
 * delta, budget overruns against approved task budgets plus open PO
 * commitments, and stale unbilled time and document lines under the WIP
 * billing predicates. The pack function is exercised directly (the same way
 * the registry dispatches it); control-plane persistence is covered by
 * continuous-close.integration.test.ts.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function scan(orgId: string, threshold = "100.0000") {
  return projectsFindings(orgId, threshold, defaultContinuousCloseDetectors("projects"));
}

function fingerprints(findings: Awaited<ReturnType<typeof scan>>): string[] {
  return findings.map((finding) => finding.fingerprint);
}

/** One active project carrying exactly one posted, balanced, project-tagged cost. */
async function seedProjectWithPostedCost(
  org: ScratchOrg,
  entryNumber: string,
  lineAmount: string,
): Promise<string> {
  const projectId = randomUUID();
  const entryId = randomUUID();
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-MARGIN',
            'Margin watch job', ${org.customerId}, 'active', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values
      (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entryNumber},
       ${org.date}, ${org.periodId}, ${entryNumber}, 'draft', 'manual')`);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
    values
      (${org.orgId}, ${entryId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${projectId}, ${lineAmount}, 'CAD', ${lineAmount}, '1'),
      (${org.orgId}, ${entryId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, null, ${`-${lineAmount}`}, 'CAD', ${`-${lineAmount}`}, '1')`);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
  return projectId;
}

test(
  "a loss-making project surfaces a negative-margin finding that names the crossing",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const projectId = await seedProjectWithPostedCost(org, "MARGIN-SEED", "800.0000");
      const fingerprint = `project-negative-margin:${projectId}`;
      // The previous run persisted a healthy margin for this project.
      await db.execute(sql`
        insert into ai_work_items (org_id, agent_key, finding_type, detector_version, fingerprint, severity, summary)
        values (${org.orgId}, 'projects', 'project_negative_margin', '1', ${fingerprint}, 'warning', '{"margin": "100.0000"}'::jsonb)`);

      const findings = await scan(org.orgId);
      const margins = findings.filter((finding) => finding.findingType === "project_negative_margin");
      assert.equal(margins.length, 1, `one negative-margin finding, got ${fingerprints(findings)}`);
      const only = margins[0]!;
      assert.equal(only.fingerprint, fingerprint);
      assert.equal(only.agentKey, "projects");
      assert.equal(only.materiality, "800.0000");
      assert.equal(only.subjectType, "project");
      assert.equal(only.subjectId, projectId);
      assert.equal(only.summary.priorMargin, "100.0000");
      assert.equal(only.summary.crossedIntoNegative, true);
      assert.equal(only.summary.href, `/projects?project=${projectId}`);
      assert.ok(only.evidence.length >= 1, "the margin row carries evidence");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an approved task budget plus an open PO commitment surfaces an overrun, fingerprint-stable",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const projectId = await seedProjectWithPostedCost(org, "OVERRUN-SEED", "800.0000");
      await db.execute(sql`
        insert into project_tasks (org_id, project_id, name, estimated_cost)
        values (${org.orgId}, ${projectId}, 'Approved scope', 500)`);
      const poId = randomUUID();
      const poLineId = randomUUID();
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, party_id, subsidiary_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${poId}, ${org.orgId}, 'purchase_order', 'draft', 'PO-MARGIN-1',
                ${org.vendorId}, ${org.subsidiaryId}, ${org.date}, 'CAD', '1', 1000, 0, 1000, null)`);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, description,
           quantity, unit, unit_price, amount, tax_amount, is_billable, project_id,
           quantity_fulfilled, quantity_billed, custom, extra_dims)
        values (${poLineId}, ${org.orgId}, ${poId}, 1, ${org.accounts.cogs},
                'Open PO scope', 10, 'ea', 100, 1000, 0, false, ${projectId},
                0, 0, '{}'::jsonb, '{}'::jsonb)`);
      await db.execute(sql`
        update documents set status = 'approved', updated_at = now() where id = ${poId}`);

      // Cost 800 + committed 1000 past the approved 500 budget: overrun 1300.
      const findings = await scan(org.orgId);
      const overruns = findings.filter((finding) => finding.findingType === "project_budget_overrun");
      assert.equal(overruns.length, 1, `one overrun finding, got ${fingerprints(findings)}`);
      assert.equal(overruns[0]!.fingerprint, `project-budget-overrun:${projectId}`);
      assert.equal(overruns[0]!.materiality, "1300.0000");
      const again = await scan(org.orgId);
      assert.deepEqual(
        fingerprints(again).sort(),
        fingerprints(findings).sort(),
        "repeat scans are fingerprint-stable",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "aged billable time and lines surface stale unbilled while fresh work stays silent",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const projectId = await seedProjectWithPostedCost(org, "UNBILLED-SEED", "800.0000");
      // Approved, billable, uninvoiced time from long before the cutoff:
      // 10h at 50 bills 500.
      await db.execute(sql`
        insert into time_entries
          (org_id, employee_party_id, project_id, worked_on, hours, bill_rate,
           status, is_billable, billing_status)
        values (${org.orgId}, ${org.vendorId}, ${projectId}, '2025-01-15', 10, 50,
                'approved', true, 'unbilled')`);
      // Fresh time bills more but is not stale (worked today, inside the cutoff).
      await db.execute(sql`
        insert into time_entries
          (org_id, employee_party_id, project_id, worked_on, hours, bill_rate,
           status, is_billable, billing_status)
        values (${org.orgId}, ${org.vendorId}, ${projectId}, CURRENT_DATE, 100, 100,
                'approved', true, 'unbilled')`);
      // A billable uninvoiced project-charge line from the same aged date.
      const docId = randomUUID();
      const lineId = randomUUID();
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, party_id, subsidiary_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${docId}, ${org.orgId}, 'project_charge', 'draft', 'PC-UNBILLED-1',
                ${org.customerId}, ${org.subsidiaryId}, '2025-01-15', 'CAD', '1', 200, 0, 200, null)`);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, description,
           quantity, unit, unit_price, amount, tax_amount, is_billable, project_id,
           bill_amount, quantity_fulfilled, quantity_billed, custom, extra_dims)
        values (${lineId}, ${org.orgId}, ${docId}, 1, ${org.accounts.revenue},
                'Aged billable line', 1, 'ea', 200, 200, 0, true, ${projectId},
                200, 0, 0, '{}'::jsonb, '{}'::jsonb)`);

      const findings = await scan(org.orgId);
      const stale = findings.filter((finding) => finding.findingType === "project_stale_unbilled");
      assert.equal(stale.length, 1, `one stale-unbilled finding, got ${fingerprints(findings)}`);
      const only = stale[0]!;
      assert.equal(only.fingerprint, `project-stale-unbilled:${projectId}`);
      assert.equal(only.materiality, "700.0000");
      assert.equal(only.summary.agedTime, "500.0000");
      assert.equal(only.summary.agedDocuments, "200.0000");
      assert.equal(only.summary.oldestDate, "2025-01-15");
      assert.equal(only.summary.href, `/projects?project=${projectId}`);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "project scans stay inside the requesting org",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      await seedProjectWithPostedCost(org, "ISOLATION-SEED", "800.0000");
      const findings = await scan(org.orgId);
      assert.ok(
        findings.some((finding) => finding.findingType === "project_negative_margin"),
        "the seeded org flags its loss-maker",
      );
      assert.deepEqual(await scan(other.orgId), [], "a clean org scans clean");
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);
