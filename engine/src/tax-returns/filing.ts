import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import { db, withOrg } from "../platform/db.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import {
  computeTaxReturn,
  TaxReturnError,
  type TaxReturnResult,
  type TaxReturnTranslation,
} from "./return.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { canonicalPeriodLabel } from "../periods/period-policy.ts";
import { resolveCoveringPeriodsInWindow } from "../periods/period-resolution.ts";
import { periodScopeAdvisoryLock } from "../periods/period-locks.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import {
  aggregateTaxReturnAdjustments,
  normalizeTaxReturnAdjustments,
  type TaxReturnAdjustmentInput,
} from "./adjustments.ts";
export {
  aggregateTaxReturnAdjustments,
  normalizeTaxReturnAdjustments,
  TAX_RETURN_ADJUSTMENT_LIMIT,
  TAX_RETURN_ADJUSTMENT_REASON_MAX,
  type TaxReturnAdjustmentInput,
} from "./adjustments.ts";

/**
 * Tax filing lifecycle — the governed prepared → filed transition.
 *
 * Preparing (`web/app/api/tax/filings/route.ts`) computes the return live and
 * freezes an immutable snapshot, hashing it into `snapshot_hash`. That hash is
 * the filing's source-ledger fingerprint: it can only be reproduced while the
 * ledger, tax mappings and form configuration still yield the same return.
 *
 * Marking a filing filed certifies the frozen numbers to a government, so the
 * engine owns two fences at the transition:
 *
 *  1. GOVERNANCE — every accounting period the filing window touches must be
 *     closed for the gl and tax modules on the primary book. A closed period
 *     is frozen by the kernel's own write guards, so no further posting can
 *     silently diverge the ledger from the certified return.
 *  2. INTEGRITY — the return is recomputed from the live source ledger inside
 *     the same transaction and hashed through the same snapshot builder the
 *     prepare path used. Any drift — a journal, a posted tax document, a tax
 *     mapping or rate, even a renamed form — changes the hash and the filing
 *     is rejected as stale; the reviewer prepares a new version instead.
 *     Filings prepared at snapshot v2 additionally fingerprint the return's
 *     identity and posture (registration number/id, functional and
 *     presentation currency, subsidiary scope, translation evidence), so a
 *     registration change or a currency/scope change trips stale even when
 *     every box value still matches. Pre-v2 filings verify boxes only.
 *
 * Both fences must pass before `status` leaves 'prepared'. Zero rows are
 * written on rejection.
 */

