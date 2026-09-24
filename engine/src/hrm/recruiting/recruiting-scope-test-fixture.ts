import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { createRequisition, openRequisition } from "./requisitions.ts";

/**
 * Shared two-entity harness for Audit-H recruiting scope regressions: every
 * test gets an org with a root subsidiary (A) plus a child subsidiary (B),
 * an unrestricted admin, and a recruiter whose only role sees exactly A.
 * Tests prove each boundary twice — once per entity — so a fix that guards
 * A but not B (or vice versa) still fails.
 */

export interface ScopeHarness {
  org: ScratchOrg;
  subB: string;
  adminId: string;
  scopedId: string;
}

export async function enableRecruitingDepth(orgId: string, ...keys: string[]): Promise<void> {
  for (const key of ["hrm", ...keys]) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), string_to_array(${"features," + key}, ','), 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

export async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

export async function setupScopeHarness(depthKeys: string[] = []): Promise<ScopeHarness> {
  const org = await createScratchOrg();
  await enableRecruitingDepth(org.orgId, ...depthKeys);
  const adminId = await createScratchUser(org.orgId, "Scope Admin", "scope_admin");
  await grantPermissions(org.orgId, adminId, ["hrm.recruiting.read", "hrm.recruiting.manage"]);
  const subB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  const scopedId = await createScratchUser(org.orgId, "Scoped Recruiter", "scope_recruiter");
  // Narrow the auto-created role in place: a second unrestricted role would
  // union back to org-wide, which is exactly the shape under test.
  await db.execute(sql`
    update app_roles
       set permissions = '["hrm.recruiting.read", "hrm.recruiting.manage"]'::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
     where org_id = ${org.orgId} and key = 'scope_recruiter'`);
  return { org, subB, adminId, scopedId };
}

export async function teardownScopeHarness(h: ScopeHarness): Promise<void> {
  await dropScratchOrg(h.org.orgId);
}

export async function openScopedReq(orgId: string, actorId: string, subsidiaryId: string, title: string) {
  const draft = await createRequisition({ orgId, actorId, title, employerSubsidiaryId: subsidiaryId, headcount: 1 });
  return openRequisition({ orgId, actorId, requisitionId: draft.id });
}

export async function candidateDisplayName(orgId: string, candidateId: string): Promise<string | null> {
  return (await db.execute<{ displayName: string }>(sql`
    select display_name as "displayName" from hrm_candidates
     where org_id = ${orgId} and id = ${candidateId}`)).rows[0]?.displayName ?? null;
}
