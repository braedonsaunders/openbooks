import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { defaultContinuousCloseDetectors } from "../agents/continuous-close-config.ts";
import { runContinuousCloseAgent } from "./continuous-close.ts";
import { db, withBypass, withBypassContext } from "../platform/db.ts";
import { taxFindings } from "../agents/tax.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

/**
 * Live-PostgreSQL proofs for the tax-readiness pack (background agent pack
 * B): untaxed posted lines, missing registrations, blocked returns, and
 * unlocked filing periods surface as evidence-backed finding drafts.
 *
 * The pack function is exercised directly (the same way the registry
 * dispatches it). Control-plane persistence is covered by
 * continuous-close.integration.test.ts and needs no agent-key policy rows
 * here. Posted fixtures reuse the real posting kernel (postDocument).
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

function detectorsWith(overrides: Record<string, Record<string, number>> = {}) {
  return defaultContinuousCloseDetectors("tax").map((detector) => ({
    ...detector,
    parameters: { ...detector.parameters, ...(overrides[detector.detectorKey] ?? {}) },
  }));
}

async function scan(orgId: string, overrides: Record<string, Record<string, number>> = {}) {
  return taxFindings(orgId, "1000.0000", detectorsWith(overrides));
}

/** A posted vendor bill whose single line carries (or omits) a tax code. */
async function seedPostedBill(
  org: Org,
  number: string,
  amount: string,
  taxCodeId: string | null,
): Promise<string> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
      values (${documentId}, ${org.orgId}, 'vendor_bill', 'draft', ${number}, ${org.subsidiaryId},
              ${org.vendorId}, ${org.date}, ${org.date},
              'CAD', '1', ${amount}, '0.0000', ${amount})`);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, tax_code_id, quantity, unit_price)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.cogs}, ${amount},
              ${amount}, '0.0000', ${taxCodeId}, '1', ${amount})`);
    if (taxCodeId) {
      await db.execute(sql`
        insert into document_line_tax_components
          (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
           tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
           price_includes_tax, compound_on_previous, rounding_scale, collected_account_id,
           paid_account_id, withholding_account_id, overridden)
        values (${org.orgId}, ${lineId}, ${taxCodeId}, 1, '10', ${amount}, '0.0000',
                '0.0000', '0.0000', 'standard', false, false, 2, null, ${org.accounts.taxInput},
                null, false)`);
    }
    await db.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  });
  await withBypassContext(() =>
    postDocument(documentId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }),
  );
  return documentId;
}

