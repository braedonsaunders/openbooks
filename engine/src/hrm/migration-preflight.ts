/**
 * One-time canonical employment migration preflight — pure deterministic classifier.
 *
 * Scope: classifies collector-supplied source inventory for ONE-TIME migration
 * into canonical worker_employments. It performs no DML, no compatibility
 * fallback, and no database, pool, or environment access: the only imports
 * are the pure civil-date helpers from ./temporal.ts plus node:crypto (pure
 * builtin SHA-256, no IO) for the source fingerprint. The collector that fetches
 * source rows belongs to a later slice; fixtures in tests are synthetic and
 * claim no real tenant counts. No salary, SIN, address, or other PII field
 * exists anywhere in this contract — only evidence identifiers.
 *
 * Identity: a candidate is keyed by (orgId, sourceNamespace, sourceId).
 * Duplicate keys are all retained and all refused as ambiguous, never
 * silently discarded; rows sort by (orgId, sourceNamespace, sourceId) with
 * the source fingerprint plus a full-row identity hash as the deterministic
 * tie-break, so the report JSON is invariant under input order even when two
 * variants differ only in operator evidence the fingerprint excludes.
 *
 * Idempotency: already_migrated requires a binding whose canonical
 * org/worker/employer plus source fingerprint and version are provable from
 * the input row itself. Same sourceId plus an employment id is NOT proof.
 * The fingerprint is SHA-256 (node:crypto, pure builtin, no IO) over a
 * versioned canonical encoding — no handrolled hash guards preserved
 * migration identity. Every check still runs under a consistent binding (no
 * short-circuit), and any changed source (fingerprint or version drift) is a
 * binding_conflict refusal. The worker_employments table is never consulted.
 * A duplicate key outranks even a consistent binding: the binding may attach
 * to the wrong variant, so both variants refuse as ambiguous. A conflicting
 * binding never authorizes erasing or re-migrating: the prior binding is
 * preserved and the remedy requires reconciled controlled-correction
 * evidence.
 *
 * Employment proof: parties.kind and bare active flags prove nothing — an
 * inactive role flag may be data maintenance, not a termination, so it never
 * demands a fabricated terminated_on. A missing subsidiary is UNKNOWN, never
 * the org root. Inactive, eliminated, or cross-org employers are invalid;
 * subsidiary facts that contradict each other on one id refuse as ambiguous
 * instead of letting array order pick the verdict. An inactive newly-sourced
 * party with a role but no payroll is only a draft SUSPECT (requires_review),
 * never proof to delete or exclude. Role-less payroll is an evidence case
 * that stays in the report, never silently skipped. Historic stub employers
 * may be real transfers: unmapped stubs need review, they never invalidate a
 * valid current employer. Actual service dates stay distinct from the
 * observation-start anchor: nothing backfills hired_on.
 *
 * Source hired_on/terminated_on are civil EVENT dates, not half-open
 * interval endpoints: only terminated before hired is a contradiction, and a
 * same-day hire plus termination is valid. No boundary semantics are
 * inherited here; the future canonical writer owns the interval mapping and
 * must require explicit source boundary semantics first. Conflicting dated
 * evidence (source versus operator mapping) refuses as ambiguous rather than
 * silently preferring one side.
 *
 * Observation uses the canonical current-state vocabulary
 * offered|active|on_leave|suspended|terminated|unknown with an asserted
 * instant and provenance. A valid current observation with a known employer
 * may be ready for observation-date migration with historicalCoverage
 * "unknown" plus a nonblocking note — an invented hire date is never
 * demanded. The candidate current-state mapping is emitted only when no
 * blocking issue exists. An empty inventory reports "empty_not_evaluated",
 * never a clean migration claim.
 *
 * historicalCoverage stays "unknown": a known service start does not
 * establish status or assignment history, and no input evidences that
 * coverage. The precise known service start and its provenance are reported
 * separately and never conflate the two.
 *
 * Operator mapping evidence (resolution) is validated for shape and
 * consistency only. approvedBy/approvedAt/rationale are untrusted input to
 * this pure function: presence and format are checked, authority is NOT
 * authenticated here. Remedies name the missing evidence precisely; the
 * manual resolution workflow does not exist yet, so no remedy points at any
 * screen.
 *
 * Primary-code priority (deterministic; every issue is still retained):
 * binding_conflict > already_migrated > unknown_employer > invalid_employer
 * > ambiguous > insufficient_employment_evidence > requires_review > ready.
 */

import { createHash } from "node:crypto";
import { compareCivilDates, isCivilDate } from "./temporal.ts";

export const PREFLIGHT_CODES = [
  "ready",
  "unknown_employer",
  "invalid_employer",
  "ambiguous",
  "insufficient_employment_evidence",
  "requires_review",
  "already_migrated",
  "binding_conflict",
] as const;

export type PreflightCode = (typeof PREFLIGHT_CODES)[number];

/** Canonical current-state vocabulary. No employed=>active guessing. */
export type CanonicalEmploymentStatus =
  | "offered"
  | "active"
  | "on_leave"
  | "suspended"
  | "terminated"
  | "unknown";


export interface SubsidiaryFact {
  readonly id: string;
  readonly orgId: string;
  readonly isActive: boolean;
  readonly isEliminated: boolean;
}

export interface PartyInventory {
  /** parties.kind — identity only, never employment proof. */
  readonly kind: string;
  readonly isActive: boolean;
  /** Primary subsidiary; null is allowed here and means nothing about employment. */
  readonly subsidiaryId: string | null;
  /** Source funnel marker: newly-created / never-processed draft record. */
  readonly sourceIsNew: boolean;
  readonly evidenceIds: readonly string[];
}

