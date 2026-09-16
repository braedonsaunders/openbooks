import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

// User-script `set` (before_submit / before_post) and Flows set_field write
// AROUND applyDocumentEdit with a bare update: the HTTP edit path proves uuid
// SHAPE and org OWNERSHIP for every native dimension and every
// `reference`-type custom value, but these channels applied script/flow
// values unchecked — a well-formed id from another tenant persisted as a
// silent cross-tenant pointer (custom jsonb has no constraint at all), and a
// malformed date died as an unhandled storage error.
const { db, env, withBypass, withOrgContext } = await import("./db.ts");
const {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} = await import("./test-fixtures.ts");
const { submitForApproval } = await import("./flows/submit.ts");
const { createDocumentsFlowAdapter } = await import(
  "./flows/documents-adapter.ts"
);

const DB = !!env.OPENBOOKS_DB_URL;

async function seedOrg() {
  const org = await withBypass(() => createScratchOrg());
  const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
  await withBypass(() =>
    db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features,scripts}', 'true'::jsonb)
       where id = ${org.orgId}
    `),
  );
  return { org, actorId };
}

async function seedReferenceDef(orgId: string, actorId: string) {
  await withBypass(() => db.execute(sql`
    insert into custom_field_defs
      (id, org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active, created_by, updated_by)
    values
      (${randomUUID()}, ${orgId}, 'documents', null, 'ref_party', 'Reference party', 'reference', '{"referenceTable":"parties"}'::jsonb, false, true, ${actorId}, ${actorId})
  `));
}

async function seedScript(orgId: string, setJson: string) {
  await withBypass(() => db.execute(sql`
    insert into user_scripts
      (id, org_id, name, trigger_point, document_kind, source, timeout_ms, sort_order, is_active)
    values
      (${randomUUID()}, ${orgId}, 'mutation refs probe', 'before_submit', 'journal',
       ${`function main() { return { set: ${setJson} }; }`}, 2000, 100, true)
  `));
}

async function clearScripts(orgId: string) {
  await withBypass(() =>
    db.execute(sql`
      delete from script_runs
       where script_id in (select id from user_scripts where org_id = ${orgId})
    `),
  );
  await withBypass(() =>
    db.execute(sql`delete from user_scripts where org_id = ${orgId}`),
  );
}

async function seedDraft(orgId: string, actorId: string): Promise<string> {
  const id = randomUUID();
  await withBypass(() => db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, document_date, currency, status, custom, created_by, updated_by)
    values
      (${id}, ${orgId}, 'journal', ${`MUT-${id.slice(0, 8)}`}, '2026-09-01', 'CAD', 'draft', '{}'::jsonb, ${actorId}, ${actorId})
  `));
  return id;
}

async function readDoc(id: string) {
  const r = await withBypass(() =>
    db.execute<{
      status: string;
      custom: unknown;
      memo: string | null;
      project_id: string | null;
    }>(sql`select status, custom, memo, project_id from documents where id = ${id}`),
  );
  return r.rows[0]!;
}

test(
  "before_submit script mutations refuse foreign reference and dimension ids",
  { skip: !DB },
  async () => {
    const { org: orgA, actorId } = await withBypass(seedOrg);
    const { org: orgB } = await withBypass(seedOrg);
    try {
      await withBypass(() => seedReferenceDef(orgA.orgId, actorId));
      const foreignParty = orgB.vendorId;

      await withOrgContext(orgA.orgId, async () => {
        // Custom reference pointing at another org's party must veto submit
        // and leave the row untouched.
        await seedScript(orgA.orgId, JSON.stringify({ custom: { ref_party: foreignParty } }));
        const docId = await seedDraft(orgA.orgId, actorId);
        await assert.rejects(
          submitForApproval("journal", docId, actorId),
          /not found in this organization/,
        );
        const after = await readDoc(docId);
        assert.equal(after.status, "draft");
        assert.deepEqual(after.custom, {});
        await clearScripts(orgA.orgId);

        // Native dimension pointing at another org's project must veto too.
        const foreignProject = randomUUID();
        await withBypass(() => db.execute(sql`
          insert into projects (id, org_id, name)
          values (${foreignProject}, ${orgB.orgId}, 'Foreign project')
        `));
        await seedScript(orgA.orgId, JSON.stringify({ projectId: foreignProject }));
        const docId2 = await seedDraft(orgA.orgId, actorId);
        await assert.rejects(
          submitForApproval("journal", docId2, actorId),
          /not found in this organization/,
        );
        assert.equal((await readDoc(docId2)).project_id, null);
        await clearScripts(orgA.orgId);

        // A benign mutation still applies and submit still routes.
        await seedScript(orgA.orgId, JSON.stringify({ memo: "script memo" }));
        const docId3 = await seedDraft(orgA.orgId, actorId);
        await submitForApproval("journal", docId3, actorId);
        assert.equal((await readDoc(docId3)).memo, "script memo");
        await clearScripts(orgA.orgId);
      });
    } finally {
      await withBypass(() => dropScratchOrg(orgA.orgId));
      await withBypass(() => dropScratchOrg(orgB.orgId));
    }
  },
);

test(
  "Flows set_field refuses foreign reference custom values",
  { skip: !DB },
  async () => {
    const { org: orgA, actorId } = await withBypass(seedOrg);
    const { org: orgB } = await withBypass(seedOrg);
    try {
      await withBypass(() => seedReferenceDef(orgA.orgId, actorId));
      await withOrgContext(orgA.orgId, async () => {
        const adapter = createDocumentsFlowAdapter("journal");
        const ctx = { orgId: orgA.orgId, userId: actorId };
        const docId = await seedDraft(orgA.orgId, actorId);

        await assert.rejects(
          adapter.setField(docId, "ref_party", orgB.vendorId, ctx),
          /not found in this organization/,
        );
        assert.deepEqual((await readDoc(docId)).custom, {});

        await adapter.setField(docId, "ref_party", orgA.vendorId, ctx);
        assert.deepEqual((await readDoc(docId)).custom, {
          ref_party: orgA.vendorId,
        });
      });
    } finally {
      await withBypass(() => dropScratchOrg(orgA.orgId));
      await withBypass(() => dropScratchOrg(orgB.orgId));
    }
  },
);
