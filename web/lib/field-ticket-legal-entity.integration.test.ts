import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { db, withBypassContext } from "@openbooks/engine/platform/db";
import { sql } from "drizzle-orm";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "@openbooks/engine/testing/fixtures";
import {
  createFieldTicket,
  FieldTicketError,
  loadFieldTicket,
  saveCrewGrid,
  updateTicketHeader,
} from "./field-tickets";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

test(
  "field ticket header edits preserve foreman, crew, and equipment legal-entity ownership",
  enabled,
  async () => {
    await withBypassContext(async () => {
      const org = await createScratchOrg();
      try {
        await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true)
         where id = ${org.orgId}`);
        const actor = (await seedFlowActors(org.orgId)).adminId;
        const otherSubsidiaryId = randomUUID();
        await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, is_active)
        values (${otherSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Other Legal', 'CAD', 'CA', true)`);
        const sourceProjectId = randomUUID();
        const targetProjectId = randomUUID();
        await db.execute(sql`
        insert into projects
          (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values
          (${sourceProjectId}, ${org.orgId}, ${org.subsidiaryId}, 'FT-LEGAL-A', 'Entity A', ${org.customerId}, 'active', true, '{}'::jsonb),
          (${targetProjectId}, ${org.orgId}, ${otherSubsidiaryId}, 'FT-LEGAL-B', 'Entity B', ${org.customerId}, 'active', true, '{}'::jsonb)`);
        const employeeId = randomUUID();
        await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'employee', 'Entity A employee', ${org.subsidiaryId}, true, '{}'::jsonb)`);
        await db.execute(sql`
        insert into employee_roles (party_id, org_id, is_active)
        values (${employeeId}, ${org.orgId}, true)`);

        const foremanTicket = await createFieldTicket(org.orgId, actor, {
          projectId: sourceProjectId,
          allowedSubsidiaryIds: null,
        });
        let loaded = await loadFieldTicket(org.orgId, foremanTicket.id);
        await assert.rejects(
          updateTicketHeader(
            org.orgId,
            actor,
            foremanTicket.id,
            { foremanPartyId: org.customerId },
            loaded.revision,
            null,
          ),
          (error: unknown) =>
            error instanceof FieldTicketError && /active employee/.test(error.message),
        );
        await updateTicketHeader(
          org.orgId,
          actor,
          foremanTicket.id,
          { foremanPartyId: employeeId },
          loaded.revision,
          null,
        );
        loaded = await loadFieldTicket(org.orgId, foremanTicket.id);
        await assert.rejects(
          updateTicketHeader(
            org.orgId,
            actor,
            foremanTicket.id,
            {
              projectId: targetProjectId,
            },
            loaded.revision,
            null,
          ),
          (error: unknown) =>
            error instanceof FieldTicketError && /legal entity/.test(error.message),
        );
        assert.equal(
          (await loadFieldTicket(org.orgId, foremanTicket.id)).projectId,
          sourceProjectId,
        );

        const timeTypeId = randomUUID();
        await db.execute(sql`
        insert into time_types (id, org_id, name, is_active, show_on_field_ticket, classification)
        values (${timeTypeId}, ${org.orgId}, 'Straight time', true, true, 'regular')`);
        const crewTicket = await createFieldTicket(org.orgId, actor, {
          projectId: sourceProjectId,
          allowedSubsidiaryIds: null,
        });
        loaded = await loadFieldTicket(org.orgId, crewTicket.id);
        await saveCrewGrid(
          org.orgId,
          actor,
          crewTicket.id,
          [
            {
              employeePartyId: employeeId,
              itemId: null,
              timeTypeId,
              hours: { [loaded.fieldTicket.periodStart]: "2" },
            },
          ],
          loaded.revision,
          null,
        );
        loaded = await loadFieldTicket(org.orgId, crewTicket.id);
        await assert.rejects(
          updateTicketHeader(
            org.orgId,
            actor,
            crewTicket.id,
            {
              projectId: targetProjectId,
              foremanPartyId: null,
            },
            loaded.revision,
            null,
          ),
          (error: unknown) =>
            error instanceof FieldTicketError &&
            /draft crew hours from another legal entity/.test(error.message),
        );
        assert.equal((await loadFieldTicket(org.orgId, crewTicket.id)).projectId, sourceProjectId);

        const equipmentTicket = await createFieldTicket(org.orgId, actor, {
          projectId: sourceProjectId,
          allowedSubsidiaryIds: null,
        });
        const equipmentUnitId = randomUUID();
        await db.execute(sql`
        insert into equipment_units (id, org_id, subsidiary_id, unit_number, name, status)
        values (${equipmentUnitId}, ${org.orgId}, ${org.subsidiaryId}, ${`FT-${equipmentUnitId.slice(0, 8)}`}, 'Entity A equipment', 'active')`);
        await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, amount, project_id, equipment_unit_id, field_ticket_id)
        values (${org.orgId}, ${equipmentTicket.id}, 1, ${org.accounts.cogs}, '10', ${sourceProjectId}, ${equipmentUnitId}, ${equipmentTicket.id})`);
        loaded = await loadFieldTicket(org.orgId, equipmentTicket.id);
        await assert.rejects(
          updateTicketHeader(
            org.orgId,
            actor,
            equipmentTicket.id,
            {
              projectId: targetProjectId,
              foremanPartyId: null,
            },
            loaded.revision,
            null,
          ),
          (error: unknown) =>
            error instanceof FieldTicketError &&
            /equipment lines from another legal entity/.test(error.message),
        );
        assert.equal(
          (await loadFieldTicket(org.orgId, equipmentTicket.id)).projectId,
          sourceProjectId,
        );
        const line = (
          await db.execute<{ project_id: string }>(
            sql`
        select project_id from document_lines where org_id = ${org.orgId} and document_id = ${equipmentTicket.id}`,
            "objects",
          )
        )[0];
        assert.equal(line?.project_id, sourceProjectId);
      } finally {
        await dropScratchOrg(org.orgId);
      }
    });
  },
);
