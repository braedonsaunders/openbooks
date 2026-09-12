import { pageSpecSchema } from "@braedonsaunders/appkit-viewspec";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../db.ts";
import { verifyUser } from "../flows/targets.ts";
import {
  installModule,
  uninstallModule,
  upgradeModule,
  type InstallOutcome,
} from "./installer.ts";

/**
 * Module rehearsal — stage a module in a linked sandbox org, preview it on
 * the REAL route, then promote it to production or discard it.
 *
 * A sandbox is a linked org (sandboxes.org_id → production_org_id), so
 * "staging" is a real install into the sandbox org through installModule —
 * the sole projection writer — plus one row per page contribution in
 * page_spec_drafts for the rehearsing author. The renderer reads exactly
 * those two row shapes (loadPageSpec for the projection, loadPageSpecDraft
 * on ?layoutPreview=1 for the draft), so the preview IS the page: its
 * chrome, its data, its interactions — never a bespoke rehearsal screen.
 *
 * Why BOTH a sandbox install and drafts, rather than one of them:
 *
 * - The sandbox install proves the module projects cleanly (route conflicts
 *   against the sandbox's layouts fail the stage, not the promote) and is
 *   what the sandbox's real route renders for everyone working there.
 * - The author draft is what ?layoutPreview=1 renders for the author alone,
 *   mirroring the page-layout preview asymmetry the platform already ships:
 *   look before anyone else does, including before the sandbox's other
 *   readers see the staged projection. Drafts expire on their own and are
 *   never audited (they change nothing anyone else can observe).
 *
 * Promote installs the STAGED bytes (the sandbox's recorded active-version
 * manifest, never the caller's re-supplied copy) into the production org and
 * narrows the grant to the promoter's effective set. Discard uninstalls the
 * sandbox module (deactivate, never delete) and deletes the author's drafts
 * for the staged routes. Neither stage nor discard writes the production
 * org; promote never rewrites history (install vs upgrade vs converge is
 * chosen explicitly from production state).
 *
 * The diff card the module drawer renders is describeRehearsal's `changes`:
 * per-contribution added/changed/removed between the staged sandbox manifest
 * and the live production manifest, in the same shape as diff_module's
 * output. The drawer owns the pixels; this is the payload.
 *
 * Every statement carries an explicit org_id predicate; RLS enforces it
 * again at storage. The sandbox linkage check fails closed: a sandbox that
 * does not belong to the named production org is refused, never staged into.
 */

export class ModuleRehearsalError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ModuleRehearsalError";
    this.status = status;
  }
}

/**
 * Preview window the draft sweep honors. Owned by web/lib/page-specs.ts
 * DRAFT_TTL_MINUTES; the renderer enforces its own window on read regardless,
 * so drift here only changes sweep hygiene, never what renders.
 */
const DRAFT_TTL_MINUTES = 30;

export interface RehearsalPreview {
  route: string;
  /** The real route with ?layoutPreview=1, segments substituted; null when a segment value is missing. */
  previewUrl: string | null;
  previewError?: string;
}

export interface StageRehearsalResult {
  moduleId: string;
  versionId: string;
  outcome: InstallOutcome;
  key: string;
  version: string;
  previews: RehearsalPreview[];
}

export interface PromoteRehearsalResult {
  moduleId: string;
  versionId: string;
  outcome: InstallOutcome;
  version: string;
}

export interface DiscardRehearsalResult {
  /** Null when the sandbox never staged this key: discard is idempotent. */
  moduleId: string | null;
  deactivatedProjections: number;
  clearedDrafts: number;
}

export interface RehearsalChange {
  kind: string;
  identity: string;
  change: "added" | "removed" | "changed";
  target: string;
}

export interface DescribeRehearsalResult {
  staged: { moduleId: string; versionId: string; version: string; status: string } | null;
  live: { moduleId: string; versionId: string; version: string; status: string } | null;
  changes: RehearsalChange[];
  unchanged: number;
  permissions: { live: string[]; staged: string[]; added: string[]; removed: string[] };
  previews: RehearsalPreview[];
}