export class TaxFilingError extends Error {
  readonly name = "TaxFilingError";
  constructor(
    /** Machine-readable failure the API maps to an HTTP status. */
    readonly code: "not-found" | "already-filed" | "period-not-closed" | "stale",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Snapshot schema version. v1 hashed form/period/channel/boxes/adjustments
 * only, so a registration change or a currency/scope posture change passed
 * the mark-filed staleness check whenever the box values still matched. v2
 * additionally hashes every identity/posture field below. Rows prepared
 * before the v2 columns existed keep version 1 and verify exactly as
 * prepared (boxes only) — they can never gain identity evidence that was
 * never frozen, and forcing them stale would strand every historical filing.
 *
 * v3 records adjustments as governed entries (line, amount, reason, author,
 * time) instead of a bare amount per line. Earlier versions keep their amount
 * map and verify exactly as prepared.
 */
export const TAX_FILING_SNAPSHOT_VERSION = 3;

export type TaxFilingSnapshotVersion = 1 | 2 | 3;

/** One recorded adjustment entry on a v3 filing. */
export interface TaxFilingAdjustment {
  lineCode: string;
  /** Exact decimal as displayed on the return (never sign-flipped). */
  amount: string;
  reason: string;
  /** The user who prepared the filing with this entry. */
  enteredBy: string;
  /** When the entry was recorded (ISO 8601). */
  enteredAt: string;
}

export interface TaxFilingSnapshot {
  /**
   * Present on v2 and v3 snapshots; ABSENT on v1 so a v1 payload hashes
   * byte-identically to the hash its prepare stored.
   */
  version?: number;
  formCode: string;
  formName: string;
  from: string;
  to: string;
  submissionChannel: string;
  /** The org's registration number travelling on the return (v2 and later). */
  registrationNumber?: string | null;
  /** The pinned or auto-matched tax_registrations id (v2 and later). */
  registrationId?: string | null;
  /** Denomination of `boxes` (v2 and later). */
  functionalCurrency?: string;
  /** Frozen filing-entity scope, sorted (v2 and later). */
  subsidiaryIds?: string[];
  /** Translation evidence for a translated consolidated view (v2 and later). */
  translation?: TaxReturnTranslation | null;
  boxes: {
    lineCode: string;
    label: string;
    value: string;
    computed: boolean;
    editable: boolean;
  }[];
  /** Amount per line (v1, v2) or the governed entries (v3). */
  adjustments: Record<string, string> | TaxFilingAdjustment[];
}

/**
 * Build the immutable filing snapshot and its SHA-256 fingerprint from a
 * computed return. Shared by prepare (captures the fingerprint) and mark-filed
 * (reproduces it) so the two paths can never disagree about what was hashed.
 *
 * `version` selects the schema: 3 (the default) for new filings, 2 or 1 to
 * reproduce the fingerprint of an earlier filing. Array order is
 * significant to the hash, so subsidiary ids sort here — the engine's scope
 * resolution reads subsidiaries in unspecified row order and two reads of the
 * same scope must fingerprint identically. Translation entities arrive sorted
 * from the return and are re-sorted defensively for the same reason; object
 * keys are normalized by canonicalJson.
 */
export function buildTaxFilingSnapshot(
  result: TaxReturnResult,
  adjustments: Record<string, string> | readonly TaxFilingAdjustment[],
  version: TaxFilingSnapshotVersion = TAX_FILING_SNAPSHOT_VERSION,
): { snapshot: TaxFilingSnapshot; snapshotHash: string } {
  const boxes = result.boxes.map((box) => ({
    lineCode: box.lineCode,
    label: box.label,
    value: box.value,
    computed: box.computed,
    editable: box.editable,
  }));
  const identity = {
    formCode: result.formCode,
    formName: result.formName,
    from: result.from,
    to: result.to,
    submissionChannel: result.submissionChannel,
  };
  let snapshot: TaxFilingSnapshot;
  if (version === 1) {
    if (Array.isArray(adjustments))
      throw new Error("snapshot version 1 records adjustments as amounts per line");
    snapshot = { ...identity, boxes, adjustments: { ...(adjustments as Record<string, string>) } };
  } else {
    // v2 and v3 share the identity and posture fields; v3 swaps the amount
    // map for the governed entries, sorted so the fingerprint never depends
    // on the order the filer entered them.
    if (version === 2 && Array.isArray(adjustments)) {
      throw new Error("snapshot version 2 records adjustments as amounts per line");
    }
    if (version === 3 && !Array.isArray(adjustments)) {
      throw new Error("snapshot version 3 records adjustments as governed entries");
    }
    snapshot = {
      version,
      ...identity,
      registrationNumber: result.registrationNumber,
      registrationId: result.registrationId,
      functionalCurrency: result.functionalCurrency,
      subsidiaryIds: [...result.subsidiaryIds].sort(),
      translation: result.translation
        ? {
            ...result.translation,
            entities: result.translation.entities
              .map((entity) => ({
                ...entity,
                boxes: entity.boxes.map((box) => ({ ...box })),
              }))
              .sort((a, b) => a.subsidiaryId.localeCompare(b.subsidiaryId)),
          }
        : null,
      boxes,
      adjustments:
        version === 3
          ? sortTaxFilingAdjustments(adjustments as readonly TaxFilingAdjustment[])
          : { ...(adjustments as Record<string, string>) },
    };
  }
  // JSONB does not preserve object insertion order. Canonicalize before
  // hashing so prepare and mark-filed derive the same fingerprint after the
  // adjustments object makes a database round trip.
  const snapshotHash = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  return { snapshot, snapshotHash };
}

/** Code-unit comparison: the fingerprint must not depend on the host locale. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic order for recorded entries: line, then time, reason, amount and author. */
export function sortTaxFilingAdjustments(
  entries: readonly TaxFilingAdjustment[],
): TaxFilingAdjustment[] {
  return entries
    .map((entry) => ({ ...entry }))
    .sort(
      (a, b) =>
        compareCodeUnits(a.lineCode, b.lineCode) ||
        compareCodeUnits(a.enteredAt, b.enteredAt) ||
        compareCodeUnits(a.reason, b.reason) ||
        compareCodeUnits(a.amount, b.amount) ||
        compareCodeUnits(a.enteredBy, b.enteredBy),
    );
}

type FilingRow = {
  id: string;
  form_code: string;
  period_from: string;
  period_to: string;
  status: "prepared" | "filed";
  adjustments: Record<string, string> | TaxFilingAdjustment[];
  snapshot_hash: string;
  snapshot_version: number | null;
  subsidiary_ids: string[] | null;
  registration_id: string | null;
  translation: TaxReturnTranslation | null;
};

/**
 * Every posting-calendar period the filing window touches, closed for gl AND
 * tax on the primary book. The covered legal entities are the filing's FROZEN
 * subsidiary scope — the exact set the return summed — so closing one
 * entity's periods certifies that entity's filing while an unrelated entity
 * stays open. A filing with no frozen scope (pre-snapshot, NULL) is the
 * legacy org-wide return and still needs every active, non-elimination
 * subsidiary closed. A frozen scope naming subsidiaries outside this
 * organization fails closed by name: the scope can no longer be honored, so
 * the filing is stale, not certifiable.
 *
 * The effective lock for each entity is its subsidiary row when one exists,
 * otherwise the org-wide default. This means an org-wide close may govern
 * every entity, but a scoped close must cover every entity and a scoped
 * reopen cannot be hidden by an older org-wide close. Only an explicit
 * `closed` state is evidence; open, soft-closed, or lapsed-reopen rows fail
 * closed.
 */
async function assertCoveredPeriodsClosed(
  orgId: string,
  from: string,
  to: string,
  subsidiaryIds: string[] | null,
): Promise<void> {
  // The shared active posting primary — never a deactivated primary.
  const bookId = await activePostingPrimaryBookId(orgId);
  if (!bookId) throw new TaxFilingError("period-not-closed", "no primary accounting book");

  // The window resolves through the shared posting-calendar resolver, never
  // an unscoped period read: an alternate planning calendar's open periods
  // must not hold a posting fence hostage.
  const periods = await resolveCoveringPeriodsInWindow(db, orgId, from, to);
  if (periods.length === 0) {
    throw new TaxFilingError(
      "period-not-closed",
      `no accounting period covers ${from}..${to} — generate the fiscal calendar before filing`,
    );
  }

  // Controlled reopen and close writers serialize on this period/book fence.
  // Take every lock in a stable order and retain them through mark-filed's
  // status and audit writes, so a reopen cannot commit after this check while
  // the filing is being certified against the now-open period.
  for (const period of [...periods].sort((a, b) => a.id.localeCompare(b.id))) {
    await periodScopeAdvisoryLock(db, orgId, period.id, bookId);
  }

  // A frozen scope that no longer resolves is not an empty covered set (which
  // would certify against org-wide locks alone) — it is a filing whose terms
  // changed after preparation. A frozen scope is honored EXACTLY (no
  // active/elimination filter): the scope was validated at prepare time, and
  // silently dropping a deactivated entity from the fence would certify a
  // narrower world than the return summed.
  let coveredWhere: ReturnType<typeof sql>;
  if (subsidiaryIds === null) {
    coveredWhere = sql`where s.org_id = ${orgId} and s.is_active and not s.is_elimination`;
  } else if (subsidiaryIds.length === 0) {
    coveredWhere = sql`where false`;
  } else {
    const known = (
      await db.execute<{ id: string }>(
        sql`
      select id from subsidiaries
       where org_id = ${orgId} and id = any(${uuidArray(subsidiaryIds)}::uuid[])`,
        "objects",
      )
    ).map((r) => r.id);
    const missing = subsidiaryIds.filter((id) => !known.includes(id));
    if (missing.length > 0) {
      throw new TaxFilingError(
        "stale",
        `filing's frozen subsidiary scope references subsidiaries outside this organization: ${missing.join(", ")} — prepare a new version`,
      );
    }
    coveredWhere = sql`where s.org_id = ${orgId} and s.id = any(${uuidArray(subsidiaryIds)}::uuid[])`;
  }

  for (const module of ["gl", "tax"] as const) {
    for (const period of periods) {
      const closure = await db.execute<{
        covered: number;
        closed: number;
        org_wide_closed: number;
      }>(
        sql`
        with covered_entities as (
          select s.id
            from subsidiaries s
           ${coveredWhere}
        )
        select
          count(*)::int as covered,
          count(*) filter (
            where coalesce(scoped.state, org_wide.state) = 'closed'
          )::int as closed,
          (
            select count(*)::int
              from period_locks l
             where l.org_id = ${orgId}
               and l.period_id = ${period.id}
               and l.book_id = ${bookId}
               and l.module = ${module}
               and l.subsidiary_id is null
               and l.state = 'closed'
          ) as org_wide_closed
          from covered_entities entity
          left join period_locks scoped
            on scoped.org_id = ${orgId}
           and scoped.period_id = ${period.id}
           and scoped.book_id = ${bookId}
           and scoped.module = ${module}
           and scoped.subsidiary_id = entity.id
          left join period_locks org_wide
            on org_wide.org_id = ${orgId}
           and org_wide.period_id = ${period.id}
           and org_wide.book_id = ${bookId}
           and org_wide.module = ${module}
           and org_wide.subsidiary_id is null`,
        "objects",
      );
      const row = closure[0];
      const covered = Number(row?.covered ?? 0);
      const closed = Number(row?.closed ?? 0);
      const orgWideClosed = Number(row?.org_wide_closed ?? 0) > 0;
      // Organizations normally always have a root subsidiary. If malformed
      // data leaves no active legal entity, retain the historical org-wide
      // fence rather than accidentally treating an empty set as closed.
      const satisfiesFence = covered === 0 ? orgWideClosed : closed === covered;
      if (!satisfiesFence) {
        throw new TaxFilingError(
          "period-not-closed",
          `period ${canonicalPeriodLabel({ fiscalYear: period.fiscal_year, periodNumber: period.period_number, adjustment: false })} must be closed for ${module} across every covered subsidiary before the filing can be marked filed`,
        );
      }
    }
  }
}

/**
 * The `computeTaxReturn` options that reproduce a frozen filing: its
 * subsidiary scope and pinned registration as the filing entity, its stored
 * translation evidence as the declared policy. A v2 filing with an empty
 * scope and no registration is the degenerate org-wide return and replays no
 * filing entity (the engine reads that as the historical unpredicated
 * scope); a NULL scope is a pre-snapshot (v1) filing and replays no posture
 * at all, so it verifies boxes only, exactly as prepared.
 */
function frozenReturnOpts(row: FilingRow): {
  filingEntity?: { subsidiaryIds: string[]; registrationId?: string };
  translation?: { presentationCurrency: string; rateType: string; rateDate: string };
} {
  if (frozenSnapshotVersion(row.snapshot_version) < 2) return {};
  const scopeIds = row.subsidiary_ids ?? [];
  const filingEntity =
    scopeIds.length > 0 || row.registration_id
      ? {
          subsidiaryIds: scopeIds,
          ...(row.registration_id ? { registrationId: row.registration_id } : {}),
        }
      : undefined;
  const translation = row.translation
    ? {
        presentationCurrency: row.translation.presentationCurrency,
        rateType: row.translation.rateType,
        rateDate: row.translation.rateDate,
      }
    : undefined;
  return {
    ...(filingEntity ? { filingEntity } : {}),
    ...(translation ? { translation } : {}),
  };
}

/** The snapshot schema a stored row was fingerprinted under (pre-v2 rows are v1). */
function frozenSnapshotVersion(stored: number | null): TaxFilingSnapshotVersion {
  if (stored === null || stored === 1) return 1;
  if (stored === 2 || stored === 3) return stored;
  throw new TaxFilingError(
    "stale",
    "this filing uses an unsupported snapshot version — use an application version that supports it",
  );
}

/** The recorded entries of a v3 filing; the amount map of an earlier one. */
function frozenAdjustmentEntries(
  row: FilingRow,
  version: TaxFilingSnapshotVersion,
): Record<string, string> | TaxFilingAdjustment[] {
  if (version === 3) {
    if (!Array.isArray(row.adjustments)) {
      throw new TaxFilingError(
        "stale",
        "the filing's recorded adjustment evidence is missing — prepare a new version",
      );
    }
    if (
      row.adjustments.some(
        (entry) =>
          !entry ||
          typeof entry.lineCode !== "string" ||
          typeof entry.amount !== "string" ||
          typeof entry.reason !== "string" ||
          typeof entry.enteredBy !== "string" ||
          !entry.enteredBy.trim() ||
          typeof entry.enteredAt !== "string" ||
          Number.isNaN(Date.parse(entry.enteredAt)),
      )
    ) {
      throw new TaxFilingError(
        "stale",
        "the filing's recorded adjustment evidence is incomplete — prepare a new version",
      );
    }
    try {
      normalizeTaxReturnAdjustments(row.adjustments);
    } catch (error) {
      if (!(error instanceof TaxReturnError)) throw error;
      throw new TaxFilingError(
        "stale",
        `the filing's recorded adjustment evidence cannot be verified (${error.message}) — prepare a new version`,
      );
    }
    return row.adjustments;
  }
  if (!row.adjustments || Array.isArray(row.adjustments) || typeof row.adjustments !== "object") {
    throw new TaxFilingError(
      "stale",
      "the filing's recorded adjustment amounts cannot be verified — prepare a new version",
    );
  }
  return row.adjustments;
}

/** Per-line amounts the return computation replays for the stored adjustments. */
function frozenAmounts(row: FilingRow, version: TaxFilingSnapshotVersion): Record<string, string> {
  const entries = frozenAdjustmentEntries(row, version);
  return Array.isArray(entries) ? aggregateTaxReturnAdjustments(entries) : entries;
}

/**
 * Record a prepared filing: the immutable snapshot, its fingerprint, and one
 * audit row per adjustment entry. The adjustment entries are validated against
 * the computed return, so a recorded amount always lands on an adjustment line
 * of the same return with the same total. Filings are numbered per period and
 * the write takes the same advisory lock mark-filed takes. Zero rows are
 * written on rejection.
 */
export async function prepareTaxFiling(
  orgId: string,
  actorId: string,
  result: TaxReturnResult,
  inputs: readonly TaxReturnAdjustmentInput[],
): Promise<{ id: string; version: number }> {
  if (!actorId) throw new TaxReturnError("an attributable filing actor is required");
  const entries = normalizeTaxReturnAdjustments(inputs);
  const totals = aggregateTaxReturnAdjustments(entries);
  for (const [lineCode, total] of Object.entries(totals)) {
    const box = result.boxes.find((candidate) => candidate.lineCode === lineCode);
    if (!box || !box.editable || box.computed || box.inputKey) {
      throw new TaxReturnError(
        `line ${lineCode} is not an adjustment line of this return — enter adjustments only on lines that take a manual amount`,
      );
    }
    if (box.value !== fromUnits(toUnits(total))) {
      throw new TaxReturnError(
        `the return on line ${lineCode} no longer matches the entered adjustments — recompute the return before saving`,
      );
    }
  }
  for (const box of result.boxes.filter((box) => box.editable && !box.computed && !box.inputKey)) {
    if (box.value !== fromUnits(toUnits(totals[box.lineCode] ?? "0"))) {
      throw new TaxReturnError(
        `the return on line ${box.lineCode} has an amount without matching adjustment evidence — recompute the return before saving`,
      );
    }
  }
  const enteredAt = new Date().toISOString();
  const adjustments = sortTaxFilingAdjustments(
    entries.map((entry) => ({ ...entry, enteredBy: actorId, enteredAt })),
  );
  const { snapshot, snapshotHash } = buildTaxFilingSnapshot(
    result,
    adjustments,
    TAX_FILING_SNAPSHOT_VERSION,
  );

  return await withOrg(orgId, async () => {
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtext(${`tax-filing:${orgId}:${snapshot.formCode}:${snapshot.from}:${snapshot.to}`}))`);
    const form = (
      await db.execute<{ country: string | null }>(
        sql`
      select country from tax_return_forms
       where org_id = ${orgId} and code = ${snapshot.formCode} limit 1`,
        "objects",
      )
    )[0];
    if (!form)
      throw new TaxReturnError(
        "the return form is no longer available — choose an available form and recompute",
      );
    const versions = await db.execute<{ version: number }>(
      sql`
      select coalesce(max(version), 0)::int + 1 as version
        from tax_filings
       where org_id = ${orgId} and form_code = ${snapshot.formCode}
         and period_from = ${snapshot.from} and period_to = ${snapshot.to}`,
      "objects",
    );
    const version = Number(versions[0]?.version ?? 1);
    // The filing freezes the return's identity and currency posture alongside
    // its boxes: the export reprint and the mark-filed staleness check read
    // these columns, never the org's live configuration. An org-wide return
    // stores an empty scope, not NULL — NULL means pre-snapshot.
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into tax_filings
        (org_id, form_code, form_name, country, period_from, period_to, version,
         status, submission_channel, boxes, adjustments, snapshot_hash,
         functional_currency, presentation_currency, translation, subsidiary_ids,
         registration_id, registration_number, snapshot_version,
         created_by, updated_by)
      values (${orgId}, ${snapshot.formCode}, ${snapshot.formName}, ${form?.country ?? null},
              ${snapshot.from}, ${snapshot.to}, ${version}, 'prepared', ${snapshot.submissionChannel},
              ${JSON.stringify(snapshot.boxes)}::jsonb, ${JSON.stringify(snapshot.adjustments)}::jsonb,
              ${snapshotHash},
              ${snapshot.functionalCurrency!}, ${snapshot.translation?.presentationCurrency ?? null},
              ${snapshot.translation ? JSON.stringify(snapshot.translation) : null}::jsonb,
              ${`{${snapshot.subsidiaryIds!.join(",")}}`}::uuid[],
              ${snapshot.registrationId ?? null}, ${snapshot.registrationNumber ?? null}, ${TAX_FILING_SNAPSHOT_VERSION},
              ${actorId}, ${actorId})
      returning id`,
      "objects",
    );
    const row = inserted[0];
    if (inserted.length !== 1 || !row) {
      throw new TaxReturnError("the filing could not be recorded — prepare it again");
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'tax_filings', ${row.id}, 'insert',
              ${JSON.stringify({
                status: "prepared",
                formCode: snapshot.formCode,
                from: snapshot.from,
                to: snapshot.to,
                version,
                snapshotHash,
                snapshotVersion: TAX_FILING_SNAPSHOT_VERSION,
              })}::jsonb,
              ${actorId})`);
    for (const entry of adjustments) {
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'tax_filings', ${row.id}, 'insert',
                ${JSON.stringify({
                  adjustment: {
                    lineCode: entry.lineCode,
                    amount: entry.amount,
                    reason: entry.reason,
                  },
                  before: null,
                  after: entry,
                })}::jsonb,
                ${actorId})`);
    }
    return { id: row.id, version };
  });
}

