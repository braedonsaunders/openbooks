import { sql, type SQL } from "drizzle-orm";
import { db } from "../../platform/db.ts";

type Projection = (table: string, denied: ReadonlySet<string>) => Promise<SQL>;
/** `unattributed` marks a table that records no audit actor columns, so none are withheld by default. */
type Collection = {
  key: string;
  table: string;
  where: SQL;
  denied: readonly string[];
  updated?: true;
  unattributed?: true;
};

/** Gather subject records and their historical parents without exporting other workers or audit operators. */
export async function gatherWorkRecords(
  orgId: string,
  partyId: string,
  project: Projection,
): Promise<Record<string, unknown>> {
  return gatherCollections(orgId, rosterCollections(orgId, partyId), project);
}

/**
 * Shift roster records keyed on the person: recurring assignments and their
 * patterns and occurrence decisions, the person's own shift requests, swaps
 * offered to them (without the requester's reason), device identities,
 * check-ins and attendance observations with their attribution.
 */
function rosterCollections(orgId: string, partyId: string): Collection[] {
  const assignments = sql`select id from schedule_pattern_assignments where org_id=${orgId} and worker_party_id=${partyId}`;
  const events = sql`select id from schedule_attendance_events where org_id=${orgId} and worker_party_id=${partyId}`;
  const observations = sql`select id from schedule_attendance_observations where org_id=${orgId} and worker_party_id=${partyId}`;
  const claims = sql`select id from schedule_attendance_event_claims where org_id=${orgId} and event_id in (${events})`;
  const person = ["worker_party_id", "employment_id"];
  return [
    {
      key: "shiftPatternAssignments",
      table: "schedule_pattern_assignments",
      where: sql`id in (${assignments})`,
      denied: person,
      updated: true,
    },
    {
      key: "shiftPatterns",
      table: "schedule_patterns",
      where: sql`id in (select pattern_id from schedule_pattern_assignments where org_id=${orgId} and id in (${assignments}))`,
      denied: ["customer_party_id"],
      updated: true,
    },
    {
      key: "shiftPatternExceptions",
      table: "schedule_pattern_exceptions",
      where: sql`assignment_id in (${assignments})`,
      denied: ["revoked_by"],
    },
    {
      key: "shiftRequestsMade",
      table: "schedule_entry_requests",
      where: sql`worker_party_id=${partyId}`,
      denied: ["worker_party_id", "counterpart_party_id", "counterpart_responded_by", "decided_by"],
      updated: true,
    },
    {
      key: "shiftSwapsOffered",
      table: "schedule_entry_requests",
      where: sql`counterpart_party_id=${partyId}`,
      denied: [
        "worker_party_id",
        "counterpart_party_id",
        "counterpart_responded_by",
        "decided_by",
        "reason",
        "decision_reason",
      ],
      updated: true,
    },
    {
      key: "attendanceDeviceIdentities",
      table: "schedule_attendance_identities",
      where: sql`worker_party_id=${partyId}`,
      denied: person,
      updated: true,
    },
    {
      key: "attendanceCheckIns",
      table: "schedule_attendance_events",
      where: sql`id in (${events})`,
      denied: person,
    },
    {
      key: "attendanceShiftObservations",
      table: "schedule_attendance_observations",
      where: sql`id in (${observations})`,
      denied: person,
    },
    {
      key: "attendanceCheckInClaims",
      table: "schedule_attendance_event_claims",
      where: sql`id in (${claims})`,
      denied: ["released_by"],
    },
    {
      key: "attendanceObservationCheckIns",
      table: "schedule_attendance_observation_events",
      where: sql`observation_id in (${observations}) and event_claim_id in (${claims})`,
      denied: [],
    },
    // The field status the person recorded on service visits (left, arrived, completed).
    {
      key: "serviceVisitStatusHistory",
      table: "service_visit_events",
      where: sql`worker_party_id=${partyId}`,
      denied: ["worker_party_id", "actor_id"],
      unattributed: true,
    },
    // Earlier roster and attendance rows carried into Unified Scheduling for this person.
    {
      key: "rosterSourceRecords",
      table: "schedule_source_records",
      where: sql`worker_party_id=${partyId}`,
      denied: ["worker_party_id"],
    },
    // The person's own published schedule as it was delivered, whoever received it.
    {
      key: "scheduleDeliveries",
      table: "schedule_distribution_recipients",
      where: sql`worker_party_id=${partyId}`,
      denied: ["party_id", "worker_party_id"],
      unattributed: true,
    },
    // Equipment and location schedules delivered to the person: the delivery
    // and its address are theirs, the report describes other people's work.
    {
      key: "resourceScheduleDeliveries",
      table: "schedule_distribution_recipients",
      where: sql`party_id=${partyId} and worker_party_id is null`,
      denied: ["party_id", "worker_party_id", "report"],
      unattributed: true,
    },
  ];
}

/**
 * Payroll source evidence keyed on the employee: statutory holiday pay
 * obligations, adopted opening-balance employer and levy authorities, and the
 * Record of Employment history, line evidence, issued-slip sources and return
 * to work facts. Source files are referenced by id only; no file bytes export.
 */
