import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { PayrollError } from "./payroll-error.ts";
import {
  yearEndFiling,
  type PayrollFilingCorrectionKind,
  type PayrollFilingCorrectionRow,
  type PayrollFilingData,
  type PayrollFilingFieldChange,
  type PayrollFilingFile,
  type PayrollFilingReported,
  type PayrollFilingReportedField,
  type PayrollFilingRevision,
  type PayrollFilingSlipData,
  type PayrollYearEndFiling,
} from "./payroll-filing-registry.ts";

/**
 * The payroll filing LIFECYCLE — original → amended → cancelled.
 *
 * Every employer eventually files a wrong slip: a taxable benefit that was
 * missed, a SIN keyed wrong, an employee who was never on this entity at all.
 * Before this module the product's answer was that a filing could not be
 * corrected, which is a compliance dead end that surfaces at the worst
 * possible moment.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL
 * ---------------------------------------------------------------------------
 *
 * A filing has a STATE and a HISTORY. An issued artifact is evidence of what
 * the employer declared to the agency, so:
 *
 *   - nothing ever updates an issued submission. A correction is a NEW
 *     submission that SUPERSEDES the previous one, and the original file's
 *     bytes stay retrievable forever;
 *   - AMEND and CANCEL are different operations. Amending restates values on
 *     a slip that should exist; cancelling declares that a slip should never
 *     have existed. Agencies treat them differently and so does this model;
 *   - the DELTA is the deliverable. An operator amending sees exactly which
 *     boxes moved, old value beside new — which is also the first thing the
 *     agency's own review asks, and literally what the IRS's correction forms
 *     print in two columns.
 *
 * ---------------------------------------------------------------------------
 * RECOMPUTE, NOT RE-TYPE
 * ---------------------------------------------------------------------------
 *
 * An amendment RECOMPUTES from the ledger. It never captures operator-entered
 * corrected amounts.
 *
 * The engine's invariant is that YTD state = payroll_opening_balances +
 * payroll_opening_balance_components + posted stubs, and nothing else
 * accumulates. A slip is a projection of that. If an amendment could carry
 * hand-keyed numbers, the amended T4 and the subledger it is supposed to
 * summarize would disagree, permanently and invisibly — the employer would be
 * reconciling remittances against one set of figures and defending a filing
 * built from another. So the correction is made where the wrong number IS: a
 * voided run, an adjustment run, a corrected opening balance, a retro-pay
 * ledger correction. The amendment is the CONSEQUENCE of that, and this
 * module recomputes it.
 *
 * Corrections that are genuinely not in the ledger — a wrong SIN, a wrong
 * name, a wrong province of employment — are handled the same way, because
 * they are not ledger facts either: they live on the employee's profile and
 * the stub's province snapshot, they are corrected THERE, and the recompute
 * picks them up. The issued snapshot is what makes the change visible: it
 * holds what was printed, so the delta shows "Province of employment (10):
 * ON → BC" without anyone re-typing a box.
 *
 * Two disagreements are therefore possible and BOTH are surfaced rather than
 * hidden (see `PayrollFilingRowStatus`):
 *
 *   - `absent`      — a row was issued and the ledger no longer produces it.
 *     That is the cancellation case, and until it is cancelled the filed
 *     population and the ledger disagree.
 *   - `resurrected` — a row was CANCELLED and the ledger still produces it.
 *     The operator withdrew a slip without correcting the data underneath it;
 *     the next original would re-file it.
 *
 * The recompute deliberately does NOT assume the ledger is frozen after year
 * end. Every read is live, so a retro-pay correction posted in March moves the
 * delta for the prior year the moment it is committed.
 *
 * ---------------------------------------------------------------------------
 * COUNTRY-AGNOSTIC
 * ---------------------------------------------------------------------------
 *
 * There is no country and no form name in this file. `revision` is the
 * agency-neutral state; how it is CARRIED is a pack declaration
 * (`PayrollYearEndFiling.amendment`, required): the CRA re-files the same T4
 * XML under a report-type code, the IRS uses a wholly separate W-2c/941-X
 * carrying both previously-reported and corrected amounts, and Revenu Québec
 * REFUSES because the RL-1 correction format is partner-gated. This module
 * branches on none of that — it asks the pack.
 */

