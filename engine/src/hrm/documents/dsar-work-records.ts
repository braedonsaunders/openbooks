import { sql, type SQL } from "drizzle-orm";
import { db } from "../../platform/db.ts";

type Projection = (table: string, denied: ReadonlySet<string>) => Promise<SQL>;
type Collection = { key: string; table: string; where: SQL; denied: readonly string[]; updated?: true };

/** Gather subject records and their historical parents without exporting other workers or audit operators. */
export async function gatherWorkRecords(orgId: string, partyId: string, project: Projection): Promise<Record<string, unknown>> {
  const employments = sql`select id from worker_employments where org_id=${orgId} and worker_party_id=${partyId}`;
  const assignments = sql`select id from hrm_shift_assignments where org_id=${orgId} and employment_id in (${employments})`;
  const shifts = sql`select id from hrm_shifts where org_id=${orgId} and employment_id in (${employments})`;
  const events = sql`select id from hrm_attendance_events where org_id=${orgId} and employment_id in (${employments})`;
  const observations = sql`select id from hrm_attendance_observations where org_id=${orgId} and employment_id in (${employments})`;
  const claims = sql`select id from hrm_attendance_event_claims where org_id=${orgId} and event_id in (${events}) and shift_id in (${shifts})`;
  const person = ["employment_id", "worker_party_id"];
  const approval = ["author_party_id", "decided_by"];
  const collections: Collection[] = [
    { key: "shiftAssignments", table: "hrm_shift_assignments", where: sql`id in (${assignments})`, denied: [...person, ...approval], updated: true },
    { key: "shiftPublications", table: "hrm_shift_publications", where: sql`assignment_id in (${assignments})`, denied: [] },
    { key: "shifts", table: "hrm_shifts", where: sql`id in (${shifts})`, denied: [...person, ...approval], updated: true },
    { key: "shiftRequests", table: "hrm_shift_requests", where: sql`employment_id in (${employments})`, denied: [...person, ...approval], updated: true },
    { key: "shiftTemplates", table: "hrm_shift_templates", where: sql`id in (
      select template_id from hrm_shift_assignments where org_id=${orgId} and id in (${assignments})
      union select template_id from hrm_shifts where org_id=${orgId} and id in (${shifts}))`, denied: approval, updated: true },
    { key: "attendanceIdentities", table: "hrm_attendance_identities", where: sql`employment_id in (${employments})`, denied: person, updated: true },
    { key: "attendanceEvents", table: "hrm_attendance_events", where: sql`id in (${events})`, denied: person },
    { key: "attendanceObservations", table: "hrm_attendance_observations", where: sql`id in (${observations})`, denied: person },
    { key: "attendanceEventClaims", table: "hrm_attendance_event_claims", where: sql`id in (${claims})`, denied: ["released_by"] },
    { key: "attendanceObservationEvents", table: "hrm_attendance_observation_events", where: sql`observation_id in (${observations}) and event_claim_id in (${claims})`, denied: [] },
  ];
  return gatherCollections(orgId, collections, project);
}

export async function gatherTrainingRecords(orgId: string, partyId: string, project: Projection): Promise<Record<string, unknown>> {
  const employments = sql`select id from worker_employments where org_id=${orgId} and worker_party_id=${partyId}`;
  const participants = sql`select id from hrm_training_participants where org_id=${orgId} and employment_id in (${employments})`;
  const sessions = sql`select session_id from hrm_training_participants where org_id=${orgId} and id in (${participants})`;
  return gatherCollections(orgId, [
    { key: "trainingParticipants", table: "hrm_training_participants", where: sql`id in (${participants})`, denied: ["employment_id"], updated: true },
    { key: "trainingSessions", table: "hrm_training_sessions", where: sql`id in (${sessions})`, denied: [], updated: true },
    { key: "trainingCourses", table: "hrm_training_courses", where: sql`id in (
      select course_id from hrm_training_sessions where org_id=${orgId} and id in (${sessions}))`, denied: ["author_party_id", "decided_by"], updated: true },
    { key: "trainingFeedback", table: "hrm_training_feedback", where: sql`participant_id in (${participants})`, denied: [] },
  ], project);
}

/** Saved assignment inputs and calculation factors belong to the employee; approval actor identities do not. */
export async function gatherCompensationRecords(orgId: string, partyId: string, project: Projection): Promise<Record<string, unknown>> {
  const employments = sql`select id from worker_employments where org_id=${orgId} and worker_party_id=${partyId}`;
  const assignments = sql`select id from payroll_compensation_assignments
    where org_id=${orgId} and employee_party_id=${partyId} and employment_id in (${employments})`;
  const result = await gatherCollections(orgId, [
    { key: "compensationAssignments", table: "payroll_compensation_assignments", where: sql`id in (${assignments})`,
      denied: ["employment_id", "employee_party_id", "submitted_by", "decided_by", "authorship"], updated: true },
    { key: "compensationCalculations", table: "payroll_compensation_calculations", where: sql`employment_id in (${employments}) and assignment_id in (${assignments})`,
      denied: ["employment_id"] },
  ], project);
  const calculations = result.compensationCalculations as Record<string, unknown>[];
  result.compensationCalculations = calculations.map(row => {
    const source = row.source_snapshot as Record<string, unknown>;
    const { employeePartyId: _party, employmentId: _employment, subsidiaryId: _subsidiary, ...subjectSource } = source;
    return { ...row, source_snapshot: subjectSource };
  });
  return result;
}

async function gatherCollections(orgId: string, collections: Collection[], project: Projection): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const collection of collections) {
    // Catalog projection retains dated evidence and exact decimals as the schema grows.
    const columns = await project(collection.table, new Set(["org_id", "created_by", ...(collection.updated ? ["updated_by"] : []), ...collection.denied]));
    const rows: Record<string, unknown>[] = [];
    let lastId: string | null = null;
    for (;;) {
      const page = (await db.execute<Record<string, unknown> & { id: string }>(sql`
        select ${columns} from ${sql.identifier(collection.table)}
        where org_id=${orgId} and (${collection.where}) and (${lastId}::uuid is null or id>${lastId}::uuid)
        order by id limit 1000`)).rows;
      rows.push(...page);
      if (page.length < 1000) break;
      lastId = page[page.length - 1]!.id;
    }
    result[collection.key] = rows;
  }
  return result;
}
