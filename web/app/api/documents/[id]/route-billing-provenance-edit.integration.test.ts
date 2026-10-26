import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Generated draft lines retain billed-time provenance across supported
// pricing edits and line replacement. Only the session boundary is scripted;
// handler, service, authority and storage remain native.
const root = pathToFileURL(process.cwd() + "/").href;
const state: { orgId: string; actorId: string } = { orgId: "", actorId: "" };
Object.assign(globalThis, { __billingProvenanceEditState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "../../../../lib/authz" ||
      (specifier === "@/lib/authz" && context.parentURL?.includes("/lib/api/route"))
    )
      return virtual(`
      export async function getAuthz() {
        const s = globalThis.__billingProvenanceEditState;
        return { user: { orgId: s.orgId, id: s.actorId, roles: [{key:"admin"}], isSuperAdmin: false }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
      }
      export { can, guardSubsidiaryScope, subsidiariesInScope } from '${root}web/lib/authz.ts'
    `);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { documentRevisionCounterSql } = await import("@openbooks/engine/records/revision");
const { createBillingRequest } = await import("../../../../lib/billing-requests.ts");
const { generateInvoiceFromBillingRequest } = await import("../../../../lib/billing.ts");
const { PATCH } = await import("./route.ts");

async function revision(orgId: string, id: string): Promise<string> {
  return (
    await db.execute<{ revision: string }>(
      sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id=${id} and org_id=${orgId}`,
      "objects",
    )
  )[0]!.revision;
}

async function patchDoc(
  orgId: string,
  id: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(orgId, () =>
      PATCH(
        new Request(`http://documents.test/api/documents/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
      ),
    );
    return { status: response.status, json: await response.json().catch(() => null) };
  } catch (error) {
    return {
      status: 500,
      json: { thrown: error instanceof Error ? error.message : String(error) },
    };
  }
}

type FixtureOrg = {
  orgId: string;
  subsidiaryId: string;
  date: string;
  customerId: string;
  vendorId: string;
  accounts: { revenue: string; cogs: string };
  items: { service: string };
};