// ---------------------------------------------------------------------------
// Reading the history
// ---------------------------------------------------------------------------

/** One artifact that was issued, with the slips it reported. */
export interface PayrollFilingSubmission {
  id: string;
  country: string;
  filingKey: string;
  taxYear: number;
  revision: PayrollFilingRevision;
  /** 1, 2, 3 … in issue order; the original is 1. */
  revisionNumber: number;
  supersedesId: string | null;
  issuedAt: string;
  note: string | null;
  slipCount: number;
  /**
   * Metadata of the transmitted file. The BYTES are deliberately not carried
   * here — `filingArtifact` fetches them on demand, so a history read never
   * hauls every T4 XML the org ever filed into memory (or onto a wire).
   */
  artifact: { filename: string; contentType: string; bytes: number } | null;
  slips: PayrollFilingIssuedSlip[];
}

export interface PayrollFilingIssuedSlip {
  rowId: string;
  label: string;
  revision: PayrollFilingRevision;
  reported: PayrollFilingReported;
}

function toReported(raw: unknown): PayrollFilingReported {
  const value = (raw ?? {}) as Partial<PayrollFilingReported>;
  return {
    fields: Array.isArray(value.fields) ? value.fields : [],
    confidential: Array.isArray(value.confidential) ? value.confidential : [],
  };
}

/**
 * Every artifact issued for one filing-year, OLDEST first — the order the
 * supersession chain reads in.
 */
