import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import { dropScratchOrgReporting } from "@openbooks/engine/testing/fixtures";
import {
  LABELLED_AUDIT_TABLES,
  auditRecordLabelSource,
  auditRecordLabels,
} from "./audit-record-labels";
import { readAuditEvent, readAuditPage } from "./audit-reader";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("every audit label source reads columns the schema has", { skip: !DB }, async () => {
  assert.ok(LABELLED_AUDIT_TABLES.length >= 40, "the label registry loaded");
  const orgId = randomUUID();
  const failures: string[] = [];
  await withBypassContext(async () => {
    for (const table of LABELLED_AUDIT_TABLES) {
      const query = auditRecordLabelSource(table, orgId, [randomUUID()])!;
      try {
        const rows = await db.execute(query, "objects");
        assert.deepEqual(rows, [], `${table} labels nothing outside its organization`);
      } catch (error) {
        failures.push(`${table}: ${(error as Error).message}`);
      }
    }
  });
  assert.deepEqual(failures, [], failures.join("\n"));
});

test(
  "the audit log names equity records by their number, code and legal entity, within the organization",
  { skip: !DB },
  async () => {
    const { setupEquityWorld, seedHolder } = await import("@openbooks/engine/testing/equity-world");
    const { issueSecurity, recordEquityAccountPolicy } = await import("@openbooks/engine/equity");
    const w = await withBypassContext(() => setupEquityWorld({ policy: false }));
    try {
      const policy = await recordEquityAccountPolicy({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        effectiveFrom: "2026-01-01",
        commonStockAccountId: w.accounts.common,
        preferredStockAccountId: w.accounts.preferred,
        apicAccountId: w.accounts.apic,
        apicShareBasedAccountId: w.accounts.apicShareBased,
        compensationExpenseAccountId: w.accounts.expense,
        treasuryStockAccountId: w.accounts.treasury,
        convertibleInstrumentsAccountId: w.accounts.convertible,
        reason: "Configure equity posting accounts",
      });
      assert.equal(policy.status, "applied");
      assert.ok(policy.id);
      const issued = await issueSecurity({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        kind: "share",
        holderPartyId: w.holderId,
        issueDate: "2026-07-01",
        shareClassId: w.commonClassId,
        quantity: "1000",
        pricePerShare: "0.0001",
        considerationAccountId: w.org.accounts.bank,
      });
      const holder = await withBypassContext(() => seedHolder(w.org.orgId, "Audited Holder"));
      const unknownRow = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`insert into audit_log (id, org_id, table_name, row_id, action, changes)
      values (${randomUUID()}, ${w.org.orgId}, 'audit_label_example', ${unknownRow}, 'update', '{}'::jsonb),
             (${randomUUID()}, ${w.org.orgId}, 'parties', ${holder}, 'update', '{}'::jsonb)`),
      );
      await withOrgContext(w.org.orgId, async () => {
        const page = await readAuditPage(w.org.orgId, { page: 1, perPage: 100 });
        const security = page.rows.find(
          (row) => row.recordType === "equity_securities" && row.rowId === issued.id,
        );
        assert.ok(security, "the issue is audited");
        assert.ok(
          security.recordLabel?.label?.startsWith("CS-"),
          JSON.stringify(security.recordLabel),
        );
        const shareClass = page.rows.find((row) => row.recordType === "equity_share_classes");
        assert.equal(shareClass?.recordLabel?.label, "CS · Common Stock");
        const policy = page.rows.find((row) => row.recordType === "equity_account_policies");
        assert.deepEqual(
          policy?.recordLabel?.on,
          "2026-01-01",
          "an account policy reads by its effective date",
        );
        assert.ok(policy?.recordLabel?.label, "and its legal entity");
        assert.equal(
          page.rows.find((row) => row.rowId === holder)?.recordLabel?.label,
          "Audited Holder",
        );
        assert.equal(
          page.rows.find((row) => row.rowId === unknownRow)?.recordLabel,
          null,
          "a family with no label source keeps its row id",
        );
        const event = await readAuditEvent(w.org.orgId, security.id);
        assert.equal(
          event?.recordLabel?.label,
          security.recordLabel?.label,
          "the event drawer reads the same label",
        );
      });
      // Another organization's audit rows never borrow these records' labels.
      const foreign = await withBypassContext(() =>
        auditRecordLabels(randomUUID(), [{ table: "equity_securities", rowId: issued.id }]),
      );
      assert.equal(foreign.size, 0);
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