export interface EmployerInventory {
  /** Collector-asserted current employer; null means UNKNOWN, never org root. */
  readonly assertedSubsidiaryId: string | null;
  readonly subsidiaryFacts: readonly SubsidiaryFact[];
  /** Historic stub employer ids (e.g. transfer trail), may be real history. */
  readonly historicSubsidiaryIds: readonly string[];
}

export interface RoleInventory {
  readonly present: boolean;
  /** Current flag only; null means unstated. Never employment proof alone. */
  readonly isActive: boolean | null;
  /** Actual known service dates (date-only text) with provenance, or null. */
  readonly hiredOn: string | null;
  readonly terminatedOn: string | null;
  readonly dateProvenance: string | null;
  /** Non-PII employment context (e.g. labour jurisdiction code as stored). */
  readonly countryContext: string | null;
  readonly evidenceIds: readonly string[];
}

export interface PayrollInventory {
  readonly present: boolean;
  readonly isActive: boolean | null;
  /** Scoped employer the profile/schedule row belongs to; enables conflict detection. */
  readonly subsidiaryId: string | null;
  /** Non-PII payroll country context as stored (opaque string, equality only). */
  readonly countryContext: string | null;
  readonly evidenceIds: readonly string[];
}

export interface ObservationEvidence {
  readonly status: CanonicalEmploymentStatus;
  /** Asserted current-state instant; the observation anchor, never a hire date. */
  readonly observedAt: string | null;
  readonly provenance: string;
}

export interface ResolutionEvidence {
  readonly kind: "operator-employer-date-mapping";
  readonly employerSubsidiaryId: string | null;
  readonly hiredOn: string | null;
  readonly terminatedOn: string | null;
  /** Untrusted operator metadata: checked for presence/shape, never authenticated. */
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly rationale: string;
}

export interface MigrationBinding {
  readonly canonicalOrgId: string;
  readonly canonicalWorkerPartyId: string;
  readonly canonicalEmployerSubsidiaryId: string;
  readonly canonicalEmploymentId: string;
  readonly sourceFingerprint: string;
  readonly sourceVersion: string;
  readonly boundAt: string;
  readonly provenance: string;
}

export interface SourcePersonRow {
  readonly orgId: string;
  readonly sourceNamespace: string;
  readonly sourceId: string;
  /** Native parties.id the candidate maps to. */
  readonly nativePartyId: string;
  readonly sourceVersion: string;
  readonly party: PartyInventory;
  readonly employer: EmployerInventory;
  readonly role: RoleInventory | null;
  readonly payroll: PayrollInventory | null;
  readonly observation: ObservationEvidence | null;
  readonly resolution: ResolutionEvidence | null;
  readonly existingBinding: MigrationBinding | null;
}

export interface PreflightIssue {
  /** Fine-grained named code; level is the count-bearing primary-code bucket. */
  readonly code: string;
  readonly level: Exclude<PreflightCode, "ready">;
  readonly detail: string;
  readonly remedy: string;
}

export interface PreflightNote {
  readonly code: string;
  readonly detail: string;
}

export interface CandidateMapping {
  readonly employerSubsidiaryId: string;
  readonly status: CanonicalEmploymentStatus;
  /** Observation-date anchor (civil date part of observedAt). */
  readonly effectiveFrom: string;
  readonly serviceStart: string | null;
  readonly serviceStartProvenance: string | null;
}

export interface PersonPreflight {
  readonly orgId: string;
  readonly sourceNamespace: string;
  readonly sourceId: string;
  readonly nativePartyId: string;
  readonly classification: PreflightCode;
  /**
   * Stays "unknown": no input evidences full status/assignment history.
   * Kept for the future coverage-evidence slice; never derived from hired_on.
   */
  readonly historicalCoverage: "known" | "unknown";
  /** Precise known service start and its provenance, or null when unknown. */
  readonly serviceStart: string | null;
  readonly serviceStartProvenance: string | null;
  readonly issues: readonly PreflightIssue[];
  readonly notes: readonly PreflightNote[];
  /** Present only when an employer-valid current-state mapping resolves. */
  readonly candidate: CandidateMapping | null;
  readonly provenance: readonly string[];
}

export interface PreflightReport {
  /** "empty_not_evaluated" for an empty inventory — never a clean claim. */
  readonly status: "evaluated" | "empty_not_evaluated";
  readonly rows: readonly PersonPreflight[];
  readonly counts: Record<PreflightCode, number>;
}

/**
 * Evidence presence: whitespace-only counts as missing. Callers keep the
 * exact input text (identity keys, fingerprints, and sort order all use raw
 * values, never trimmed copies) and refuse blank evidence with a precise
 * remedy instead of coercing it.
 */
function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Empty string is missing, matching collector normalization. */
function normalizedId(value: string | null): string | null {
  if (value === null) return null;
  return value.length === 0 ? null : value;
}

const RECORDED_STAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * Strict UTC instant check mirroring the temporal.ts recorded-stamp
 * contract (full-string match, real calendar day, no leap second).
 * temporal.ts keeps its parser private, so the boundary is re-expressed
 * here over the public isCivilDate helper instead of imported.
 */
function isRecordedInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RECORDED_STAMP_PATTERN.exec(value);
  if (match === null || match[0] !== value) return false;
  const datePart = `${match[1]}-${match[2]}-${match[3]}`;
  if (!isCivilDate(datePart)) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  return hour <= 23 && minute <= 59 && second <= 59;
}

/**
 * Stable source fingerprint over the source-system inventory. Exported so the
 * future binding writer (collector side) can pin the exact fingerprint a
 * binding was made from; the classifier recomputes it to prove consistency.
 * Operator evidence (observation, resolution) is excluded: later assertions
 * must not read as source drift. Evidence handles are excluded likewise.
 */
const FINGERPRINT_VERSION = "openbooks/hrm-migration-preflight/source-fingerprint/v1";
const ROW_IDENTITY_VERSION = "openbooks/hrm-migration-preflight/row-identity/v1";

/** Stable canonical encoding: object keys sorted recursively, arrays ordered. */
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

function sha256Hex(version: string, encoded: string): string {
  return createHash("sha256").update(`${version}\n${encoded}`, "utf8").digest("hex");
}

export function fingerprintSourceRow(row: SourcePersonRow): string {
  const role = row.role !== null && row.role.present
    ? {
      isActive: row.role.isActive,
      hiredOn: row.role.hiredOn,
      terminatedOn: row.role.terminatedOn,
      dateProvenance: row.role.dateProvenance,
      countryContext: row.role.countryContext,
    }
    : null;
  const payroll = row.payroll !== null && row.payroll.present
    ? {
      isActive: row.payroll.isActive,
      subsidiaryId: row.payroll.subsidiaryId,
      countryContext: row.payroll.countryContext,
    }
    : null;
  return sha256Hex(
    FINGERPRINT_VERSION,
    canonicalEncode({
      sourceVersion: row.sourceVersion,
      party: {
        kind: row.party.kind,
        isActive: row.party.isActive,
        subsidiaryId: row.party.subsidiaryId,
        sourceIsNew: row.party.sourceIsNew,
      },
      employer: {
        asserted: row.employer.assertedSubsidiaryId,
        historic: [...row.employer.historicSubsidiaryIds].sort(),
      },
      role,
      payroll,
    }),
  );
}

/**
 * Full-row identity hash for the sort tie-break. Covers the entire row —
 * including operator evidence the source fingerprint deliberately excludes —
 * so duplicate variants that differ only outside the fingerprint still sort
 * deterministically. Never used as migration identity.
 */
function rowIdentityHash(row: SourcePersonRow): string {
  return sha256Hex(ROW_IDENTITY_VERSION, canonicalEncode(row));
}

function duplicateKey(row: SourcePersonRow): string {
  return `${row.orgId}\0${row.sourceNamespace}\0${row.sourceId}`;
}

interface RowContext {
  issues: PreflightIssue[];
  notes: PreflightNote[];
  provenance: string[];
}

function addProvenance(ctx: RowContext, values: readonly (string | null)[]): void {
  for (const value of values) {
    if (isNonBlank(value) && !ctx.provenance.includes(value)) ctx.provenance.push(value);
  }
}

function checkBinding(
  row: SourcePersonRow,
  fingerprint: string,
  effectiveEmployer: string | null,
  ctx: RowContext,
): boolean {
  const binding = row.existingBinding;
  if (binding === null) return false;
  const mismatches: string[] = [];
  if (binding.canonicalOrgId !== row.orgId) mismatches.push("canonical org differs from row org");
  if (binding.canonicalWorkerPartyId !== row.nativePartyId) {
    mismatches.push("canonical worker differs from row native party");
  }
  if (binding.canonicalEmployerSubsidiaryId !== effectiveEmployer) {
    mismatches.push("canonical employer differs from the row effective employer");
  }
  if (!isNonBlank(binding.canonicalEmploymentId)) mismatches.push("canonical employment id is missing");
  if (binding.sourceVersion !== row.sourceVersion) {
    mismatches.push(`source version drifted (bound ${binding.sourceVersion}, row ${row.sourceVersion})`);
  }
  if (!isNonBlank(binding.sourceVersion) || !isNonBlank(row.sourceVersion)) {
    mismatches.push("source version is missing or blank and cannot prove consistency");
  }
  if (binding.sourceFingerprint !== fingerprint) {
    mismatches.push("source fingerprint differs: the source changed since binding");
  }
  if (!isRecordedInstant(binding.boundAt)) mismatches.push("boundAt is not a valid UTC instant");
  if (!isNonBlank(binding.provenance)) mismatches.push("binding provenance is missing");
  if (mismatches.length > 0) {
    ctx.issues.push({
      code: "binding_conflict",
      level: "binding_conflict",
      detail: `idempotency binding conflicts and refuses: ${mismatches.join("; ")}.`,
      remedy:
        "Preserve the prior binding: never erase it and never re-migrate into a duplicate " +
        "employment. Supply reconciled controlled-correction evidence (corrected canonical org, " +
        "worker party, employer, source version, and fingerprint with operator approval) that " +
        "supersedes the binding through the migration correction path; the worker_employments " +
        "table is never consulted as proof.",
    });
    return false;
  }
  return true;
}