export async function filingSubmissions(
  orgId: string,
  country: string,
  filingKey: string,
  taxYear: number,
): Promise<PayrollFilingSubmission[]> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select s.id, s.country, s.filing_key, s.tax_year, s.revision, s.revision_number,
           s.supersedes_id, s.issued_at, s.note, s.slip_count,
           s.artifact_filename, s.artifact_content_type,
           octet_length(s.artifact_body) as artifact_bytes,
           coalesce(
             (select jsonb_agg(jsonb_build_object(
                       'rowId', sl.row_id, 'label', sl.label,
                       'revision', sl.revision, 'reported', sl.reported)
                     order by sl.label, sl.row_id)
                from payroll_filing_submission_slips sl
               where sl.submission_id = s.id),
             '[]'::jsonb) as slips
      from payroll_filing_submissions s
     where s.org_id = ${orgId} and s.country = ${country}
       and s.filing_key = ${filingKey} and s.tax_year = ${taxYear}
     order by s.revision_number
  `));
  return rows.rows.map((row) => ({
    id: String(row.id),
    country: String(row.country),
    filingKey: String(row.filing_key),
    taxYear: Number(row.tax_year),
    revision: row.revision as PayrollFilingRevision,
    revisionNumber: Number(row.revision_number),
    supersedesId: (row.supersedes_id as string | null) ?? null,
    issuedAt: new Date(row.issued_at as string).toISOString(),
    note: (row.note as string | null) ?? null,
    slipCount: Number(row.slip_count ?? 0),
    artifact: row.artifact_filename
      ? {
        filename: String(row.artifact_filename),
        contentType: String(row.artifact_content_type ?? "application/octet-stream"),
        bytes: Number(row.artifact_bytes ?? 0),
      }
      : null,
    slips: ((row.slips as unknown[]) ?? []).map((slip) => {
      const value = slip as Record<string, unknown>;
      return {
        rowId: String(value.rowId),
        label: String(value.label ?? ""),
        revision: value.revision as PayrollFilingRevision,
        reported: toReported(value.reported),
      };
    }),
  }));
}

/**
 * The EXACT bytes of one issued artifact. This is the audit trail's whole
 * point: what went to the agency is retrievable unchanged, however many
 * amendments have since superseded it.
 */
export async function filingArtifact(
  orgId: string,
  submissionId: string,
): Promise<PayrollFilingFile | null> {
  const rows = (await db.execute<{
      artifact_filename: string | null;
      artifact_content_type: string | null;
      artifact_body: string | null;
    }>(sql`
    select artifact_filename, artifact_content_type, artifact_body
      from payroll_filing_submissions
     where org_id = ${orgId} and id = ${submissionId}
  `));
  const row = rows.rows[0];
  if (!row || row.artifact_body == null || !row.artifact_filename) return null;
  return {
    filename: row.artifact_filename,
    contentType: row.artifact_content_type ?? "application/octet-stream",
    body: row.artifact_body,
  };
}

/**
 * What each row LAST reported, across the whole supersession chain. A row is
 * only present here if some issued artifact carried it; the latest artifact
 * that named the row wins, which is exactly how an agency reads a series of
 * amendments.
 */
export function lastReportedByRow(
  submissions: readonly PayrollFilingSubmission[],
): Map<string, { slip: PayrollFilingIssuedSlip; submission: PayrollFilingSubmission }> {
  const latest = new Map<string, { slip: PayrollFilingIssuedSlip; submission: PayrollFilingSubmission }>();
  // `filingSubmissions` returns oldest first, so a later artifact simply
  // overwrites an earlier statement about the same row.
  for (const submission of submissions) {
    for (const slip of submission.slips) latest.set(slip.rowId, { slip, submission });
  }
  return latest;
}

// ---------------------------------------------------------------------------
// The delta
// ---------------------------------------------------------------------------

/** Stable identity of a reported field across two issues of the same slip. */
const fieldKey = (field: { code: string | null; label: string }) =>
  `${field.code ?? ""}\u0000${field.label}`;

/**
 * Exactly which fields moved between what was reported and what is true now.
 *
 * Pure, and in the FORM's vocabulary — box codes and printed labels, because
 * that is what the operator is looking at and what the agency will ask about.
 * A field that appears on only one side is a change too (a box that started or
 * stopped being reported), never a silent omission.
 */
export function diffReported(
  previous: PayrollFilingReported,
  current: PayrollFilingReported,
): PayrollFilingFieldChange[] {
  const changes: PayrollFilingFieldChange[] = [];
  const before = new Map(previous.fields.map((field) => [fieldKey(field), field]));
  const seen = new Set<string>();
  for (const field of current.fields) {
    const key = fieldKey(field);
    seen.add(key);
    const old = before.get(key);
    if (old && old.value === field.value) continue;
    changes.push({
      code: field.code,
      label: field.label,
      previous: old ? old.value : null,
      current: field.value,
      redacted: false,
    });
  }
  for (const field of previous.fields) {
    if (seen.has(fieldKey(field))) continue;
    changes.push({
      code: field.code,
      label: field.label,
      previous: field.value,
      current: null,
      redacted: false,
    });
  }

  // Confidential identifiers are compared by keyed fingerprint and reported
  // as CHANGED with both values withheld. "The SIN on this slip is wrong" has
  // to be visible; the SIN itself must not be, and must never be stored in
  // the filing history to make the comparison possible.
  const beforeSecret = new Map(previous.confidential.map((f) => [f.label, f.fingerprint]));
  const seenSecret = new Set<string>();
  for (const field of current.confidential) {
    seenSecret.add(field.label);
    const old = beforeSecret.get(field.label);
    if (old === field.fingerprint) continue;
    changes.push({
      code: null,
      label: field.label,
      previous: null,
      current: null,
      redacted: true,
    });
  }
  for (const field of previous.confidential) {
    if (seenSecret.has(field.label)) continue;
    changes.push({ code: null, label: field.label, previous: null, current: null, redacted: true });
  }
  return changes;
}

/**
 * Where one row sits in the lifecycle.
 *
 *  - `unfiled`     — the ledger produces it; no artifact has ever named it.
 *  - `unchanged`   — issued, and every field still matches.
 *  - `changed`     — issued, and the ledger now says something different.
 *  - `absent`      — issued, and the ledger no longer produces the row at all.
 *  - `withdrawn`   — cancelled, and the ledger agrees it should not exist.
 *  - `resurrected` — CANCELLED, and the ledger still produces it. A slip was
 *    withdrawn without correcting the data underneath; the disagreement is
 *    named rather than quietly re-filed.
 */
export type PayrollFilingRowStatus =
  | "unfiled" | "unchanged" | "changed" | "absent" | "withdrawn" | "resurrected";

export interface PayrollFilingRowReview {
  rowId: string;
  label: string;
  status: PayrollFilingRowStatus;
  /** The revision of the artifact that last named this row. */
  lastRevision: PayrollFilingRevision | null;
  lastIssuedAt: string | null;
  /** Fields that moved, in the form's own vocabulary. Empty unless changed. */
  changes: PayrollFilingFieldChange[];
}

/** Everything a correction decision needs, for one filing-year. */
export interface PayrollFilingLifecycle {
  country: string;
  filingKey: string;
  label: string;
  taxYear: number;
  /** The pack's declared correction mechanics, flattened for the surface. */
  amendment:
  | { supported: false; refusal: string }
  | {
    supported: true;
    revisions: readonly PayrollFilingCorrectionKind[];
    vehicle: "same_form" | "correction_form";
    formLabel: string | null;
    download: { label: string; note: string | null } | null;
    downloadRefusal: string | null;
    hasSlip: boolean;
  };
  submissions: PayrollFilingSubmission[];
  rows: PayrollFilingRowReview[];
  /**
   * The population could not be built (an unknown year's caps, an undeclared
   * mapping) — in the builder's own words. The history is still returned; a
   * refusal to recompute must not hide what was already filed.
   */
  populationRefusal: string | null;
}

/**
 * The correction review for one filing-year: the history, and every row's
 * status with its field-level delta.
 *
 * Nothing here writes, and nothing here is country-specific. The current
 * values come from the pack's own slip declaration (falling back to its
 * population columns when it declares no slip), so the delta an operator
 * approves is the same data the pack's correction form prints.
 */
export async function filingLifecycle(
  orgId: string,
  country: string,
  filingKey: string,
  taxYear: number,
): Promise<PayrollFilingLifecycle> {
  const filing = yearEndFiling(country, filingKey);
  const submissions = await filingSubmissions(orgId, country, filingKey, taxYear);
  const issued = lastReportedByRow(submissions);

  let data: PayrollFilingData = { rowKey: "rowId", columns: [], rows: [] };
  let populationRefusal: string | null = null;
  try {
    data = await filing.population(orgId, taxYear);
  } catch (error) {
    if (!(error instanceof PayrollError)) throw error;
    populationRefusal = error.message;
  }

  const rows: PayrollFilingRowReview[] = [];
  const currentIds = new Set<string>();
  for (const row of data.rows) {
    const rowId = String(row[data.rowKey] ?? "");
    if (!rowId) continue;
    currentIds.add(rowId);
    const label = rowLabel(data, row);
    const previous = issued.get(rowId);
    if (!previous) {
      rows.push({
        rowId, label, status: "unfiled", lastRevision: null, lastIssuedAt: null, changes: [],
      });
      continue;
    }
    // Only rows that were actually issued cost a slip build — an unfiled
    // population never pays for a per-row query it has nothing to compare to.
    const current = await currentReported(filing, orgId, taxYear, data, row);
    const changes = diffReported(previous.slip.reported, current.reported);
    const cancelled = previous.slip.revision === "cancelled";
    rows.push({
      rowId,
      label,
      status: cancelled ? "resurrected" : changes.length > 0 ? "changed" : "unchanged",
      lastRevision: previous.slip.revision,
      lastIssuedAt: previous.submission.issuedAt,
      changes: cancelled ? [] : changes,
    });
  }

  // Rows the ledger no longer produces. A slip that was filed and has since
  // vanished from the subledger (a voided run, an employee moved to another
  // entity) is precisely the cancellation case, and it must be visible even
  // though nothing in the current population mentions it.
  for (const [rowId, previous] of issued) {
    if (currentIds.has(rowId)) continue;
    rows.push({
      rowId,
      label: previous.slip.label,
      status: previous.slip.revision === "cancelled" ? "withdrawn" : "absent",
      lastRevision: previous.slip.revision,
      lastIssuedAt: previous.submission.issuedAt,
      changes: [],
    });
  }
  rows.sort((a, b) => a.label.localeCompare(b.label) || a.rowId.localeCompare(b.rowId));

  return {
    country,
    filingKey,
    label: filing.label,
    taxYear,
    amendment: filing.amendment.supported
      ? {
        supported: true,
        revisions: filing.amendment.revisions,
        vehicle: filing.amendment.vehicle,
        formLabel: filing.amendment.formLabel ?? null,
        download: filing.amendment.download
          ? {
            label: filing.amendment.download.label,
            note: filing.amendment.download.note ?? null,
          }
          : null,
        downloadRefusal: filing.amendment.downloadRefusal ?? null,
        hasSlip: filing.amendment.slip != null,
      }
      : { supported: false, refusal: filing.amendment.refusal },
    submissions,
    rows,
    populationRefusal,
  };
}

/** The row's first declared column — how a human names this slip. */
function rowLabel(data: PayrollFilingData, row: Record<string, string | number | null>): string {
  const first = data.columns[0]?.key ?? data.rowKey;
  return String(row[first] ?? row[data.rowKey] ?? "");
}

/**
 * What the row reports TODAY: the pack's slip when it declares one (the full
 * statutory box set plus the identification printed above it), else the
 * population columns it does declare. Either way the shape is the pack's own
 * vocabulary and this function invents nothing.
 */
async function currentReported(
  filing: PayrollYearEndFiling,
  orgId: string,
  taxYear: number,
  data: PayrollFilingData,
  row: Record<string, string | number | null>,
): Promise<{ slip: PayrollFilingSlipData | null; reported: PayrollFilingReported }> {
  const rowId = String(row[data.rowKey] ?? "");
  const confidential = filing.amendment.supported && filing.amendment.confidential
    ? await filing.amendment.confidential(orgId, taxYear, rowId)
    : [];
  if (filing.slip) {
    const slip = await filing.slip.build(orgId, taxYear, rowId);
    const fields: PayrollFilingReportedField[] = [
      ...slip.headerFields.map((field) => ({ code: null, label: field.label, value: field.value })),
      ...slip.boxes.map((box) => ({ code: box.code, label: box.label, value: box.value })),
    ];
    return { slip, reported: { fields, confidential } };
  }
  return {
    slip: null,
    reported: {
      fields: data.columns.map((column) => ({
        code: null,
        label: column.label,
        value: String(row[column.key] ?? ""),
      })),
      confidential,
    },
  };
}

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

export interface RecordFilingIssueInput {
  orgId: string;
  actorId: string;
  country: string;
  filingKey: string;
  taxYear: number;
  revision: PayrollFilingRevision;
  /**
   * The rows the artifact covers. Required for a correction — an amendment
   * names the slips it restates — and ignored for an original, which by
   * definition covers the whole population.
   */
  rowIds?: readonly string[];
  note?: string | null;
  /**
   * The operator's explanation for a cancellation. The API requires this
   * separately from the generic filing note; accepting it here also makes the
   * engine boundary explicit for trusted internal callers.
   */
  reason?: string | null;
  /** Extra parameters the filing's own download builder parses. */
  params?: Record<string, string>;
}

export interface RecordFilingIssueResult {
  submission: PayrollFilingSubmission;
  /** The artifact produced, when the pack builds one. */
  file: PayrollFilingFile | null;
  /**
   * Why no file accompanies this issue, in the pack's own words. An issue
   * with no artifact is legitimate (a W-2 keyed into SSA BSO, a paper 941) —
   * but never silent.
   */
  fileRefusal: string | null;
  /** The correction rows the artifact carried, delta and all. */
  corrections: PayrollFilingCorrectionRow[];
}

/**
 * Record that a filing was ISSUED — the original, or a correction of it.
 *
 * Recording an issue is an EXPLICIT act, deliberately not a side effect of
 * downloading the file: downloading is not transmitting, and a lifecycle that
 * started itself the first time somebody previewed an XML would fill the
 * audit trail with filings that never happened.
 *
 * Everything is snapshotted at this moment: the artifact's exact bytes, and
 * every covered row's reported values. That snapshot is the "previously
 * reported" column of the next correction, and it is never touched again.
 */
export async function recordFilingIssue(
  input: RecordFilingIssueInput,
): Promise<RecordFilingIssueResult> {
  const { orgId, actorId, country, filingKey, taxYear, revision } = input;
  const cancellationReason = input.reason?.trim() || input.note?.trim() || null;
  const filing = yearEndFiling(country, filingKey);
  const submissions = await filingSubmissions(orgId, country, filingKey, taxYear);

  // Normalize the evidence once at the service boundary. A trusted caller
  // may use `reason`, while older callers may already supply the filing note;
  // either way a cancellation is persisted with the confirmed explanation.
  const normalizedInput = revision === "cancelled"
    ? { ...input, note: cancellationReason }
    : input;

  if (revision === "original") {
    return await issueOriginal(normalizedInput, filing, submissions);
  }
  return await issueCorrection(normalizedInput, filing, submissions, revision);
}

async function issueOriginal(
  input: RecordFilingIssueInput,
  filing: PayrollYearEndFiling,
  submissions: readonly PayrollFilingSubmission[],
): Promise<RecordFilingIssueResult> {
  const { orgId, country, filingKey, taxYear } = input;
  if (submissions.length > 0) {
    // A slip DISCOVERED after the return went out is neither an amendment nor
    // a cancellation: every agency here files it as an ADDITIONAL original
    // (the CRA's "adding slips"; an additional W-2 rather than a W-2c). That
    // needs the pack's file builder to emit a file scoped to the added slips,
    // which no `PayrollFilingDownload` can express today — and a whole-year
    // file re-sent as an original would give the agency two competing
    // returns. So it is a NAMED gap rather than a wrong file.
    throw new PayrollError(
      `${filing.label} for ${taxYear} has already been issued (revision `
      + `${submissions[submissions.length - 1]!.revisionNumber}, `
      + `${submissions[submissions.length - 1]!.revision}) — correct it with an amendment `
      + "or a cancellation; a second original would give the agency two competing returns. "
      + "Slips DISCOVERED since the return was filed are filed as additional originals, which "
      + "is not produced here: file those slips through the agency's own service and record "
      + "them there",
    );
  }
  const data = await filing.population(orgId, taxYear);
  const rows = data.rows;
  if (rows.length === 0) {
    throw new PayrollError(
      `${filing.label} has no rows for ${taxYear} — there is nothing to issue`,
    );
  }
  let file: PayrollFilingFile | null = null;
  let fileRefusal: string | null = null;
  if (filing.download) {
    file = await filing.download.build(orgId, taxYear, input.params ?? {});
  } else {
    fileRefusal = filing.downloadRefusal
      ?? `the ${country} "${filingKey}" filing declares no electronic file`;
  }

  const slips: PayrollFilingIssuedSlip[] = [];
  for (const row of rows) {
    const rowId = String(row[data.rowKey] ?? "");
    if (!rowId) continue;
    const current = await currentReported(filing, orgId, taxYear, data, row);
    slips.push({
      rowId, label: rowLabel(data, row), revision: "original", reported: current.reported,
    });
  }

  const submission = await persist(input, {
    revision: "original", revisionNumber: 1, supersedesId: null, file, slips,
  });
  return { submission, file, fileRefusal, corrections: [] };
}

async function issueCorrection(
  input: RecordFilingIssueInput,
  filing: PayrollYearEndFiling,
  submissions: readonly PayrollFilingSubmission[],
  revision: PayrollFilingCorrectionKind,
): Promise<RecordFilingIssueResult> {
  const { orgId, country, filingKey, taxYear } = input;
  const cancellationReason = input.reason?.trim() || input.note?.trim() || null;
  const amendment = filing.amendment;

  // The pack's own refusal, by name. This is the doctrine the product's
  // trustworthiness rests on: where an agency's correction format cannot be
  // produced correctly, nothing is produced at all.
  if (!amendment.supported) throw new PayrollError(amendment.refusal);
  if (!amendment.revisions.includes(revision)) {
    throw new PayrollError(
      `${filing.label} cannot be ${revision} — the ${country} pack declares `
      + `${amendment.revisions.join(", ")} for this filing`,
    );
  }
  if (submissions.length === 0) {
    throw new PayrollError(
      `${filing.label} for ${taxYear} has never been issued — there is nothing to `
      + `${revision === "cancelled" ? "cancel" : "amend"}. Record the original filing first`,
    );
  }

  const requested = [...new Set(input.rowIds ?? [])];
  if (requested.length === 0) {
    throw new PayrollError(
      `name the ${filing.label} rows to ${revision === "cancelled" ? "cancel" : "amend"} — `
      + "a correction restates named slips, never the whole return",
    );
  }

  const lifecycle = await filingLifecycle(orgId, country, filingKey, taxYear);
  if (lifecycle.populationRefusal && revision === "amended") {
    throw new PayrollError(
      `${filing.label} for ${taxYear} cannot be recomputed, so no amendment can be built: `
      + lifecycle.populationRefusal,
    );
  }
  const byRow = new Map(lifecycle.rows.map((row) => [row.rowId, row]));
  const issued = lastReportedByRow(submissions);

  const unknown = requested.filter((rowId) => !issued.has(rowId));
  if (unknown.length > 0) {
    throw new PayrollError(
      `these rows were never issued on a ${filing.label} for ${taxYear}, so they cannot be `
      + `${revision === "cancelled" ? "cancelled" : "amended"}: `
      + unknown.map((rowId) => byRow.get(rowId)?.label || rowId).join(", "),
    );
  }
  if (revision === "cancelled" && !cancellationReason) {
    throw new PayrollError(
      "a nonblank cancellation reason is required and is retained in the filing history",
    );
  }
  if (revision === "amended") {
    const unmoved = requested.filter((rowId) => {
      const review = byRow.get(rowId);
      return review == null || review.status === "unchanged";
    });
    if (unmoved.length > 0) {
      throw new PayrollError(
        "nothing changed on these slips, so amending them would restate the same figures to "
        + "the agency: "
        + unmoved.map((rowId) => byRow.get(rowId)?.label || rowId).join(", ")
        + " — correct the underlying payroll data first (the slip is recomputed from the "
        + "ledger, never typed over)",
      );
    }
    const gone = requested.filter((rowId) => byRow.get(rowId)?.status === "absent");
    if (gone.length > 0) {
      throw new PayrollError(
        "the payroll ledger no longer produces these slips at all, so there is nothing to "
        + "restate — cancel them instead: "
        + gone.map((rowId) => byRow.get(rowId)?.label || rowId).join(", "),
      );
    }
  }

  // The correction rows: what was reported, what is true now, and the delta —
  // computed ONCE, so the file the agency receives and the delta the operator
  // approved are the same object.
  const data = lifecycle.populationRefusal
    ? { rowKey: "rowId", columns: [], rows: [] } as PayrollFilingData
    : await filing.population(orgId, taxYear);
  const dataByRow = new Map(
    data.rows.map((row) => [String(row[data.rowKey] ?? ""), row] as const),
  );

  const corrections: PayrollFilingCorrectionRow[] = [];
  const slips: PayrollFilingIssuedSlip[] = [];
  for (const rowId of requested) {
    const previous = issued.get(rowId)!;
    const row = dataByRow.get(rowId);
    // A cancellation reports the slip AS FILED — the agency is being told
    // that this exact slip should not exist, so the values it carries are the
    // ones it carried, not a recomputation that may no longer produce them.
    const current = revision === "cancelled" || !row
      ? { slip: null, reported: previous.slip.reported }
      : await currentReported(filing, orgId, taxYear, data, row);
    const changes = revision === "cancelled"
      ? []
      : diffReported(previous.slip.reported, current.reported);
    corrections.push({
      rowId,
      label: byRow.get(rowId)?.label || previous.slip.label,
      revision,
      previously: previous.slip.reported,
      current: current.slip ?? reportedAsSlip(filing, previous.slip),
      changes,
    });
    slips.push({
      rowId,
      label: byRow.get(rowId)?.label || previous.slip.label,
      revision,
      reported: current.reported,
    });
  }

  let file: PayrollFilingFile | null = null;
  let fileRefusal: string | null = null;
  if (amendment.download) {
    file = await amendment.download.build({ orgId, taxYear, revision, rows: corrections });
  } else {
    fileRefusal = amendment.downloadRefusal ?? null;
  }

  const previousSubmission = submissions[submissions.length - 1]!;
  const submission = await persist(input, {
    revision,
    revisionNumber: previousSubmission.revisionNumber + 1,
    supersedesId: previousSubmission.id,
    file,
    slips,
  });
  return { submission, file, fileRefusal, corrections };
}

/**
 * A cancelled row's "current" slip: what the artifact actually reported. The
 * pack's correction renderer still receives a `PayrollFilingSlipData`, so a
 * cancellation prints through the same form-faithful pathway as everything
 * else instead of getting a bespoke shape.
 */
function reportedAsSlip(
  filing: PayrollYearEndFiling,
  slip: PayrollFilingIssuedSlip,
): PayrollFilingSlipData {
  return {
    formCode: `${filing.key.toUpperCase()}_ISSUED`,
    formName: filing.label,
    headerFields: slip.reported.fields
      .filter((field) => field.code == null)
      .map((field) => ({ label: field.label, value: field.value })),
    boxes: slip.reported.fields
      .filter((field) => field.code != null)
      .map((field) => ({ code: field.code!, label: field.label, value: field.value })),
  };
}

/** Insert the submission and its slip snapshots as one atomic act. */
async function persist(
  input: RecordFilingIssueInput,
  issue: {
    revision: PayrollFilingRevision;
    revisionNumber: number;
    supersedesId: string | null;
    file: PayrollFilingFile | null;
    slips: PayrollFilingIssuedSlip[];
  },
): Promise<PayrollFilingSubmission> {
  const { orgId, actorId, country, filingKey, taxYear } = input;
  const submissionId = await db.transaction(async (tx) => {
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into payroll_filing_submissions
        (org_id, country, filing_key, tax_year, revision, revision_number, supersedes_id,
         note, slip_count, artifact_filename, artifact_content_type, artifact_body,
         created_by, updated_by)
      values (${orgId}, ${country}, ${filingKey}, ${taxYear}, ${issue.revision},
              ${issue.revisionNumber}, ${issue.supersedesId}, ${input.note ?? null},
              ${issue.slips.length}, ${issue.file?.filename ?? null},
              ${issue.file?.contentType ?? null}, ${issue.file?.body ?? null},
              ${actorId}, ${actorId})
      returning id
    `));
    const id = inserted.rows[0]!.id;
    for (const slip of issue.slips) {
      await tx.execute(sql`
        insert into payroll_filing_submission_slips
          (org_id, submission_id, row_id, label, revision, reported, created_by, updated_by)
        values (${orgId}, ${id}, ${slip.rowId}, ${slip.label}, ${slip.revision},
                ${JSON.stringify(slip.reported)}::jsonb, ${actorId}, ${actorId})
      `);
    }
    return id;
  });
  const submissions = await filingSubmissions(orgId, country, filingKey, taxYear);
  return submissions.find((submission) => submission.id === submissionId)!;
}

