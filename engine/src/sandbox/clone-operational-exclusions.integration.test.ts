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
// invitation/payment/kiosk secrets routable without an org predicate, same
// class as api_keys). OM-13b: cloning a template carrying scheduler rows
// died deterministically with PG 23505 on scheduler_outbox_occurrence.
const NEVER_CLONED = [
  "scheduler_outbox",
  "scheduler_outbox_terminal_audit",
  "payment_links",
  "field_ticket_signature_requests",
  "hrm_survey_invitations",
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
