import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";
import { loadCatalog } from "./catalog.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// Tables the clone must never copy: executable scheduler work (a global
// (kind, occurrence_key) unique the copy collides with, and side effects a
// sample or sandbox must never replay) and bearer-equivalent tokens (live
// invitation/payment/kiosk/document-signing secrets routable without an org
// predicate, same class as api_keys). OM-13b: cloning a template carrying
// scheduler rows died deterministically with PG 23505 on
// scheduler_outbox_occurrence; OM-13-CLONE: hrm_document_signers.token_hash
// is the same shape (global unique, org-less lookup) and collides the same
// way on any template with in-flight signing links.
const NEVER_CLONED = [
  "scheduler_outbox",
  "scheduler_outbox_terminal_audit",
  "payment_links",
  "field_ticket_signature_requests",
  "hrm_survey_invitations",
  "hrm_document_signers",
  "time_kiosks",
] as const;

test("the clone plan never copies executable scheduler work or live tokens", { skip: !DB }, async () => {
  const catalog = await loadCatalog();
  for (const table of NEVER_CLONED) {
    assert.ok(!catalog.rebaseSet.has(table), `${table} must be excluded from the clone plan`);
  }
});

test("cloning a template with scheduler and token rows succeeds and copies none of them", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let created: { sandboxId: string; sandboxOrgId: string } | null = null;
  let cloneError: unknown = null;
  try {
    await db.execute(sql`
      insert into scheduler_outbox (id, org_id, kind, subject_id, payload, occurrence_key, status)
      values (${randomUUID()}, ${org.orgId}, 'flow_email', ${randomUUID()}, '{}'::jsonb, ${`clone-probe-${randomUUID()}`}, 'pending')
    `);
    await db.execute(sql`
      insert into time_kiosks (id, org_id, name, pin_required, photo_required, device_token_hash, is_active)
      values (${randomUUID()}, ${org.orgId}, 'probe kiosk', false, false, ${`probe-token-${randomUUID()}`}, true)
    `);
    // An in-flight document signing link: bearer-equivalent like the kiosk
    // token above, routed by a global token_hash unique with no org
    // predicate. The seed is only non-vacuous with a live row present.
    const signerPartyId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name)
      values (${signerPartyId}, ${org.orgId}, 'employee', 'Probe Signer')
    `);
    const hrmDocId = randomUUID();
    await db.execute(sql`
      insert into hrm_documents (id, org_id, title, category_key)
      values (${hrmDocId}, ${org.orgId}, 'Probe policy', 'policy')
    `);
    await db.execute(sql`
      insert into hrm_document_signers (id, org_id, document_id, ord, signer_party_id, role, status, token_hash)
      values (${randomUUID()}, ${org.orgId}, ${hrmDocId}, 0, ${signerPartyId}, 'employee', 'pending', ${`probe-sign-token-${randomUUID()}`})
    `);
    try {
      created = await createSandbox({
        productionOrgId: org.orgId,
        name: `Clone probe ${randomUUID()}`,
        tier: "full",
        masked: false,
      });
    } catch (error) {
      cloneError = error;
    }
    assert.equal(cloneError, null);
    for (const table of NEVER_CLONED) {
      const copied = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from ${sql.identifier(table)} where org_id = ${created!.sandboxOrgId}
      `)).rows[0]!.n;
      assert.equal(copied, 0, `sandbox must not carry ${table} rows`);
    }
    // The source rows are untouched by the clone.
    const sourceOutbox = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from scheduler_outbox where org_id = ${org.orgId}
    `)).rows[0]!.n;
    assert.equal(sourceOutbox, 1);
  } finally {
    // A failed clone still commits its shell (org + sandbox row): remove
    // every sandbox of the scratch org before dropping it, so the shell
    // never masks the clone failure or strands the fixture.
    const shells = (await db.execute<{ id: string }>(sql`
      select id from sandboxes where production_org_id = ${org.orgId}
    `)).rows;
    for (const shell of shells) {
      await deleteSandbox(shell.id).catch(() => undefined);
    }
    if (created) await deleteSandbox(created.sandboxId).catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});

test("flow run history is copied with its global dedup key cleared", { skip: !DB }, async () => {
  // OM-13-CLONE: flow_runs.occurrence_key sits in a global partial unique
  // with no org_id, so copying it verbatim collides with the source's own
  // row (PG 23505) and hands the sandbox production's dedup claim. The run
  // rows themselves are inert history worth keeping (gates and effects hang
  // off them by NOT NULL run_id), so the clone clears the key instead of
  // dropping the table.
  const org = await createScratchOrg();
  let created: { sandboxId: string; sandboxOrgId: string } | null = null;
  try {
    const flowId = randomUUID();
    await db.execute(sql`
      insert into flows (id, org_id, name, subject_kind, graph, enabled)
      values (${flowId}, ${org.orgId}, 'probe flow', 'customer', '{}'::jsonb, true)
    `);
    const occurrenceKey = `flow-probe-${randomUUID()}`;
    await db.execute(sql`
      insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, occurrence_key, status)
      values (${randomUUID()}, ${org.orgId}, ${flowId}, 'customer', ${randomUUID()}, 'manual', ${occurrenceKey}, 'completed')
    `);
    created = await createSandbox({
      productionOrgId: org.orgId,
      name: `Flow probe ${randomUUID()}`,
      tier: "full",
      masked: false,
    });
    const copied = (await db.execute<{ n: number; keys: (string | null)[] }>(sql`
      select count(*)::int as n, array_agg(occurrence_key) as keys from flow_runs where org_id = ${created.sandboxOrgId}
    `)).rows[0]!;
    assert.equal(copied.n, 1, "flow run history must survive the clone");
    assert.deepEqual(copied.keys, [null], "the copied run must not carry the source dedup key");
    // The source row keeps its key: the clone cleared its own copy, never
    // the template.
    const source = (await db.execute<{ occurrence_key: string | null }>(sql`
      select occurrence_key from flow_runs where org_id = ${org.orgId}
    `)).rows[0]!;
    assert.equal(source.occurrence_key, occurrenceKey);
  } finally {
    const shells = (await db.execute<{ id: string }>(sql`
      select id from sandboxes where production_org_id = ${org.orgId}
    `)).rows;
    for (const shell of shells) {
      await deleteSandbox(shell.id).catch(() => undefined);
    }
    if (created) await deleteSandbox(created.sandboxId).catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});
