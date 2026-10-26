import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import type { SessionUser } from "../../../lib/auth";

const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __partyUpdateControlsSession: session });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next-intl/server")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}",
      };
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts"))
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__partyUpdateControlsSession.user}",
      };
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { PATCH, GET } = await import("./[id]/route");
const { GET: transactions } = await import("./[id]/transactions/route");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patchRequest = (body: unknown) =>
  new Request("http://audit.local", { method: "PATCH", body: JSON.stringify(body) });

async function fixture() {
  // Fixture seeding runs under bypass (exactly what the pooled fixture path
  // does): the shared cluster enforces RLS and CI's superuser role hides it.
  // Explicit withOrg/withBypass blocks take precedence over the
  // request-org resolver the route import registers, so this holds no
  // matter which module the test runner preloads first.
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() =>
    createScratchUser(org.orgId, "Party auditor", "reviewer"),
  );
  await withBypassContext(() =>
    db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
    ),
  );
  session.user = {
    id: actor,
    orgId: org.orgId,
    name: "Auditor",
    email: "auditor@example.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: actor,
  };
  return { org, actor };
}

async function revision(orgId: string, partyId: string): Promise<string> {
  const res = await withOrgContext(orgId, () =>
    GET(new Request("http://audit.local"), params(partyId)),
  );
  assert.equal(res.status, 200);
  return (await res.json()).party.updated_at as string;
}