// ---------------------------------------------------------------------------
// Rendering one correction
// ---------------------------------------------------------------------------

/**
 * One row's correction rendered as its statutory form — the pack's own
 * declaration, through the same form-faithful facsimile pathway every slip
 * uses. Refuses by name where the pack cannot produce one.
 */
export async function filingCorrectionSlip(
  orgId: string,
  country: string,
  filingKey: string,
  taxYear: number,
  rowId: string,
  revision: PayrollFilingCorrectionKind,
): Promise<PayrollFilingSlipData> {
  const filing = yearEndFiling(country, filingKey);
  if (!filing.amendment.supported) throw new PayrollError(filing.amendment.refusal);
  if (!filing.amendment.slip) {
    throw new PayrollError(
      `the ${country} "${filingKey}" filing declares no correction form to render — `
      + `${filing.amendment.downloadRefusal ?? "the correction is transmitted, not printed"}`,
    );
  }
  if (!filing.amendment.revisions.includes(revision)) {
    throw new PayrollError(
      `${filing.label} cannot be ${revision} — the ${country} pack declares `
      + `${filing.amendment.revisions.join(", ")} for this filing`,
    );
  }
  const submissions = await filingSubmissions(orgId, country, filingKey, taxYear);
  const previous = lastReportedByRow(submissions).get(rowId);
  if (!previous) {
    throw new PayrollError(
      `no issued ${filing.label} for ${taxYear} reported this row, so there is nothing to correct`,
    );
  }
  const lifecycle = await filingLifecycle(orgId, country, filingKey, taxYear);
  const review = lifecycle.rows.find((row) => row.rowId === rowId);
  const data = lifecycle.populationRefusal
    ? { rowKey: "rowId", columns: [], rows: [] } as PayrollFilingData
    : await filing.population(orgId, taxYear);
  const row = data.rows.find((candidate) => String(candidate[data.rowKey] ?? "") === rowId);
  const current = revision === "cancelled" || !row
    ? { slip: null, reported: previous.slip.reported }
    : await currentReported(filing, orgId, taxYear, data, row);
  return await filing.amendment.slip.build(
    {
      rowId,
      label: review?.label || previous.slip.label,
      revision,
      previously: previous.slip.reported,
      current: current.slip ?? reportedAsSlip(filing, previous.slip),
      changes: revision === "cancelled"
        ? []
        : diffReported(previous.slip.reported, current.reported),
    },
    orgId,
    taxYear,
  );
}
