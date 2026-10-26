import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";

/**
 * The record behind an attachment target, including the legal-entity columns
 * needed to apply the caller's subsidiary scope before listing metadata.
 * Documents and fixed assets own their subsidiary directly; compliance rows
 * and lien waivers inherit it from their project (or party when no project is
 * present).
 */
export interface AttachmentTarget {
  targetTable: string;
  targetId: string;
  kind: string | null;
  subsidiaryId: string | null;
  /** A document's party (an expense report's employee); null for other tables. */
  documentPartyId: string | null;
  partySubsidiaryId: string | null;
  projectSubsidiaryId: string | null;
}

/** Load an attachment target without disclosing anything outside the org. */
export async function loadAttachmentTarget(
  orgId: string,
  targetTable: string,
  targetId: string,
  executor: SqlExecutor = db,
  forUpdate = false,
): Promise<AttachmentTarget | null> {
  const lock = forUpdate ? sql`for update` : sql``;
  type RawTarget = {
    kind?: string | null;
    subsidiaryId?: string | null;
    partyId?: string | null;
    partySubsidiaryId?: string | null;
    projectSubsidiaryId?: string | null;
    projectId?: string | null;
  };
  const row = (
    targetTable === "documents"
      ? (
          await executor.execute<{
            kind: string;
            subsidiaryId: string | null;
            partyId: string | null;
          }>(
            sql`
        select kind, subsidiary_id as "subsidiaryId", party_id as "partyId"
          from documents
         where id = ${targetId} and org_id = ${orgId} ${lock}`,
            "objects",
          )
        )[0]
      : targetTable === "parties"
        ? (
            await executor.execute<{ subsidiaryId: string | null }>(
              sql`
          select subsidiary_id as "subsidiaryId"
            from parties
           where id = ${targetId} and org_id = ${orgId} ${lock}`,
              "objects",
            )
          )[0]
        : targetTable === "item_rate_versions"
          ? (
              await executor.execute(
                sql`
            select id
              from item_rate_versions
             where id = ${targetId} and org_id = ${orgId} ${lock}`,
                "objects",
              )
            )[0]
          : targetTable === "fixed_assets"
            ? (
                await executor.execute<{ subsidiaryId: string | null }>(
                  sql`
              select subsidiary_id as "subsidiaryId"
                from fixed_assets
               where id = ${targetId} and org_id = ${orgId} ${lock}`,
                  "objects",
                )
              )[0]
            : targetTable === "compliance_records"
              ? (
                  await executor.execute<{
                    partySubsidiaryId: string | null;
                    projectSubsidiaryId: string | null;
                    projectId: string | null;
                  }>(
                    sql`
                select cr.project_id as "projectId", p.subsidiary_id as "partySubsidiaryId",
                       pj.subsidiary_id as "projectSubsidiaryId"
                  from compliance_records cr
                  join parties p on p.id = cr.party_id and p.org_id = cr.org_id
                  left join projects pj on pj.id = cr.project_id and pj.org_id = cr.org_id
                 where cr.id = ${targetId} and cr.org_id = ${orgId}
                 ${forUpdate ? sql`for update of cr, p` : sql``}`,
                    "objects",
                  )
                )[0]
              : targetTable === "lien_waivers"
                ? (
                    await executor.execute<{
                      partySubsidiaryId: string | null;
                      projectSubsidiaryId: string | null;
                    }>(
                      sql`
                  select p.subsidiary_id as "partySubsidiaryId",
                         pj.subsidiary_id as "projectSubsidiaryId"
                    from lien_waivers lw
                    join parties p on p.id = lw.party_id and p.org_id = lw.org_id
                  join projects pj on pj.id = lw.project_id and pj.org_id = lw.org_id
                   where lw.id = ${targetId} and lw.org_id = ${orgId}
                   ${forUpdate ? sql`for update of lw, p, pj` : sql``}`,
                      "objects",
                    )
                  )[0]
                : undefined
  ) as RawTarget | undefined;

  if (!row) return null;
  if (forUpdate && targetTable === "compliance_records" && row.projectId) {
    const project = await executor.execute<{ subsidiaryId: string | null }>(
      sql`
      select subsidiary_id as "subsidiaryId" from projects
       where id = ${row.projectId} and org_id = ${orgId} for update`,
      "objects",
    );
    row.projectSubsidiaryId = project[0]?.subsidiaryId ?? null;
  }
  return {
    targetTable,
    targetId,
    kind: targetTable === "documents" ? (row.kind ?? null) : null,
    subsidiaryId:
      targetTable === "documents" || targetTable === "parties" || targetTable === "fixed_assets"
        ? (row.subsidiaryId ?? null)
        : null,
    documentPartyId: targetTable === "documents" ? (row.partyId ?? null) : null,
    partySubsidiaryId:
      targetTable === "compliance_records" || targetTable === "lien_waivers"
        ? (row.partySubsidiaryId ?? null)
        : null,
    projectSubsidiaryId:
      targetTable === "compliance_records" || targetTable === "lien_waivers"
        ? (row.projectSubsidiaryId ?? null)
        : null,
  };
}

/** Apply row/legal-entity visibility to an already-loaded target. */
export function attachmentTargetInScope(
  authz: { allowedSubsidiaryIds: ReadonlySet<string> | null },
  target: AttachmentTarget,
): boolean {
  if (authz.allowedSubsidiaryIds === null) return true;

  // Rate-card versions are org-wide setup records: the table has no
  // subsidiary dimension, and the rate-book APIs intentionally expose them to
  // any caller holding admin.setup.manage regardless of subsidiary scope.
  if (target.targetTable === "item_rate_versions") return true;

  if (target.targetTable === "parties") {
    return subsidiaryScopeAllows(authz.allowedSubsidiaryIds, target.subsidiaryId, {
      orgWideNull: true,
    });
  }

  if (target.targetTable === "compliance_records") {
    // A project is the legal entity when present; an unprojected certificate
    // follows the vendor party's primary legal entity. Both linked rows must
    // remain visible when both carry a subsidiary, so a cross-entity link
    // cannot be used to disclose evidence from the hidden side.
    const partyVisible = subsidiaryScopeAllows(
      authz.allowedSubsidiaryIds,
      target.partySubsidiaryId,
      { orgWideNull: true },
    );
    const projectVisible =
      target.projectSubsidiaryId === null ||
      subsidiaryScopeAllows(authz.allowedSubsidiaryIds, target.projectSubsidiaryId);
    return partyVisible && projectVisible;
  }

  if (target.targetTable === "lien_waivers") {
    const partyVisible = subsidiaryScopeAllows(
      authz.allowedSubsidiaryIds,
      target.partySubsidiaryId,
      { orgWideNull: true },
    );
    const projectVisible =
      target.projectSubsidiaryId === null ||
      subsidiaryScopeAllows(authz.allowedSubsidiaryIds, target.projectSubsidiaryId);
    return partyVisible && projectVisible;
  }

  return subsidiaryScopeAllows(authz.allowedSubsidiaryIds, target.subsidiaryId);
}
