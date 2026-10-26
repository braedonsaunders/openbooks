import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../../../lib/auth";

/**
 * Direct-deposit capture at hire: an employee's bank details must be
 * writable by the hiring and payroll operators, not only by master-data
 * holders. POST/PATCH/DELETE on the native party bank path stay under
 * parties.manage — except when the party carries an active employee role,
 * where hrm.employment.manage or payroll.manage suffices. Vendors and
 * anyone without a grant still get the named 403, and every allowed write
 * keeps the approval, revision, audit and scope controls behind it.
 */
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __bankEmployeeAuthzUser: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier === "./auth" || specifier.endsWith("/lib/auth")) &&
      context.parentURL?.endsWith("/web/lib/authz.ts")
    ) {
      return virtual(
        "export async function currentUser(){return globalThis.__bankEmployeeAuthzUser.user}",
      );
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { POST: createAccount, PATCH: updateAccount } = await import("./route");

function asUser(id: string, orgId: string): SessionUser {
  return {
    id,
    orgId,
    name: "Hire banker",
    email: "hire-banker@scratch.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: id,
  };
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const holder = async (name: string, roleKey: string, permissions: string[]) => {
      const id = await withBypassContext(() => createScratchUser(org.orgId, name, roleKey));
      await withBypassContext(() =>
        db.execute(
          sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb where org_id=${org.orgId} and key=${roleKey}`,
        ),
      );
      return id;
    };
    const hr = await holder("H R Banker", "hr_banker", ["hrm.employment.manage"]);
    const payroll = await holder("Payroll Banker", "pr_banker", ["payroll.manage"]);
    const master = await holder("Master Banker", "master_banker", ["parties.manage"]);
    const reader = await holder("Reader Banker", "reader_banker", []);
    await withBypassContext(() =>
      db.execute(
        sql`update orgs set settings=jsonb_set(jsonb_set(coalesce(settings,'{}'::jsonb),'{features,hrm}'::text[],'true'::jsonb,true),'{features,payroll}'::text[],'true'::jsonb,true) where id=${org.orgId}`,
      ),
    );
    const employee = randomUUID();
    await withBypassContext(() =>
      db.execute(
        sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom) values (${employee},${org.orgId},'person','Hired Hannah',${org.subsidiaryId},true,'{}'::jsonb)`,
      ),
    );
    await withBypassContext(() =>
      db.execute(
        sql`insert into employee_roles(org_id,party_id,is_active,created_by,updated_by) values (${org.orgId},${employee},true,${hr},${hr})`,
      ),
    );
    const vendor = randomUUID();
    await withBypassContext(() =>
      db.execute(
        sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom) values (${vendor},${org.orgId},'company','Vendor Vera',${org.subsidiaryId},true,'{}'::jsonb)`,
      ),
    );
    await withBypassContext(() =>
      db.execute(
        sql`insert into vendor_roles(org_id,party_id,is_active,created_by,updated_by) values (${org.orgId},${vendor},true,${hr},${hr})`,
      ),
    );
    return { org, hr, payroll, master, reader, employee, vendor };
  } catch (e) {
    await withBypassContext(() => dropScratchOrg(org.orgId));
    throw e;
  }
}

const post = (partyId: string) =>
  new Request(`http://bank.local/api/parties/${partyId}/bank-accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bankName: "Hire Bank", accountNumber: "00112233" }),
  });

async function accountCount(orgId: string, partyId: string): Promise<number> {
  return Number(
    (
      await db.execute<{ count: string }>(
        sql`select count(*)::text as count from party_bank_accounts where org_id=${orgId} and party_id=${partyId}`,
        "objects",
      )
    )[0]!.count,
  );
}

test("HR and payroll operators capture an employee bank account; vendors stay master-data-only", async () => {
  const { org, hr, payroll, master, reader, employee, vendor } = await fixture();
  try {
    await withOrgContext(org.orgId, async () => {
      state.user = asUser(hr, org.orgId);
      const hrEmployee = await createAccount(post(employee), {
        params: Promise.resolve({ id: employee }),
      });
      assert.equal(hrEmployee.status, 201, JSON.stringify(await hrEmployee.clone().json()));
      assert.equal(await accountCount(org.orgId, employee), 1);

      const hrVendor = await createAccount(post(vendor), {
        params: Promise.resolve({ id: vendor }),
      });
      assert.equal(hrVendor.status, 403, JSON.stringify(await hrVendor.clone().json()));
      assert.match(
        String(((await hrVendor.clone().json()) as { error: string }).error),
        /parties\.manage/,
      );
      assert.equal(
        await accountCount(org.orgId, vendor),
        0,
        "a refused create writes no bank details",
      );

      state.user = asUser(payroll, org.orgId);
      const payrollEmployee = await createAccount(post(employee), {
        params: Promise.resolve({ id: employee }),
      });
      assert.equal(
        payrollEmployee.status,
        201,
        JSON.stringify(await payrollEmployee.clone().json()),
      );

      state.user = asUser(master, org.orgId);
      const masterVendor = await createAccount(post(vendor), {
        params: Promise.resolve({ id: vendor }),
      });
      assert.equal(masterVendor.status, 201, JSON.stringify(await masterVendor.clone().json()));

      state.user = asUser(reader, org.orgId);
      const readerEmployee = await createAccount(post(employee), {
        params: Promise.resolve({ id: employee }),
      });
      assert.equal(readerEmployee.status, 403);

      state.user = null;
      const anonymous = await createAccount(post(employee), {
        params: Promise.resolve({ id: employee }),
      });
      assert.equal(anonymous.status, 401);
    });
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("the shared write gate covers edits: HR passes for the employee, refused for the vendor", async () => {
  const { org, hr, employee, vendor } = await fixture();
  try {
    await withOrgContext(org.orgId, async () => {
      state.user = asUser(hr, org.orgId);
      const patch = (partyId: string) =>
        updateAccount(
          new Request(
            `http://bank.local/api/parties/${partyId}/bank-accounts?accountId=${randomUUID()}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ expectedUpdatedAt: "x" }),
            },
          ),
          { params: Promise.resolve({ id: partyId }) },
        );
      // The employee edit passes the gate (400 "nothing to update" = unknown
      // account, reached past authorization); the vendor edit is refused up
      // front.
      const employeeEdit = await patch(employee);
      assert.equal(employeeEdit.status, 400, JSON.stringify(await employeeEdit.clone().json()));
      const vendorEdit = await patch(vendor);
      assert.equal(vendorEdit.status, 403, JSON.stringify(await vendorEdit.clone().json()));
    });
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
