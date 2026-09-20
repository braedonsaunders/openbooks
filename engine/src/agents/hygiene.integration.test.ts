import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { addCalendarDays } from "../platform/business-date.ts";
import { defaultContinuousCloseDetectors } from "./continuous-close-config.ts";
import { db, withBypass, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { hygieneFindings } from "./hygiene.ts";

/**
 * Live-PostgreSQL proof for the data-hygiene pack with its production
 * loaders: one seeded gap per detector, plus org isolation. Assertions use
 * contains-semantics because the scratch bootstrap owns baseline master data
 * (its seeded service item, for example, legitimately lacks a tax code).
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function seedAccount(orgId: string, number: string, name: string, type: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into accounts (id, org_id, number, name, type) values (${id}, ${orgId}, ${number}, ${name}, ${type})`));
  return id;
}

test(
  "hygiene pack flags each seeded master-data gap and isolates tenants",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const other = await withBypass(() => createScratchOrg());
    try {
      const cashMisfiled = await seedAccount(org.orgId, "1999", "Harbor Cash", "expense");
      const provisionMisfiled = await seedAccount(org.orgId, "1998", "Harbor Provision", "asset_bank");
      const foreignCash = await seedAccount(other.orgId, "1999", "Foreign Cash", "expense");

      for (const name of ["Harbor Foods", "HARBOR  Foods"]) {
        await withBypassContext(() => db.execute(sql`
          insert into parties (id, org_id, kind, display_name) values (${randomUUID()}, ${org.orgId}, 'customer', ${name})`));
      }
      for (const name of ["Tax Twin A", "Tax Twin B"]) {
        await withBypassContext(() => db.execute(sql`
          insert into parties (id, org_id, kind, display_name, tax_ids)
          values (${randomUUID()}, ${org.orgId}, 'vendor', ${name}, '{"gst":"R123"}')`));
      }

      const itemId = randomUUID();
      await withBypassContext(() => db.execute(sql`
        insert into items (id, org_id, kind, name) values (${itemId}, ${org.orgId}, 'sale', 'Widget')`));

      const projectId = randomUUID();
      await withBypassContext(() => db.execute(sql`
        insert into projects (id, org_id, code, name) values (${projectId}, ${org.orgId}, 'HT-1', 'Harbor Tower')`));

      // An empty APPROVED scenario is guard-forbidden (the scenario trigger
      // requires a non-zero line and lines freeze outside draft), so the
      // empty-scenario detector is legacy defense: walk a healthy scenario
      // through the real draft → approved lifecycle and assert no false
      // positive (the positive path is covered in hygiene.test.ts with
      // injected rows).
      const scenarioId = randomUUID();
      const fiscalYear = (await withBypassContext(() => db.execute<{ fiscal_year: number }>(sql`
        select fiscal_year from accounting_periods where id = ${org.periodId} and org_id = ${org.orgId}`))).rows[0]!.fiscal_year;
      await withBypassContext(() => db.execute(sql`
        insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
        values (${scenarioId}, ${org.orgId}, ${org.bookId}, ${fiscalYear}, 'Plan', 'budget', 'draft')`));
      const revenueAccount = (await withBypassContext(() => db.execute<{ id: string }>(sql`
        select id from accounts where org_id = ${org.orgId} and type = 'income' limit 1`))).rows[0]?.id
        ?? org.accounts.revenue;
      await withBypassContext(() => db.execute(sql`
        insert into budget_lines (id, org_id, scenario_id, account_id, period_id, amount)
        values (${randomUUID()}, ${org.orgId}, ${scenarioId}, ${revenueAccount}, ${org.periodId}, '100')`));
      await withBypassContext(() => db.execute(sql`
        update budget_scenarios set status = 'pending_approval', revision = revision + 1 where id = ${scenarioId}`));
      await withBypassContext(() => db.execute(sql`
        update budget_scenarios set status = 'approved', revision = revision + 1 where id = ${scenarioId}`));

      const componentId = randomUUID();
      await withBypassContext(() => db.execute(sql`
        insert into pay_components (id, org_id, code, name, kind) values (${componentId}, ${org.orgId}, 'GARN', 'Garnishment', 'deduction')`));

      const findings = await withBypassContext(() =>
        hygieneFindings(org.orgId, "1000.0000", defaultContinuousCloseDetectors("hygiene")),
      );
      const byType = (type: string) => findings.filter((finding) => finding.findingType === type);
      const subjects = (type: string) => new Set(byType(type).map((finding) => finding.subjectId));

      const controls = subjects("control_account_type_mismatch");
      assert.ok(controls.has(cashMisfiled), "cash typed as expense flags");
      assert.ok(controls.has(provisionMisfiled), "provision typed as asset flags");
      assert.ok(!controls.has(foreignCash), "the other tenant's gap never leaks in");
      const foreignFindings = await withBypassContext(() =>
        hygieneFindings(other.orgId, "1000.0000", defaultContinuousCloseDetectors("hygiene")),
      );
      assert.ok(
        foreignFindings.some((finding) => finding.subjectId === foreignCash),
        "the foreign gap is detectable in its own tenant (absence above is isolation, not a broken seed)",
      );
      assert.ok(
        byType("control_account_type_mismatch").every((finding) => finding.severity === "warning" && finding.materiality === "0.0000"),
        "hygiene carries no measured exposure",
      );

      const dupes = byType("duplicate_party_identity");
      assert.equal(dupes.filter((finding) => finding.summary.matchOn === "name").length, 1, "one normalized-name group");
      assert.equal(dupes.filter((finding) => finding.summary.matchOn === "tax_id").length, 1, "one shared-tax-id group");

      assert.ok(subjects("item_missing_tax_code").has(itemId), "untaxed sale item flags");
      assert.ok(subjects("project_missing_cost_budget").has(projectId), "unbudgeted project flags");

      const scenarios = byType("budget_scenario_without_lines");
      assert.ok(
        scenarios.every((finding) => finding.subjectId !== scenarioId),
        "the healthy approved scenario is not flagged",
      );

      const components = byType("unmapped_payroll_component");
      const garnishment = components.find((finding) => finding.subjectId === componentId);
      assert.ok(garnishment, "unmapped deduction flags");
      assert.deepEqual(garnishment!.summary.missing, ["liabilityAccountId", "remittancePartyId"]);

      assert.ok(
        findings.every((finding) => (finding.proposal ?? null) === null),
        "master-data fixes need judgment: reviews, not pre-filled commands",
      );
      assert.ok(
        findings.every((finding) => typeof finding.summary.href === "string" && finding.summary.href.startsWith("/")),
        "every gap names its review path",
      );
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
      await withBypass(() => dropScratchOrg(other.orgId));
    }
  },
);

/**
 * A bank-typed account carrying a persistent credit-normal balance that
 * nobody reconciles is either miscategorised (a tax-provision liability
 * sitting inside asset_bank, so dashboard cash and both cash-flow
 * statements counted a provision as cash) or an unmanaged overdraft.
 * Either way the product should say so: the finding is a warning with a
 * review path, never a retype.
 */
test(
  "bank-typed credit balances flag only when unmanaged and persistent",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const seedBank = async (number: string, name: string, reconcilable: boolean): Promise<string> => {
        const id = randomUUID();
        await withBypassContext(() => db.execute(sql`
          insert into accounts (id, org_id, number, name, type, reconcilable, currency_restriction)
          values (${id}, ${org.orgId}, ${number}, ${name}, 'asset_bank', ${reconcilable}, ${reconcilable ? "CAD" : null})`));
        return id;
      };
      const postBalanced = async (postingDate: string, debitAccount: string, creditAccount: string, amount: string) => {
        const entryId = randomUUID();
        await withBypassContext(() => db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
          values
            (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`HX-${entryId.slice(0, 8)}`},
             ${postingDate}, ${org.periodId}, 'hygiene bank-credit seed', 'draft', 'manual')`));
        await withBypassContext(() => db.execute(sql`
          insert into journal_lines
            (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values
            (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${debitAccount}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
            (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${creditAccount}, ${org.subsidiaryId}, ${`-${amount}`}, 'CAD', ${`-${amount}`}, '1')`));
        await withBypassContext(() => db.execute(sql`
          update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}`));
      };
      const oldDate = addCalendarDays(org.date, -120);

      // The 5910 shape: credit-normal before the trailing window and still
      // credit-normal today, never reconciled.
      const reserve = await seedBank("5970", "Harbor Reserve", false);
      await postBalanced(oldDate, org.accounts.adjustment, reserve, "40000");
      // A managed facility: credit-normal but statement-reconcilable.
      const facility = await seedBank("5971", "Harbor Facility", true);
      await postBalanced(org.date, org.accounts.cogs, facility, "100000");
      // Genuine cash: debit-normal.
      const operating = await seedBank("5972", "Harbor Operating", false);
      await postBalanced(org.date, operating, org.accounts.revenue, "50000");
      // A fresh overdraft: positive before the window, negative today.
      const swing = await seedBank("5973", "Harbor Swing", false);
      await postBalanced(oldDate, swing, org.accounts.revenue, "100000");
      await postBalanced(org.date, org.accounts.cogs, swing, "150000");

      const findings = await withBypassContext(() =>
        hygieneFindings(org.orgId, "1000.0000", defaultContinuousCloseDetectors("hygiene")),
      );
      const subjects = new Set(
        findings
          .filter(
            (finding) =>
              finding.findingType === "control_account_type_mismatch" &&
              finding.summary.reason === "bank_credit_balance",
          )
          .map((finding) => finding.subjectId),
      );
      assert.ok(subjects.has(reserve), "unmanaged persistent credit-balance bank flags");
      assert.ok(!subjects.has(facility), "a reconciled facility stays silent");
      assert.ok(!subjects.has(operating), "debit-normal cash stays silent");
      assert.ok(!subjects.has(swing), "a fresh overdraft stays silent");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
