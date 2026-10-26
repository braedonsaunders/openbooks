import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, schema, withBypass, withOrgContext } from "../platform/db.ts";
import { captureTransactionAuditSnapshot } from "../records/transaction-audit.ts";
import { createProgram } from "../stored-value/accounts.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { postDocument } from "./posting-document.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const protectedKeys = [
  "closeout",
  "storeCreditProgramId",
  "marketplace",
  "marketplaceClearingAccountId",
  "marketplaceTax",
] as const;
const closeout = {
  tipsTotal: "5.0000",
  feeTotal: "0",
  overShort: "0",
  serverPartyId: null,
  parts: [{ position: 1, tip: "5.0000", fee: "0" }],
};

async function fixture(body: (org: ScratchOrg, actorId: string) => Promise<void>): Promise<void> {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() =>
      createScratchUser(org.orgId, "Posting operator", "admin"),
    );
    await withOrgContext(org.orgId, async () => {
      await grantScratchPermissions(org.orgId, actorId, ["gl.post"]);
      const changed = await db.execute(
        sql`update orgs set settings = settings ||
        jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) ||
        '{"scripts":true,"flows":true,"storedValue":true}'::jsonb) where id = ${org.orgId} returning id`,
        "objects",
      );
      assert.equal(changed.length, 1);
      await body(org, actorId);
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
}

async function document(
  org: ScratchOrg,
  actorId: string,
  kind: "journal" | "cash_sale" | "customer_credit",
  custom: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  const total = kind === "cash_sale" ? "100.0000" : "10.0000";
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
     posting_date, currency, fx_rate, subtotal, tax_total, total, custom, created_by)
    values (${id}, ${org.orgId}, ${kind}, 'draft', ${`DOC-${id}`}, ${org.subsidiaryId},
      ${kind === "journal" ? null : org.customerId}, ${org.date}, ${org.date}, 'CAD', '1',
      ${total}, '0', ${total}, ${JSON.stringify(custom)}::jsonb, ${actorId})`);
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, subsidiary_id, amount, quantity,
     unit_price, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${kind === "journal" ? org.accounts.bank : org.accounts.revenue},
      ${org.subsidiaryId}, ${total}, '1', ${total}, '0', ${total})`);
  if (kind === "journal")
    await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, subsidiary_id, amount, quantity,
     unit_price, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 2, ${org.accounts.cogs}, ${org.subsidiaryId}, '-10', '1', '-10', '0', '-10')`);
  if (kind === "cash_sale")
    await db.execute(sql`insert into document_tenders
    (org_id, document_id, position, kind, method_label, account_id, amount_minor, currency)
    values (${org.orgId}, ${id}, 1, 'card', 'Card', ${org.accounts.bank}, '1050000', 'CAD')`);
  const approved = await db.execute(
    sql`update documents set status = 'approved'
    where org_id = ${org.orgId} and id = ${id} returning id`,
    "objects",
  );
  assert.equal(approved.length, 1);
  return id;
}

async function script(
  org: ScratchOrg,
  kind: string,
  mutation: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into user_scripts
    (id, org_id, name, trigger_point, document_kind, source, timeout_ms, sort_order, is_active)
    values (${id}, ${org.orgId}, 'Before-post metadata', 'before_post', ${kind},
      ${`function main(ctx) { return { set: ${JSON.stringify(mutation)} }; }`}, 2000, 100, true)`);
  return id;
}

async function flow(
  org: ScratchOrg,
  actorId: string,
  kind: string,
  fields: { field: string; value: unknown }[],
): Promise<string> {
  for (const { field } of fields) {
    if (field === "memo") continue;
    await db.insert(schema.customFieldDefs).values({
      orgId: org.orgId,
      targetTable: "documents",
      targetKind: kind,
      key: field,
      label: field,
      fieldType: "text",
      config: {},
      createdBy: actorId,
      updatedBy: actorId,
    });
  }
  const id = randomUUID();
  const nodes = [
    {
      id: "trigger",
      position: { x: 0, y: 0 },
      data: { kind: "trigger", trigger: { trigger: "before_post" } },
    },
    ...fields.map(({ field, value }, index) => ({
      id: `action-${index}`,
      position: { x: (index + 1) * 100, y: 0 },
      data: {
        kind: "action",
        action: { action: "set_field", field, value: { kind: "literal", value } },
      },
    })),
  ];
  const edges = fields.map((_, index) => ({
    id: `edge-${index}`,
    source: index === 0 ? "trigger" : `action-${index - 1}`,
    target: `action-${index}`,
    sourceHandle: "next",
  }));
  await db.execute(sql`insert into flows (id, org_id, name, subject_kind, enabled, graph)
    values (${id}, ${org.orgId}, 'Before-post metadata', ${kind}, true,
      ${JSON.stringify({ schemaVersion: 1, nodes, edges })}::jsonb)`);
  return id;
}

