import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmRecruitingManageOrg } from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { requireActorId, requireOrgId } from "./input.ts";
import type { RequisitionCompensation } from "./requisitions.ts";

/**
 * Reusable job descriptions (0634): the organization's library of posting
 * content. Setup owns authoring (the shared registry CRUD, audited there);
 * this module owns the read contract a requisition starts from. A
 * requisition copies the content when it is created, so a later library
 * edit never rewrites an opening that already exists.
 */

export interface JobDescriptionDTO {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly employmentKind: string | null;
  readonly compensation: RequisitionCompensation | null;
  readonly description: string;
  readonly isActive: boolean;
}

type JobDescriptionRow = {
  id: string;
  name: string;
  title: string;
  employmentKind: string | null;
  compensationMin: string | null;
  compensationMax: string | null;
  compensationCurrency: string | null;
  compensationBasis: string | null;
  description: string;
  isActive: boolean;
};

const JOB_DESCRIPTION_COLUMNS = sql`
  id, name, title, employment_kind as "employmentKind",
  compensation_min::text as "compensationMin", compensation_max::text as "compensationMax",
  compensation_currency as "compensationCurrency", compensation_basis as "compensationBasis",
  description, is_active as "isActive"
`;

function toDTO(row: JobDescriptionRow): JobDescriptionDTO {
  const basis = row.compensationBasis;
  if (basis !== null && basis !== "hourly" && basis !== "annual") {
    throw new RecruitingError("REFUSED", `job description ${row.name} carries unknown pay basis ${basis} — correct it in Setup`);
  }
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    employmentKind: row.employmentKind,
    compensation:
      row.compensationMin !== null && row.compensationMax !== null && row.compensationCurrency !== null && basis !== null
        ? { min: row.compensationMin, max: row.compensationMax, currency: row.compensationCurrency, basis }
        : null,
    description: row.description,
    isActive: row.isActive,
  };
}

/**
 * The library entry a new requisition starts from, read inside the
 * caller's transaction. Refuses an entry outside the organization or one
 * that has been deactivated: retired content is kept for the openings that
 * already copied it, never offered to a new one.
 */
export async function loadJobDescriptionForRequisition(
  exec: SqlExecutor,
  orgId: string,
  jobDescriptionId: string,
): Promise<JobDescriptionDTO> {
  const row = (await exec.execute<JobDescriptionRow>(sql`
    select ${JOB_DESCRIPTION_COLUMNS} from hrm_job_descriptions
     where org_id = ${orgId} and id = ${jobDescriptionId}
  `)).rows[0];
  if (!row) {
    throw new RecruitingError("NOT_FOUND", "job description is not visible in this organization — choose one from the library");
  }
  if (!row.isActive) {
    throw new RecruitingError(
      "REFUSED",
      `job description ${row.name} is inactive — reactivate it in Setup or start the opening from an active one`,
    );
  }
  return toDTO(row);
}

/**
 * Deletion refusal for a library entry, read inside the deleting
 * transaction before the DELETE: an entry any requisition started from is
 * history-pinned, so the refusal names it and the remedy (deactivate it).
 * Null when the entry is unreferenced. The storage foreign key stays the
 * backstop for a reference created concurrently.
 */
export async function jobDescriptionDeleteRefusal(
  exec: SqlExecutor,
  orgId: string,
  jobDescriptionId: string,
): Promise<string | null> {
  const row = (await exec.execute<{ name: string; openings: number }>(sql`
    select jd.name,
           (select count(*)::int from hrm_requisitions r
             where r.org_id = jd.org_id and r.job_description_id = jd.id) as openings
      from hrm_job_descriptions jd
     where jd.org_id = ${orgId} and jd.id = ${jobDescriptionId}
  `)).rows[0];
  if (!row || row.openings === 0) return null;
  return `Job description ${row.name} was used by ${row.openings} requisition${row.openings === 1 ? "" : "s"} and is kept as their history — deactivate it instead of deleting it`;
}

/**
 * Active library entries, ordered by name, offered when opening a
 * requisition — gated on the same manage grant that opening requires.
 */
export async function listActiveJobDescriptions(query: {
  readonly orgId: string;
  readonly actorId: string;
}): Promise<readonly JobDescriptionDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    const rows = (await db.execute<JobDescriptionRow>(sql`
      select ${JOB_DESCRIPTION_COLUMNS} from hrm_job_descriptions
       where org_id = ${orgId} and is_active
       order by name, id
    `)).rows;
    return rows.map(toDTO);
  });
}
