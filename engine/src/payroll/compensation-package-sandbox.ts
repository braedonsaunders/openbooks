import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { compensationPackageDefinitionHash, type CompensationPackageDefinition } from "./compensation-package.ts";
import type { CompensationPackageAuthorship } from "./compensation-package-store.ts";

/** Rebind approved policy identities to proven native counterparts without repricing financial history. */
export async function rebaseClonedCompensationPackages(tx: SqlExecutor, sourceOrgId: string, targetOrgId: string, seed: string): Promise<void> {
  const permitted = (await tx.execute<{ allowed: boolean }>(sql`select public.openbooks_clone_authority() as allowed`)).rows[0];
  if (permitted?.allowed !== true) throw new Error("Compensation identity rebasing requires the controlled sandbox clone transaction.");
  const components = (await tx.execute<{ sourceId: string; targetId: string }>(sql`select s.id as "sourceId",t.id as "targetId"
    from pay_components s join pay_components t on t.org_id=${targetOrgId} and t.id=ob_rebase(s.id,${seed}::uuid) where s.org_id=${sourceOrgId}`)).rows;
  const counterparts = new Map(components.map((row) => [row.sourceId, row.targetId]));
  const users = (await tx.execute<{ sourceId: string; targetId: string }>(sql`select s.id as "sourceId",t.id as "targetId" from users s join users t on t.org_id=${targetOrgId} and t.id=ob_rebase(s.id,${seed}::uuid) where s.org_id=${sourceOrgId}`)).rows;
  const parties = (await tx.execute<{ sourceId: string; targetId: string }>(sql`select s.id as "sourceId",t.id as "targetId" from parties s join parties t on t.org_id=${targetOrgId} and t.id=ob_rebase(s.id,${seed}::uuid) where s.org_id=${sourceOrgId}`)).rows;
  const userIds = new Map(users.map((row) => [row.sourceId, row.targetId])), partyIds = new Map(parties.map((row) => [row.sourceId, row.targetId]));
  const authors = (authorship: CompensationPackageAuthorship): CompensationPackageAuthorship => authorship.map((author) => {
    const actorId = userIds.get(author.actorId), partyId = author.partyId === null ? null : partyIds.get(author.partyId);
    if (!actorId || partyId === undefined) throw new Error("Cloned compensation authorship has no proven native person or user counterpart — repeat the clone with its complete identity history.");
    return { actorId, partyId };
  });
  const rows = (await tx.execute<{ id: string; definition: CompensationPackageDefinition; authorship: CompensationPackageAuthorship }>(sql`select id,definition,authorship from payroll_compensation_versions where org_id=${targetOrgId} order by id for update`)).rows;
  for (const row of rows) {
    if (row.definition.orgId !== sourceOrgId) throw new Error("Cloned compensation definition does not belong to the source organization — repeat the native clone from verified source records.");
    const definition: CompensationPackageDefinition = { ...row.definition, orgId: targetOrgId, rules: row.definition.rules.map((rule) => {
      const componentId = counterparts.get(rule.componentId);
      if (!componentId) throw new Error(`Cloned compensation rule ${rule.key} has no native target component — include its payroll configuration in this sandbox tier.`);
      return { ...rule, componentId };
    }) };
    const hash = compensationPackageDefinitionHash(definition);
    const updated = await tx.execute(sql`update payroll_compensation_versions set definition=${canonicalJson(definition)}::jsonb,definition_hash=${hash},authorship=${canonicalJson(authors(row.authorship))}::jsonb where org_id=${targetOrgId} and id=${row.id} returning id`);
    if (updated.rows.length !== 1) throw new Error("Cloned compensation definition was not rebound — repeat the native clone; partial copies are rolled back.");
  }
  const assignments = (await tx.execute<{ id: string; authorship: CompensationPackageAuthorship }>(sql`select id,authorship from payroll_compensation_assignments where org_id=${targetOrgId} order by id for update`)).rows;
  for (const row of assignments) {
    const updated = await tx.execute(sql`update payroll_compensation_assignments set authorship=${canonicalJson(authors(row.authorship))}::jsonb where org_id=${targetOrgId} and id=${row.id} returning id`);
    if (updated.rows.length !== 1) throw new Error("Cloned compensation assignment authorship was not rebound — repeat the native clone; partial copies are rolled back.");
  }
}