/** The installer's canonical bytes, as module_versions carries them. */
interface StoredManifest {
  key: string;
  name: string;
  version: string;
  description: string | null;
  permissions: string[];
  contributions: StoredContribution[];
}

interface StoredContribution {
  kind: string;
  route?: string;
  spec?: unknown;
  [key: string]: unknown;
}

/** Deterministic JSON encoding so a live contribution compares equal to the bytes that wrote it. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function readStoredManifest(raw: unknown, what: string): StoredManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ModuleRehearsalError(`${what} carries a corrupt manifest: expected an object`, 500);
  }
  const m = raw as Record<string, unknown>;
  if (
    typeof m.key !== "string" ||
    typeof m.version !== "string" ||
    !Array.isArray(m.permissions) ||
    !Array.isArray(m.contributions)
  ) {
    throw new ModuleRehearsalError(`${what} carries a corrupt manifest: missing key/version/permissions/contributions`, 500);
  }
  return m as unknown as StoredManifest;
}

/** Stable identity per contribution — page claims one route, the installer's dedupe namespace. */
function contributionIdentity(contribution: StoredContribution): string {
  if (contribution.kind === "page" && typeof contribution.route === "string") return contribution.route;
  return stableStringify(contribution);
}

/** Where a contribution renders from — v1 projects only page → page_specs. */
function contributionTarget(contribution: StoredContribution): string {
  if (contribution.kind === "page") return "page_specs";
  return contribution.kind;
}