test(
  "posted untaxed lines surface per kind with evidence; taxed lines stay silent",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      // Scratch fixtures post into the July open period while the business
      // day is real today: widen the window to reach them.
      const untaxedId = await seedPostedBill(org, "TAX-UNTAXED", "1500.0000", null);
      const codeId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`
          insert into tax_codes
            (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
          values (${codeId}, ${org.orgId}, 'TAX-STD', 'Standard', 'both', 'standard',
                  ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`);
      });
      await seedPostedBill(org, "TAX-TAXED", "2500.0000", codeId);

      const findings = await scan(org.orgId, { tax_missing_codes: { lookbackDays: 90 } });
      assert.equal(findings.length, 1, `only the untaxed kind fires, got ${findings.map((finding) => finding.findingType)}`);
      const finding = findings[0]!;
      assert.equal(finding.agentKey, "tax");
      assert.equal(finding.findingType, "tax_missing_codes");
      assert.equal(finding.fingerprint, "tax-missing-codes:vendor_bill");
      assert.equal(finding.materiality, "1500.0000");
      assert.equal(finding.summary.href, "/tax");
      const evidenceIds = finding.evidence.map((item) => item.sourceId);
      assert.ok(evidenceIds.includes(untaxedId), "the untaxed bill is evidence");
      assert.equal(finding.evidence.length, 1, "the taxed bill contributes no evidence rows");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "registration, computability, and lock findings follow the filing lifecycle",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const formCode = "TAX-TEST-1";
      await withBypassContext(async () => {
        await db.execute(sql`
          insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
          values (${randomUUID()}, ${org.orgId}, ${formCode}, 'Test return', 'efile_api', true)`);
      });

      // A configured form with no registration and no lock: registration +
      // unlock findings, and no blocked computation (nothing registered).
      let findings = await scan(org.orgId);
      let types = findings.map((finding) => finding.findingType).sort();
      assert.deepEqual(types, ["tax_missing_registration", "tax_unlocked_period"], `unregistered posture, got ${types}`);

      // Register the form with one mapped box: the registration finding
      // clears and the return computes, so only the unlock remains.
      await withBypassContext(async () => {
        const jurisdictionId = randomUUID();
        await db.execute(sql`
          insert into tax_jurisdictions (id, org_id, code, name, country)
          values (${jurisdictionId}, ${org.orgId}, 'TAX-J1', 'Test jurisdiction', 'CA')`);
        await db.execute(sql`
          insert into tax_registrations (id, org_id, jurisdiction_id, registration_number, return_form_code, is_active)
          values (${randomUUID()}, ${org.orgId}, ${jurisdictionId}, '123456789', ${formCode}, true)`);
        const codeId = randomUUID();
        await db.execute(sql`
          insert into tax_codes
            (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
          values (${codeId}, ${org.orgId}, 'TAX-READY', 'Readiness', 'both', 'standard',
                  ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`);
        await db.execute(sql`
          insert into tax_report_lines
            (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
          values (${randomUUID()}, ${org.orgId}, ${formCode}, '1', 'Test box', ${codeId}, 'tax_collected', -1, 10)`);
      });
      findings = await scan(org.orgId);
      types = findings.map((finding) => finding.findingType).sort();
      assert.deepEqual(types, ["tax_unlocked_period"], `registered posture, got ${types}`);

      // Break the box mapping: the registered return no longer computes, and
      // the pack reports the filing engine's own error as evidence.
      await withBypassContext(async () => {
        await db.execute(sql`delete from tax_report_lines where org_id = ${org.orgId} and report_code = ${formCode}`);
      });
      findings = await scan(org.orgId);
      types = findings.map((finding) => finding.findingType).sort();
      assert.deepEqual(types, ["tax_return_blocked", "tax_unlocked_period"], `broken mapping posture, got ${types}`);
      const blocked = findings.find((finding) => finding.findingType === "tax_return_blocked")!;
      assert.equal(blocked.severity, "critical");
      assert.ok(
        typeof blocked.summary.error === "string" && blocked.summary.error.length > 0,
        "the engine error travels on the finding",
      );

      // Restore the mapping and close the tax lock for the latest completed
      // period: full readiness, the pack goes quiet.
      const book = (await withBypassContext(() =>
        db.execute<{ id: string }>(sql`select id from accounting_books where org_id = ${org.orgId} and is_primary limit 1`),
      )).rows[0]!;
      await withBypassContext(async () => {
        const codeId = (await db.execute<{ id: string }>(sql`
          select id from tax_codes where org_id = ${org.orgId} and code = 'TAX-READY' limit 1`)).rows[0]!;
        await db.execute(sql`
          insert into tax_report_lines
            (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
          values (${randomUUID()}, ${org.orgId}, ${formCode}, '1', 'Test box', ${codeId.id}, 'tax_collected', -1, 10)`);
        await db.execute(sql`
          insert into period_locks (org_id, period_id, book_id, module, state)
          values (${org.orgId}, ${org.periodId}, ${book.id}, 'tax', 'closed')`);
      });
      findings = await scan(org.orgId);
      assert.deepEqual(
        findings.map((finding) => finding.findingType),
        [],
        "a registered, computable, locked posture emits nothing",
      );
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "the tax pack persists through a full control-plane run",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      await seedPostedBill(org, "TAX-RUN", "2000.0000", null);
      await withBypassContext(async () => {
        await db.execute(sql`
          insert into ai_agent_policies
            (id, org_id, agent_key, enabled, automatic_runs, cadence, materiality_threshold,
             detector_settings, analysis_settings, next_run_at)
          values (${randomUUID()}, ${org.orgId}, 'tax', true, false, 'daily', '1000',
                  ${JSON.stringify({ tax_missing_codes: { parameters: { lookbackDays: 90 } } })}::jsonb,
                  ${JSON.stringify({ rootCauseAnalysis: false, recommendations: false, narrative: false })}::jsonb,
                  null)
        `);
      });
      const result = await runContinuousCloseAgent({ orgId: org.orgId, agentKey: "tax", trigger: "manual" });
      assert.equal((result as { status: string }).status, "completed");
      assert.ok((result as { detected: number }).detected >= 1, "the run detects the untaxed bill");
      const persisted = (await withBypassContext(() =>
        db.execute<{ finding_type: string; fingerprint: string }>(sql`
          select finding_type, fingerprint from ai_work_items
           where org_id = ${org.orgId} and agent_key = 'tax'
        `))).rows;
      assert.ok(
        persisted.some((row) => row.fingerprint === "tax-missing-codes:vendor_bill"),
        `the finding persists with a stable fingerprint, got ${JSON.stringify(persisted)}`,
      );
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "tax findings never leak across orgs",
  { skip: !DB },
  async () => {
    const orgA = await withBypass(() => createScratchOrg());
    const orgB = await withBypass(() => createScratchOrg());
    try {
      await seedPostedBill(orgA, "TAX-OTHER-ORG", "9000.0000", null);
      const findingsA = await scan(orgA.orgId, { tax_missing_codes: { lookbackDays: 90 } });
      assert.ok(findingsA.length > 0, "org A flags its own untaxed lines");
      assert.deepEqual(await scan(orgB.orgId, { tax_missing_codes: { lookbackDays: 90 } }), [], "org B sees none of org A's lines");
    } finally {
      await withBypass(() => dropScratchOrg(orgA.orgId));
      await withBypass(() => dropScratchOrg(orgB.orgId));
    }
  },
);
