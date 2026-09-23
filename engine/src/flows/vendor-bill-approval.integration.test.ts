import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedApprovalFlow } from "../testing/fixtures.ts";
import {
  hasVendorBillApprovalFlow,
  isVendorBillApprovalRequired,
} from "./vendor-bill-approval.ts";

/**
 * Vendor-bill release policy reads: the org switch defaults OFF and an
 * "approval flow configured" signal requires a flow that can actually gate
 * (an enabled vendor-bill flow carrying a gate node). Pure-automation flows
 * must not silence the Setup warning — they never own a submit.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function setRequirement(orgId: string, value: string): Promise<void> {
  // jsonb_set never creates INTERMEDIATE path elements, so merge the
  // `approvals` object explicitly instead of setting a two-level path.
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         coalesce(settings, '{}'::jsonb), '{approvals}',
         coalesce(settings->'approvals', '{}'::jsonb) || jsonb_build_object('requireVendorBillApproval', ${value}::jsonb),
         true)
     where id = ${orgId}`);
}

test("vendor-bill approval requirement defaults OFF and round-trips a boolean", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.equal(await isVendorBillApprovalRequired(org.orgId), false);
    await setRequirement(org.orgId, "true");
    assert.equal(await isVendorBillApprovalRequired(org.orgId), true);
    await setRequirement(org.orgId, "false");
    assert.equal(await isVendorBillApprovalRequired(org.orgId), false);
    // Junk never enables the gate: fail closed toward today's behaviour.
    await setRequirement(org.orgId, '"yes"');
    assert.equal(await isVendorBillApprovalRequired(org.orgId), false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("vendor-bill approval flow signal needs an enabled gating flow", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.equal(await hasVendorBillApprovalFlow(org.orgId), false);
    // Pure automation (on_submit trigger, no gate) never owns a submit.
    await db.execute(sql`
      insert into flows (id, org_id, name, subject_kind, enabled, graph)
      values (${randomUUID()}, ${org.orgId}, 'Automation only', 'vendor_bill', true,
              ${JSON.stringify({
                schemaVersion: 1,
                nodes: [
                  { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } },
                  { id: "ping", position: { x: 220, y: 0 }, data: { kind: "action", action: { action: "notify", to: [], title: "hi", body: "hi" } } },
                ],
                edges: [{ id: "e1", source: "trigger", target: "ping", sourceHandle: "next" }],
              })}::jsonb)`);
    assert.equal(await hasVendorBillApprovalFlow(org.orgId), false);
    // A disabled gating flow configures nothing either.
    const { flowId } = await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "submitter" }],
      mode: "any",
    });
    await db.execute(sql`update flows set enabled = false where id = ${flowId}`);
    assert.equal(await hasVendorBillApprovalFlow(org.orgId), false);
    await db.execute(sql`update flows set enabled = true where id = ${flowId}`);
    assert.equal(await hasVendorBillApprovalFlow(org.orgId), true);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
