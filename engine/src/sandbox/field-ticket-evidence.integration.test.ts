import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { MASKED_STORAGE_KIND } from "../platform/file-storage.ts";
import { captureFieldTicketLaborEvidence } from "../projects/field-ticket-labor-evidence.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, seedPayrollPerson } from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";

const evidenceTables = [
  { name: "field_tickets", ids: ["document_id", "foreman_party_id", "charge_document_id", "submitted_by"], key: "document_id", count: 1 },
  { name: "field_ticket_labor_snapshots", ids: ["id", "field_ticket_id", "captured_by", "superseded_by"], key: "id", count: 2 },
  { name: "field_ticket_labor_lines", ids: ["id", "snapshot_id", "field_ticket_id", "employee_party_id", "item_id", "time_type_id", "project_task_id", "time_entry_id", "created_by"], key: "id", count: 2 },
  { name: "field_ticket_signatures", ids: ["id", "field_ticket_id", "signature_file_id", "created_by"], key: "id", count: 1 },
] as const;

async function evidence(orgId: string) {
  return Promise.all(evidenceTables.map(async table => ({ table: table.name,
    rows: (await db.execute(sql`select to_jsonb(e) as row from ${sql.identifier(table.name)} e
      where org_id=${orgId} order by ${sql.identifier(table.key)}`)).rows })));
}

async function wipeFlags() {
  await db.execute(sql`select set_config('openbooks.clone','on',true),
    set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true),
    set_config('openbooks.sandbox_wipe','on',true)`);
}