export async function gatherPayrollEvidenceRecords(
  orgId: string,
  partyId: string,
  project: Projection,
): Promise<Record<string, unknown>> {
  const subject = sql`employee_party_id=${partyId}`;
  const person = ["employee_party_id"];
  const employment = ["employee_party_id", "employment_id"];
  const result = await gatherCollections(
    orgId,
    [
      {
        key: "holidayPayObligations",
        table: "payroll_holiday_obligations",
        where: subject,
        denied: employment,
      },
      {
        key: "openingEmployerAuthorities",
        table: "payroll_opening_employer_authorities",
        where: subject,
        denied: person,
      },
      {
        key: "openingLevySourceAuthorities",
        table: "payroll_opening_levy_source_authorities",
        where: subject,
        denied: person,
      },
      {
        key: "openingReportingAuthorities",
        table: "payroll_ca_opening_reporting_authorities",
        where: subject,
        denied: person,
      },
      {
        key: "roeHistoricalPeriods",
        table: "payroll_roe_historical_periods",
        where: subject,
        denied: employment,
        updated: true,
      },
      {
        key: "roeLineEvidence",
        table: "payroll_roe_line_evidence",
        where: subject,
        denied: employment,
        updated: true,
      },
      {
        key: "roeIssuedEventSources",
        table: "payroll_roe_issued_event_sources",
        where: subject,
        denied: person,
      },
      {
        key: "roeSubsequentServiceSources",
        table: "payroll_roe_subsequent_service_sources",
        where: subject,
        denied: employment,
        updated: true,
      },
    ],
    project,
  );
  // Occurrences are keyed by their obligation and date rather than a row id.
  result.holidayPayOccurrences = await db.execute<Record<string, unknown>>(
    sql`
    select ${await project("payroll_holiday_occurrences", new Set(["org_id", "employee_party_id"]))}
      from payroll_holiday_occurrences
     where org_id=${orgId} and employee_party_id=${partyId}
     order by holiday_date, obligation_id`,
    "objects",
  );
  return result;
}

export async function gatherTrainingRecords(
  orgId: string,
  partyId: string,
  project: Projection,
): Promise<Record<string, unknown>> {
  const employments = sql`select id from worker_employments where org_id=${orgId} and worker_party_id=${partyId}`;
  const participants = sql`select id from hrm_training_participants where org_id=${orgId} and employment_id in (${employments})`;
  const sessions = sql`select session_id from hrm_training_participants where org_id=${orgId} and id in (${participants})`;
  return gatherCollections(
    orgId,
    [
      {
        key: "trainingParticipants",
        table: "hrm_training_participants",
        where: sql`id in (${participants})`,
        denied: ["employment_id"],
        updated: true,
      },
      {
        key: "trainingSessions",
        table: "hrm_training_sessions",
        where: sql`id in (${sessions})`,
        denied: [],
        updated: true,
      },
      {
        key: "trainingCourses",
        table: "hrm_training_courses",
        where: sql`id in (
      select course_id from hrm_training_sessions where org_id=${orgId} and id in (${sessions}))`,
        denied: ["author_party_id", "decided_by"],
        updated: true,
      },
      {
        key: "trainingFeedback",
        table: "hrm_training_feedback",
        where: sql`participant_id in (${participants})`,
        denied: [],
      },
    ],
    project,
  );
}

/** Saved assignment inputs and calculation factors belong to the employee; approval actor identities do not. */
export async function gatherCompensationRecords(
  orgId: string,
  partyId: string,
  project: Projection,
): Promise<Record<string, unknown>> {
  const employments = sql`select id from worker_employments where org_id=${orgId} and worker_party_id=${partyId}`;
  const assignments = sql`select id from payroll_compensation_assignments
    where org_id=${orgId} and employee_party_id=${partyId} and employment_id in (${employments})`;
  const result = await gatherCollections(
    orgId,
    [
      {
        key: "compensationAssignments",
        table: "payroll_compensation_assignments",
        where: sql`id in (${assignments})`,
        denied: ["employment_id", "employee_party_id", "submitted_by", "decided_by", "authorship"],
        updated: true,
      },
      {
        key: "compensationCalculations",
        table: "payroll_compensation_calculations",
        where: sql`employment_id in (${employments}) and assignment_id in (${assignments})`,
        denied: ["employment_id"],
      },
    ],
    project,
  );
  const calculations = result.compensationCalculations as Record<string, unknown>[];
  result.compensationCalculations = calculations.map((row) => {
    const source = row.source_snapshot as Record<string, unknown>;
    const {
      employeePartyId: _party,
      employmentId: _employment,
      subsidiaryId: _subsidiary,
      ...subjectSource
    } = source;
    return { ...row, source_snapshot: subjectSource };
  });
  return result;
}

async function gatherCollections(
  orgId: string,
  collections: Collection[],
  project: Projection,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const collection of collections) {
    // Catalog projection retains dated evidence and exact decimals as the schema grows.
    const actors = collection.unattributed
      ? []
      : ["created_by", ...(collection.updated ? ["updated_by"] : [])];
    const columns = await project(
      collection.table,
      new Set(["org_id", ...actors, ...collection.denied]),
    );
    const rows: Record<string, unknown>[] = [];
    let lastId: string | null = null;
    for (;;) {
      const page: (Record<string, unknown> & { id: string })[] = await db.execute<
        Record<string, unknown> & { id: string }
      >(
        sql`
        select ${columns} from ${sql.identifier(collection.table)}
        where org_id=${orgId} and (${collection.where}) and (${lastId}::uuid is null or id>${lastId}::uuid)
        order by id limit 1000`,
        "objects",
      );
      rows.push(...page);
      if (page.length < 1000) break;
      lastId = page[page.length - 1]!.id;
    }
    result[collection.key] = rows;
  }
  return result;
}
