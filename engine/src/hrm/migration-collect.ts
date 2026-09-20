/**
 * One-time legacy employment evidence collector.
 *
 * The executor (./migration-execute.ts) never invents employment facts: it
 * takes SourcePersonRow[] as its input contract. This module builds those
 * rows from what the product actually records today, for ONE org per run:
 *
 * - employee_roles (party_id UNIQUE, hired_on, terminated_on, is_active,
 *   department/trade/title, supervisor) joined to parties (kind, is_active,
 *   subsidiary_id — today's only employer dimension);
 * - employee_payroll_profiles (pay_schedule_id -> pay_schedules.subsidiary_id
 *   as employer corroboration, filing_account_id recorded on the profile)
 *   with the schedule subsidiary carried as the payroll scope;
 * - the observable facts anchoring a CURRENT observation: the latest
 *   committed pay stub date, the latest approved timesheet week, and the
 *   entitlement ledger's latest movement date.
 *
 * Mapping rules (the classifier in ./migration-preflight.ts owns every
 * verdict; this module only reports evidence, never resolves it):
 *
 * - One row per employee_roles row, in deterministic party-id order. A
 *   party with payroll but no role produces no row: the collection
 *   population is the role population, and the row contract documents that.
 * - The asserted employer is ALWAYS parties.subsidiary_id (null stays null
 *   and means UNKNOWN, never the org root). A schedule subsidiary that
 *   disagrees is carried as the payroll scope so the classifier refuses the
 *   conflict (schedule_employer_conflict) instead of letting either side win.
 * - The observation instant is the latest anchor civil date at UTC midnight
 *   (stored data only — never now(), so re-collection is byte-identical).
 *   Status is terminated when a termination event is recorded, else active.
 *   Activity dated AFTER the recorded termination is a genuine conflict this
 *   module cannot resolve: it is reported with status unknown and a
 *   provenance naming both facts, so no migration is anchored until an
 *   operator asserts the true current state. (Contract note: the frozen
 *   classifier has no post-termination-activity rule; the pipeline refuses
 *   such rows at the executor as missing_current_observation.)
 * - Subsidiary facts cover every legal subsidiary of the org (eliminations
 *   included, mapped to isEliminated). Historic stub employers are the
 *   distinct schedule subsidiaries behind the person's committed runs.
 * - Operator mappings (--operator-mappings) are optional overrides keyed by
 *   native party id. They attach as resolution evidence with
 *   kind operator-employer-date-mapping; the classifier judges completeness.
 *   A mapping naming a party this run did not collect is refused, never
 *   silently dropped.
 * - existingBinding is always null: the executor rebuilds idempotency
 *   bindings from stored employment_changes evidence itself, and a caller
 *   binding that diverges from stored evidence throws there.
 * - historicalCoverage is the classifier's to emit (always unknown); the
 *   collector never derives coverage from a hire date.
 *
 * The collector is read-only (SELECT only), runs inside withOrgTransaction
 * with bypass off, and returns the rows with a SHA-256 evidence hash over
 * the whole collected input so a reviewed collection can be pinned before
 * the dry-run hash interlock certifies the report.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import type {
  EmployerInventory,
  ObservationEvidence,
  PayrollInventory,
  ResolutionEvidence,
  RoleInventory,
  SourcePersonRow,
  SubsidiaryFact,
} from "./migration-preflight.ts";

/** Source namespace for legacy-extracted employment evidence. */
export const LEGACY_EMPLOYMENT_SOURCE_NAMESPACE = "legacy-extract";

/** Collector contract version: a collector change drifts every binding. */
export const COLLECTOR_SOURCE_VERSION = "collect-v1";

const EVIDENCE_HASH_VERSION = "openbooks/hrm-migration-collect/evidence/v1";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A computed refusal that must reach the caller. */
export class EmploymentCollectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmploymentCollectionError";
  }
}