async function evidence(org: ScratchOrg, id: string) {
  const snapshot = await captureTransactionAuditSnapshot(db, id, org.orgId);
  assert.ok(snapshot);
  const row = (
    await db.execute<{
      scripts: number;
      flows: number;
      effects: number;
      audits: number;
      tenders: unknown[];
    }>(
      sql`select
    (select count(*)::int from script_runs where org_id = ${org.orgId} and target_id = ${id}) as scripts,
    (select count(*)::int from flow_runs where org_id = ${org.orgId} and subject_id = ${id}) as flows,
    (select count(*)::int from flow_run_effects e join flow_runs r on r.org_id = e.org_id and r.id = e.run_id
      where r.org_id = ${org.orgId} and r.subject_id = ${id}) as effects,
    (select count(*)::int from audit_log where org_id = ${org.orgId}
      and table_name = 'documents' and row_id = ${id}) as audits,
    (select coalesce(jsonb_agg(to_jsonb(t) order by position), '[]'::jsonb)
      from document_tenders t where org_id = ${org.orgId} and document_id = ${id}) as tenders`,
      "objects",
    )
  )[0];
  assert.ok(row);
  return { snapshot, ...row };
}

function post(org: ScratchOrg, actorId: string, id: string) {
  return postDocument(
    id,
    { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
    { deferEffects: true, audit: { actorId, source: "api" } },
  );
}

async function legs(org: ScratchOrg, id: string) {
  return await db.execute<{ account: string; amount: string }>(
    sql`select l.account_id as account, l.amount::text as amount
    from journal_entries e join journal_lines l on l.org_id = e.org_id and l.entry_id = e.id
    where e.org_id = ${org.orgId} and e.source_document_id = ${id} order by l.line_number`,
    "objects",
  );
}

test(
  "before-post scripts refuse each protected custom mutation without document or automation effects",
  { skip: !DB },
  async () => {
    await fixture(async (org, actorId) => {
      const source = await document(org, actorId, "journal", { marker: "posted source" });
      await post(org, actorId, source);
      const retainedSource = await evidence(org, source);
      assert.ok(protectedKeys.length > 0, "the protected custom keys are named");
      for (const key of protectedKeys) {
        const approved = { marker: "approved", [key]: key === "closeout" ? closeout : "retained" };
        const id = await document(org, actorId, "journal", approved);
        const before = await evidence(org, id);
        const scriptId = await script(org, "journal", {
          memo: "must roll back",
          custom: { [key]: null },
        });
        await assert.rejects(
          post(org, actorId, id),
          new RegExp(`protected posting custom field.*${key}`),
        );
        assert.deepEqual(await evidence(org, id), before, key);
        assert.deepEqual(
          await evidence(org, source),
          retainedSource,
          "prior posted source stays byte-identical",
        );
        const disabled = await db.execute(
          sql`update user_scripts set is_active = false
        where org_id = ${org.orgId} and id = ${scriptId} returning id`,
          "objects",
        );
        assert.equal(disabled.length, 1);
      }
    });
  },
);

test(
  "a before-post closeout flow rolls back earlier script and flow effects; operational metadata posts with the approved tips split",
  { skip: !DB },
  async () => {
    await fixture(async (org, actorId) => {
      const tips = await seedPostingAccount(
        org.orgId,
        "2160",
        "Tips payable",
        "liability_current_other",
        org.subsidiaryId,
      );
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,tipsPayable}',
      to_jsonb(${tips}::text), true) where id = ${org.orgId}`);
      const source = await document(org, actorId, "cash_sale", { closeout });
      await post(org, actorId, source);
      const retainedSource = await evidence(org, source);
      await script(org, "cash_sale", {
        memo: "script metadata",
        custom: { operationNote: "reviewed" },
      });
      const refusingFlow = await flow(org, actorId, "cash_sale", [
        { field: "memo", value: "flow metadata" },
        { field: "closeout", value: null },
      ]);
      const id = await document(org, actorId, "cash_sale", { closeout, marker: "approved" });
      const before = await evidence(org, id);
      await assert.rejects(
        post(org, actorId, id),
        /before-post automation changed protected posting custom field.*closeout/,
      );
      assert.deepEqual(
        await evidence(org, id),
        before,
        "script evidence, effects, tender identities and write revisions roll back",
      );
      assert.deepEqual(await evidence(org, source), retainedSource);
      const disabled = await db.execute(
        sql`update flows set enabled = false
      where org_id = ${org.orgId} and id = ${refusingFlow} returning id`,
        "objects",
      );
      assert.equal(disabled.length, 1);
      await flow(org, actorId, "cash_sale", [{ field: "memo", value: "flow metadata" }]);
      await post(org, actorId, id);
      const after = await evidence(org, id);
      assert.equal(after.snapshot.document.status, "posted");
      assert.equal(after.snapshot.document.memo, "flow metadata");
      assert.deepEqual(after.snapshot.document.custom, {
        closeout: { ...closeout, parts: [{ position: "1", tip: "5.0000", fee: "0" }] },
        marker: "approved",
        operationNote: "reviewed",
      });
      assert.equal(after.scripts, 1);
      assert.equal(after.flows, 1);
      assert.equal(after.effects, 1);
      assert.equal(
        after.audits,
        2,
        "flow update and document posting each retain their native audit envelope",
      );
      assert.deepEqual(await legs(org, id), [
        { account: org.accounts.bank, amount: "105.0000" },
        { account: tips, amount: "-5.0000" },
        { account: org.accounts.revenue, amount: "-100.0000" },
      ]);
      assert.deepEqual(await evidence(org, source), retainedSource);
    });
  },
);

test(
  "before-post flows cannot remove the store-credit programme chosen before approval",
  { skip: !DB },
  async () => {
    await fixture(async (org, actorId) => {
      const liability = await seedPostingAccount(
        org.orgId,
        "2600",
        "Store-credit liability",
        "liability_current_other",
        org.subsidiaryId,
      );
      const program = await createProgram({
        orgId: org.orgId,
        name: "Customer store credit",
        kind: "store_credit",
        liabilityAccountId: liability,
        actorId,
      });
      const source = await document(org, actorId, "customer_credit", {
        storeCreditProgramId: program.id,
      });
      await post(org, actorId, source);
      const retainedSource = await evidence(org, source);
      assert.deepEqual(await legs(org, source), [
        { account: liability, amount: "-10.0000" },
        { account: org.accounts.revenue, amount: "10.0000" },
      ]);
      await flow(org, actorId, "customer_credit", [
        { field: "memo", value: "must roll back" },
        { field: "storeCreditProgramId", value: null },
      ]);
      const id = await document(org, actorId, "customer_credit", {
        storeCreditProgramId: program.id,
      });
      const before = await evidence(org, id);
      await assert.rejects(
        post(org, actorId, id),
        /before-post automation changed protected posting custom field.*storeCreditProgramId/,
      );
      assert.deepEqual(await evidence(org, id), before);
      assert.deepEqual(await evidence(org, source), retainedSource);
    });
  },
);

test(
  "before-post flows preserve protected marketplace metadata independently of tax-component financial routing",
  { skip: !DB },
  async () => {
    await fixture(async (org, actorId) => {
      // Marketplace clearing is resolved from retained tax components, not these custom keys.
      for (const key of [
        "marketplace",
        "marketplaceClearingAccountId",
        "marketplaceTax",
      ] as const) {
        const id = await document(org, actorId, "journal", { [key]: "approved metadata" });
        const before = await evidence(org, id);
        const flowId = await flow(org, actorId, "journal", [
          { field: "memo", value: "must roll back" },
          { field: key, value: null },
        ]);
        await assert.rejects(
          post(org, actorId, id),
          new RegExp(`before-post automation changed protected posting custom field.*${key}`),
        );
        assert.deepEqual(await evidence(org, id), before, key);
        const disabled = await db.execute(
          sql`update flows set enabled = false
        where org_id = ${org.orgId} and id = ${flowId} returning id`,
          "objects",
        );
        assert.equal(disabled.length, 1);
      }
    });
  },
);
