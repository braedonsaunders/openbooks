import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/platform/db";
import { getAuthz, resolveUserAuthz, can, type Authz } from "./authz";
import { canRunReportEntity, canRunReportStatement, reportEntityPermission } from "./report-authz";
import type { SessionUser } from "./auth";
import { REPORT_ENTITY_MAP } from "@openbooks/reports";
import { expenseScope } from "./expense-access";

const execution = new AsyncLocalStorage<Authz>();
export const withReportAuthz = <T>(authz: Authz, action: () => T): T =>
  execution.run(authz, action);

/** Every web report execution requires a verified request or durable principal. */
export async function requireReportAuthz(orgId: string): Promise<Authz> {
  const authz = execution.getStore() ?? (await getAuthz());
  if (!authz || authz.user.orgId !== orgId || !can(authz, "reports.read")) {
    throw new Error("Report access denied");
  }
  return authz;
}

export type ReportAuthorization = {
  version: 1;
  userId: string;
  allowedSubsidiaryIds: string[] | null;
  /** Extra permissions the RENDERED content required beyond the definition
   * gate — e.g. payroll.read for a journal/GL artifact bearing pay-run
   * lines, whose kind is gated by the reports feature only. Recorded at
   * render time; downloads refuse viewers who lack them (by name) instead
   * of re-rendering per viewer. Absent on artifacts rendered before the
   * field existed: those keep the definition-level gate only. */
  requiredPermissions?: string[];
  /** Which expense report rows the content includes, for a query over an
   * entity whose rows include expense reports: every report, the reports of
   * one user's linked person, or none. A download needs the same reach: an
   * org-wide expense reader, or that same user. Absent on such an artifact
   * (rendered before recording), it is treated as including every report. */
  expenseRows?: ReportArtifactExpenseRows;
  /** Append-only evidence of each background render of this run: when it
   * rendered, the expense report rows its content holds (null when the
   * content reads no entity holding them) and the rendered content's hash.
   * A render reads with its principal's authority at render time, so this,
   * not the authorization above, says what a rendered artifact holds. */
  renders?: ReportRenderEvidence[];
  definition: {
    report_type: "query" | "statement";
    query: unknown;
    statement: { kind?: string; params?: Record<string, string> } | null;
    name: string;
    slug: string;
    kind: string;
  };
};

export type ReportArtifactExpenseRows =
  { scope: "all" } | { scope: "own"; userId: string } | { scope: "none" };

export type ReportRenderEvidence = {
  renderedAt: string;
  expenseRows: ReportArtifactExpenseRows | null;
  contentHash?: string;
};

/** True when a query definition reads an entity whose rows include expense reports. */
function queryIncludesExpenseRows(query: unknown): boolean {
  const key =
    query && typeof query === "object" ? (query as { entity?: unknown }).entity : undefined;
  return typeof key === "string" && Boolean(REPORT_ENTITY_MAP[key]?.expenseRows);
}

/** The expense report rows a reader's run of this query includes, or undefined when it reads no such entity. */
export function artifactExpenseRows(
  authz: Authz,
  query: unknown,
): ReportArtifactExpenseRows | undefined {
  if (!queryIncludesExpenseRows(query)) return undefined;
  const scope = expenseScope(authz, "read");
  return scope === "all"
    ? { scope: "all" }
    : scope === "own"
      ? { scope: "own", userId: authz.user.id }
      : { scope: "none" };
}

/**
 * A schedule authorized to deliver expense reports whose principal now holds
 * no expense read at all. Narrower or wider access renders with the
 * principal's current authority; losing it entirely is refused, so the
 * schedule does not quietly deliver a report stripped of what it was set up
 * to show.
 */
export function expenseReadRevoked(
  authorized: ReportArtifactExpenseRows | undefined,
  rendered: ReportArtifactExpenseRows | undefined,
): boolean {
  return authorized !== undefined && authorized.scope !== "none" && rendered?.scope === "none";
}

export const EXPENSE_READ_REVOKED_REMEDY =
  "The schedule owner no longer holds expense read (expenses.read, or expenses.self for their own reports) and this schedule delivers expense reports: restore the owner's expense access, or create the schedule again under a user who holds it.";

/**
 * The expense report rows stored output holds. Rendered output answers from
 * its render evidence: the render whose content hash matches, or every render
 * of the run when the bytes are not identified. Output with no render
 * evidence answers from its authorization (absent: every report).
 */