/**
 * The dangling-schedule refusal, decided on the join itself. pay_schedule_id
 * is NOT NULL, so a profile whose schedule the org-scoped read cannot
 * observe (a cross-org or otherwise missing reference) is corrupt and is
 * refused with its remedy. The schedule's OWN subsidiary is a payload column
 * that is legitimately null for an org-wide schedule — it was never a join
 * sentinel, and treating it as one refused every org whose schedules are
 * org-wide and sent the operator to reconcile healthy data.
 */
export function assertScheduleObservable(
  profile: Pick<ProfileRecord, "id" | "pay_schedule_id" | "schedule_missing">,
): void {
  if (!profile.schedule_missing) return;
  throw new EmploymentCollectionError(
    `payroll profile ${profile.id} names pay schedule ${profile.pay_schedule_id} ` +
      "which no read can observe; refusing to collect a dangling payroll " +
      "reference — reconcile employee_payroll_profiles before re-running",
  );
}

/** One operator employer/date override, keyed by native party id. */
export interface OperatorEmploymentMapping {
  readonly partyId: string;
  readonly employerSubsidiaryId: string | null;
  readonly hiredOn: string | null;
  readonly terminatedOn: string | null;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly rationale: string;
}

export interface CollectLegacyEmploymentsOptions {
  readonly operatorMappings?: readonly OperatorEmploymentMapping[];
}

export interface CollectedLegacyEmployments {
  readonly orgId: string;
  readonly rows: readonly SourcePersonRow[];
  /** SHA-256 over the whole collected input (canonical encoding, below). */
  readonly evidenceHash: string;
}

/** Stable canonical encoding (mirrors the preflight fingerprint helper). */
function canonicalEncode(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalEncode).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalEncode(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Pin a reviewed collection: SHA-256 over the versioned canonical encoding
 * of the whole row array. Row order is party-id order, so the hash is
 * stable across runs over unchanged evidence.
 */
export function hashCollectedInput(rows: readonly SourcePersonRow[]): string {
  return createHash("sha256")
    .update(`${EVIDENCE_HASH_VERSION}\n${canonicalEncode(rows)}`, "utf8")
    .digest("hex");
}

interface RoleRecord {
  id: string;
  party_id: string;
  hired_on: string | null;
  terminated_on: string | null;
  is_active: boolean;
}

interface PartyRecord {
  id: string;
  kind: string;
  is_active: boolean;
  subsidiary_id: string | null;
}

interface ProfileRecord {
  id: string;
  employee_party_id: string;
  pay_schedule_id: string;
  labour_jurisdiction: string | null;
  is_active: boolean;
  /** The schedule's own subsidiary scope; null is a legitimate org-wide schedule. */
  schedule_subsidiary_id: string | null;
  /** True only when the LEFT JOIN found no schedule row: the reference is dangling. */
  schedule_missing: boolean;
}

interface SubsidiaryRecord {
  id: string;
  is_active: boolean;
  is_elimination: boolean;
}

interface AnchorRecord {
  employee_party_id: string;
  anchor_date: string;
  anchor_id: string;
  schedule_subsidiary_id: string | null;
}

interface WeekRecord {
  employee_party_id: string;
  anchor_date: string;
  anchor_id: string;
}

function assertUuid(value: string, what: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new EmploymentCollectionError(
      `${what} ${JSON.stringify(value)} is not a valid UUID; refusing to collect ` +
        "without an explicit tenant scope",
    );
  }
}