for (const masked of [false, true]) {
  test(`${masked ? "masked" : "full"} sandbox retains Field Ticket revisions and signatures through refresh and governed deletion`,
    { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    const name = `Field Ticket evidence ${randomUUID()}`;
    let originalError: unknown;
    try {
      const actorId = await createScratchUser(org.orgId, "Field Ticket sandbox owner", "admin");
      const person = randomUUID(), ticket = randomUUID(), folder = randomUUID(), file = randomUUID();
      await seedPayrollPerson(org.orgId, person, "Field Ticket foreman", { subsidiaryId: org.subsidiaryId });
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,currency,status)
        values(${ticket},${org.orgId},'field_ticket','FT-RETAINED',${org.date},'CAD','approved')`);
      await db.execute(sql`insert into field_tickets(document_id,org_id,period,period_start,period_end,foreman_party_id,submitted_by)
        values(${ticket},${org.orgId},'weekly',${org.date},${org.date},${person},${actorId})`);
      await db.execute(sql`insert into folders(id,org_id,name) values(${folder},${org.orgId},'Signed Field Tickets')`);
      await db.execute(sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes)
        values(${file},${org.orgId},${folder},'signature.png','image/png',0)`);
      await db.execute(sql`insert into field_ticket_signatures(org_id,field_ticket_id,role,signer_name,comment,signature_file_id,signed_at,created_by)
        values(${org.orgId},${ticket},'foreman','Field Ticket foreman','Reviewed original labor',${file},now(),${actorId})`);
      for (const [index, hours] of ["8.0000", "9.0000"].entries()) {
        const captured = await withOrgContext(org.orgId, () => captureFieldTicketLaborEvidence({
          orgId: org.orgId, fieldTicketId: ticket, actorId, evidenceBasis: "source_import",
          reason: index === 0 ? "Imported original labor" : "Reviewed additional hour",
          currency: "CAD", sourceSystem: "Reviewed labor archive", sourcePayloadHash: String(index + 1).repeat(64),
          supersedeCurrent: index !== 0,
          lines: [{ employeePartyId: person, employeeName: "Field Ticket foreman", itemId: org.items.service,
            itemName: "Service", timeTypeName: "Regular", timeClassification: "regular", workedOn: org.date,
            hours, costRate: "37.12500000", costRateCurrency: "CAD", billRate: "78.50000000", billRateCurrency: "CAD",
            costAmount: index === 0 ? "297.0000" : "334.1250", billAmount: index === 0 ? "628.0000" : "706.5000",
            sourceSystem: "Reviewed labor archive", sourceLineRef: `labor-${index}`, sourcePayloadHash: String(index + 1).repeat(64) }],
        }));
        assert.equal(captured.revision, index + 1);
        assert.equal(captured.lineCount, 1);
      }
      const before = await evidence(org.orgId);
      const created = await withOrgContext(org.orgId, () => createSandbox({
        productionOrgId: org.orgId, name, tier: "full", masked, createdBy: actorId, lifecycleAuthority: { actorId },
      }));
      const target = created.sandboxOrgId;
      const assertCopy = async () => {
        for (const table of evidenceTables) {
          const replacements = table.ids.map(key => sql`${key}::text,ob_rebase(original.${sql.identifier(key)},target.sandbox_seed)`);
          const copied = (await db.execute<{ matched: boolean }>(sql`
            select to_jsonb(copied)=(to_jsonb(original)||jsonb_build_object('org_id',target.id,${sql.join(replacements, sql`, `)})) as matched
              from ${sql.identifier(table.name)} original join orgs target on target.id=${target}
              join ${sql.identifier(table.name)} copied on copied.org_id=target.id
                and copied.${sql.identifier(table.key)}=ob_rebase(original.${sql.identifier(table.key)},target.sandbox_seed)
             where original.org_id=${org.orgId}`)).rows;
          assert.equal(copied.length, table.count, table.name);
          assert.ok(copied.every(row => row.matched), `${table.name} preserves every stored field and counterpart`);
          assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count
            from ${sql.identifier(table.name)} where org_id=${target}`)).rows[0]!.count, table.count);
        }
        const current = (await db.execute<{ count: number }>(sql`select count(*)::int as count
          from field_ticket_labor_snapshots where org_id=${target} and superseded_at is null`)).rows[0]!.count;
        assert.equal(current, 1);
        const signature = (await db.execute<{ same_org: boolean; storage_kind: string }>(sql`
          select f.org_id=s.org_id as same_org,f.storage_kind from field_ticket_signatures s
          join files f on f.id=s.signature_file_id where s.org_id=${target}`)).rows;
        assert.equal(signature.length, 1);
        assert.equal(signature[0]!.same_org, true);
        assert.equal(signature[0]!.storage_kind, masked ? MASKED_STORAGE_KIND : "db");
        assert.deepEqual(await evidence(org.orgId), before);
        assert.equal((await db.execute<{ status: string }>(sql`select status from sandboxes where id=${created.sandboxId}`)).rows[0]!.status, "ready");
      };
      await assertCopy();

      // Caller flags cannot delete retained evidence as an ordinary tenant,
      // and privileged maintenance cannot use the exemption in production.
      for (const [table, pattern, update] of [
        ["field_ticket_labor_lines", /snapshot lines are append-only evidence/, sql`hours=hours+1`],
        ["field_ticket_labor_snapshots", /snapshots are retained evidence/, sql`reason='Altered history'`],
        ["field_ticket_signatures", /signatures are append-only evidence/, sql`comment='Altered signature'`],
      ] as const) {
        for (const [scope, privileged] of [[target, false], [org.orgId, true]] as const) {
          const write = async () => { await wipeFlags(); await db.execute(sql`delete from ${sql.identifier(table)} where org_id=${scope}`); };
          await assert.rejects(privileged ? withMaintenanceTransaction(null, write) : withOrgTransaction(scope, write),
            error => errorChainMatches(error, pattern));
        }
        await assert.rejects(withMaintenanceTransaction(null, async () => {
          assert.equal((await db.execute(sql`delete from sandboxes where id=${created.sandboxId} returning id`)).rows.length, 1);
          await wipeFlags();
          await db.execute(sql`delete from ${sql.identifier(table)} where org_id=${target}`);
        }), error => errorChainMatches(error, pattern));
        await assert.rejects(withMaintenanceTransaction(null, async () => {
          await wipeFlags();
          await db.execute(sql`update ${sql.identifier(table)} set ${update} where org_id=${target}`);
        }), error => errorChainMatches(error, /immutable|append-only/));
        await assertCopy();
      }

      const historic = (await db.execute<{ id: string; row: Record<string, unknown> }>(sql`
        select line.id,to_jsonb(line) as row from field_ticket_labor_lines line
        join field_ticket_labor_snapshots snapshot on snapshot.id=line.snapshot_id and snapshot.org_id=line.org_id
        where line.org_id=${target} and snapshot.superseded_at is not null`)).rows[0]!;
      const historicalRefusal = /line must belong to the current snapshot and ticket in the same organization/;
      for (const [scope, privileged, change] of [
        [target, false, {}],
        [org.orgId, true, {}],
        [target, true, { hours: "8.2500" }],
        [target, true, { cost_rate: "40.00000000" }],
        [target, true, { source_line_ref: "manufactured-source" }],
        [target, true, { employee_name: "Altered historical worker" }],
        [target, true, { id: randomUUID() }],
      ] as const) {
        const original = (await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(line) as row
          from field_ticket_labor_lines line join field_ticket_labor_snapshots snapshot on snapshot.id=line.snapshot_id
          where line.org_id=${org.orgId} and snapshot.superseded_at is not null`)).rows[0]!.row;
        const candidate = scope === target ? { ...historic.row, ...change } : original;
        const write = async () => {
          await wipeFlags();
          if (privileged && scope === target) {
            assert.equal((await db.execute(sql`delete from field_ticket_labor_lines where org_id=${target} and id=${historic.id} returning id`)).rows.length, 1);
          }
          await db.execute(sql`insert into field_ticket_labor_lines
            select (jsonb_populate_record(null::field_ticket_labor_lines,${JSON.stringify(candidate)}::jsonb)).*`);
        };
        await assert.rejects(privileged ? withMaintenanceTransaction(null, write) : withOrgTransaction(scope, write),
          error => errorChainMatches(error, historicalRefusal));
        await assertCopy();
      }

      await withOrgContext(org.orgId, () => refreshSandbox(created.sandboxId, { keepCustomizations: false, authority: { actorId } }));
      await assertCopy();
      await withOrgContext(org.orgId, () => deleteSandbox(created.sandboxId, { actorId }));
      for (const table of evidenceTables) {
        assert.equal((await db.execute(sql`select 1 from ${sql.identifier(table.name)} where org_id=${target}`)).rows.length, 0);
      }
      assert.equal((await db.execute(sql`select 1 from files where org_id=${target}`)).rows.length, 0);
      assert.equal((await db.execute(sql`select 1 from orgs where id=${target}`)).rows.length, 0);
      assert.deepEqual(await evidence(org.orgId), before);
    } catch (error) {
      originalError = error;
      throw error;
    } finally {
      try {
        const retained = (await db.execute<{ id: string }>(sql`select id from sandboxes where production_org_id=${org.orgId} and name=${name}`)).rows;
        for (const sandbox of retained) await deleteSandbox(sandbox.id, { systemReason: "Remove Field Ticket sandbox fixture" });
        await dropScratchOrgReporting(org.orgId);
      } catch (cleanupError) {
        if (originalError) throw new AggregateError([originalError, cleanupError], "Field Ticket scenario and cleanup both failed", { cause: originalError });
        throw cleanupError;
      }
    }
  });
}