function storedExpenseReaches(
  snapshot: ReportAuthorization,
  contentHash: string | undefined,
): ReportArtifactExpenseRows[] {
  const renders = Array.isArray(snapshot.renders) ? snapshot.renders : [];
  if (renders.length > 0) {
    const matching = contentHash
      ? renders.filter((render) => render?.contentHash === contentHash)
      : [];
    return (matching.length > 0 ? matching : renders).map(
      (render) => render?.expenseRows ?? { scope: "none" },
    );
  }
  if (
    snapshot.definition.report_type === "query" &&
    queryIncludesExpenseRows(snapshot.definition.query)
  ) {
    return [snapshot.expenseRows ?? { scope: "all" }];
  }
  return [];
}

export function snapshotReportAuthorization(
  authz: Authz,
  definition: ReportAuthorization["definition"],
): ReportAuthorization {
  // Query definitions name their entity permission up front (a payroll
  // register snapshot carries payroll.read from creation). Statement content
  // is data-dependent, so the render stamps requiredPermissions later.
  const entityPermission =
    definition.report_type === "query" ? reportEntityPermission(definition.query) : null;
  const expenseRows =
    definition.report_type === "query" ? artifactExpenseRows(authz, definition.query) : undefined;
  return {
    version: 1,
    userId: authz.user.id,
    allowedSubsidiaryIds:
      authz.allowedSubsidiaryIds === null ? null : [...authz.allowedSubsidiaryIds].sort(),
    ...(entityPermission ? { requiredPermissions: [entityPermission] } : {}),
    ...(expenseRows ? { expenseRows } : {}),
    definition,
  };
}

export async function canAccessReportDefinition(
  authz: Authz,
  def: ReportAuthorization["definition"],
): Promise<boolean> {
  return (
    can(authz, "reports.read") &&
    (def.report_type === "statement"
      ? Boolean(def.statement?.kind) &&
        (await canRunReportStatement(authz, def.statement?.kind, def.statement?.params))
      : Boolean(def.query) && (await canRunReportEntity(authz, def.query)))
  );
}

/** Historical output requires the original data permissions and the entire
 * original scope. A narrower reader cannot safely consume unfiltered bytes. */
export type ReportArtifactAccess =
  { ok: true; missingPermissions: [] } | { ok: false; missingPermissions: string[] };

/**
 * `expenseReach: false` is for re-authorizing the principal of a background
 * render: that render's expense rows are clamped by the principal's current
 * expense read, so only readers of the stored output need its reach.
 * `contentHash` identifies the stored bytes, so the render that produced them
 * answers for them.
 */
export async function reportArtifactAccessDetail(
  authz: Authz,
  raw: unknown,
  options: { expenseReach?: boolean; contentHash?: string } = {},
): Promise<ReportArtifactAccess> {
  if (!raw || typeof raw !== "object") return { ok: false, missingPermissions: [] };
  const snapshot = raw as ReportAuthorization;
  if (
    snapshot.version !== 1 ||
    !snapshot.definition ||
    !(snapshot.allowedSubsidiaryIds === null || Array.isArray(snapshot.allowedSubsidiaryIds))
  )
    return { ok: false, missingPermissions: [] };
  if (
    authz.allowedSubsidiaryIds !== null &&
    (snapshot.allowedSubsidiaryIds === null ||
      !snapshot.allowedSubsidiaryIds.every((id) => authz.allowedSubsidiaryIds!.has(id)))
  )
    return { ok: false, missingPermissions: [] };
  if (!(await canAccessReportDefinition(authz, snapshot.definition)))
    return { ok: false, missingPermissions: [] };
  // Stored expense report rows reach only a reader with the same expense reach.
  if (options.expenseReach !== false) {
    const reach = expenseScope(authz, "read");
    const readable = (contained: ReportArtifactExpenseRows) =>
      contained.scope === "none" ||
      reach === "all" ||
      (contained.scope === "own" && reach === "own" && contained.userId === authz.user.id);
    if (!storedExpenseReaches(snapshot, options.contentHash).every(readable))
      return { ok: false, missingPermissions: ["expenses.read"] };
  }
  // Render-time content permissions: a malformed record fails closed with no
  // names to give; an absent one predates recording (definition gate only).
  if (snapshot.requiredPermissions === undefined) return { ok: true, missingPermissions: [] };
  if (
    !Array.isArray(snapshot.requiredPermissions) ||
    !snapshot.requiredPermissions.every((p) => typeof p === "string")
  )
    return { ok: false, missingPermissions: [] };
  const missing = snapshot.requiredPermissions.filter((p) => !can(authz, p));
  if (missing.length > 0) return { ok: false, missingPermissions: missing };
  return { ok: true, missingPermissions: [] };
}

export async function canAccessReportArtifact(authz: Authz, raw: unknown): Promise<boolean> {
  return (await reportArtifactAccessDetail(authz, raw)).ok;
}

/** Load the durable principal behind a background render: the user the
 * run was minted for, still active and still attached to this org. */