async function selectAll<T>(
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

/**
 * Collect one org's legacy employment evidence. Read-only: every statement
 * is a SELECT inside the org's own transaction (bypass off). Throws
 * EmploymentCollectionError for corrupt references or unknown mapping
 * targets; every throw names the remedy.
 */
export async function collectLegacyEmployments(
  orgId: string,
  options: CollectLegacyEmploymentsOptions = {},
): Promise<CollectedLegacyEmployments> {
  assertUuid(orgId, "org");
  const mappings = options.operatorMappings ?? [];
  for (const mapping of mappings) {
    assertUuid(mapping.partyId, "operator mapping party");
  }

  return withOrgTransaction(orgId, async () => {
    const roles = await selectAll<RoleRecord>(sql`
      select r.id::text as id, r.party_id::text as party_id,
             r.hired_on::text as hired_on, r.terminated_on::text as terminated_on,
             r.is_active as is_active
        from employee_roles r
       where r.org_id = ${orgId}
       order by r.party_id`);
    if (roles.length === 0) {
      const empty: readonly SourcePersonRow[] = [];
      return { orgId, rows: empty, evidenceHash: hashCollectedInput(empty) };
    }
    const partyIds = roles.map((role) => role.party_id);
    const partyList = sql.join(
      partyIds.map((partyId) => sql`${partyId}::uuid`),
      sql`, `,
    );

    const partyRows = await selectAll<PartyRecord>(sql`
      select p.id::text as id, p.kind as kind, p.is_active as is_active,
             p.subsidiary_id::text as subsidiary_id
        from parties p
       where p.org_id = ${orgId} and p.id in (${partyList})`);
    const parties = new Map(partyRows.map((party) => [party.id, party]));

    const profileRows = await selectAll<ProfileRecord>(sql`
      select p.id::text as id, p.employee_party_id::text as employee_party_id,
             p.pay_schedule_id::text as pay_schedule_id,
             p.labour_jurisdiction as labour_jurisdiction,
             p.is_active as is_active,
             s.subsidiary_id::text as schedule_subsidiary_id,
             (s.id is null) as schedule_missing
        from employee_payroll_profiles p
        left join pay_schedules s
          on s.org_id = p.org_id and s.id = p.pay_schedule_id
       where p.org_id = ${orgId} and p.employee_party_id in (${partyList})`);
    const profiles = new Map(profileRows.map((profile) => [profile.employee_party_id, profile]));

    const subsidiaryRows = await selectAll<SubsidiaryRecord>(sql`
      select s.id::text as id, s.is_active as is_active,
             s.is_elimination as is_elimination
        from subsidiaries s
       where s.org_id = ${orgId}
       order by s.id`);
    const subsidiaryFacts: readonly SubsidiaryFact[] = subsidiaryRows.map((row) => ({
      id: row.id,
      orgId,
      isActive: row.is_active,
      isEliminated: row.is_elimination,
    }));

    const stubRows = await selectAll<AnchorRecord>(sql`
      select s.employee_party_id::text as employee_party_id,
             s.pay_date::text as anchor_date, s.id::text as anchor_id,
             sc.subsidiary_id::text as schedule_subsidiary_id
        from pay_stubs s
        join pay_runs r
          on r.document_id = s.pay_run_document_id
        join pay_schedules sc
          on sc.org_id = s.org_id and sc.id = r.pay_schedule_id
       where s.org_id = ${orgId}
         and r.run_status = 'committed'
         and s.employee_party_id in (${partyList})`);
    const weekRows = await selectAll<WeekRecord>(sql`
      select w.employee_party_id::text as employee_party_id,
             w.week_start::text as anchor_date, w.id::text as anchor_id
        from timesheet_weeks w
       where w.org_id = ${orgId}
         and w.status = 'approved'
         and w.employee_party_id in (${partyList})`);
    const ledgerRows = await selectAll<WeekRecord>(sql`
      select e.employee_party_id::text as employee_party_id,
             e.movement_date::text as anchor_date, e.id::text as anchor_id
        from entitlement_ledger e
       where e.org_id = ${orgId}
         and e.employee_party_id in (${partyList})`);

    const stubsByParty = groupAnchors(stubRows);
    const weeksByParty = groupAnchors(weekRows);
    const ledgerByParty = groupAnchors(ledgerRows);
    const mappingByParty = new Map(mappings.map((mapping) => [mapping.partyId, mapping]));

    const rows: SourcePersonRow[] = roles.map((role) => {
      const party = parties.get(role.party_id);
      if (party === undefined) {
        throw new EmploymentCollectionError(
          `employee role ${role.id} names party ${role.party_id} which no read can ` +
            "observe; refusing to collect employment evidence onto a missing party — " +
            "reconcile employee_roles before re-running",
        );
      }
      const profile = profiles.get(role.party_id) ?? null;
      if (profile !== null) assertScheduleObservable(profile);
      const mapping = mappingByParty.get(role.party_id) ?? null;
      return buildRow({
        orgId,
        role,
        party,
        profile,
        subsidiaryFacts,
        stubs: stubsByParty.get(role.party_id) ?? [],
        weeks: weeksByParty.get(role.party_id) ?? [],
        ledger: ledgerByParty.get(role.party_id) ?? [],
        mapping,
      });
    });

    for (const mapping of mappings) {
      if (!partyIds.includes(mapping.partyId)) {
        throw new EmploymentCollectionError(
          `operator mapping names party ${mapping.partyId} which this run did not ` +
            "collect (no employee role in this org); refusing to drop an operator " +
            "override silently — scope the mapping to a collected party",
        );
      }
    }
    return { orgId, rows, evidenceHash: hashCollectedInput(rows) };
  });
}

interface Anchor {
  readonly date: string;
  readonly id: string;
  readonly scheduleSubsidiaryId: string | null;
}

function groupAnchors(rows: readonly (AnchorRecord | WeekRecord)[]): Map<string, Anchor[]> {
  const grouped = new Map<string, Anchor[]>();
  for (const row of rows) {
    const anchor: Anchor = {
      date: row.anchor_date,
      id: row.anchor_id,
      scheduleSubsidiaryId: "schedule_subsidiary_id" in row ? row.schedule_subsidiary_id : null,
    };
    const existing = grouped.get(row.employee_party_id);
    if (existing === undefined) grouped.set(row.employee_party_id, [anchor]);
    else existing.push(anchor);
  }
  return grouped;
}

interface AnchorSource {
  readonly source: "pay_stubs" | "timesheet_weeks" | "entitlement_ledger";
  readonly anchors: readonly Anchor[];
}

function latestAnchorDate(anchors: readonly Anchor[]): string | null {
  let latest: string | null = null;
  for (const anchor of anchors) {
    if (latest === null || anchor.date > latest) latest = anchor.date;
  }
  return latest;
}

interface BuildRowInput {
  readonly orgId: string;
  readonly role: RoleRecord;
  readonly party: PartyRecord;
  readonly profile: ProfileRecord | null;
  readonly subsidiaryFacts: readonly SubsidiaryFact[];
  readonly stubs: readonly Anchor[];
  readonly weeks: readonly Anchor[];
  readonly ledger: readonly Anchor[];
  readonly mapping: OperatorEmploymentMapping | null;
}

function buildRow(input: BuildRowInput): SourcePersonRow {
  const { orgId, role, party, profile } = input;
  const roleInventory: RoleInventory = {
    present: true,
    isActive: role.is_active,
    hiredOn: role.hired_on,
    terminatedOn: role.terminated_on,
    // Provenance names the exact source column behind the carried date.
    dateProvenance:
      role.hired_on !== null
        ? "employee_roles.hired_on"
        : role.terminated_on !== null
          ? "employee_roles.terminated_on"
          : null,
    // No role-level jurisdiction is stored; never derived.
    countryContext: null,
    evidenceIds: [`employee_roles:${role.id}`],
  };

  let payroll: PayrollInventory | null = null;
  if (profile !== null) {
    payroll = {
      present: true,
      isActive: profile.is_active,
      // The schedule subsidiary is corroboration, never the assertion: when
      // it disagrees with the party subsidiary the classifier refuses.
      subsidiaryId: profile.schedule_subsidiary_id,
      // Opaque stored value, equality only; never branched on here.
      countryContext: profile.labour_jurisdiction,
      evidenceIds: [
        `employee_payroll_profiles:${profile.id}`,
        `pay_schedules:${profile.pay_schedule_id}`,
      ],
    };
  }

  const sources: readonly AnchorSource[] = [
    { source: "pay_stubs", anchors: input.stubs },
    { source: "timesheet_weeks", anchors: input.weeks },
    { source: "entitlement_ledger", anchors: input.ledger },
  ];
  const latestPerSource = sources.map((entry) => ({
    source: entry.source,
    latest: latestAnchorDate(entry.anchors),
  }));
  let anchorDate: string | null = null;
  for (const entry of latestPerSource) {
    if (entry.latest !== null && (anchorDate === null || entry.latest > anchorDate)) {
      anchorDate = entry.latest;
    }
  }

  let observation: ObservationEvidence | null = null;
  if (anchorDate !== null) {
    const winning = latestPerSource
      .filter((entry) => entry.latest === anchorDate)
      .map((entry) => entry.source)
      .sort();
    const handles = (source: string): string => {
      const entry = sources.find((candidate) => candidate.source === source)!;
      return entry.anchors
        .filter((anchor) => anchor.date === anchorDate)
        .map((anchor) => `${source}:${anchor.id}@${anchor.date}`)
        .sort()
        .join("+");
    };
    const anchorProvenance = winning.map(handles).join("+");
    const termination = role.terminated_on;
    if (termination !== null && anchorDate > termination) {
      // Activity after the recorded termination: neither fact yields, so no
      // current status is asserted. The provenance carries the conflict and
      // the pipeline refuses until an operator asserts the true state.
      observation = {
        status: "unknown",
        observedAt: `${anchorDate}T00:00:00Z`,
        provenance:
          `conflicting-employment-evidence terminated_on:${role.terminated_on} ` +
          `vs ${anchorProvenance}`,
      };
    } else {
      observation = {
        status: termination !== null ? "terminated" : "active",
        observedAt: `${anchorDate}T00:00:00Z`,
        provenance: anchorProvenance,
      };
    }
  }

  const historicSubsidiaryIds = [
    ...new Set(
      input.stubs
        .map((anchor) => anchor.scheduleSubsidiaryId)
        .filter((id): id is string => id !== null),
    ),
  ].sort();

  const partyEvidenceIds = [`parties:${party.id}`];
  if (party.subsidiary_id !== null) {
    partyEvidenceIds.push(`subsidiaries:${party.subsidiary_id}`);
  }
  for (const historic of historicSubsidiaryIds) {
    if (historic !== party.subsidiary_id) partyEvidenceIds.push(`subsidiaries:${historic}`);
  }

  const employer: EmployerInventory = {
    // Today's only employer dimension. Null stays null (UNKNOWN, never root).
    assertedSubsidiaryId: party.subsidiary_id,
    subsidiaryFacts: input.subsidiaryFacts,
    historicSubsidiaryIds,
  };

  let resolution: ResolutionEvidence | null = null;
  if (input.mapping !== null) {
    resolution = {
      kind: "operator-employer-date-mapping",
      employerSubsidiaryId: input.mapping.employerSubsidiaryId,
      hiredOn: input.mapping.hiredOn,
      terminatedOn: input.mapping.terminatedOn,
      approvedBy: input.mapping.approvedBy,
      approvedAt: input.mapping.approvedAt,
      rationale: input.mapping.rationale,
    };
  }

  return {
    orgId,
    sourceNamespace: LEGACY_EMPLOYMENT_SOURCE_NAMESPACE,
    sourceId: role.id,
    nativePartyId: party.id,
    sourceVersion: COLLECTOR_SOURCE_VERSION,
    party: {
      kind: party.kind,
      isActive: party.is_active,
      subsidiaryId: party.subsidiary_id,
      // The live database carries no source-funnel draft marker: no
      // collected row claims draft status, and the draft-suspect path stays
      // closed for collector output rather than guessed open.
      sourceIsNew: false,
      evidenceIds: partyEvidenceIds,
    },
    employer,
    role: roleInventory,
    payroll,
    observation,
    resolution,
    // The executor rebuilds bindings from stored employment_changes evidence;
    // a caller binding that diverges from stored evidence throws there.
    existingBinding: null,
  };
}