function checkEmployer(
  row: SourcePersonRow,
  effectiveEmployer: string | null,
  resolutionEmployer: string | null,
  assertedEmployer: string | null,
  ctx: RowContext,
): void {
  if (resolutionEmployer !== null && assertedEmployer !== null && resolutionEmployer !== assertedEmployer) {
    ctx.issues.push({
      code: "conflicting_employer_mapping",
      level: "ambiguous",
      detail:
        `operator mapping names employer ${resolutionEmployer} but the source asserts ` +
        `${assertedEmployer}; refusing to guess which current employer is real.`,
      remedy:
        "Supply collector evidence for the single true current employer subsidiary, or a corrected " +
        "operator employer/date mapping that agrees with the source assertion.",
    });
  }
  if (effectiveEmployer === null) {
    ctx.issues.push({
      code: "unknown_employer",
      level: "unknown_employer",
      detail:
        "no current employer is asserted and no operator mapping supplies one: the employer is " +
        "UNKNOWN, never the org root.",
      remedy:
        "Supply collector evidence for the current employer subsidiary id, or an operator " +
        "employer/date mapping naming it with approver, instant, and rationale.",
    });
    return;
  }
  const matching = row.employer.subsidiaryFacts.filter((candidate) => candidate.id === effectiveEmployer);
  const distinct = new Set(matching.map((candidate) =>
    `${candidate.orgId}\0${candidate.isActive}\0${candidate.isEliminated}`,
  ));
  if (distinct.size > 1) {
    ctx.issues.push({
      code: "conflicting_subsidiary_evidence",
      level: "ambiguous",
      detail:
        `subsidiary facts contradict each other on id ${effectiveEmployer}: refusing to let ` +
        `fact order decide whether the employer is valid.`,
      remedy:
        "Supply collector evidence with one coherent legal subsidiary fact per id and org " +
        "(active, eliminated, and owning org agreed), so the employer verdict is order-invariant.",
    });
    return;
  }
  const fact = matching[0] ?? null;
  if (fact === null) {
    if (distinct.size === 0) {
      ctx.issues.push({
        code: "employer_unknown_reference",
        level: "invalid_employer",
        detail: `employer ${effectiveEmployer} matches no known legal subsidiary fact for this inventory.`,
        remedy:
          "Supply collector evidence with the legal subsidiary facts for the org, including the " +
          "asserted employer, or correct the asserted employer reference.",
      });
    }
  } else if (fact.orgId !== row.orgId) {
    ctx.issues.push({
      code: "employer_cross_org",
      level: "invalid_employer",
      detail: `employer ${effectiveEmployer} belongs to org ${fact.orgId}, not row org ${row.orgId}.`,
      remedy:
        "Supply collector evidence scoping the employer subsidiary to the row org, or move the " +
        "candidate to the owning org inventory; cross-org employment is never migrated.",
    });
  } else if (fact.isEliminated) {
    ctx.issues.push({
      code: "employer_eliminated",
      level: "invalid_employer",
      detail: `employer ${effectiveEmployer} is an eliminated legal subsidiary.`,
      remedy:
        "Supply collector evidence for the surviving current employer subsidiary, or an operator " +
        "employer/date mapping recording the transfer.",
    });
  } else if (!fact.isActive) {
    ctx.issues.push({
      code: "employer_inactive",
      level: "invalid_employer",
      detail: `employer ${effectiveEmployer} is an inactive legal subsidiary.`,
      remedy:
        "Supply collector evidence that the subsidiary is active for employment, or an operator " +
        "employer/date mapping naming the active current employer.",
    });
  }
  const partySubsidiary = normalizedId(row.party.subsidiaryId);
  if (partySubsidiary !== null && partySubsidiary !== effectiveEmployer) {
    ctx.issues.push({
      code: "party_employer_mismatch",
      level: "ambiguous",
      detail:
        `party primary subsidiary ${partySubsidiary} disagrees with effective employer ` +
        `${effectiveEmployer}; refusing to guess which one employs this person.`,
      remedy:
        "Supply collector evidence reconciling the party primary subsidiary against the asserted " +
        "employer (transfer trail or corrected reference).",
    });
  }
  for (const historic of row.employer.historicSubsidiaryIds) {
    if (historic === effectiveEmployer) continue;
    const known = row.employer.subsidiaryFacts.some(
      (candidate) => candidate.id === historic && candidate.orgId === row.orgId,
    );
    if (known) {
      ctx.notes.push({
        code: "historic_employer_transfer",
        detail:
          `historic stub employer ${historic} maps to a known org subsidiary and differs from the ` +
          `current employer: read as a possible real transfer, not a contradiction.`,
      });
    } else {
      ctx.issues.push({
        code: "unresolved_historic_employer",
        level: "requires_review",
        detail:
          `historic stub employer ${historic} matches no known org subsidiary fact; the current ` +
          `employer record stands, but the history cannot be mapped.`,
        remedy:
          "Supply collector evidence mapping the historic stub subsidiary (transfer record or legal " +
          "entity fact) so the employment history migrates complete.",
      });
    }
  }
}

function checkObservation(row: SourcePersonRow, ctx: RowContext): boolean {
  const observation = row.observation;
  if (observation === null) return false;
  if (
    observation.status !== "offered" &&
    observation.status !== "active" &&
    observation.status !== "on_leave" &&
    observation.status !== "suspended" &&
    observation.status !== "terminated" &&
    observation.status !== "unknown"
  ) {
    ctx.issues.push({
      code: "invalid_observation_status",
      level: "ambiguous",
      detail: `observation status ${JSON.stringify(observation.status)} is outside the canonical vocabulary.`,
      remedy:
        "Supply collector evidence with a canonical observation status " +
        "(offered, active, on_leave, suspended, terminated, or unknown).",
    });
    return false;
  }
  if (observation.status === "unknown") return false;
  if (!isRecordedInstant(observation.observedAt) || !isNonBlank(observation.provenance)) {
    ctx.issues.push({
      code: "invalid_observation_evidence",
      level: "ambiguous",
      detail:
        "a current observation asserts employment status but its asserted instant or provenance " +
        "cannot be interpreted; the observation-start anchor must stay distinct from service dates.",
      remedy:
        "Supply collector evidence with the observation instant as a UTC YYYY-MM-DDTHH:mm:ss[.fraction]Z " +
        "stamp plus the provenance of who asserted it and when.",
    });
    return false;
  }
  return true;
}