async function loadReportPrincipal(
  orgId: string,
  snapshot: ReportAuthorization,
): Promise<SessionUser> {
  if (snapshot?.version !== 1 || !snapshot.userId)
    throw new Error("Report schedule requires reauthorization");
  // bypass: user-keyed-lookup — the principal a scheduled render runs as may have a home identity in another organization.
  const row = await withBypassContext(
    async () =>
      (
        await db.execute<{
          id: string;
          email: string;
          name: string;
          org_id: string;
          is_super_admin: boolean;
        }>(
          sql`
    select u.id, u.email, u.name, u.org_id, u.is_super_admin from users u
     where u.id = ${snapshot.userId} and u.is_active
       and (u.org_id = ${orgId} or u.is_super_admin or exists (
         select 1 from role_assignments a where a.user_id = u.id and a.org_id = ${orgId}
       ))
  `,
          "objects",
        )
      )[0],
  );
  if (!row) throw new Error("Report execution principal is inactive or unavailable");
  return {
    ...row,
    orgId,
    roles: [],
    envKind: "production",
    productionOrgId: orgId,
    homeUserId: row.id,
    homeOrgId: row.org_id,
    isSuperAdmin: row.is_super_admin,
  };
}

/** Durable principal behind a statement-batch render: the batch creator, re-resolved at execution. */
export type StatementBatchAuthorization = Pick<
  ReportAuthorization,
  "version" | "userId" | "allowedSubsidiaryIds"
>;

/**
 * Authorize a batched-statement render minted by a batch run. Same shape as
 * a scheduled render — a durable principal re-resolved at execution, never
 * a saved permission set — but under send authority: the creator must still
 * hold the statement send grants (ar.create with its ar.read/reports.read
 * render pair), or the render fails with the remedy (create a new batch
 * run) instead of delivering.
 */
/**
 * A revoked sender refusal: the batch creator no longer holds the send
 * grants. It answers 403 with its remedy; anything else from principal
 * resolution is unexpected and answers through the shared mapping.
 */
export class StatementBatchSenderError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "StatementBatchSenderError";
  }
}

export async function statementBatchReportAuthz(
  orgId: string,
  snapshot: StatementBatchAuthorization,
): Promise<Authz> {
  const user = await loadReportPrincipal(orgId, snapshot as ReportAuthorization);
  const current = await resolveUserAuthz(user);
  for (const permission of ["ar.create", "ar.read", "reports.read"] as const) {
    if (!can(current, permission)) {
      throw new StatementBatchSenderError(
        `Statement batch sender no longer holds ${permission} — create a new batch run`,
      );
    }
  }
  return narrowToSnapshotScope(current, snapshot as ReportAuthorization);
}

/** Narrow a re-resolved principal to the run's pinned subsidiary scope. */
function narrowToSnapshotScope(current: Authz, snapshot: ReportAuthorization): Authz {
  return {
    ...current,
    allowedSubsidiaryIds:
      snapshot.allowedSubsidiaryIds === null ? null : new Set(snapshot.allowedSubsidiaryIds),
  };
}

/** Re-resolve active membership and grants at execution, never trust a saved
 * permission set. Deactivation/revocation fails the run; grants cannot widen it. */
export async function scheduledReportAuthz(
  orgId: string,
  snapshot: ReportAuthorization,
): Promise<Authz> {
  const user = await loadReportPrincipal(orgId, snapshot);
  const current = await resolveUserAuthz(user);
  if (
    !can(current, "reports.schedule") ||
    !(await reportArtifactAccessDetail(current, snapshot, { expenseReach: false })).ok
  ) {
    throw new Error("Report execution permission was revoked");
  }
  return narrowToSnapshotScope(current, snapshot);
}

/**
 * Authorize a close-package render minted by the close-delivery worker.
 * Same shape as a scheduled render — a durable principal re-resolved at
 * execution, never a saved permission set — but under close authority:
 * the publish path needs the sender to still hold close.run, the manual
 * send-now path needs periods.manage, and both need to still run the
 * definition itself. Either half revoked fails the render with the
 * remedy (re-send the package) instead of delivering.
 */
export async function closePackageReportAuthz(
  orgId: string,
  snapshot: ReportAuthorization,
  closePackage: { runId: string | null },
): Promise<Authz> {
  const user = await loadReportPrincipal(orgId, snapshot);
  const current = await resolveUserAuthz(user);
  const sendPermission = closePackage.runId ? "close.run" : "periods.manage";
  if (!can(current, sendPermission)) {
    throw new Error(`Close package sender no longer holds ${sendPermission} — re-send the package`);
  }
  if (!(await reportArtifactAccessDetail(current, snapshot, { expenseReach: false })).ok) {
    throw new Error("Report execution permission was revoked");
  }
  return narrowToSnapshotScope(current, snapshot);
}
