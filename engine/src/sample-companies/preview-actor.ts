import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { BUILT_IN_ROLES } from "../organization/permissions.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

/** Called only inside the locked clone-finalization transaction. The new
 * administrator receives a private snapshot of native role defaults; inherited
 * roles, existing users, explicit denials and assignments remain untouched. */
export async function createPreviewActor(tx: SqlExecutor, input: {
  orgId: string; memberUserId: string; memberName: string; sourceOrgId: string; templateOrgId: string;
}): Promise<string> {
  const definition = BUILT_IN_ROLES.admin;
  if (!definition?.permissions.length) throw new SampleCompanyError("native administrator defaults are unavailable");
  const actorId = randomUUID(), roleId = randomUUID(), personId = randomUUID();
  const name = input.memberName || "Sample company administrator";
  const email = `sample-${input.memberUserId}@openbooks.invalid`;
  const role = {
    key: `sample-admin-${actorId}`, name: "Sample company administrator",
    description: "Administrator access for the member's new sample company.",
    isBuiltIn: false, permissions: [...definition.permissions], subsidiaryRestriction: { mode: "all" },
  };
  const created = await tx.execute<{ id: string }>(sql`
    insert into users (id, org_id, email, name, password_hash, is_active, is_super_admin, created_by, updated_by)
    values (${actorId},${input.orgId},${email},${name},'sample-company-direct-login-disabled',true,false,${actorId},${actorId})
    returning id`);
  if (created.rows.length !== 1) throw new SampleCompanyError("sample administrator identity was not created");
  const person = await tx.execute<{ id: string }>(sql`
    insert into parties (id,org_id,kind,display_name,is_active,created_by,updated_by)
    values (${personId},${input.orgId},'person',${name},true,${actorId},${actorId}) returning id`);
  if (person.rows.length !== 1) throw new SampleCompanyError("sample administrator person was not created");
  const linked = await tx.execute<{ id: string }>(sql`
    update users set party_id=${personId},updated_by=${actorId}
    where org_id=${input.orgId} and id=${actorId} and party_id is null returning id`);
  if (linked.rows.length !== 1) throw new SampleCompanyError("sample administrator person was not linked");
  const createdRole = await tx.execute<{ id: string }>(sql`
    insert into app_roles (id,org_id,key,name,description,is_built_in,permissions,subsidiary_restriction,created_by,updated_by)
    values (${roleId},${input.orgId},${role.key},${role.name},${role.description},false,
      ${JSON.stringify(role.permissions)}::jsonb,${JSON.stringify(role.subsidiaryRestriction)}::jsonb,${actorId},${actorId}) returning id`);
  if (createdRole.rows.length !== 1) throw new SampleCompanyError("sample administrator role was not created");
  const assignment = await tx.execute<{ id: string }>(sql`
    insert into role_assignments (org_id,user_id,role_id,created_by,updated_by)
    values (${input.orgId},${actorId},${roleId},${actorId},${actorId}) returning id`);
  if (assignment.rows.length !== 1) throw new SampleCompanyError("sample administrator role was not assigned");

  const provenance = {
    source: "sample_company_administrator_provisioning",
    reason: "Create an administrator for the requesting member's new sample company",
    memberUserId: input.memberUserId, requestedFromOrgId: input.sourceOrgId, templateOrgId: input.templateOrgId,
  };
  const evidence = [
    { table: "users", id: actorId, after: { name, email, isActive: true, isSuperAdmin: false, partyId: personId, directLogin: "disabled" } },
    { table: "parties", id: personId, after: { kind: "person", displayName: name, isActive: true } },
    { table: "app_roles", id: roleId, after: role },
    { table: "role_assignments", id: assignment.rows[0]!.id, after: { userId: actorId, roleId } },
  ];
  const audited = await tx.execute<{ id: string }>(sql`
    insert into audit_log (org_id,table_name,row_id,action,actor_id,changes)
    values ${sql.join(evidence.map(record => sql`(${input.orgId},${record.table},${record.id},'insert',${actorId},
      ${JSON.stringify({ ...provenance, before: null, after: record.after })}::jsonb)`), sql`, `)} returning id`);
  if (audited.rows.length !== evidence.length) throw new SampleCompanyError("sample administrator provisioning audit was not recorded");
  return actorId;
}