async function writeAudit(
  tx: SqlExecutor,
  opts: {
    orgId: string;
    table: string;
    rowId: string;
    action: "insert" | "update";
    event: string;
    reason: string;
    before: unknown;
    after: unknown;
    actorId: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${opts.orgId}, ${opts.table}, ${opts.rowId}, ${opts.action},
            ${JSON.stringify({ event: opts.event, reason: opts.reason, before: opts.before, after: opts.after })}::jsonb,
            ${opts.actorId})`);
}

/**
 * The sandbox boundary: the sandbox org must be linked to the production org.
 * Fails closed — an unlinked org id is refused, never staged into, so a
 * rehearsal cannot become a cross-tenant write.
 */
async function assertSandboxLink(productionOrgId: string, sandboxOrgId: string): Promise<void> {
  const link = (
    await db.execute<{ org_id: string }>(sql`
      select org_id from sandboxes
       where org_id = ${sandboxOrgId} and production_org_id = ${productionOrgId}
       limit 1`)
  ).rows[0];
  if (!link) {
    throw new ModuleRehearsalError(
      "rehearsal refused: this sandbox does not belong to the requesting production org",
      403,
    );
  }
}

/** The rehearsing author must be an active user of the sandbox org: drafts are author-scoped there. */
async function assertSandboxAuthor(sandboxOrgId: string, actorId: string): Promise<void> {
  const author = await verifyUser(sandboxOrgId, actorId);
  if (!author) {
    throw new ModuleRehearsalError("rehearsal refused: the author is not an active user of this sandbox", 403);
  }
}

/**
 * One openable URL per staged route, built exactly like the page-layout
 * previewUrl: segment placeholders substituted, ?layoutPreview=1 appended.
 * A route whose segments have no value is reported, not guessed — a blank
 * segment would render some other page entirely.
 */
function previewUrls(
  contributions: StoredContribution[],
  params?: Record<string, string>,
): RehearsalPreview[] {
  return contributions
    .filter((c) => c.kind === "page" && typeof c.route === "string")
    .map((c) => {
      const route = c.route as string;
      let missing: string | null = null;
      const path = route.replace(/\[([^\]]+)\]/g, (_, name: string) => {
        const value = params?.[name];
        if (typeof value !== "string" || value === "") {
          missing ??= name;
          return "";
        }
        return encodeURIComponent(value);
      });
      if (missing) {
        return { route, previewUrl: null, previewError: `preview needs a value for [${missing}]` };
      }
      return { route, previewUrl: `${path}?layoutPreview=1` };
    });
}

type StagedModule = {
  moduleId: string;
  status: string;
  granted: string[];
  versionId: string;
  versionStatus: string;
  manifest: StoredManifest;
};

/** The sandbox's staged module and its active version manifest — the bytes promote installs. */
async function readStaged(tx: SqlExecutor, sandboxOrgId: string, key: string): Promise<StagedModule | null> {
  const row = (
    await tx.execute<{
      id: string;
      status: string;
      granted_permissions: string[];
      version_id: string | null;
      version_status: string | null;
      manifest: unknown;
    }>(sql`
      select m.id, m.status, m.granted_permissions,
             v.id as version_id, v.status as version_status, v.manifest
        from modules m
        left join module_versions v
          on v.org_id = m.org_id and v.id = m.active_version_id
       where m.org_id = ${sandboxOrgId} and m.key = ${key}
       limit 1`)
  ).rows[0];
  if (!row || !row.version_id) return null;
  return {
    moduleId: row.id,
    status: row.status,
    granted: row.granted_permissions,
    versionId: row.version_id,
    versionStatus: row.version_status ?? "unknown",
    manifest: readStoredManifest(row.manifest, `the staged version of module "${key}"`),
  };
}

/**
 * Write the author's preview drafts for every staged page contribution.
 * The spec bytes are the installer's stored bytes, re-validated with the
 * same pageSpecSchema object — a stored document that no longer parses fails
 * loudly here rather than writing a draft the renderer would silently ignore.
 */
async function writePreviewDrafts(
  tx: SqlExecutor,
  opts: { sandboxOrgId: string; actorId: string; manifest: StoredManifest },
): Promise<void> {
  const pages = opts.manifest.contributions.filter(
    (c) => c.kind === "page" && typeof c.route === "string",
  );
  // Sweep this author's expired drafts on the way past, mirroring
  // savePageSpecDraft: a background job for a handful of rows per rehearsal
  // would be machinery without a purpose.
  await tx.execute(sql`
    delete from page_spec_drafts
     where org_id = ${opts.sandboxOrgId} and user_id = ${opts.actorId}
       and created_at < now() - ${`${DRAFT_TTL_MINUTES} minutes`}::interval`);
  for (const page of pages) {
    const parsed = pageSpecSchema.safeParse(page.spec);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new ModuleRehearsalError(
        `rehearsal refused: the staged spec for route ${page.route} no longer parses: ${detail}`,
        500,
      );
    }
    await tx.execute(sql`
      insert into page_spec_drafts (org_id, user_id, route, spec)
      values (${opts.sandboxOrgId}, ${opts.actorId}, ${page.route as string},
              ${JSON.stringify(parsed.data)}::jsonb)
      on conflict (org_id, user_id, route)
      do update set spec = excluded.spec, created_at = now()`);
  }
}

/**
 * Stage a module install in a linked sandbox: install through the installer
 * (real projections in the sandbox org — the sandbox's real route renders
 * the module spec), then draft each page contribution for the author so
 * ?layoutPreview=1 renders it for them alone. Nothing is written to the
 * production org. Restaging the identical manifest converges (the
 * installer's already-installed) and refreshes the drafts.
 */
export async function stageModuleRehearsal(opts: {
  productionOrgId: string;
  sandboxOrgId: string;
  actorId: string;
  /** Raw manifest: caller pre-validation is a fast path; the installer enforces canonical strictness itself. */
  manifest: unknown;
  grantedPermissions?: string[];
  /**
   * The staging actor's resolved permission set. Required, no default:
   * the recorded grant is approved ∩ requested ∩ effective, and a caller
   * that cannot state its authority must not stage.
   */
  installerEffectivePermissions: readonly string[];
  /** Segment values for preview URLs on routes carrying [segments]. */
  params?: Record<string, string>;
  /** Why: recorded on every audit row this stage writes. */
  reason?: string;
}): Promise<StageRehearsalResult> {
  await assertSandboxLink(opts.productionOrgId, opts.sandboxOrgId);
  await assertSandboxAuthor(opts.sandboxOrgId, opts.actorId);
  const reason = opts.reason && opts.reason.length > 0 ? opts.reason : "rehearsal stage";

  const installed = await installModule({
    orgId: opts.sandboxOrgId,
    actorId: opts.actorId,
    manifest: opts.manifest,
    ...(opts.grantedPermissions !== undefined ? { grantedPermissions: opts.grantedPermissions } : {}),
    installerEffectivePermissions: opts.installerEffectivePermissions,
    reason,
  });

  // The installer owns its transaction; drafts follow in a second one. On a
  // draft failure the install stands and the error names it — restaging
  // converges through the installer and rewrites the drafts.
  const staged = await db.transaction(async (tx) => {
    const moduleRow = (
      await tx.execute<{ id: string; key: string }>(sql`
        select m.id, m.key from modules m
         where m.org_id = ${opts.sandboxOrgId} and m.id = ${installed.moduleId}
         limit 1`)
    ).rows[0];
    if (!moduleRow) {
      throw new ModuleRehearsalError("rehearsal failed: the staged module row is missing", 500);
    }
    const version = (
      await tx.execute<{ version: string; manifest: unknown }>(sql`
        select version, manifest from module_versions
         where org_id = ${opts.sandboxOrgId} and id = ${installed.versionId}
         limit 1`)
    ).rows[0];
    if (!version) {
      throw new ModuleRehearsalError("rehearsal failed: the staged version row is missing", 500);
    }
    const manifest = readStoredManifest(version.manifest, `the staged version of module "${moduleRow.key}"`);
    await writePreviewDrafts(tx, { sandboxOrgId: opts.sandboxOrgId, actorId: opts.actorId, manifest });
    await writeAudit(tx, {
      orgId: opts.sandboxOrgId,
      table: "modules",
      rowId: installed.moduleId,
      action: "update",
      event: "module_rehearsal_staged",
      reason,
      before: null,
      after: {
        key: manifest.key,
        version: manifest.version,
        version_id: installed.versionId,
        outcome: installed.outcome,
        production_org_id: opts.productionOrgId,
      },
      actorId: opts.actorId,
    });
    return manifest;
  });

  return {
    moduleId: installed.moduleId,
    versionId: installed.versionId,
    outcome: installed.outcome,
    key: staged.key,
    version: staged.version,
    previews: previewUrls(staged.contributions, opts.params),
  };
}

/**
 * Promote the staged sandbox version into production: the sandbox's recorded
 * active-version manifest is installed verbatim — never a caller re-supply —
 * and the grant narrows to the promoter's effective set. First contact
 * installs; a new label upgrades; an identical label converges; a label
 * wearing different bytes is refused (history is append-only).
 */
export async function promoteRehearsal(opts: {
  productionOrgId: string;
  sandboxOrgId: string;
  actorId: string;
  key: string;
  /**
   * The promoting actor's resolved permission set. Required, no default:
   * the recorded grant narrows to granted ∩ effective, fail-closed.
   */
  installerEffectivePermissions: readonly string[];
  /** Why: recorded on every audit row this promote writes. */
  reason?: string;
}): Promise<PromoteRehearsalResult> {
  await assertSandboxLink(opts.productionOrgId, opts.sandboxOrgId);
  const reason = opts.reason && opts.reason.length > 0 ? opts.reason : "rehearsal promote";

  const staged = await db.transaction(async (tx) => readStaged(tx, opts.sandboxOrgId, opts.key));
  if (!staged) {
    throw new ModuleRehearsalError(`module "${opts.key}" has no staged version in this sandbox`, 409);
  }
  if (staged.status === "disabled") {
    throw new ModuleRehearsalError(
      `module "${opts.key}" was discarded in this sandbox; stage it again before promoting`,
      409,
    );
  }

  const production = await db.transaction(async (tx) => {
    const moduleRow = (
      await tx.execute<{ id: string }>(sql`
        select id from modules
         where org_id = ${opts.productionOrgId} and key = ${opts.key}
         limit 1`)
    ).rows[0] ?? null;
    if (!moduleRow) return { moduleId: null as string | null, labels: new Map<string, string>() };
    const versions = (
      await tx.execute<{ version: string; manifest: unknown }>(sql`
        select version, manifest from module_versions
         where org_id = ${opts.productionOrgId} and module_id = ${moduleRow.id}`)
    ).rows;
    return {
      moduleId: moduleRow.id,
      labels: new Map(versions.map((v) => [v.version, stableStringify(v.manifest)])),
    };
  });

  const installOpts = {
    orgId: opts.productionOrgId,
    actorId: opts.actorId,
    manifest: staged.manifest as unknown,
    grantedPermissions: staged.granted,
    installerEffectivePermissions: opts.installerEffectivePermissions,
    reason,
  };
  let promoted;
  if (!production.moduleId) {
    promoted = await installModule(installOpts);
  } else if (!production.labels.has(staged.manifest.version)) {
    promoted = await upgradeModule({ ...installOpts, key: opts.key });
  } else if (production.labels.get(staged.manifest.version) === stableStringify(staged.manifest)) {
    // The staged bytes already ran in production under this label: converge
    // instead of appending a duplicate row.
    promoted = await installModule(installOpts);
  } else {
    throw new ModuleRehearsalError(
      `version ${staged.manifest.version} of module "${opts.key}" already exists in production ` +
        `with a different manifest; stage a new version instead`,
      409,
    );
  }

  await db.transaction(async (tx) => {
    await writeAudit(tx, {
      orgId: opts.productionOrgId,
      table: "modules",
      rowId: promoted.moduleId,
      action: "update",
      event: "module_rehearsal_promoted",
      reason,
      before: { key: opts.key },
      after: {
        key: opts.key,
        version: staged.manifest.version,
        version_id: promoted.versionId,
        outcome: promoted.outcome,
        staged_in_sandbox_org_id: opts.sandboxOrgId,
        staged_version_id: staged.versionId,
      },
      actorId: opts.actorId,
    });
  });

  return { moduleId: promoted.moduleId, versionId: promoted.versionId, outcome: promoted.outcome, version: staged.manifest.version };
}

/**
 * Discard a sandbox staging: uninstall the sandbox module (projections
 * deactivated, never deleted) and delete the author's drafts for the staged
 * routes. The production org is never touched. Idempotent: discarding a key
 * the sandbox never staged clears zero drafts and reports null.
 */
export async function discardRehearsal(opts: {
  productionOrgId: string;
  sandboxOrgId: string;
  actorId: string;
  key: string;
  /** Why: recorded on every audit row this discard writes. */
  reason?: string;
}): Promise<DiscardRehearsalResult> {
  await assertSandboxLink(opts.productionOrgId, opts.sandboxOrgId);
  const reason = opts.reason && opts.reason.length > 0 ? opts.reason : "rehearsal discard";

  const stagedRoutes = await db.transaction(async (tx) => {
    const staged = await readStaged(tx, opts.sandboxOrgId, opts.key);
    return staged
      ? staged.manifest.contributions
          .filter((c) => c.kind === "page" && typeof c.route === "string")
          .map((c) => c.route as string)
      : [];
  });

  const uninstalled = await uninstallModule({
    orgId: opts.sandboxOrgId,
    actorId: opts.actorId,
    key: opts.key,
    reason,
  });

  let clearedDrafts = 0;
  if (stagedRoutes.length > 0) {
    clearedDrafts = Number(
      (
        await db.execute<{ n: string }>(sql`
          with deleted as (
            delete from page_spec_drafts
             where org_id = ${opts.sandboxOrgId} and user_id = ${opts.actorId}
               and route in (${sql.join(stagedRoutes.map((r) => sql`${r}`), sql`, `)})
            returning id
          )
          select count(*) as n from deleted`)
      ).rows[0]!.n,
    );
  }

  if (uninstalled.moduleId) {
    await db.transaction(async (tx) => {
      await writeAudit(tx, {
        orgId: opts.sandboxOrgId,
        table: "modules",
        rowId: uninstalled.moduleId!,
        action: "update",
        event: "module_rehearsal_discarded",
        reason,
        before: { key: opts.key },
        after: {
          key: opts.key,
          deactivated_projections: uninstalled.deactivatedProjections,
          cleared_drafts: clearedDrafts,
          production_org_id: opts.productionOrgId,
        },
        actorId: opts.actorId,
      });
    });
  }

  return {
    moduleId: uninstalled.moduleId,
    deactivatedProjections: uninstalled.deactivatedProjections,
    clearedDrafts,
  };
}

/**
 * The diff-card payload for the module drawer: what promoting the staged
 * sandbox version would change in production, per contribution —
 * added/changed/removed against the live production manifest — plus the
 * permission delta and the preview URLs. Nothing is stored.
 */
export async function describeRehearsal(opts: {
  productionOrgId: string;
  sandboxOrgId: string;
  key: string;
  /** Segment values for preview URLs on routes carrying [segments]. */
  params?: Record<string, string>;
}): Promise<DescribeRehearsalResult> {
  await assertSandboxLink(opts.productionOrgId, opts.sandboxOrgId);

  const { staged, live } = await db.transaction(async (tx) => {
    const stagedRow = await readStaged(tx, opts.sandboxOrgId, opts.key);
    const liveRow = await readStaged(tx, opts.productionOrgId, opts.key);
    return {
      staged: stagedRow
        ? {
            moduleId: stagedRow.moduleId,
            versionId: stagedRow.versionId,
            version: stagedRow.manifest.version,
            status: stagedRow.status,
            manifest: stagedRow.manifest,
          }
        : null,
      live: liveRow
        ? {
            moduleId: liveRow.moduleId,
            versionId: liveRow.versionId,
            version: liveRow.manifest.version,
            status: liveRow.status,
            manifest: liveRow.manifest,
          }
        : null,
    };
  });
  if (!staged) {
    throw new ModuleRehearsalError(`module "${opts.key}" has no staged version in this sandbox`, 404);
  }

  const liveByIdentity = new Map<string, string>();
  const livePermissions: string[] = [];
  let liveVersion: { moduleId: string; versionId: string; version: string; status: string } | null = null;
  if (live) {
    liveVersion = { moduleId: live.moduleId, versionId: live.versionId, version: live.manifest.version, status: live.status };
    for (const c of live.manifest.contributions) {
      liveByIdentity.set(`${c.kind}#${contributionIdentity(c)}`, stableStringify(c));
    }
    for (const p of live.manifest.permissions) livePermissions.push(p);
  }

  const changes: RehearsalChange[] = [];
  const seenLive = new Set<string>();
  for (const c of staged.manifest.contributions) {
    const namespaced = `${c.kind}#${contributionIdentity(c)}`;
    const body = stableStringify(c);
    const liveBody = liveByIdentity.get(namespaced);
    if (liveBody === undefined) {
      changes.push({ kind: c.kind, identity: contributionIdentity(c), change: "added", target: contributionTarget(c) });
    } else {
      seenLive.add(namespaced);
      if (liveBody !== body) {
        changes.push({ kind: c.kind, identity: contributionIdentity(c), change: "changed", target: contributionTarget(c) });
      }
    }
  }
  for (const [namespaced] of liveByIdentity) {
    if (seenLive.has(namespaced)) continue;
    const hash = namespaced.indexOf("#");
    const kind = namespaced.slice(0, hash);
    changes.push({ kind, identity: namespaced.slice(hash + 1), change: "removed", target: kind === "page" ? "page_specs" : kind });
  }
  changes.sort((a, b) => a.identity.localeCompare(b.identity) || a.kind.localeCompare(b.kind));
  const changed = changes.filter((c) => c.change === "changed").length;
  const unchanged = seenLive.size - changed;

  const stagedPermissions = [...staged.manifest.permissions].sort();
  const sortedLive = [...livePermissions].sort();
  return {
    staged: { moduleId: staged.moduleId, versionId: staged.versionId, version: staged.manifest.version, status: staged.status },
    live: liveVersion,
    changes,
    unchanged,
    permissions: {
      live: sortedLive,
      staged: stagedPermissions,
      added: stagedPermissions.filter((p) => !sortedLive.includes(p)),
      removed: sortedLive.filter((p) => !stagedPermissions.includes(p)),
    },
    previews: previewUrls(staged.manifest.contributions, opts.params),
  };
}
