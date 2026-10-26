import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  assertDedicatedFixtureDatabase,
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import { resolveApprovalSubjects, type ApprovalSubjectText } from "./approval-subjects.ts";

/**
 * Financial-change inbox rows must name the accounting event with the
 * subject's title — never the bare "financial change" kind with an empty
 * party and amount. The resolver reads the frozen change: the subject label
 * for the title, the event label for the kind, the person for payroll, and
 * proposed money where the payload carries it.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;
const text: ApprovalSubjectText = Object.assign((key: string) => key, {
  has: () => false,
});

async function seedChange(
  orgId: string,
  subsidiaryId: string,
  submitterId: string,
  args: {
    domain: string;
    subjectId: string;
    operation: string;
    payload?: Record<string, unknown>;
    beforeState?: Record<string, unknown>;
  },
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into financial_changes
      (id, org_id, subsidiary_id, domain, subject_id, operation, effective_on, reason,
       idempotency_key, payload, before_state, submitted_by, created_by, updated_by)
    values (${id}, ${orgId}, ${subsidiaryId}, ${args.domain}, ${args.subjectId}, ${args.operation},
      '2026-07-15', 'subject readout for the inbox row', ${`subject-${id}`},
      ${JSON.stringify(args.payload ?? {})}::jsonb, ${JSON.stringify(args.beforeState ?? {})}::jsonb,
      ${submitterId}, ${submitterId}, ${submitterId})`);
  return id;
}

test(
  "financial-change subjects resolve to event, title, party, and amount",
  { skip: !DB },
  async () => {
    await assertDedicatedFixtureDatabase();
    const org = await createScratchOrg();
    try {
      const submitter = await createScratchUser(org.orgId, "Subject Proposer", "accountant");
      await db.execute(
        sql`update items set code = 'FG-HOUSE-12', name = 'House 12' where id = ${org.items.assembly} and org_id = ${org.orgId}`,
      );
      const worker = randomUUID();
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${worker}, ${org.orgId}, 'person', 'Rowan Poe', ${org.subsidiaryId}, true, '{}'::jsonb)`);

      const bom = await seedChange(org.orgId, org.subsidiaryId, submitter, {
        domain: "manufacturing",
        subjectId: org.items.assembly,
        operation: "bom_revision_activation",
        payload: {
          assemblyItemId: org.items.assembly,
          expectedVersion: null,
          components: [
            {
              componentItemId: org.items.component,
              quantityPer: "2.0000",
              sortOrder: 0,
              effectiveFrom: "2026-07-15",
              effectiveTo: null,
              operationSeq: 10,
              scrapPct: "1.5000",
              isByproduct: false,
              quantityBasis: "per_unit",
              formulaOutputQuantity: "1.0000",
              outputCostWeight: null,
            },
          ],
          requiredSubsidiaryIds: [org.subsidiaryId],
        },
        beforeState: { kind: "assembly", version: null, lines: [] },
      });
      const routingId = randomUUID();
      await db.execute(sql`
      insert into mfg_routings
        (id, org_id, produced_item_id, code, name, version, status, effective_from, overhead_basis, created_by, updated_by)
      values (${routingId}, ${org.orgId}, ${org.items.assembly}, 'RTG-7', 'Routing 7', 1, 'draft',
        '2026-07-15', 'labor_hours', ${submitter}, ${submitter})`);
      const routing = await seedChange(org.orgId, org.subsidiaryId, submitter, {
        domain: "manufacturing",
        subjectId: routingId,
        operation: "routing_revision_activation",
        payload: { routingId, requiredSubsidiaryIds: [org.subsidiaryId], supersedes: [] },
        beforeState: {
          candidate: { id: routingId, effectiveFrom: "2026-07-15", operations: [] },
          active: [],
          supersedes: [],
        },
      });
      const holiday = await seedChange(org.orgId, org.subsidiaryId, submitter, {
        domain: "payroll",
        subjectId: worker,
        operation: "adjudicated_holiday_hours",
        payload: { hours: "8" },
      });
      const provision = await seedChange(org.orgId, org.subsidiaryId, submitter, {
        domain: "asset",
        subjectId: randomUUID(),
        operation: "revaluation",
        payload: { estimate: "1500.00", currency: "CAD" },
      });

      const details = await resolveApprovalSubjects(
        org.orgId,
        [
          { kind: "financial_change", subjectId: bom },
          { kind: "financial_change", subjectId: routing },
          { kind: "financial_change", subjectId: holiday },
          { kind: "financial_change", subjectId: provision },
          { kind: "financial_change", subjectId: randomUUID() },
        ],
        text,
      );
      assert.equal(details.size, 4, "unresolvable subjects stay absent");

      const bomDetail = details.get(`financial_change:${bom}`)!;
      assert.equal(bomDetail.summary, "FG-HOUSE-12 — House 12");
      assert.equal(bomDetail.kindLabel, "Bill of materials revision approval");
      assert.equal(bomDetail.partyName, null);
      assert.equal(bomDetail.amount ?? null, null);

      const routingDetail = details.get(`financial_change:${routing}`)!;
      assert.equal(routingDetail.kindLabel, "Routing revision approval");
      assert.equal(routingDetail.summary, "RTG-7 — Routing 7");

      const holidayDetail = details.get(`financial_change:${holiday}`)!;
      assert.equal(holidayDetail.partyName, "Rowan Poe");
      assert.equal(holidayDetail.summary, "Rowan Poe");

      const provisionDetail = details.get(`financial_change:${provision}`)!;
      assert.equal(provisionDetail.amount, "1500.00");
      assert.equal(provisionDetail.currency, "CAD");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
