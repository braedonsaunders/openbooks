import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withBypassContext, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedPayrollPerson,
  seedPayrollTime,
} from "../testing/fixtures.ts";
import { loadWageTimeEntries } from "../payroll/wage-hours.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

function policyRefusal(error: unknown): boolean {
  const cause = error as { constraint?: string; cause?: { constraint?: string } };
  assert.equal(cause.cause?.constraint ?? cause.constraint, "time_type_historical_policy");
  return true;
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const typeId = randomUUID(),
    employeeId = randomUUID();
  const actorId = await withBypassContext(async () => {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    await seedPayrollPerson(org.orgId, employeeId, "Hourly worker", {
      subsidiaryId: org.subsidiaryId,
    });
    const inserted = await db.execute(
      sql`insert into time_types
      (id,org_id,name,classification,cost_multiplier,bill_multiplier,exclude_from_wages,created_by,updated_by)
      values (${typeId},${org.orgId},'Overtime at standard billing','overtime',1.5,1,false,${actor},${actor}) returning id`,
      "objects",
    );
    assert.equal(inserted.length, 1);
    return actor;
  });
  return {
    org,
    typeId,
    employeeId,
    actorId,
    inOrg: <T>(fn: () => Promise<T>) => withOrgContext(org.orgId, fn),
  };
}