function checkResolutionDates(row: SourcePersonRow, ctx: RowContext): {
  applied: boolean;
  hiredOn: string | null;
  terminatedOn: string | null;
  employer: string | null;
} {
  const empty = { applied: false, hiredOn: null, terminatedOn: null, employer: null };
  const resolution = row.resolution;
  if (resolution === null) return empty;
  if (resolution.kind !== "operator-employer-date-mapping") {
    ctx.issues.push({
      code: "incomplete_resolution_evidence",
      level: "requires_review",
      detail: `resolution kind ${JSON.stringify(resolution.kind)} is not a recognized operator mapping.`,
      remedy:
        "Supply an operator employer/date mapping with kind operator-employer-date-mapping, employer, " +
        "approver, instant, and rationale; presence is checked, authority is not authenticated here.",
    });
    return empty;
  }
  const problems: string[] = [];
  if (!isNonBlank(resolution.approvedBy)) problems.push("approver is missing");
  if (!isRecordedInstant(resolution.approvedAt)) problems.push("approval instant is not a valid UTC stamp");
  if (!isNonBlank(resolution.rationale)) problems.push("rationale is missing");
  if (resolution.hiredOn !== null && !isCivilDate(resolution.hiredOn)) {
    problems.push(`mapped hired_on ${resolution.hiredOn} is not a valid YYYY-MM-DD date`);
  }
  if (resolution.terminatedOn !== null && !isCivilDate(resolution.terminatedOn)) {
    problems.push(`mapped terminated_on ${resolution.terminatedOn} is not a valid YYYY-MM-DD date`);
  }
  // Civil event dates: only terminated strictly before hired contradicts.
  if (
    resolution.hiredOn !== null &&
    resolution.terminatedOn !== null &&
    isCivilDate(resolution.hiredOn) &&
    isCivilDate(resolution.terminatedOn) &&
    compareCivilDates(resolution.terminatedOn, resolution.hiredOn) < 0
  ) {
    problems.push("mapped terminated_on is before mapped hired_on");
  }
  if (problems.length > 0) {
    ctx.issues.push({
      code: "incomplete_resolution_evidence",
      level: "requires_review",
      detail: `operator mapping cannot be applied: ${problems.join("; ")}.`,
      remedy:
        "Supply a complete operator employer/date mapping (employer, valid date-only service dates, " +
        "approver, valid approval instant, rationale); an incomplete mapping contributes nothing.",
    });
    return empty;
  }
  return {
    applied: true,
    hiredOn: resolution.hiredOn,
    terminatedOn: resolution.terminatedOn,
    employer: normalizedId(resolution.employerSubsidiaryId),
  };
}

/**
 * One explicit date-evidence contract across role presence combinations:
 * observed termination requires an actual terminated_on date, never invented
 * from flags or from the observation anchor.
 */
function addMissingTerminationDate(ctx: RowContext): void {
  ctx.issues.push({
    code: "missing_termination_date",
    level: "requires_review",
    detail:
      "termination is observed as the current status but no terminated_on date exists; the " +
      "termination date is not invented from flags or from the observation anchor.",
    remedy:
      "Supply collector evidence with the actual termination date (YYYY-MM-DD) and its provenance.",
  });
}

