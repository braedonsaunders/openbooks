import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  db,
  withOrgContext as withOrg,
  withBypassContext,
} from "@openbooks/engine/platform/database";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/src/testing/fixtures.ts";
import { loadSalesMapCustomers } from "./sales-map";

test(
  "customer map views enforce native department, employee and entity scope and require verified coordinates",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actor = await withBypassContext(() =>
        createScratchUser(org.orgId, "Map reviewer", "admin"),
      );
      await withOrg(org.orgId, async () => {
        const department = (
          await db.execute<{ id: string }>(
            sql`insert into departments(org_id,name,subsidiary_id) values(${org.orgId},'Enterprise sales',${org.subsidiaryId}) returning id`,
          )
        ).rows[0]!.id;
        const rep = (
          await db.execute<{ id: string }>(
            sql`insert into parties(org_id,kind,display_name,subsidiary_id) values(${org.orgId},'employee','Map sales representative',${org.subsidiaryId}) returning id`,
          )
        ).rows[0]!.id;
        await db.execute(
          sql`insert into employee_roles(org_id,party_id,is_sales_rep,department_id) values(${org.orgId},${rep},true,${department})`,
        );
        for (const verified of [true, false]) {
          const customer = (
            await db.execute<{ id: string }>(
              sql`insert into parties(org_id,kind,display_name,subsidiary_id) values(${org.orgId},'company',${verified ? "Verified customer" : "Unverified customer"},${org.subsidiaryId}) returning id`,
            )
          ).rows[0]!.id;
          await db.execute(
            sql`insert into customer_roles(org_id,party_id,sales_rep_id) values(${org.orgId},${customer},${rep})`,
          );
          await db.execute(
            sql`insert into addresses(org_id,party_id,is_default_billing,longitude,latitude,location_verified_at,location_verified_by) values(${org.orgId},${customer},true,-79.3832,43.6532,${verified ? new Date() : null},${verified ? actor : null})`,
          );
        }
        const scope = {
          orgId: org.orgId,
          actorId: actor,
          allowedSubsidiaryIds: null,
        };
        const filters = {
          subsidiaryId: org.subsidiaryId,
          departmentId: department,
          salesTeamId: null,
          employeeId: rep,
        };
        const map = await loadSalesMapCustomers(scope, filters);
        assert.deepEqual(map.stats, { total: 2, located: 1 });
        assert.equal(map.locations.length, 1);
        assert.equal(map.locations[0]!.name, "Verified customer");
        assert.equal(map.locations[0]!.longitude, -79.3832);
        const forbidden = await loadSalesMapCustomers(
          { ...scope, allowedSubsidiaryIds: new Set() },
          filters,
        );
        assert.deepEqual(forbidden.stats, { total: 0, located: 0 });
        assert.deepEqual(forbidden.locations, []);
        const otherDepartment = await loadSalesMapCustomers(scope, {
          ...filters,
          departmentId: "00000000-0000-4000-8000-000000000001",
        });
        assert.deepEqual(otherDepartment.locations, []);
        assert.equal(otherDepartment.stats.total, 0);
        const anotherEmployee = await loadSalesMapCustomers(scope, {
          ...filters,
          employeeId: "00000000-0000-4000-8000-000000000002",
        });
        assert.deepEqual(anotherEmployee.locations, []);
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