test(
  "recorded time preserves wage and billing semantics across policy edits while future unused types remain configurable",
  enabled,
  async () => {
    const f = await fixture();
    try {
      await withBypassContext(() =>
        seedPayrollTime(f.org.orgId, f.employeeId, f.actorId, {
          workedOn: f.org.date,
          hours: "1",
          status: "draft",
          costingBasis: "actual",
          billingStatus: "unbilled",
          timeTypeId: f.typeId,
          costRate: "63",
          billRate: "125",
        }),
      );
      await f.inOrg(async () => {
        // Draft use also binds the policy; an approval cannot race a global edit.
        await assert.rejects(
          db.execute(sql`update time_types set classification='regular'
        where org_id=${f.org.orgId} and id=${f.typeId}`),
          policyRefusal,
        );
        const approved = await db.execute(
          sql`update time_entries set status='approved',approved_by=${f.actorId},approved_at=clock_timestamp()
        where org_id=${f.org.orgId} and employee_party_id=${f.employeeId} returning id`,
          "objects",
        );
        assert.equal(approved.length, 1);
        const input = {
          orgId: f.org.orgId,
          employeePartyIds: [f.employeeId],
          periodStart: f.org.date,
          periodEnd: f.org.date,
          documentId: randomUUID(),
        };
        const before = await loadWageTimeEntries(db, input);
        assert.equal(before.length, 1);
        assert.equal(before[0]!.classification, "overtime");
        assert.equal(before[0]!.multiplier, "1.5000");
        for (const change of [
          sql`classification='regular'`,
          sql`cost_multiplier=1`,
          sql`bill_multiplier=1.5`,
          sql`exclude_from_wages=true`,
        ]) {
          await assert.rejects(
            db.execute(sql`update time_types set ${change}
          where org_id=${f.org.orgId} and id=${f.typeId}`),
            policyRefusal,
          );
        }
        await assert.rejects(
          db.execute(sql`delete from time_types where org_id=${f.org.orgId} and id=${f.typeId}`),
          policyRefusal,
        );
        assert.deepEqual(await loadWageTimeEntries(db, input), before);
        const pricing = await db.execute(
          sql`select cost_rate::text,bill_rate::text,status from time_entries
        where org_id=${f.org.orgId} and employee_party_id=${f.employeeId}`,
          "objects",
        );
        assert.deepEqual(pricing, [
          { cost_rate: "63.0000", bill_rate: "125.0000", status: "approved" },
        ]);
        const renamed = await db.execute(
          sql`update time_types set name='Retired overtime',is_active=false
        where org_id=${f.org.orgId} and id=${f.typeId} returning id`,
          "objects",
        );
        assert.equal(renamed.length, 1);
        const future = randomUUID();
        await db.execute(
          sql`insert into time_types(id,org_id,name) values(${future},${f.org.orgId},'Future policy')`,
        );
        const changed = await db.execute(
          sql`update time_types set classification='double_time',cost_multiplier=2,bill_multiplier=1
        where org_id=${f.org.orgId} and id=${future} returning id`,
          "objects",
        );
        assert.equal(changed.length, 1);
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a financial document line binds its time policy even without atomic time and foreign-organization references refuse",
  enabled,
  async () => {
    const f = await fixture();
    const foreign = await withBypassContext(() => createScratchOrg());
    try {
      await f.inOrg(async () => {
        const docId = randomUUID();
        await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,document_date,currency,subtotal,tax_total,total)
        values(${docId},${f.org.orgId},'sales_order','draft',${docId},${f.org.subsidiaryId},${f.org.date},'CAD',125,0,125)`);
        const line = await db
          .execute(
            sql`insert into document_lines(org_id,document_id,line_number,time_type_id,account_id,quantity,unit_price,amount)
        values(${f.org.orgId},${docId},1,${f.typeId},${f.org.accounts.revenue},1,125,125) returning id`,
            "objects",
          )
          .catch((error: unknown) => {
            const cause = (error as { cause?: unknown }).cause;
            throw cause instanceof Error ? cause : error;
          });
        assert.equal(line.length, 1);
        await assert.rejects(
          db.execute(sql`update time_types set classification='regular'
        where org_id=${f.org.orgId} and id=${f.typeId}`),
          policyRefusal,
        );
      });
      await withOrgContext(foreign.orgId, async () => {
        const foreignDoc = randomUUID();
        await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,document_date,currency,subtotal,tax_total,total)
        values(${foreignDoc},${foreign.orgId},'sales_order','draft',${foreignDoc},${foreign.subsidiaryId},${foreign.date},'CAD',125,0,125)`);
        await assert.rejects(
          db.execute(sql`insert into document_lines(org_id,document_id,line_number,time_type_id,account_id,quantity,unit_price,amount)
        values(${foreign.orgId},${foreignDoc},1,${f.typeId},${foreign.accounts.revenue},1,125,125)`),
          (error: unknown) => {
            const cause = error as { cause?: { code?: string; message?: string } };
            assert.equal(cause.cause?.code, "23503");
            assert.match(
              cause.cause?.message ?? "",
              /time type does not exist in this organization/,
            );
            return true;
          },
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(foreign.orgId));
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "first time-policy binding serializes with a concurrent financial-semantic edit",
  enabled,
  async () => {
    const f = await fixture();
    const binding = await f.inOrg(() => pool.connect());
    const editing = await f.inOrg(() => pool.connect());
    try {
      await binding.query("begin");
      await binding.query(
        `insert into time_entries(org_id,employee_party_id,worked_on,hours,status,costing_basis,billing_status,time_type_id)
      values($1,$2,$3,1,'draft','actual','unbilled',$4)`,
        [f.org.orgId, f.employeeId, f.org.date, f.typeId],
      );
      await editing.query("begin");
      await editing.query("set local lock_timeout='100ms'");
      await assert.rejects(
        editing.query("update time_types set cost_multiplier=1 where org_id=$1 and id=$2", [
          f.org.orgId,
          f.typeId,
        ]),
        (error: unknown) => (error as { code?: string }).code === "55P03",
      );
      await editing.query("rollback");
      await binding.query("commit");
      await assert.rejects(
        editing.query("update time_types set cost_multiplier=1 where org_id=$1 and id=$2", [
          f.org.orgId,
          f.typeId,
        ]),
        policyRefusal,
      );
      const retained = await editing.query(
        "select classification,cost_multiplier::text,bill_multiplier::text from time_types where org_id=$1 and id=$2",
        [f.org.orgId, f.typeId],
      );
      assert.deepEqual(retained.rows, [
        { classification: "overtime", cost_multiplier: "1.5000", bill_multiplier: "1.0000" },
      ]);
    } finally {
      await binding.query("rollback");
      await editing.query("rollback");
      binding.release();
      editing.release();
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test(
  "a concurrent first binding waits for an unused policy edit and then uses its committed semantics",
  enabled,
  async () => {
    const f = await fixture();
    const editing = await f.inOrg(() => pool.connect());
    const binding = await f.inOrg(() => pool.connect());
    try {
      await editing.query("begin");
      const changed = await editing.query(
        "update time_types set classification=$3,cost_multiplier=2 where org_id=$1 and id=$2 returning id",
        [f.org.orgId, f.typeId, "double_time"],
      );
      assert.equal(changed.rowCount, 1);
      await binding.query("begin");
      await binding.query("set local lock_timeout='100ms'");
      const insert = `insert into time_entries(org_id,employee_party_id,worked_on,hours,status,costing_basis,billing_status,time_type_id)
      values($1,$2,$3,1,'draft','actual','unbilled',$4) returning id`;
      const params = [f.org.orgId, f.employeeId, f.org.date, f.typeId];
      await assert.rejects(
        binding.query(insert, params),
        (error: unknown) => (error as { code?: string }).code === "55P03",
      );
      await binding.query("rollback");
      await editing.query("commit");
      assert.equal((await binding.query(insert, params)).rowCount, 1);
      const policy = await binding.query(
        `select tt.classification,tt.cost_multiplier::text as multiplier
      from time_entries te join time_types tt on tt.org_id=te.org_id and tt.id=te.time_type_id
      where te.org_id=$1 and te.employee_party_id=$2`,
        [f.org.orgId, f.employeeId],
      );
      assert.deepEqual(policy.rows, [{ classification: "double_time", multiplier: "2.0000" }]);
    } finally {
      await editing.query("rollback");
      await binding.query("rollback");
      editing.release();
      binding.release();
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);
