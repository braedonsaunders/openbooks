import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Authz } from "@/lib/authz";
import { stubModules } from "../../../../../../testing/stub-modules";
import { db, env, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import { sql } from "drizzle-orm";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";

const state = { authz: null as Authz | null };
Object.assign(globalThis, { __approvalRequestReadTest: state });
const authzUrl = import.meta.resolve("@/lib/authz");
stubModules({
  authz: `export * from ${JSON.stringify(authzUrl)};export async function getAuthz(){return globalThis.__approvalRequestReadTest.authz}`,
});
const { GET } = await import("./route");
const read = (id: string, kind = "party_bank_account") =>
  GET(new Request(`http://openbooks.test/api/flows/records/${kind}/${id}`), {
    params: Promise.resolve({ subjectKind: kind, id }),
  });

test(
  "native request reads preserve tenant and legal-entity scope without exposing bank secrets",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const foreign = await withBypassContext(() => createScratchOrg());
    const actor = await withBypassContext(() =>
      createScratchUser(org.orgId, "Request reviewer", "admin"),
    );
    const foreignActor = await withBypassContext(() =>
      createScratchUser(foreign.orgId, "Request author", "admin"),
    );
    const ownId = randomUUID(),
      foreignId = randomUUID();
    try {
      await withBypassContext(async () => {
        await db.execute(
          sql`update app_roles set permissions='["parties.read"]'::jsonb where org_id=${org.orgId} and key='admin'`,
        );
        for (const [owner, id, author] of [
          [org, ownId, actor],
          [foreign, foreignId, foreignActor],
        ] as const) {
          await db.execute(
            sql`update parties set subsidiary_id=${owner.subsidiaryId} where org_id=${owner.orgId} and id=${owner.customerId}`,
          );
          await db.execute(sql`insert into party_bank_accounts(id,org_id,party_id,bank_name,country,currency,
          account_number_encrypted,account_last_four,approval_status,is_active,created_by,updated_by)
          values(${id},${owner.orgId},${owner.customerId},'Operating bank','CA','CAD','retained-secret-envelope','1234','pending',false,${author},${author})`);
        }
      });
      state.authz = {
        user: {
          orgId: org.orgId,
          id: actor,
          roles: [],
          name: "Request reviewer",
          email: "reviewer@scratch.test",
          envKind: "production",
          productionOrgId: org.orgId,
          homeOrgId: org.orgId,
          homeUserId: actor,
          isSuperAdmin: false,
        },
        permissions: new Set(["parties.read"]),
        allowedSubsidiaryIds: null,
      } satisfies Authz;
      await withOrgContext(org.orgId, async () => {
        const response = await read(ownId);
        assert.equal(response.status, 200);
        const detail = await response.json();
        assert.equal(detail.subjectId, ownId);
        assert.ok(
          detail.fields.some(
            (field: { key: string; value: unknown }) =>
              field.key === "bankName" && field.value === "Operating bank",
          ),
        );
        assert.ok(!JSON.stringify(detail).includes("retained-secret-envelope"));
        assert.equal((await read(foreignId)).status, 404);
        assert.equal((await read(randomUUID())).status, 404);
        state.authz = { ...state.authz!, allowedSubsidiaryIds: new Set() };
        assert.equal((await read(ownId)).status, 404);
        state.authz = { ...state.authz!, allowedSubsidiaryIds: null, permissions: new Set() };
        assert.equal((await read(ownId)).status, 404);
        state.authz = { ...state.authz!, permissions: new Set(["parties.read"]) };
        await withBypassContext(() =>
          db.execute(sql`update app_roles set permissions='[]'::jsonb where org_id=${org.orgId}`),
        );
        assert.equal(
          (await read(ownId)).status,
          404,
          "a stale session grant cannot disclose a record after native authority is revoked",
        );
      });
    } finally {
      state.authz = null;
      await withBypassContext(() => dropScratchOrg(foreign.orgId));
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
