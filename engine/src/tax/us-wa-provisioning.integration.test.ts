import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { provisionTaxPacks } from "./pack-provisioning.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const RUNTIME_DB = process.env.OPENBOOKS_RUNTIME_DB_URL;

test(
  "Washington provisions the combined excise return with state, B&O, and location boxes",
  { skip: !DB || !RUNTIME_DB },
  async () => {
    const target = await withBypass(() => createScratchOrg());
    try {
      const result = await provisionTaxPacks(target.orgId, ["US_WA_CET"]);
      assert.ok(result.taxCodesCreated >= 7);
      assert.ok(result.registrationsCreated >= 1);

      const installed = await withOrgContext(target.orgId, async () => {
        const jurisdictions = (await db.execute(sql`
          select code from tax_jurisdictions
           where org_id = ${target.orgId} and code in ('US', 'US-WA')
           order by code
        `)).rows as Array<{ code: string }>;
        const codes = (await db.execute(sql`
          select code.code,
                 coalesce(
                   jsonb_agg(
                     jsonb_build_object(
                       'rate', rate.rate_percent::text,
                       'from', rate.effective_from::text,
                       'to', rate.effective_to::text
                     ) order by rate.effective_from
                   ) filter (where rate.id is not null),
                   '[]'::jsonb
                 ) as rates
            from tax_codes code
            left join tax_rates rate
              on rate.org_id = code.org_id and rate.tax_code_id = code.id
           where code.org_id = ${target.orgId}
             and code.code in ('US-WA-ST', 'US-WA-BO-RET', 'US-WA-BO-WHO', 'US-WA-BO-MFG',
                               'US-WA-BO-SVC', 'US-WA-BO-SVC1M', 'US-WA-BO-SVC5M')
           group by code.id, code.code
           order by code.code
        `)).rows as Array<{
          code: string;
          rates: Array<{ rate: string; from: string; to: string | null }>;
        }>;
        const groupMembers = (await db.execute(sql`
          select count(*)::text as "count"
            from tax_group_members member
            join tax_groups grp on grp.id = member.tax_group_id and grp.org_id = ${target.orgId}
           where grp.code = 'US-WA-TAX'
        `)).rows as Array<{ count: string }>;
        const forms = (await db.execute(sql`
          select code from tax_return_forms
           where org_id = ${target.orgId} and code in ('US_WA_CET', 'US_SALES_TAX_WORKPAPER')
           order by code
        `)).rows as Array<{ code: string }>;
        const boxes = (await db.execute(sql`
          select line_code as "lineCode", formula,
                 count(tax_code_id)::text as "mappedCodes"
            from tax_report_lines
           where org_id = ${target.orgId} and report_code = 'US_WA_CET'
           group by line_code, formula
           order by min(sequence)
        `)).rows as Array<{ lineCode: string; formula: string | null; mappedCodes: string }>;
        const registrations = (await db.execute(sql`
          select registration.is_active as "isActive",
                 registration.filing_frequency as "filingFrequency",
                 registration.return_form_code as "returnFormCode"
            from tax_registrations registration
            join tax_jurisdictions jurisdiction
              on jurisdiction.id = registration.jurisdiction_id
             and jurisdiction.org_id = registration.org_id
           where registration.org_id = ${target.orgId} and jurisdiction.code = 'US-WA'
        `)).rows as Array<{ isActive: boolean; filingFrequency: string; returnFormCode: string | null }>;
        return { jurisdictions, codes, groupMembers, forms, boxes, registrations };
      });

      assert.deepEqual(installed.jurisdictions.map((row) => row.code), ["US", "US-WA"]);
      assert.deepEqual(installed.forms.map((row) => row.code), ["US_SALES_TAX_WORKPAPER", "US_WA_CET"]);
      assert.deepEqual(installed.codes.find((row) => row.code === "US-WA-ST")?.rates, [
        { rate: "2.0000", from: "1935-05-01", to: "1941-04-30" },
        { rate: "3.0000", from: "1941-05-01", to: "1955-04-30" },
        { rate: "3.3300", from: "1955-05-01", to: "1959-03-31" },
        { rate: "4.0000", from: "1959-04-01", to: "1965-05-31" },
        { rate: "4.2000", from: "1965-06-01", to: "1967-06-30" },
        { rate: "4.5000", from: "1967-07-01", to: "1976-05-31" },
        { rate: "4.6000", from: "1976-06-01", to: "1979-06-30" },
        { rate: "4.5000", from: "1979-07-01", to: "1981-12-03" },
        { rate: "5.5000", from: "1981-12-04", to: "1982-04-30" },
        { rate: "5.4000", from: "1982-05-01", to: "1983-02-28" },
        { rate: "6.5000", from: "1983-03-01", to: null },
      ]);
      assert.deepEqual(installed.codes.find((row) => row.code === "US-WA-BO-RET")?.rates, [
        { rate: "0.4710", from: "1982-07-01", to: "2026-12-31" },
        { rate: "0.5000", from: "2027-01-01", to: null },
      ]);
      assert.equal(installed.codes.length, 7);
      assert.equal(installed.groupMembers[0]?.count, "7");
      assert.deepEqual(installed.boxes.map((row) => row.lineCode), [
        "BO_RET", "BO_WHO", "BO_MFG", "BO_SVC", "BO_SVC1M", "BO_SVC5M",
        "ST_TAXABLE", "ST_TAX", "USE_TAX", "LOCAL_TAXABLE", "LOCAL_TAX",
        "SBC_CREDIT", "WA_GROSS", "WA_TAX", "TOTAL_DUE",
      ]);
      assert.equal(installed.boxes.find((row) => row.lineCode === "WA_TAX")?.mappedCodes, "7");
      assert.equal(installed.boxes.find((row) => row.lineCode === "WA_GROSS")?.mappedCodes, "7");
      assert.equal(
        installed.boxes.find((row) => row.lineCode === "TOTAL_DUE")?.formula,
        "ST_TAX + USE_TAX + LOCAL_TAX + BO_RET + BO_WHO + BO_MFG + BO_SVC + BO_SVC1M + BO_SVC5M - SBC_CREDIT",
      );
      assert.deepEqual(installed.registrations, [
        { isActive: true, filingFrequency: "quarterly", returnFormCode: "US_WA_CET" },
      ]);

      const again = await provisionTaxPacks(target.orgId, ["US_WA_CET"]);
      assert.equal(again.taxCodesCreated, 0);
      assert.equal(again.registrationsCreated, 0);
    } finally {
      await withBypass(() => dropScratchOrg(target.orgId));
    }
  },
);
