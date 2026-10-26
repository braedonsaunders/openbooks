import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { stubModules } from "../testing/stub-modules.ts";

stubModules({ intl: true, navigation: false, authz: false, features: false });
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, seedFlowActors, dropScratchOrgReporting } =
  await import("@openbooks/engine/testing/fixtures");
const { createBillingRequest } = await import("./billing-requests");
const { generateInvoiceFromBillingRequest } = await import("./billing");
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

async function fixture(lineBuilder: "tm_actual" | "cost_plus") {
  const org = await withBypassContext(() => createScratchOrg());
  const project = randomUUID(),
    employee = randomUUID(),
    priced = randomUUID(),
    missing = randomUUID();
  const actor = await withBypassContext(async () => {
    const actors = await seedFlowActors(org.orgId);
    await (
      await import("@openbooks/engine/testing/fixtures")
    ).grantScratchPermissions(org.orgId, actors.adminId, ["ar.create"]);
    await db.execute(sql`update orgs set settings=jsonb_set(
      jsonb_set(settings,'{features,projects}','true'::jsonb),
      '{controlAccounts,projectRevenue}',to_jsonb(${org.accounts.revenue}::text)) where id=${org.orgId}`);
    await db.execute(
      sql`update items set default_rate=null,tax_code_id=null where org_id=${org.orgId} and id=${org.items.service}`,
    );
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom,invoicing_profile)
      values(${project},${org.orgId},${org.subsidiaryId},'RATES','Time pricing',${org.customerId},'active',true,
        '{"markupPercent":"10"}'::jsonb,${JSON.stringify({ lineBuilder })}::jsonb)`);
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active)
      values(${employee},${org.orgId},'employee','Billable worker',${org.subsidiaryId},true)`);
    await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,
      is_billable,status,cost_rate,bill_rate,created_by,approved_by,approved_at)
      values(${priced},${org.orgId},${employee},${org.date},'2',${project},${org.items.service},true,'approved','30','100',${actors.adminId},${actors.adminId},now()),
        (${missing},${org.orgId},${employee},${org.date},'1',${project},${org.items.service},true,'approved',null,null,${actors.adminId},${actors.adminId},now())`);
    return actors.adminId;
  });
  const inOrg = <T>(fn: () => Promise<T>) => withOrgContext(org.orgId, fn);
  const request = await inOrg(() =>
    createBillingRequest(org.orgId, actor, {
      projectId: project,
      basis: "time_selection",
      selectedTimeEntryIds: [priced, missing],
      cutoffDate: org.date,
      backupRequired: false,
    }),
  );
  const snapshot = () =>
    inOrg(async () => ({
      time: await db.execute<{ raw: string }>(
        sql`select to_jsonb(t)::text as raw from time_entries t
      where org_id=${org.orgId} order by id`,
        "objects",
      ),
      requests: await db.execute<{ raw: string }>(
        sql`select to_jsonb(r)::text as raw from billing_requests r
      where org_id=${org.orgId} order by id`,
        "objects",
      ),
      documents: await db.execute<{ raw: string }>(
        sql`select to_jsonb(d)::text as raw from documents d
      where org_id=${org.orgId} order by id`,
        "objects",
      ),
      sequences: await db.execute<{ raw: string }>(
        sql`select to_jsonb(n)::text as raw from number_sequences n
      where org_id=${org.orgId} order by id`,
        "objects",
      ),
      audits: (
        await db.execute<{ count: number }>(
          sql`select count(*)::int as count from audit_log where org_id=${org.orgId}`,
          "objects",
        )
      )[0]!.count,
    }));
  return {
    org,
    actor,
    project,
    priced,
    missing,
    request,
    inOrg,
    snapshot,
    cleanup: () => dropScratchOrgReporting(org.orgId),
  };
}

for (const lineBuilder of ["tm_actual", "cost_plus"] as const) {
  test(
    `project ${lineBuilder} billing refuses missing pricing atomically and preserves an explicit zero rate`,
    enabled,
    async () => {
      const f = await fixture(lineBuilder);
      try {
        const before = await f.snapshot();
        await assert.rejects(
          f.inOrg(() => generateInvoiceFromBillingRequest(f.org.orgId, f.actor, f.request.id)),
          lineBuilder === "cost_plus" ? /has no approved cost rate/ : /has no billing rate/,
        );
        assert.deepEqual(
          await f.snapshot(),
          before,
          "refusal must leave numbering, billing sources, request and audit unchanged",
        );
        // Explicit zero is a recorded pricing decision, unlike missing coverage.
        await withBypassContext(() =>
          db.execute(
            lineBuilder === "cost_plus"
              ? sql`update time_entries set cost_rate='0',bill_rate='999' where org_id=${f.org.orgId} and id=${f.missing}`
              : sql`update items set default_rate='0' where org_id=${f.org.orgId} and id=${f.org.items.service}`,
          ),
        );
        const invoice = await f.inOrg(() =>
          generateInvoiceFromBillingRequest(f.org.orgId, f.actor, f.request.id),
        );
        await f.inOrg(async () => {
          const lines = await db.execute<{ entryId: string; rate: string; amount: string }>(
            sql`
          select time_entry_id as "entryId",unit_price::text as rate,amount::text as amount from document_lines
          where org_id=${f.org.orgId} and document_id=${invoice.id} order by time_entry_id`,
            "objects",
          );
          assert.equal(lines.length, 2);
          assert.deepEqual(
            lines.find((line) => line.entryId === f.missing),
            { entryId: f.missing, rate: "0.00000000", amount: "0.0000" },
          );
          assert.deepEqual(
            lines.find((line) => line.entryId === f.priced),
            {
              entryId: f.priced,
              rate: lineBuilder === "cost_plus" ? "33.00000000" : "100.00000000",
              amount: lineBuilder === "cost_plus" ? "66.0000" : "200.0000",
            },
          );
          const sources = await db.execute<{ status: string; invoiceId: string }>(
            sql`
          select billing_status as status,invoiced_by_line_id as "invoiceId" from time_entries
          where org_id=${f.org.orgId} and id in (${f.priced},${f.missing})`,
            "objects",
          );
          assert.equal(sources.length, 2);
          assert.ok(sources.every((source) => source.status === "billed" && source.invoiceId));
          await assert.rejects(
            generateInvoiceFromBillingRequest(f.org.orgId, f.actor, f.request.id),
            /already been invoiced/,
          );
        });
      } finally {
        await f.cleanup();
      }
    },
  );
}

test(
  "an explicit time billing snapshot outranks a configured item default, including zero",
  enabled,
  async () => {
    const f = await fixture("tm_actual");
    try {
      await withBypassContext(async () => {
        await db.execute(
          sql`update items set default_rate='125' where org_id=${f.org.orgId} and id=${f.org.items.service}`,
        );
        await db.execute(
          sql`update time_entries set bill_rate='0' where org_id=${f.org.orgId} and id=${f.missing}`,
        );
      });
      const invoice = await f.inOrg(() =>
        generateInvoiceFromBillingRequest(f.org.orgId, f.actor, f.request.id),
      );
      const line = await f.inOrg(
        async () =>
          (
            await db.execute<{ rate: string; amount: string }>(
              sql`
      select unit_price::text as rate,amount::text as amount from document_lines
      where org_id=${f.org.orgId} and document_id=${invoice.id} and time_entry_id=${f.missing}`,
              "objects",
            )
          )[0],
      );
      assert.deepEqual(line, { rate: "0.00000000", amount: "0.0000" });
    } finally {
      await f.cleanup();
    }
  },
);

for (const [name, classification, expected] of [
  ["Heures supplémentaires", "overtime", "0.0000"],
  ["Double checking", "regular", "30.0000"],
  ["Majoré", "double_time", "0.0000"],
] as const) {
  test(
    `invoice adjustments use ${classification} classification independently of the name ${name}`,
    enabled,
    async () => {
      const f = await fixture("tm_actual");
      try {
        const timeType = randomUUID(),
          book = randomUUID(),
          version = randomUUID(),
          adjustment = randomUUID();
        await withBypassContext(async () => {
          // Deliberately neutral multipliers prove they cannot classify the work.
          await db.execute(sql`insert into time_types(id,org_id,name,classification,cost_multiplier,bill_multiplier)
          values(${timeType},${f.org.orgId},${name},${classification},'1','1')`);
          await db.execute(sql`update time_entries set time_type_id=${timeType},bill_rate='100'
          where org_id=${f.org.orgId} and id in (${f.priced},${f.missing})`);
          await db.execute(sql`insert into item_rate_books(id,org_id,code,name,currency,is_active)
          values(${book},${f.org.orgId},'LABOR','Labor adjustments','CAD',true)`);
          await db.execute(sql`insert into item_rate_versions(id,org_id,rate_book_id,effective_from,status)
          values(${version},${f.org.orgId},${book},'2000-01-01','draft')`);
          await db.execute(sql`insert into labor_rate_version_policies(org_id,version_id,derivation_policy)
          values(${f.org.orgId},${version},'explicit')`);
          await db.execute(sql`insert into labor_rate_adjustments(id,org_id,version_id,code,name,category,calculation,value,
          presentation,applies_regular,applies_overtime,applies_double_time)
          values(${adjustment},${f.org.orgId},${version},'REGULAR','Regular surcharge','surcharge','percent','10',
            'separate',true,false,false)`);
          await db.execute(
            sql`update item_rate_versions set status='active' where org_id=${f.org.orgId} and id=${version}`,
          );
          await db.execute(sql`insert into item_rate_book_assignments(org_id,rate_book_id,project_id,date_basis,is_active)
          values(${f.org.orgId},${book},${f.project},'usage_date',true)`);
        });
        await f.inOrg(async () => {
          await assert.rejects(
            db.execute(sql`update time_types set classification=${classification === "regular" ? "overtime" : "regular"}
          where org_id=${f.org.orgId} and id=${timeType}`),
            (error: unknown) => {
              const cause = error as { cause?: { constraint?: string } };
              assert.equal(cause.cause?.constraint, "time_type_historical_policy");
              return true;
            },
          );
        });
        const invoice = await f.inOrg(() =>
          generateInvoiceFromBillingRequest(f.org.orgId, f.actor, f.request.id),
        );
        const measured = await f.inOrg(
          async () =>
            (
              await db.execute<{ amount: string; count: number }>(
                sql`
        select coalesce(sum(amount),0)::numeric(19,4)::text as amount,count(*)::int as count from document_lines
        where org_id=${f.org.orgId} and document_id=${invoice.id} and description='Regular surcharge'`,
                "objects",
              )
            )[0]!,
        );
        assert.deepEqual(measured, {
          amount: expected,
          count: classification === "regular" ? 1 : 0,
        });
      } finally {
        await f.cleanup();
      }
    },
  );
}

for (const authority of ["denied", "inactive", "empty entity scope", "caller scope"] as const) {
  test(
    `native billing resolves current actor authority before consuming sources: ${authority}`,
    enabled,
    async () => {
      const f = await fixture("tm_actual");
      try {
        await withBypassContext(async () => {
          await db.execute(
            sql`update items set default_rate='0' where org_id=${f.org.orgId} and id=${f.org.items.service}`,
          );
          if (authority === "denied") {
            await db.execute(sql`update user_permission_overrides set effect='deny'
            where org_id=${f.org.orgId} and user_id=${f.actor} and permission='ar.create'`);
          } else if (authority === "inactive") {
            await db.execute(
              sql`update users set is_active=false where org_id=${f.org.orgId} and id=${f.actor}`,
            );
          } else if (authority === "empty entity scope") {
            await db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb
            where org_id=${f.org.orgId} and id in
              (select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actor})`);
          }
        });
        const before = await f.snapshot();
        await assert.rejects(
          f.inOrg(() =>
            generateInvoiceFromBillingRequest(
              f.org.orgId,
              f.actor,
              f.request.id,
              authority === "caller scope" ? new Set<string>() : null,
            ),
          ),
          authority === "denied" || authority === "inactive"
            ? /not found/
            : /Billing request not found/,
        );
        assert.deepEqual(
          await f.snapshot(),
          before,
          "authority refusal preserves source consumption, numbering, requests, documents and audit",
        );
      } finally {
        await f.cleanup();
      }
    },
  );
}