function checkEvidence(
  row: SourcePersonRow,
  observationCurrent: boolean,
  observationTerminated: boolean,
  resolution: { applied: boolean; hiredOn: string | null; terminatedOn: string | null },
  ctx: RowContext,
): { serviceStart: string | null; serviceStartProvenance: string | null } {
  const role = row.role !== null && row.role.present ? row.role : null;
  const payroll = row.payroll !== null && row.payroll.present ? row.payroll : null;
  if (row.role !== null && !row.role.present && (row.role.hiredOn !== null || row.role.terminatedOn !== null)) {
    ctx.issues.push({
      code: "contradictory_role_presence",
      level: "ambiguous",
      detail: "source reports no role yet carries role service dates; refusing to guess which claim holds.",
      remedy:
        "Supply collector evidence confirming whether an employee role exists for this party and, " +
        "if so, its actual service dates with provenance.",
    });
  }
  // Operator mappings prove dates independently of any legacy role: a
  // complete mapping is consumed even when no role exists. An internally
  // contradictory mapping was already refused above (resolution would not be
  // applied), and a source-versus-mapping conflict needs source dates to
  // contradict, so there is nothing to silently prefer here.
  const mappedStart = resolution.applied ? resolution.hiredOn : null;
  const mappedEnd = resolution.applied ? resolution.terminatedOn : null;
  const mappedStartProvenance = mappedStart !== null ? "operator-employer-date-mapping" : null;
  if (role === null && payroll === null) {
    // One explicit date-evidence contract across role presence: observed
    // termination requires an actual terminated_on date, never invented
    // from the observation anchor.
    if (observationTerminated && mappedEnd === null) {
      addMissingTerminationDate(ctx);
    }
    if (observationCurrent) {
      if (mappedStart === null) {
        ctx.notes.push({
          code: "service_start_unknown",
          detail:
            "current employment is observed but no role, payroll profile, or actual service start is " +
            "known: the migration may proceed on the observation date while historical coverage stays " +
            "unknown. The observation-start anchor is not copied into hired_on.",
        });
      }
      return { serviceStart: mappedStart, serviceStartProvenance: mappedStartProvenance };
    }
    ctx.issues.push({
      code: "insufficient_employment_evidence",
      level: "insufficient_employment_evidence",
      detail:
        `no role, no payroll profile, and no current observation exist for this candidate ` +
        `(parties.kind ${JSON.stringify(row.party.kind)} proves nothing about employment).`,
      remedy:
        "Supply collector evidence of employment: an employee role with actual service dates and " +
        "provenance, a payroll profile, or an operator-asserted current observation with " +
        "instant and provenance. Current active flags alone are never enough.",
    });
    return { serviceStart: mappedStart, serviceStartProvenance: mappedStartProvenance };
  }
  let serviceStart: string | null = null;
  let serviceStartProvenance: string | null = null;
  let serviceEnd: string | null = null;
  if (role !== null) {
    // Source hired_on/terminated_on are civil EVENT dates, not half-open
    // interval endpoints: only terminated strictly before hired contradicts;
    // a same-day hire plus termination is valid and migrates as-is.
    const roleHiredValid = role.hiredOn !== null && isCivilDate(role.hiredOn);
    const roleTerminatedValid = role.terminatedOn !== null && isCivilDate(role.terminatedOn);
    if (role.hiredOn !== null && !roleHiredValid) {
      ctx.issues.push({
        code: "invalid_service_date",
        level: "ambiguous",
        detail: `role hired_on ${role.hiredOn} is not a valid YYYY-MM-DD calendar date.`,
        remedy:
          "Supply collector evidence with the actual hire date as a real YYYY-MM-DD calendar date " +
          "plus its provenance; the observation-start anchor must never be copied into hired_on.",
      });
    }
    if (role.terminatedOn !== null && !roleTerminatedValid) {
      ctx.issues.push({
        code: "invalid_service_date",
        level: "ambiguous",
        detail: `role terminated_on ${role.terminatedOn} is not a valid YYYY-MM-DD calendar date.`,
        remedy:
          "Supply collector evidence with the actual termination date as a real YYYY-MM-DD calendar " +
          "date plus its provenance; historical status is never invented.",
      });
    }
    // Conflicting dated evidence refuses: the mapping never silently loses
    // to the source, and the source never silently loses to the mapping.
    if (
      roleHiredValid &&
      resolution.applied &&
      resolution.hiredOn !== null &&
      resolution.hiredOn !== role.hiredOn
    ) {
      ctx.issues.push({
        code: "conflicting_service_dates",
        level: "ambiguous",
        detail:
          `source hired_on ${role.hiredOn} disagrees with mapped hired_on ${resolution.hiredOn}; ` +
          `refusing to choose which service start is real.`,
        remedy:
          "Supply collector evidence reconciling the hire date (one agreed YYYY-MM-DD date with " +
          "provenance, or a corrected operator mapping).",
      });
    } else if (roleHiredValid && isNonBlank(role.dateProvenance)) {
      serviceStart = role.hiredOn;
      serviceStartProvenance = role.dateProvenance;
    } else if (roleHiredValid) {
      ctx.issues.push({
        code: "missing_service_date_provenance",
        level: "requires_review",
        detail: `role hired_on ${role.hiredOn} carries no provenance, so it cannot anchor history.`,
        remedy:
          "Supply collector evidence naming where the hire date was observed (source record and " +
          "provenance); an unprovenanced date is not migrated as fact.",
      });
    } else if (resolution.applied && resolution.hiredOn !== null) {
      serviceStart = resolution.hiredOn;
      serviceStartProvenance = "operator-employer-date-mapping";
    }
    if (
      roleTerminatedValid &&
      resolution.applied &&
      resolution.terminatedOn !== null &&
      resolution.terminatedOn !== role.terminatedOn
    ) {
      ctx.issues.push({
        code: "conflicting_service_dates",
        level: "ambiguous",
        detail:
          `source terminated_on ${role.terminatedOn} disagrees with mapped terminated_on ` +
          `${resolution.terminatedOn}; refusing to choose which service end is real.`,
        remedy:
          "Supply collector evidence reconciling the termination date (one agreed YYYY-MM-DD date " +
          "with provenance, or a corrected operator mapping).",
      });
    } else if (roleTerminatedValid) {
      serviceEnd = role.terminatedOn;
    } else if (resolution.applied && resolution.terminatedOn !== null) {
      serviceEnd = resolution.terminatedOn;
    }
    if (
      serviceStart !== null &&
      serviceEnd !== null &&
      compareCivilDates(serviceEnd, serviceStart) < 0
    ) {
      ctx.issues.push({
        code: "contradictory_service_dates",
        level: "ambiguous",
        detail:
          `terminated_on ${serviceEnd} is before hired_on ${serviceStart}; same-day hire plus ` +
          `termination is valid, earlier termination is not.`,
        remedy:
          "Supply collector evidence reconciling the service event dates (corrected hire/termination " +
          "dates with provenance); a termination before the hire is refused, never auto-ordered.",
      });
    }
    // A bare inactive flag is not employment proof in either direction: it
    // may be data maintenance, so it never demands a fabricated
    // terminated_on. Only observed/corroborated termination (a current
    // terminated observation) requires the actual termination date — the
    // same explicit contract the role-less branches below share.
    if (observationTerminated && serviceEnd === null) {
      addMissingTerminationDate(ctx);
    }
    if (role.countryContext !== null && payroll !== null && payroll.countryContext !== null &&
      role.countryContext !== payroll.countryContext) {
      ctx.issues.push({
        code: "country_context_conflict",
        level: "ambiguous",
        detail:
          `role country context ${role.countryContext} disagrees with payroll country context ` +
          `${payroll.countryContext}; refusing to guess the employment context.`,
        remedy:
          "Supply collector evidence reconciling the role and payroll country contexts to one stored value.",
      });
    }
  }
  const hasCorroboration = payroll !== null || observationCurrent;
  if (serviceStart === null && role !== null) {
    if (observationCurrent) {
      ctx.notes.push({
        code: "service_start_unknown",
        detail:
          "current employment is observed but no actual service start is known: the migration may " +
          "proceed on the observation date while historical coverage stays unknown. The " +
          "observation-start anchor is not copied into hired_on.",
      });
    } else if (hasCorroboration) {
      ctx.issues.push({
        code: "missing_service_start",
        level: "requires_review",
        detail:
          "role and payroll evidence exists but no actual hire date with provenance is known, and no " +
          "current observation anchors the migration date.",
        remedy:
          "Supply collector evidence with the actual hire date and provenance, an operator " +
          "employer/date mapping supplying it, or an operator-asserted current observation with " +
          "instant and provenance for observation-date migration.",
      });
    } else {
      ctx.issues.push({
        code: "flags_only_role",
        level: "insufficient_employment_evidence",
        detail:
          "the role carries only current flags with no service dates, no payroll corroboration, and " +
          "no observation; employment history cannot be inferred from current flags.",
        remedy:
          "Supply collector evidence of employment: actual service dates with provenance, a payroll " +
          "profile, or an operator-asserted current observation with instant and provenance.",
      });
    }
  }
  if (role === null && payroll !== null) {
    // Role-less payroll consumes a complete operator mapping the same way:
    // mapped dates are preserved, never discarded for lack of a role.
    const serviceStart = mappedStart;
    const serviceStartProvenance = mappedStartProvenance;
    // Same explicit date-evidence contract as every other role presence:
    // observed termination requires an actual terminated_on date.
    if (observationTerminated && mappedEnd === null) {
      addMissingTerminationDate(ctx);
    }
    if (observationCurrent) {
      ctx.notes.push({
        code: "roleless_payroll_evidence",
        detail:
          "payroll evidence exists with no role and current status is observed: the candidate stays " +
          "in the report as an evidence case and may migrate on the observation date; the consumer " +
          "must still confirm the role mapping.",
      });
      if (serviceStart === null) {
        ctx.notes.push({
          code: "service_start_unknown",
          detail:
            "no actual service start is known: the migration may proceed on the observation date " +
            "while historical coverage stays unknown. The observation-start anchor is not copied " +
            "into hired_on.",
        });
      }
    } else {
      ctx.issues.push({
        code: "roleless_payroll_evidence",
        level: "requires_review",
        detail:
          "payroll evidence exists with no role: an evidence case that is never silently skipped and " +
          "never auto-manufactures a role.",
        remedy:
          "Supply collector evidence confirming the employee role for this party (or that none exists " +
          "and the payroll row needs its own disposition), or an operator-asserted current " +
          "observation with instant and provenance.",
      });
    }
    return { serviceStart, serviceStartProvenance };
  }
  if (
    !row.party.isActive &&
    row.party.sourceIsNew &&
    role !== null &&
    payroll === null
  ) {
    ctx.issues.push({
      code: "draft_suspect",
      level: "requires_review",
      detail:
        "inactive newly-sourced party with a role but no payroll evidence is only a draft SUSPECT: " +
        "not enough proof to delete or exclude as fact.",
      remedy:
        "Supply collector evidence deciding the draft: payroll or service-date proof that this is a " +
        "real employment, or source-funnel proof that the record was never more than a draft.",
    });
  }
  return { serviceStart, serviceStartProvenance };
}