test("impossible hired-on dates are refused with 422 and store nothing", async () => {
  const { org } = await fixture();
  try {
    await withOrgContext(org.orgId, async () => {
      const bad = await PATCH(
        patchRequest({
          kind: "person",
          roles: { employee: { enabled: true, hiredOn: "2026-02-30" } },
          expectedUpdatedAt: await revision(org.orgId, org.customerId),
        }),
        params(org.customerId),
      );
      assert.equal(bad.status, 422, await bad.clone().text());
      assert.equal(
        (
          await db.execute<{ n: string }>(
            sql`select count(*)::text as n from employee_roles where org_id=${org.orgId} and party_id=${org.customerId}`,
            "objects",
          )
        )[0]!.n,
        "0",
      );
      const good = await PATCH(
        patchRequest({
          kind: "person",
          roles: { employee: { enabled: true, hiredOn: "2026-02-28" } },
          expectedUpdatedAt: await revision(org.orgId, org.customerId),
        }),
        params(org.customerId),
      );
      assert.equal(good.status, 200, await good.clone().text());
      assert.equal(
        (
          await db.execute<{ hired_on: string }>(
            sql`select hired_on::text from employee_roles where org_id=${org.orgId} and party_id=${org.customerId}`,
            "objects",
          )
        )[0]!.hired_on,
        "2026-02-28",
      );
    });
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("an edit echoing a backed role kind persists instead of 422ing", async () => {
  // The drawer echoes the stored kind back on every save, but
  // PATCH only accepted company|person — so every edit of an employee-kind
  // party failed while the UI reported success. Only backed kinds round-trip,
  // so the fixture carries the employee role. Real route,
  // real rows.
  const { org } = await fixture();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(
        sql`update parties set kind = 'employee' where id = ${org.customerId} and org_id = ${org.orgId}`,
      );
      await db.execute(
        sql`insert into employee_roles (org_id, party_id) values (${org.orgId}, ${org.customerId})`,
      );
      const res = await PATCH(
        patchRequest({
          kind: "employee",
          shortCode: "DE-001",
          expectedUpdatedAt: await revision(org.orgId, org.customerId),
        }),
        params(org.customerId),
      );
      assert.equal(res.status, 200, await res.clone().text());
      const stored = (
        await db.execute<{ kind: string; short_code: string }>(
          sql`
        select kind, short_code from parties where id = ${org.customerId} and org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!;
      assert.equal(stored.kind, "employee");
      assert.equal(stored.short_code, "DE-001");
    });
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("an edit claiming an unbacked role kind is refused by name", async () => {
  // Kind "vendor" with no vendor_roles row strands a "Kind: Vendor"
  // the Compliance tab cannot back. The save must refuse, naming the role,
  // and store nothing.
  const { org } = await fixture();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(
        sql`update parties set kind = 'vendor' where id = ${org.customerId} and org_id = ${org.orgId}`,
      );
      const res = await PATCH(
        patchRequest({
          kind: "vendor",
          shortCode: "VN-001",
          expectedUpdatedAt: await revision(org.orgId, org.customerId),
        }),
        params(org.customerId),
      );
      assert.equal(res.status, 422, await res.clone().text());
      assert.match(
        ((await res.json()) as { error: string }).error,
        /kind "vendor" needs the vendor role/,
      );
      const stored = (
        await db.execute<{ kind: string; short_code: string | null }>(
          sql`
        select kind, short_code from parties where id = ${org.customerId} and org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!;
      assert.equal(stored.kind, "vendor");
      assert.equal(stored.short_code, null);
      assert.equal(
        (
          await db.execute<{ n: string }>(
            sql`select count(*)::text as n from vendor_roles where org_id = ${org.orgId} and party_id = ${org.customerId}`,
            "objects",
          )
        )[0]!.n,
        "0",
      );
    });
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("routine party saves preserve the reserved source sync-identity bridge", async () => {
  const { org } = await fixture();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(
        sql`update parties set custom='{"source":{"system":"fixture-source","externalId":"C-1"}}'::jsonb where id=${org.customerId} and org_id=${org.orgId}`,
      );
      const res = await PATCH(
        patchRequest({
          displayName: "Renamed customer",
          custom: {},
          expectedUpdatedAt: await revision(org.orgId, org.customerId),
        }),
        params(org.customerId),
      );
      assert.equal(res.status, 200, await res.clone().text());
      const custom = (
        await db.execute<{ custom: Record<string, unknown> }>(
          sql`select custom from parties where id=${org.customerId}`,
          "objects",
        )
      )[0]!.custom;
      assert.deepEqual(custom, { source: { system: "fixture-source", externalId: "C-1" } });
    });
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("party PATCH preserves omitted required custom fields on a partial edit", async () => {
  const { org, actor } = await fixture();
  try {
    await withOrgContext(org.orgId, async () => {
      const requiredId = randomUUID();
      const optionalId = randomUUID();
      await db.execute(sql`
        insert into custom_field_defs
          (id, org_id, target_table, key, label, field_type, config, is_required, is_active, created_by, updated_by)
        values
          (${requiredId}, ${org.orgId}, 'parties', 'required_code', 'Required code', 'text', '{}'::jsonb, true, true, ${actor}, ${actor}),
          (${optionalId}, ${org.orgId}, 'parties', 'optional_note', 'Optional note', 'text', '{}'::jsonb, false, true, ${actor}, ${actor})
      `);
      await db.execute(
        sql`update parties set custom='{"required_code":"R-1"}'::jsonb where id=${org.customerId} and org_id=${org.orgId}`,
      );

      const response = await PATCH(
        patchRequest({
          custom: { optional_note: "updated" },
          expectedUpdatedAt: await revision(org.orgId, org.customerId),
        }),
        params(org.customerId),
      );
      assert.equal(response.status, 200, await response.clone().text());
      const stored = (
        await db.execute<{ custom: Record<string, unknown> }>(
          sql`
        select custom from parties where id=${org.customerId} and org_id=${org.orgId}`,
          "objects",
        )
      )[0]!.custom;
      assert.deepEqual(stored, { required_code: "R-1", optional_note: "updated" });
    });
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("transaction filter enums stay inside the caller subsidiary scope", async () => {
  const { org, actor } = await fixture();
  try {
    await withOrgContext(org.orgId, async () => {
      const hidden = randomUUID();
      await db.execute(
        sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`,
      );
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,document_date,currency,status,subsidiary_id,created_by,updated_by) values
        (${randomUUID()},${org.orgId},'sales_order','VIS-1',${org.customerId},${org.date},'CAD','draft',${org.subsidiaryId},${actor},${actor}),
        (${randomUUID()},${org.orgId},'customer_invoice','HID-1',${org.customerId},${org.date},'CAD','draft',${hidden},${actor},${actor})`);
      await db.execute(
        sql`update app_roles set subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb where org_id=${org.orgId} and key='reviewer'`,
      );
      const res = await transactions(new Request("http://audit.local/api"), params(org.customerId));
      assert.equal(res.status, 200, await res.clone().text());
      const body = await res.json();
      assert.equal(body.rows.length, 1);
      assert.deepEqual(body.kinds, ["sales_order"]);
    });
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("native employee create remains employee and hires through the canonical lifecycle", async () => {
  const { setupHarness, withHarness } = await import("@openbooks/engine/testing/hrm-harness");
  const { POST } = await import("./route");
  const { proposeFirstEmployment } = await import("@openbooks/engine/hrm/first-employment");
  const { findEmploymentsByParty } = await import("@openbooks/engine/hrm/employment-read");
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
  await withHarness(
    () =>
      setupHarness({
        features: ["hrm"],
        users: [
          {
            key: "hrId",
            name: "Hiring manager",
            handle: "party_hire_manager",
            permissions: ["*"],
            link: true,
          },
        ],
      } as const),
    async (h) => {
      session.user = {
        id: h.hrId,
        orgId: h.org.orgId,
        name: "Hiring manager",
        email: "hr@example.test",
        roles: [],
        isSuperAdmin: false,
        envKind: "production",
        productionOrgId: h.org.orgId,
        homeOrgId: h.org.orgId,
        homeUserId: h.hrId,
      };
      try {
        const partyId = randomUUID();
        const response = await POST(
          new Request("http://audit.local/api/parties", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": partyId },
            body: JSON.stringify({
              kind: "employee",
              displayName: "New employee",
              subsidiaryId: h.org.subsidiaryId,
              roles: { employee: { enabled: true } },
            }),
          }),
        );
        assert.equal(response.status, 201, await response.clone().text());
        const payload = (await response.json()) as {
          party: { id: string; kind: string };
          employee: { is_active: boolean };
        };
        assert.equal(payload.party.id, partyId);
        assert.equal(payload.party.kind, "employee");
        assert.equal(payload.employee.is_active, true);
        const hire = await proposeFirstEmployment({
          orgId: h.org.orgId,
          actorId: h.hrId,
          workerPartyId: partyId,
          employerSubsidiaryId: h.org.subsidiaryId,
          effectiveFrom: "2026-09-01",
          reason: "Start employment",
        });
        assert.equal(hire.status, "applied");
        assert.deepEqual(
          await findEmploymentsByParty({
            orgId: h.org.orgId,
            actorId: h.hrId,
            workerPartyId: partyId,
          }),
          [hire.employmentId],
        );
        const stored = (
          await db.execute<{ kind: string; status: string; activeRole: boolean }>(
            sql`
        select p.kind, v.status, r.is_active as "activeRole" from parties p
        join employee_roles r on r.org_id=p.org_id and r.party_id=p.id
        join worker_employments e on e.org_id=p.org_id and e.worker_party_id=p.id
        join worker_employment_versions v on v.org_id=e.org_id and v.employment_id=e.id and v.recorded_until is null
        where p.org_id=${h.org.orgId} and p.id=${partyId}
      `,
            "objects",
          )
        )[0];
        assert.deepEqual(stored, { kind: "employee", status: "active", activeRole: true });
      } finally {
        session.user = null;
      }
    },
  );
});

test("company keeps its commercial roles and refuses employee role assignment", async () => {
  const { org } = await fixture();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(
        sql`update parties set kind='company' where org_id=${org.orgId} and id=${org.customerId}`,
      );
      await db.execute(
        sql`insert into customer_roles (org_id, party_id) values (${org.orgId}, ${org.customerId})`,
      );
      const rejected = await PATCH(
        patchRequest({
          roles: { employee: { enabled: true } },
          expectedUpdatedAt: await revision(org.orgId, org.customerId),
        }),
        params(org.customerId),
      );
      assert.equal(rejected.status, 422, await rejected.clone().text());
      assert.match(
        ((await rejected.json()) as { error: string }).error,
        /requires kind "person" or "employee"/,
      );
      assert.equal(
        (
          await db.execute<{ n: string }>(
            sql`select count(*)::text as n from employee_roles
        where org_id=${org.orgId} and party_id=${org.customerId}`,
            "objects",
          )
        )[0]!.n,
        "0",
      );
      const allowed = await PATCH(
        patchRequest({
          roles: { vendor: { enabled: true } },
          expectedUpdatedAt: await revision(org.orgId, org.customerId),
        }),
        params(org.customerId),
      );
      assert.equal(allowed.status, 200, await allowed.clone().text());
      const party = (
        await db.execute<{ kind: string; customer: boolean; vendor: boolean }>(
          sql`
        select p.kind,
          exists(select 1 from customer_roles r where r.org_id=p.org_id and r.party_id=p.id and r.is_active) as customer,
          exists(select 1 from vendor_roles r where r.org_id=p.org_id and r.party_id=p.id and r.is_active) as vendor
        from parties p where p.org_id=${org.orgId} and p.id=${org.customerId}
      `,
          "objects",
        )
      )[0];
      assert.deepEqual(party, { kind: "company", customer: true, vendor: true });
    });
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});