/** A T&M project with approved, explicitly zero-priced time, billed to a draft invoice. */
async function billedTimeInvoice(
  org: FixtureOrg,
  actor: string,
  entryCount = 1,
  includeCost = false,
) {
  await (
    await import("@openbooks/engine/testing/fixtures")
  ).grantScratchPermissions(org.orgId, actor, ["ar.create"]);
  await db.execute(
    sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(${org.accounts.revenue}::text), true) where id = ${org.orgId}`,
  );
  const project = randomUUID(),
    employee = randomUUID();
  await db.execute(
    sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom) values (${project},${org.orgId},${org.subsidiaryId},'TM','Time job',${org.customerId},'active',true,'{}'::jsonb)`,
  );
  await db.execute(
    sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Billable worker',${org.subsidiaryId})`,
  );
  const entries: string[] = [];
  for (let i = 0; i < entryCount; i++) {
    const entry = randomUUID();
    await db.execute(
      sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,is_billable,status,bill_rate) values (${entry},${org.orgId},${employee},${org.date},8,${project},true,'approved','0')`,
    );
    entries.push(entry);
  }
  let costLine: string | null = null;
  if (includeCost) {
    const source = randomUUID();
    costLine = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,document_date,subsidiary_id,party_id,project_id,currency,subtotal,total,open_balance)
      values(${source},${org.orgId},'vendor_bill','draft',${source},${org.date},${org.subsidiaryId},${org.vendorId},${project},'CAD',40,40,40)`);
    await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,description,quantity,unit_price,amount,is_billable)
      values(${costLine},${org.orgId},${source},1,${org.accounts.cogs},'Truck source cost',1,40,40,true)`);
    assert.equal(
      (
        await db.execute(
          sql`update documents set status='approved' where org_id=${org.orgId} and id=${source} returning id`,
          "objects",
        )
      ).length,
      1,
    );
  }
  const req = await createBillingRequest(org.orgId, actor, {
    projectId: project,
    basis: includeCost ? "date_range" : "time_selection",
    selectedTimeEntryIds: includeCost ? undefined : entries,
    cutoffDate: org.date,
    backupRequired: false,
  });
  const invoice = await generateInvoiceFromBillingRequest(org.orgId, actor, req.id);
  return { project, entry: entries[0]!, entries, costLine, invoiceId: invoice.id };
}

test("a billing-request invoice draft saves after its lines are priced", async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    try {
      state.orgId = org.orgId;
      state.actorId = await createScratchUser(org.orgId, "Billing controller", "reviewer");
      const { entry, invoiceId } = await billedTimeInvoice(org, state.actorId);
      const generated = await db.execute<{ id: string; item_id: string | null; amount: string }>(
        sql`select id, item_id, amount::text as amount from document_lines where org_id=${org.orgId} and document_id=${invoiceId} order by line_number`,
        "objects",
      );
      assert.equal(generated.length, 1);
      assert.equal(generated[0]!.item_id, null);
      assert.equal(generated[0]!.amount, "0.0000");

      // The tester's flow: price the $0 line through the supported picker path.
      const saved = await patchDoc(org.orgId, invoiceId, {
        expectedUpdatedAt: await revision(org.orgId, invoiceId),
        lines: [
          {
            lineId: generated[0]!.id,
            accountId: org.accounts.revenue,
            itemId: org.items.service,
            description: "Billable work",
            quantity: "8",
            unitPrice: "95",
            amount: "760",
          },
        ],
      });
      assert.equal(
        saved.status,
        200,
        `pricing the generated line must save, got ${saved.status}: ${JSON.stringify(saved.json)}`,
      );
      const stored = await db.execute<{
        item_id: string;
        amount: string;
        bill_rate: string;
        bill_amount: string;
      }>(
        sql`select item_id, amount::text as amount, bill_rate::text as bill_rate, bill_amount::text as bill_amount from document_lines where org_id=${org.orgId} and document_id=${invoiceId}`,
        "objects",
      );
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.item_id, org.items.service);
      assert.equal(stored[0]!.amount, "760.0000");
      // The billable-value snapshot follows the edit, so project financials
      // read the priced line instead of a stale zero.
      assert.equal(stored[0]!.bill_rate, "95.0000");
      assert.equal(stored[0]!.bill_amount, "760.0000");
      // Provenance survives the line replacement: the entry stays billed to
      // this invoice instead of stranding or silently unbilled time.
      const provenance = (
        await db.execute<{ status: string; line_document: string | null }>(
          sql`select billing_status as status, (select document_id::text from document_lines where id = te.invoiced_by_line_id and org_id = te.org_id) as line_document from time_entries te where id=${entry} and org_id=${org.orgId}`,
          "objects",
        )
      )[0]!;
      assert.equal(provenance.status, "billed");
      assert.equal(provenance.line_document, invoiceId);
      const total = (
        await db.execute<{ total: string }>(
          sql`select total::text as total from documents where id=${invoiceId} and org_id=${org.orgId}`,
          "objects",
        )
      )[0]!.total;
      assert.equal(total, "760.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
});

test("removing a billed-time line from the draft frees its entry", async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    try {
      state.orgId = org.orgId;
      state.actorId = await createScratchUser(org.orgId, "Billing controller", "reviewer");
      const { entries, invoiceId } = await billedTimeInvoice(org, state.actorId, 2);
      // Generated lines order by (worked_on, id) with random UUIDs, so either
      // entry may sit on line 1 — capture the order before the edit deletes
      // the generated rows.
      const order = await db.execute<{ id: string; time_entry_id: string }>(
        sql`select id, time_entry_id from document_lines where document_id = ${invoiceId} and org_id = ${org.orgId} and time_entry_id is not null order by line_number`,
        "objects",
      );
      assert.deepEqual(order.map((row) => row.time_entry_id).sort(), [...entries].sort());
      const saved = await patchDoc(org.orgId, invoiceId, {
        expectedUpdatedAt: await revision(org.orgId, invoiceId),
        lines: [
          {
            lineId: order[1]!.id,
            accountId: org.accounts.revenue,
            description: "Retained billed work",
            quantity: "1",
            unitPrice: "100",
            amount: "100",
          },
        ],
      });
      assert.equal(
        saved.status,
        200,
        `replacing the generated lines must save, got ${saved.status}: ${JSON.stringify(saved.json)}`,
      );
      // Removing the first row must not move its work onto the surviving row.
      const keptId = order[1]!.time_entry_id;
      const freedId = entries.find((id) => id !== keptId)!;
      const kept = (
        await db.execute<{ status: string; line_document: string | null }>(
          sql`select billing_status as status, (select document_id::text from document_lines where id = te.invoiced_by_line_id and org_id = te.org_id) as line_document from time_entries te where id=${keptId} and org_id=${org.orgId}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(kept, { status: "billed", line_document: invoiceId });
      const freed = (
        await db.execute<{ status: string; link: string | null }>(
          sql`select billing_status as status, invoiced_by_line_id::text as link from time_entries where id=${freedId} and org_id=${org.orgId}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(freed, { status: "unbilled", link: null });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
});

for (const action of ["reorder", "remove first", "missing identity", "tax only"] as const) {
  test(`billing draft ${action} preserves stable labor and cost provenance`, async () => {
    await withBypassContext(async () => {
      const org = await createScratchOrg();
      try {
        state.orgId = org.orgId;
        state.actorId = await createScratchUser(org.orgId, "Source reviewer", "reviewer");
        const f = await billedTimeInvoice(org, state.actorId, 1, true);
        const taxCodeId = action === "tax only" ? randomUUID() : null;
        if (taxCodeId) {
          await db.execute(sql`insert into tax_codes (id,org_id,code,name,collected_account_id,paid_account_id)
            values(${taxCodeId},${org.orgId},'BILLING-TAX','Billing tax',${org.accounts.taxOutput},${org.accounts.taxInput})`);
          await db.execute(sql`insert into tax_rates (org_id,tax_code_id,rate_percent,effective_from)
            values(${org.orgId},${taxCodeId},'5',${org.date})`);
        }
        const lines = await db.execute<{
          id: string;
          accountId: string;
          description: string;
          quantity: string;
          unitPrice: string;
          amount: string;
          timeEntryId: string | null;
        }>(
          sql`select id,account_id as "accountId",description,quantity::text,unit_price::text as "unitPrice",amount::text,
          time_entry_id as "timeEntryId" from document_lines where org_id=${org.orgId} and document_id=${f.invoiceId} order by line_number`,
          "objects",
        );
        assert.equal(lines.length, 2);
        const labor = lines.find((line) => line.timeEntryId === f.entry)!;
        const truck = lines.find((line) => line.id !== labor.id)!;
        assert.ok(labor && truck && f.costLine);
        const snapshot = async () => ({
          document: await db.execute(
            sql`select to_jsonb(d) as raw from documents d where org_id=${org.orgId} and id=${f.invoiceId}`,
            "objects",
          ),
          lines: await db.execute(
            sql`select to_jsonb(l) as raw from document_lines l where org_id=${org.orgId} and document_id=${f.invoiceId} order by id`,
            "objects",
          ),
          time: await db.execute(
            sql`select to_jsonb(t) as raw from time_entries t where org_id=${org.orgId} and id=${f.entry}`,
            "objects",
          ),
          cost: await db.execute(
            sql`select to_jsonb(l) as raw from document_lines l where org_id=${org.orgId} and id=${f.costLine}`,
            "objects",
          ),
          audit: await db.execute(
            sql`select count(*)::int as n from audit_log where org_id=${org.orgId}`,
            "objects",
          ),
        });
        const before = await snapshot();
        const selected =
          action === "remove first"
            ? [truck]
            : action === "reorder"
              ? [truck, labor]
              : [labor, truck];
        const saved = await patchDoc(org.orgId, f.invoiceId, {
          expectedUpdatedAt: await revision(org.orgId, f.invoiceId),
          lines: selected.map((line) => ({
            ...(action === "missing identity" ? {} : { lineId: line.id }),
            accountId: line.accountId,
            description: line.description,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            amount: line.amount,
            ...(action === "tax only" ? { taxCodeId, taxAmount: "0", taxOverridden: true } : {}),
          })),
        });
        if (action === "missing identity") {
          assert.equal(saved.status, 422, JSON.stringify(saved.json));
          assert.deepEqual(
            await snapshot(),
            before,
            "ambiguous identity refuses without any line, source or audit mutation",
          );
          return;
        }
        assert.equal(saved.status, 200, JSON.stringify(saved.json));
        const stored = await db.execute<{
          id: string;
          description: string;
          timeEntryId: string | null;
          amount: string;
        }>(
          sql`
          select id,description,time_entry_id as "timeEntryId",amount::text from document_lines
          where org_id=${org.orgId} and document_id=${f.invoiceId} order by line_number`,
          "objects",
        );
        assert.equal(stored.length, selected.length);
        assert.deepEqual(
          stored.map((line) => line.description),
          selected.map((line) => line.description),
        );
        const costTarget = stored.find((line) => line.description === truck.description)!;
        assert.equal(
          costTarget.timeEntryId,
          null,
          "a cost line never acquires the removed or reordered labor source",
        );
        const cost = (
          await db.execute<{ link: string | null; amount: string }>(
            sql`select billed_by_line_id as link,amount::text
          from document_lines where org_id=${org.orgId} and id=${f.costLine}`,
            "objects",
          )
        )[0]!;
        assert.equal(cost.link, costTarget.id);
        assert.equal(
          cost.amount,
          "40.0000",
          "source financial amount remains immutable across metadata relinking",
        );
        const time = (
          await db.execute<{ link: string | null; status: string }>(
            sql`select invoiced_by_line_id as link,billing_status as status
          from time_entries where org_id=${org.orgId} and id=${f.entry}`,
            "objects",
          )
        )[0]!;
        if (action === "remove first") assert.deepEqual(time, { link: null, status: "unbilled" });
        else
          assert.deepEqual(time, {
            link: stored.find((line) => line.timeEntryId === f.entry)!.id,
            status: "billed",
          });
      } finally {
        await dropScratchOrg(org.orgId);
      }
    });
  });
}