/**
 * Record the one-way prepared → filed transition. Runs in one tenant
 * transaction: governance gate, live recompute + fingerprint verification,
 * then the status write and its audit evidence. Throws {@link TaxFilingError}
 * with a machine-readable code on every rejection path — nothing is written.
 */
export async function markTaxFilingFiled(
  orgId: string,
  filingId: string,
  actorId: string,
  filingReference: string | null,
): Promise<{ id: string; filedAt: Date }> {
  if (!actorId) {
    throw new TaxFilingError("not-found", "an attributable filing actor is required");
  }
  return await withOrg(orgId, async () => {
    const filing = await db.execute<FilingRow>(
      sql`
      select id, form_code, period_from, period_to, status, adjustments, snapshot_hash,
             snapshot_version, subsidiary_ids, registration_id, translation
        from tax_filings
       where id = ${filingId} and org_id = ${orgId}
         for update`,
      "objects",
    );
    const row = filing[0];
    if (!row) throw new TaxFilingError("not-found", "tax filing not found");
    if (row.status !== "prepared") {
      throw new TaxFilingError("already-filed", "filing is already filed");
    }

    // Serialize against a concurrent prepare of the same period identity —
    // the exact advisory key the prepare path takes.
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtext(${`tax-filing:${orgId}:${row.form_code}:${row.period_from}:${row.period_to}`}))`);

    // GOVERNANCE — the covered periods must be closed before certifying.
    // The fence covers the filing's FROZEN subsidiary scope, never every
    // entity unconditionally: an unrelated open entity cannot alter a scoped
    // filing's fenced source or hash.
    await assertCoveredPeriodsClosed(orgId, row.period_from, row.period_to, row.subsidiary_ids);

    // INTEGRITY — reproduce the prepare-time fingerprint from the live source
    // ledger on this transaction's pinned connection: computeTaxReturn runs on
    // the caller's executor, so verification and the status write hold exactly
    // one pool connection and see one consistent world. (A dedicated handle
    // here would pin a second pool client for the whole recompute and
    // deadlock a saturated pool.)
    //
    // The recompute replays the filing's FROZEN posture — its subsidiary
    // scope, pinned registration and translation policy — never the org-wide
    // default. A scoped or translated filing verified org-wide would either
    // throw on mixed currency or hash a different posture and read stale on
    // every filing that was prepared exactly as requested. Pre-identity (v1)
    // filings replay no posture and verify boxes only, exactly as prepared.
    const snapshotVersion = frozenSnapshotVersion(row.snapshot_version);
    const frozenAdjustments = frozenAdjustmentEntries(row, snapshotVersion);
    let live: TaxReturnResult;
    try {
      live = await computeTaxReturn(
        orgId,
        row.form_code,
        row.period_from,
        row.period_to,
        frozenAmounts(row, snapshotVersion),
        { ...frozenReturnOpts(row), runner: db },
      );
    } catch (error) {
      if (error instanceof TaxReturnError) {
        throw new TaxFilingError(
          "stale",
          `filing can no longer be verified against its source ledger (${error.message}) — prepare a new version`,
        );
      }
      throw error;
    }
    // The fingerprint schema is the filing's own: a pre-identity (v1) filing
    // reproduces its boxes-only hash, so it verifies exactly as prepared; a
    // v2 filing additionally reproduces its registration, currency and scope
    // posture, so any of those drifting after preparation trips stale; a v3
    // filing also reproduces its recorded adjustment entries.
    const { snapshotHash } = buildTaxFilingSnapshot(live, frozenAdjustments, snapshotVersion);
    if (snapshotHash !== row.snapshot_hash) {
      throw new TaxFilingError(
        "stale",
        "filing is stale: the covered period's ledger or return configuration changed after preparation — prepare a new version",
      );
    }

    const updated = await db.execute<{ id: string; filed_at: Date }>(
      sql`
      update tax_filings
         set status = 'filed', filing_reference = ${filingReference}, filed_at = now(),
             updated_at = now(), updated_by = ${actorId}
       where id = ${row.id} and org_id = ${orgId}
      returning id, filed_at`,
      "objects",
    );
    if (updated.length !== 1 || !updated[0]) {
      throw new TaxFilingError(
        "stale",
        "the filing could not be marked filed — reload it before retrying",
      );
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'tax_filings', ${row.id}, 'update',
              ${JSON.stringify({
                before: { status: "prepared" },
                after: {
                  status: "filed",
                  filingReference: filingReference,
                  snapshotHash: row.snapshot_hash,
                  sourceVerified: true,
                },
              })}::jsonb,
              ${actorId})`);
    return { id: updated[0]!.id, filedAt: updated[0]!.filed_at };
  });
}
