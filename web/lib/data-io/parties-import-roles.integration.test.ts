import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

// Imported parties must land where the product reads them: the stored kind
// stays canonical, every named role becomes a native role row, and the
// export reads those rows back — so an exported file re-imports losslessly
// and a re-import never mints a duplicate role.
const { db, env, withBypass, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { MASTER_BY_KEY, masterResource } = await import("./master-data-resources.ts");

test(
  "parties import maps displayed kinds and role flags to native roles",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
    try {
      const resource = masterResource(MASTER_BY_KEY.get("parties")!, org.orgId);
      const ctx = {
        orgId: org.orgId,
        actorId,
        dryRun: false,
        allowedSubsidiaryIds: null,
      };
      // Scratch orgs ship seeded parties, so role and kind assertions stay
      // scoped to the imported short codes.
      const roleCount = async (table: string): Promise<number> =>
        Number(
          (
            await db.execute<{ count: string }>(
              sql`select count(*)::text as count from ${sql.raw(table)} r
                   join parties p on p.id = r.party_id and p.org_id = r.org_id
                  where r.org_id = ${org.orgId} and p.short_code in ('ACME', 'BETA')`,
              "objects",
            )
          )[0]?.count ?? "0",
        );
      await withOrgContext(org.orgId, async () => {
        const first = await resource.write(
          [
            { shortCode: "ACME", displayName: "Acme Co", kind: "Company", isVendor: "yes" },
            { shortCode: "BETA", displayName: "Beta LLC", kind: "Vendor" },
          ],
          "upsert",
          ctx,
        );
        assert.equal(first.created, 2, JSON.stringify(first.errors));

        const stored = await db.execute<{ short_code: string; kind: string }>(
          sql`
          select short_code, kind from parties
           where org_id = ${org.orgId} and short_code in ('ACME', 'BETA')
           order by short_code`,
          "objects",
        );
        assert.deepEqual(
          stored.map((r) => [r.short_code, r.kind]),
          [
            ["ACME", "company"],
            ["BETA", "vendor"],
          ],
        );
        assert.equal(await roleCount("vendor_roles"), 2);
        assert.equal(await roleCount("customer_roles"), 0);

        const read = await resource.read();
        const acme = read.rows.find((r) => r.shortCode === "ACME");
        const beta = read.rows.find((r) => r.shortCode === "BETA");
        assert.equal(acme?.isVendor, true);
        assert.equal(acme?.isCustomer, false);
        assert.equal(beta?.isVendor, true);

        const second = await resource.write(
          [
            { shortCode: "ACME", displayName: "Acme Co", kind: "Company", isVendor: "yes" },
            { shortCode: "BETA", displayName: "Beta LLC", kind: "Vendor" },
          ],
          "upsert",
          ctx,
        );
        assert.equal(second.updated, 2, JSON.stringify(second.errors));
        assert.equal(await roleCount("vendor_roles"), 2, "re-import mints no duplicate role row");

        const refused = await resource.write(
          [{ shortCode: "PAR-1", displayName: "Partner Co", kind: "Partner" }],
          "upsert",
          ctx,
        );
        assert.deepEqual(refused, {
          created: 0,
          updated: 0,
          failed: 1,
          errors: [
            {
              row: 1,
              message:
                'kind: invalid value "Partner" — use one of: company, person, customer, vendor, employee',
            },
          ],
        });
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "parties import admits native employees and refuses corporate employee role claims",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
    try {
      await withOrgContext(org.orgId, async () => {
        const resource = masterResource(MASTER_BY_KEY.get("parties")!, org.orgId);
        const ctx = { orgId: org.orgId, actorId, dryRun: false, allowedSubsidiaryIds: null };
        const accepted = await resource.write(
          [
            { shortCode: "EMP-NEW", displayName: "Native employee", kind: "Employee" },
            {
              shortCode: "PERSON-NEW",
              displayName: "Natural person",
              kind: "Person",
              isEmployee: "yes",
            },
          ],
          "upsert",
          ctx,
        );
        assert.equal(accepted.created, 2, JSON.stringify(accepted.errors));
        const stored = await db.execute<{ kind: string; active: boolean }>(
          sql`
        select p.kind, r.is_active as active from parties p join employee_roles r on r.org_id=p.org_id and r.party_id=p.id
        where p.org_id=${org.orgId} and p.short_code in ('EMP-NEW', 'PERSON-NEW') order by p.short_code
      `,
          "objects",
        );
        assert.deepEqual(stored, [
          { kind: "employee", active: true },
          { kind: "person", active: true },
        ]);
        for (const dryRun of [true, false]) {
          const refused = await resource.write(
            [
              {
                shortCode: "CORP-EMP",
                displayName: "Corporate identity",
                kind: "Company",
                isEmployee: "yes",
              },
            ],
            "upsert",
            { ...ctx, dryRun },
          );
          assert.equal(refused.failed, 1);
          assert.match(refused.errors[0]!.message, /requires kind "person" or "employee"/);
          assert.equal(refused.created, 0);
        }
        assert.equal(
          (
            await db.execute<{ n: string }>(
              sql`select count(*)::text as n from parties where org_id=${org.orgId} and short_code='CORP-EMP'`,
              "objects",
            )
          )[0]!.n,
          "0",
        );
        const imported = await resource.read();
        assert.equal(imported.rows.find((row) => row.shortCode === "EMP-NEW")?.isEmployee, true);
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
