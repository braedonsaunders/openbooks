import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { recordSupplyEvidence } from "./cross-border-records.ts";
import { assertCrossBorderSupplyEvidence } from "./cross-border-posting.ts";
import { CrossBorderTaxError } from "./cross-border-place-of-supply.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "a cross-border verdict refuses line taxes coded to another place of supply",
  { skip: !DB },
  async () => {
    // A German seller's B2C digital supply evidenced in France is taxed in
    // France. Lines coded to German VAT would be reported on the OSS return
    // under France and again on the domestic return; a reverse-charge
    // component without a reverse-charge verdict would report it nowhere.
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Cross-border lines", "admin");
      await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', '{"crossBorderTax": true}'::jsonb)
       where id = ${org.orgId}`);
      await db.execute(
        sql`update subsidiaries set country = 'DE' where org_id = ${org.orgId} and id = ${org.subsidiaryId}`,
      );
      const codes = new Map<string, string>();
      for (const [code, country, calculationType] of [
        ["DE-19", "DE", "standard"],
        ["FR-20", "FR", "standard"],
        ["RC", "FR", "reverse_charge"],
      ] as const) {
        const id = randomUUID();
        await db.execute(sql`insert into tax_codes (id, org_id, code, name, country, calculation_type)
        values (${id}, ${org.orgId}, ${code}, ${code}, ${country}, ${calculationType})`);
        codes.set(code, id);
      }
      const documentId = randomUUID();
      await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate,
         subtotal, tax_total, total, created_by, updated_by)
      values (${documentId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-XB-LINES', ${org.subsidiaryId}, ${org.customerId},
              '2026-10-05', 'EUR', '1', '100.0000', '20.0000', '120.0000', ${actorId}, ${actorId})`);
      const lineId = randomUUID();
      await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, '1', '100', '100', '20')`);
      await recordSupplyEvidence(
        db,
        org.orgId,
        documentId,
        {
          election: { supplyKind: "digital_service", customerKind: "consumer" },
          evidence: [
            { kind: "billing_address", country: "FR", source: "checkout address" },
            { kind: "ip_country", country: "FR", source: "checkout session" },
          ],
        },
        actorId,
      );
      const taxWith = async (code: string, calculationType: string) => {
        await db.execute(
          sql`delete from document_line_tax_components where org_id = ${org.orgId} and document_line_id = ${lineId}`,
        );
        await db.execute(sql`
        insert into document_line_tax_components
          (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount, tax_amount, recoverable_amount, calculation_type)
        values (${org.orgId}, ${lineId}, ${codes.get(code)!}, 1, '20', '100', '20', '20', ${calculationType})`);
      };

      await taxWith("DE-19", "standard");
      await assert.rejects(
        assertCrossBorderSupplyEvidence(db, org.orgId, documentId),
        (error: unknown) =>
          error instanceof CrossBorderTaxError &&
          /taxed in FR/.test(error.message) &&
          error.message.includes("remove the cross-border classification"),
      );
      await taxWith("RC", "reverse_charge");
      await assert.rejects(
        assertCrossBorderSupplyEvidence(db, org.orgId, documentId),
        (error: unknown) =>
          error instanceof CrossBorderTaxError &&
          /reverse charge does not apply/.test(error.message),
      );
      await taxWith("FR-20", "standard");
      const verdict = await assertCrossBorderSupplyEvidence(db, org.orgId, documentId);
      assert.deepEqual([verdict?.outcome, verdict?.country], ["customer_country", "FR"]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
