/**
 * HR-15 inbox act subsidiary-scope DB integration.
 *
 * A restricted actor must not approve an out-of-scope gate by id: the
 * session's subsidiary boundary rides the inbox context into the gate
 * write authority (decideGate), which refuses the foreign gate by name
 * instead of deciding it. The same actor with the gate's entity in scope
 * approves normally.
 *
 * Integration partition: skips without OPENBOOKS_DB_URL; run one file per
 * database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { submitForApproval } from "../flows/submit.ts";
import { flowsApprovalAdapter } from "./adapters/flows-approval.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const nowIso = (): string => new Date().toISOString();

async function gateStatus(orgId: string, subjectId: string): Promise<string> {
  const row = (await db.execute<{ status: string }>(sql`
    select status from flow_gates
     where org_id = ${orgId} and subject_id = ${subjectId} and status = 'pending'
  `)).rows[0];
  return row?.status ?? "resolved";
}

test("a restricted actor cannot approve an out-of-scope gate by id", { skip: !DB }, async () => {
  const org: ScratchOrg = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    // A second legal entity the actor's scope never names. It hangs under
    // the org root (one root per org) — still a distinct boundary id.
    const hiddenId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${hiddenId}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden Co', 'CAD', 'CA')
    `);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const docId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
    });
    await db.execute(sql`
      update documents set subsidiary_id = ${hiddenId}
       where id = ${docId} and org_id = ${org.orgId}
    `);
    const submitted = await submitForApproval("vendor_bill", docId);
    assert.equal(submitted.gated, true, "the fixture must raise a real pending gate");
    const gate = (await db.execute<{ id: string }>(sql`
      select id from flow_gates
       where org_id = ${org.orgId} and subject_id = ${docId} and status = 'pending'
    `)).rows[0];
    assert.ok(gate, "the gate the actor will name by id must exist");

    const restricted = {
      orgId: org.orgId,
      actorId: actors.approver1Id,
      asOf: nowIso(),
      scope: { roles: ["approver"], allowedSubsidiaryIds: [org.subsidiaryId] },
    };
    await assert.rejects(
      flowsApprovalAdapter.act(restricted, `gate:${gate!.id}`, "approve"),
      (error: unknown) => {
        assert.match(
          (error as Error).message,
          /approval not found/,
          "an out-of-scope gate is indistinguishable from a missing one",
        );
        return true;
      },
    );
    assert.equal(
      await gateStatus(org.orgId, docId),
      "pending",
      "the refused decision writes nothing — the gate stays pending",
    );

    // Positive control: the same actor with the gate's entity in scope
    // approves through the same adapter path.
    const allowed = {
      ...restricted,
      scope: { roles: ["approver"], allowedSubsidiaryIds: [hiddenId] },
    };
    await flowsApprovalAdapter.act(allowed, `gate:${gate!.id}`, "approve");
    assert.equal(await gateStatus(org.orgId, docId), "resolved", "the in-scope approval lands");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