const PRIMARY_PRIORITY: readonly Exclude<PreflightCode, "ready">[] = [
  "binding_conflict",
  "already_migrated",
  "unknown_employer",
  "invalid_employer",
  "ambiguous",
  "insufficient_employment_evidence",
  "requires_review",
];

function classifyRow(row: SourcePersonRow, isDuplicate: boolean): PersonPreflight {
  const ctx: RowContext = { issues: [], notes: [], provenance: [] };
  addProvenance(ctx, [
    ...row.party.evidenceIds,
    ...(row.role !== null ? row.role.evidenceIds : []),
    ...(row.payroll !== null ? row.payroll.evidenceIds : []),
    row.role !== null ? row.role.dateProvenance : null,
    row.observation !== null ? row.observation.provenance : null,
    row.existingBinding !== null ? row.existingBinding.provenance : null,
  ]);
  if (
    !isNonBlank(row.orgId) ||
    !isNonBlank(row.sourceNamespace) ||
    !isNonBlank(row.sourceId) ||
    !isNonBlank(row.nativePartyId) ||
    !isNonBlank(row.sourceVersion)
  ) {
    ctx.issues.push({
      code: "invalid_source_identity",
      level: "ambiguous",
      detail: "the candidate lacks a complete (org, namespace, source id, native party) identity.",
      remedy:
        "Supply collector evidence with the stable org id, source namespace, source key, and native " +
        "party id for this candidate.",
    });
  }
  if (isDuplicate) {
    ctx.issues.push({
      code: "duplicate_source_key",
      level: "ambiguous",
      detail:
        `duplicate (org, namespace, sourceId) key: every variant is retained and refused, never ` +
        `merged or discarded.`,
      remedy:
        "Supply collector evidence disambiguating the duplicate source keys (distinct source records " +
        "or a corrected namespace/key per variant).",
    });
  }
  const assertedEmployer = normalizedId(row.employer.assertedSubsidiaryId);
  const resolution = checkResolutionDates(row, ctx);
  const effectiveEmployer = resolution.applied && resolution.employer !== null
    ? resolution.employer
    : assertedEmployer;
  checkEmployer(row, effectiveEmployer, resolution.employer, assertedEmployer, ctx);
  const payrollScope = row.payroll !== null && row.payroll.present
    ? normalizedId(row.payroll.subsidiaryId)
    : null;
  if (payrollScope !== null && effectiveEmployer !== null && payrollScope !== effectiveEmployer) {
    ctx.issues.push({
      code: "schedule_employer_conflict",
      level: "ambiguous",
      detail:
        `payroll/schedule scope ${payrollScope} disagrees with effective employer ${effectiveEmployer}; ` +
        `refusing to guess which legal employer the schedule belongs to.`,
      remedy:
        "Supply collector evidence with the scoped subsidiary id the payroll profile and schedule " +
        "belong to, reconciled against the current employer.",
    });
  }
  const observationCurrent = checkObservation(row, ctx);
  const observationTerminated = observationCurrent && row.observation?.status === "terminated";
  const evidence = checkEvidence(
    row,
    observationCurrent,
    observationTerminated,
    { applied: resolution.applied, hiredOn: resolution.hiredOn, terminatedOn: resolution.terminatedOn },
    ctx,
  );
  const fingerprint = fingerprintSourceRow(row);
  const bindingConsistent = checkBinding(row, fingerprint, effectiveEmployer, ctx);

  // The candidate emits only when nothing blocks: any retained issue —
  // including an invalid employer under a valid observation — nulls it.
  // Notes are nonblocking and never suppress the candidate.
  let candidate: CandidateMapping | null = null;
  if (
    ctx.issues.length === 0 &&
    observationCurrent &&
    effectiveEmployer !== null &&
    row.observation !== null &&
    row.observation.observedAt !== null
  ) {
    candidate = {
      employerSubsidiaryId: effectiveEmployer,
      status: row.observation.status,
      effectiveFrom: row.observation.observedAt.slice(0, 10),
      serviceStart: evidence.serviceStart,
      serviceStartProvenance: evidence.serviceStartProvenance,
    };
  }
  const provenance = [...ctx.provenance].sort();
  const issues = ctx.issues;
  let classification: PreflightCode = "ready";
  if (isDuplicate && issues.some((issue) => issue.code === "duplicate_source_key")) {
    classification = "ambiguous";
  } else {
    for (const level of PRIMARY_PRIORITY) {
      if (level === "already_migrated") {
        if (bindingConsistent) {
          classification = "already_migrated";
          break;
        }
        continue;
      }
      if (issues.some((issue) => issue.level === level)) {
        classification = level;
        break;
      }
    }
  }
  return {
    orgId: row.orgId,
    sourceNamespace: row.sourceNamespace,
    sourceId: row.sourceId,
    nativePartyId: row.nativePartyId,
    classification,
    // Always unknown: a known service start never establishes status or
    // assignment history, and no input evidences that coverage. The precise
    // known start travels separately below.
    historicalCoverage: "unknown",
    serviceStart: evidence.serviceStart,
    serviceStartProvenance: evidence.serviceStartProvenance,
    issues,
    notes: ctx.notes,
    candidate,
    provenance,
  };
}

/**
 * Pure preflight over one batch of source inventory. Never mutates input,
 * never drops rows, deterministic under input permutation.
 */
export function preflightEmploymentMigration(rows: readonly SourcePersonRow[]): PreflightReport {
  const counts = Object.fromEntries(PREFLIGHT_CODES.map((code) => [code, 0])) as Record<
    PreflightCode,
    number
  >;
  if (rows.length === 0) return { status: "empty_not_evaluated", rows: [], counts };
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = duplicateKey(row);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const decorated = rows.map((row) => ({
    fingerprint: fingerprintSourceRow(row),
    tieBreak: rowIdentityHash(row),
    result: classifyRow(row, (seen.get(duplicateKey(row)) ?? 0) > 1),
  }));
  decorated.sort((a, b) => {
    if (a.result.orgId !== b.result.orgId) return a.result.orgId < b.result.orgId ? -1 : 1;
    if (a.result.sourceNamespace !== b.result.sourceNamespace) {
      return a.result.sourceNamespace < b.result.sourceNamespace ? -1 : 1;
    }
    if (a.result.sourceId !== b.result.sourceId) return a.result.sourceId < b.result.sourceId ? -1 : 1;
    if (a.fingerprint !== b.fingerprint) return a.fingerprint < b.fingerprint ? -1 : 1;
    if (a.tieBreak !== b.tieBreak) return a.tieBreak < b.tieBreak ? -1 : 1;
    return 0;
  });
  const reportRows = decorated.map((entry) => entry.result);
  for (const result of reportRows) counts[result.classification] += 1;
  return { status: "evaluated", rows: reportRows, counts };
}
