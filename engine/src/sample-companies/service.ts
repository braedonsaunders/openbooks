import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  db,
  pool,
  withBypassContext,
  withOrgContext,
  withOrgTransaction,
} from "../platform/db.ts";
import { createSandbox, deleteSandbox } from "../sandbox/lifecycle.ts";
import { autopilotRunToEnd, provisionRun } from "../sim/runner.ts";
import { reconcileDocumentSequences } from "../records/numbering.ts";
import { SAMPLE_COMPANY_BY_INDUSTRY, SAMPLE_COMPANY_PROFILES } from "./catalog.ts";
import {
  SampleCompanyError,
  runProvisioningStage,
} from "./provisioning-failures.ts";

export { SampleCompanyError } from "./provisioning-failures.ts";
export {
  SampleCompanyProvisioningError,
  sampleCompanyStageMessage,
  SAMPLE_COMPANY_STAGE_CODES,
} from "./provisioning-failures.ts";
export type { SampleCompanyProvisioningStage } from "./provisioning-failures.ts";

/**
 * Durable provisioning marker (SC-RESUME). Every company cloned for a member
 * carries its pipeline position in
 * `orgs.settings.sampleCompany.provisioningStage`:
 *
 *   cloned → finalized → numbering_reconciled → ready
 *
 * Each stage stamps the marker in the same transaction that completes it, so
 * a crash between stages always leaves the company resumable: the next
 * createSampleCompany for the same member and industry resumes from the
 * recorded stage instead of cloning a second company. Rows that predate
 * resumable provisioning carry no marker and are treated as ready — they
 * completed under the old flow (or are already exposed) and their position
 * cannot be reconstructed.
 *
 * No schema column is needed: the marker lives in the schemaless settings
 * document beside the existing sampleCompany metadata.
 */
export type SampleCompanyOrgStage =
  | "cloned"
  | "finalized"
  | "numbering_reconciled"
  | "ready";

const SAMPLE_COMPANY_ORG_STAGES: readonly SampleCompanyOrgStage[] = [
  "cloned",
  "finalized",
  "numbering_reconciled",
  "ready",
];

function isSampleCompanyOrgStage(value: unknown): value is SampleCompanyOrgStage {
  return (
    typeof value === "string" &&
    (SAMPLE_COMPANY_ORG_STAGES as readonly string[]).includes(value)
  );
}

export interface SampleCompanyStatus {
  industryKey: string;
  profileId: string;
  companyName: string;
  focus: readonly string[];
  templateReady: boolean;
  existingOrgId: string | null;
}

export interface CreateSampleCompanyInput {
  industryKey: string;
  memberUserId: string;
  sourceOrgId: string;
  memberName: string;
  features: Record<string, boolean>;
}

export interface CreateSampleCompanyResult {
  orgId: string;
  name: string;
  created: boolean;
  templateGenerated: boolean;
}

export interface PrepareSampleCompanyResult {
  industryKey: string;
  profileId: string;
  templateOrgId: string;
  templateName: string;
  generated: boolean;
  coverage: Pick<TemplateRow, "documents" | "postedEntries" | "parties" | "periods" | "adminRoles">;
}

export interface PromoteExistingSampleTemplateInput {
  industryKey: string;
  sourceOrgId: string;
  /** Explicit operator attestation that this tenant is approved demo content. */
  confirmedSampleData: boolean;
  /** Defaults true. False is allowed only for explicitly synthetic content. */
  masked?: boolean;
  confirmedSynthetic?: boolean;
}
type TemplateRow = {
  id: string;
  name: string;
  documents: number;
  postedEntries: number;
  parties: number;
  periods: number;
  adminRoles: number;
};

const TEMPLATE_MINIMUMS = {
  documents: 8,
  postedEntries: 4,
  parties: 6,
  periods: 3,
  adminRoles: 1,
};

/**
 * Prove that the authenticated login may act in the organization from which it
 * requested a sample company. This lookup is one of the small, read-only
 * identity-bootstrap operations that must span tenants before a request can be
 * assigned an RLS context. It returns only an authorization decision; no tenant
 * data leaves the boundary.
 */
async function assertSampleRequestAccess(input: CreateSampleCompanyInput): Promise<void> {
  const allowed = await withBypassContext(async () => {
    const result = (await db.execute<{ allowed: boolean }>(sql`
      select exists (
        select 1
          from users member
          join orgs requested on requested.id = ${input.sourceOrgId}
         where member.id = ${input.memberUserId}
           and member.is_active
           and (
             member.is_super_admin
             or requested.id = member.org_id
             or exists (
               select 1
                 from user_org_access access
                where access.member_user_id = member.id
                  and access.org_id = requested.id
                  and access.is_active
             )
             or (
               requested.env_kind = 'sandbox'
               and (
                 requested.sandbox_of = member.org_id
                 or exists (
                   select 1
                     from user_org_access parent_access
                    where parent_access.member_user_id = member.id
                      and parent_access.org_id = requested.sandbox_of
                      and parent_access.is_active
                 )
               )
             )
           )
      ) as allowed
    `));
    return result.rows[0]?.allowed === true;
  });
  if (!allowed) {
    throw new SampleCompanyError(
      "requesting member does not have access to the source organization",
    );
  }
}

async function templateCandidates(profileId: string): Promise<Array<{ id: string }>> {
  // Template discovery is an installation-level metadata lookup. It may span
  // tenants, but it deliberately does not touch users or accounting tables.
  // Content verification happens separately under each candidate's own RLS
  // context below.
  return withBypassContext(async () => {
    const result = (await db.execute<{ id: string }>(sql`
      select o.id
        from orgs o
       where o.env_kind in ('production', 'sandbox')
         and o.settings->>'simProfile' = ${profileId}
         and (
           (
             coalesce((o.settings->'sampleTemplate'->>'enabled')::boolean, false)
             and o.settings->'sampleTemplate'->>'profileId' = ${profileId}
           )
           or (
             coalesce((o.settings->>'simHarness')::boolean, false)
             and o.settings->'sampleTemplateOracle'->>'status' = 'passed'
             and o.settings->'sampleTemplateOracle'->>'profileId' = ${profileId}
           )
         )
         and not (o.settings ? 'sampleCompany')
       order by coalesce((o.settings->'sampleTemplate'->>'enabled')::boolean, false) desc,
                o.created_at desc
    `));
    return result.rows;
  });
}

async function templateFor(profileId: string): Promise<TemplateRow | null> {
  for (const candidate of await templateCandidates(profileId)) {
    const verified = await templateRowForOrg(candidate.id);
    if (!verified) continue;
    try {
      assertTemplateCoverage(verified);
      return verified;
    } catch (error) {
      if (!(error instanceof SampleCompanyError)) throw error;
    }
  }
  return null;
}

/**
 * Register the best verified synthetic company already present in this
 * deployment, generating a deterministic replacement only when none exists.
 * This is intentionally a maintainer/install-time operation. The regular
 * clone request calls the same resolver, so a prepared dev tenant is always
 * preferred and is never regenerated or overwritten.
 */
async function prepareSampleCompanyTemplateOnce(
  industryKey: string,
): Promise<PrepareSampleCompanyResult> {
  const profile = SAMPLE_COMPANY_BY_INDUSTRY.get(industryKey);
  if (!profile) throw new SampleCompanyError(`unknown sample-company industry: ${industryKey}`);
  const lockKey = `openbooks:sample-template:${profile.profileId}`;
  let lockClient = await pool.connect();
  let lockHealthy = true;
  const handleLockError = (error: Error) => {
    lockHealthy = false;
    console.error(
      `[sample-company] template lock connection was lost; it will be reacquired: ${error.message}`,
    );
  };
  const attachLockClient = () => {
    lockHealthy = true;
    lockClient.on("error", handleLockError);
  };
  const releaseLockClient = async () => {
    lockClient.off("error", handleLockError);
    if (lockHealthy) {
      await lockClient
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
        .catch(() => {});
    }
    lockClient.release(lockHealthy ? undefined : new Error("sample template lock connection lost"));
  };
  const reacquireLockIfNeeded = async () => {
    if (lockHealthy) return;
    await releaseLockClient();
    lockClient = await pool.connect();
    attachLockClient();
    await lockClient.query("select pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
  };
  attachLockClient();
  try {
    await lockClient.query("select pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    // Resolve again only after the profile-wide lock. Concurrent first users
    // must converge on one durable source instead of provisioning duplicates.
    let template = await templateFor(profile.profileId);
    let generated = false;
    if (!template) {
      template = await generateTemplate(profile.profileId);
      generated = true;
    }
    // A checked-out advisory-lock connection can disappear during a long
    // simulator run even while the request pool recovers normally. Never
    // register a template after that session lock has vanished. Reacquire the
    // lock, then converge on whichever verified candidate won while it was
    // unavailable (the just-generated candidate is also oracle-marked).
    await reacquireLockIfNeeded();
    template = (await templateFor(profile.profileId)) ?? template;
    await markTemplate(template, profile.profileId);
    // The registration is short, but fail closed if the replacement connection
    // also disappeared during it. One bounded reacquisition makes the final
    // selection deterministic without silently proceeding unlocked.
    if (!lockHealthy) {
      await reacquireLockIfNeeded();
      template = (await templateFor(profile.profileId)) ?? template;
      await markTemplate(template, profile.profileId);
      if (!lockHealthy) {
        throw new SampleCompanyError("sample template lock could not be held through registration");
      }
    }
    return {
      industryKey: profile.industryKey,
      profileId: profile.profileId,
      templateOrgId: template.id,
      templateName: template.name,
      generated,
      coverage: {
        documents: template.documents,
        postedEntries: template.postedEntries,
        parties: template.parties,
        periods: template.periods,
        adminRoles: template.adminRoles,
      },
    };
  } finally {
    await releaseLockClient();
  }
}

export async function prepareSampleCompanyTemplate(
  industryKey: string,
): Promise<PrepareSampleCompanyResult> {
  return runOperationThroughTransientDatabaseFailures(
    `prepare ${industryKey} sample company`,
    () => prepareSampleCompanyTemplateOnce(industryKey),
  );
}

export async function prepareAllSampleCompanyTemplates(): Promise<PrepareSampleCompanyResult[]> {
  const prepared: PrepareSampleCompanyResult[] = [];
  // Deliberately serial: simulator provisioning is DB-intensive, and each
  // completed profile is independently durable and resumable by rerunning.
  for (const profile of SAMPLE_COMPANY_PROFILES) {
    prepared.push(await prepareSampleCompanyTemplate(profile.industryKey));
  }
  return prepared;
}

async function templateRowForOrg(orgId: string): Promise<(TemplateRow & { envKind: string }) | null> {
  // Accounting content is never inspected under cross-tenant bypass. The
  // explicit organization context makes PostgreSQL RLS the authoritative
  // boundary even for maintainer-driven template preparation.
  return withOrgContext(orgId, async () => {
    const result = (await db.execute<TemplateRow & { envKind: string }>(sql`
      select o.id, o.name, o.env_kind as "envKind",
             (select count(*)::int from documents d where d.org_id = o.id) as documents,
             (select count(*)::int from journal_entries j
               where j.org_id = o.id and j.status = 'posted') as "postedEntries",
             (select count(*)::int from parties p where p.org_id = o.id) as parties,
             (select count(*)::int from accounting_periods p where p.org_id = o.id) as periods,
             (select count(*)::int from app_roles r
               where r.org_id = o.id and r.key = 'admin') as "adminRoles"
        from orgs o where o.id = ${orgId}
    `));
    return result.rows[0] ?? null;
  });
}

function assertTemplateCoverage(row: TemplateRow): void {
  for (const [key, minimum] of Object.entries(TEMPLATE_MINIMUMS)) {
    if (row[key as keyof typeof TEMPLATE_MINIMUMS] < minimum) {
      throw new SampleCompanyError(
        `source organization does not meet sample coverage: ${key} requires at least ${minimum}`,
      );
    }
  }
}

/**
 * Copy an explicitly approved dev/demo tenant into a dedicated reusable source.
 * The supplied tenant is never relabelled or modified. Masking is the default;
 * an unmasked promotion requires a separate synthetic-data attestation.
 */
export async function promoteExistingSampleTemplate(
  input: PromoteExistingSampleTemplateInput,
): Promise<PrepareSampleCompanyResult> {
  const profile = SAMPLE_COMPANY_BY_INDUSTRY.get(input.industryKey);
  if (!profile) throw new SampleCompanyError(`unknown sample-company industry: ${input.industryKey}`);
  if (!input.confirmedSampleData) {
    throw new SampleCompanyError("explicit sample-data approval is required");
  }
  const masked = input.masked ?? true;
  if (!masked && !input.confirmedSynthetic) {
    throw new SampleCompanyError("unmasked promotion requires explicit synthetic-data confirmation");
  }

  const source = await templateRowForOrg(input.sourceOrgId);
  if (!source || source.envKind !== "production") {
    throw new SampleCompanyError("sample promotion source must be a production-kind organization");
  }
  assertTemplateCoverage(source);

  const clone = await withBypassContext(() => createSandbox({
    productionOrgId: source.id,
    name: `SIM · ${profile.companyName}`,
    tier: "full",
    masked,
    createdBy: null,
  }));
  await withOrgTransaction(clone.sandboxOrgId, async () => {
    await db.transaction(async (tx) => {
      const state = (await tx.execute<{ settings: Record<string, unknown> }>(sql`
        select settings from orgs where id = ${clone.sandboxOrgId} for update
      `));
      const settings = { ...(state.rows[0]?.settings ?? {}) };
      delete settings.sampleCompany;
      settings.simHarness = true;
      settings.simProfile = profile.profileId;
      settings.sampleTemplatePromotion = {
        version: 1,
        sourceOrgId: source.id,
        masked,
        approvedAsSampleData: true,
        confirmedSynthetic: !masked,
        promotedAt: new Date().toISOString(),
      };
      await tx.execute(sql`
        update orgs
           set name = ${`SIM · ${profile.companyName}`},
               settings = ${JSON.stringify(settings)}::jsonb,
               updated_at = now()
         where id = ${clone.sandboxOrgId}
      `);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes)
        values (
          ${clone.sandboxOrgId}, 'orgs', ${clone.sandboxOrgId}, 'insert',
          ${JSON.stringify({
            mode: "sample_template_promotion",
            sourceOrgId: source.id,
            industryKey: profile.industryKey,
            profileId: profile.profileId,
            masked,
            approvedAsSampleData: true,
            confirmedSynthetic: !masked,
          })}::jsonb
        )
      `);
    });
  });

  const promoted = await templateRowForOrg(clone.sandboxOrgId);
  if (!promoted) throw new SampleCompanyError("promoted sample template could not be verified");
  assertTemplateCoverage(promoted);
  await markTemplate(promoted, profile.profileId);
  return {
    industryKey: profile.industryKey,
    profileId: profile.profileId,
    templateOrgId: promoted.id,
    templateName: promoted.name,
    generated: false,
    coverage: {
      documents: promoted.documents,
      postedEntries: promoted.postedEntries,
      parties: promoted.parties,
      periods: promoted.periods,
      adminRoles: promoted.adminRoles,
    },
  };
}

async function existingFor(memberUserId: string, industryKey: string): Promise<{ id: string; name: string } | null> {
  return withBypassContext(async () => {
    const result = (await db.execute<{ id: string; name: string }>(sql`
      select o.id, o.name
        from orgs o
        join user_org_access access
          on access.org_id = o.id
         and access.member_user_id = ${memberUserId}
         and access.is_active
       where o.env_kind = 'preview'
         and o.settings->'sampleCompany'->>'ownerUserId' = ${memberUserId}
         and o.settings->'sampleCompany'->>'industryKey' = ${industryKey}
         -- SC-RESUME: success is a FULLY READY company only. A partial
         -- company carries an explicit non-ready provisioningStage and must
         -- never satisfy this lookup (the retry would return it as success
         -- with unreconciled numbering). Rows without a marker predate
         -- resumable provisioning and are treated as ready.
         and coalesce(o.settings->'sampleCompany'->>'provisioningStage', 'ready') = 'ready'
       order by o.created_at asc
       limit 1
    `));
    return result.rows[0] ?? null;
  });
}

interface PartialSampleCompany {
  id: string;
  name: string;
  /** Raw recorded stage; the caller resumes known stages and compensates the rest. */
  stage: string;
  /** Provenance for the resume; empty when the record cannot be resumed. */
  templateOrgId: string;
}

/**
 * Find the oldest resumable partial company for this member and industry:
 * a clone that committed but never reached ready. A partial may still be
 * env_kind 'sandbox' (finalize never committed) or 'preview' (finalize
 * committed, numbering or access pending). Completed companies and
 * pre-marker rows never match.
 */
async function findPartialSampleCompany(
  memberUserId: string,
  industryKey: string,
): Promise<PartialSampleCompany | null> {
  return withBypassContext(async () => {
    const result = (await db.execute<{
      id: string;
      name: string;
      stage: string | null;
      templateOrgId: string | null;
    }>(sql`
      select o.id, o.name,
             o.settings->'sampleCompany'->>'provisioningStage' as stage,
             o.settings->'sampleCompany'->>'templateOrgId' as "templateOrgId"
        from orgs o
       where o.env_kind in ('preview', 'sandbox')
         and o.settings->'sampleCompany'->>'ownerUserId' = ${memberUserId}
         and o.settings->'sampleCompany'->>'industryKey' = ${industryKey}
         and o.settings->'sampleCompany'->>'provisioningStage' is not null
         and o.settings->'sampleCompany'->>'provisioningStage' <> 'ready'
       order by o.created_at asc
       limit 1
    `));
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      stage: row.stage ?? "unknown",
      templateOrgId: row.templateOrgId ?? "",
    };
  });
}

/**
 * Stamp the cloned marker immediately after createSandbox commits, together
 * with the ownership and provenance the resume lookup keys on. A write that
 * matches zero rows is a failure, not a success: the clone was just
 * committed, so zero rows means it disappeared under us.
 */
async function stampClonedSampleCompany(args: {
  sandboxOrgId: string;
  industryKey: string;
  profileId: string;
  memberUserId: string;
  sourceOrgId: string;
  templateOrgId: string;
}): Promise<void> {
  const marker = {
    version: 1,
    industryKey: args.industryKey,
    profileId: args.profileId,
    ownerUserId: args.memberUserId,
    requestedFromOrgId: args.sourceOrgId,
    templateOrgId: args.templateOrgId,
    createdAt: new Date().toISOString(),
    immutableSyntheticSource: true,
    provisioningStage: "cloned",
  };
  const stamped = (await withBypassContext(() => db.execute(sql`
    update orgs
       set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('sampleCompany',
             coalesce(settings->'sampleCompany', '{}'::jsonb) || ${JSON.stringify(marker)}::jsonb),
           updated_at = now()
     where id = ${args.sandboxOrgId}
  `)) as unknown as { rowCount?: number | null });
  if (stamped.rowCount !== 1) {
    throw new SampleCompanyError("cloned sample organization disappeared during provisioning");
  }
}

/** Flip the provisioning marker after a stage whose own writes committed. */
async function setSampleCompanyStage(orgId: string, stage: SampleCompanyOrgStage): Promise<void> {
  const stamped = (await withBypassContext(() => db.execute(sql`
    update orgs
       set settings = jsonb_set(settings, '{sampleCompany,provisioningStage}', to_jsonb(${stage}::text), true),
           updated_at = now()
     where id = ${orgId}
       and settings ? 'sampleCompany'
  `)) as unknown as { rowCount?: number | null });
  if (stamped.rowCount !== 1) {
    throw new SampleCompanyError("sample company disappeared during provisioning");
  }
}

/**
 * Compensate an unresumable partial company through the product's own
 * sandbox deletion path (the same prep dropSampleCloneOrg applies: a
 * finalized partial is env_kind 'preview', which the sandbox wipe guard
 * refuses, so normalize to 'sandbox' first), verifying the org row is
 * actually gone instead of reporting an unverified delete as success.
 * Returns 'gone' when the row already disappeared so the caller can
 * re-provision; any other unexpected shape throws loudly — provisioning a
 * second company over an undeleted partial would strand it.
 */
async function deletePartialSampleOrg(orgId: string): Promise<"deleted" | "gone"> {
  return withBypassContext(async () => {
    const row = (await db.execute<{ name: string; envKind: string; isSample: boolean }>(sql`
      select name, env_kind as "envKind",
             ((settings ? 'sampleCompany')
              or (settings ? 'sampleTemplatePromotion')
              or coalesce((settings->>'simHarness')::boolean, false)) as "isSample"
        from orgs where id = ${orgId}`)).rows[0];
    if (!row) return "gone";
    if (!row.isSample) {
      throw new SampleCompanyError(
        `refusing to delete partial sample company ${orgId}: it carries no sample-company marker`,
      );
    }
    if (row.envKind !== "preview" && row.envKind !== "sandbox") {
      throw new SampleCompanyError(
        `refusing to delete partial sample company ${orgId}: unexpected env_kind ${JSON.stringify(row.envKind)}`,
      );
    }
    if (row.envKind === "preview") {
      await db.execute(sql`update orgs set env_kind = 'sandbox' where id = ${orgId}`);
    }
    const sandboxRows = (await db.execute<{ id: string }>(sql`
      select id from sandboxes where org_id = ${orgId}`)).rows;
    if (sandboxRows.length !== 1) {
      throw new SampleCompanyError(
        `refusing to delete partial sample company ${orgId}: expected exactly one sandbox row, found ${sandboxRows.length}`,
      );
    }
    await deleteSandbox(sandboxRows[0]!.id);
    const remaining = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from orgs where id = ${orgId}`)).rows[0]!.n;
    if (remaining !== 0) {
      throw new SampleCompanyError(`partial sample company ${orgId} survived deletion`);
    }
    return "deleted";
  });
}

export async function sampleCompanyStatuses(memberUserId: string): Promise<SampleCompanyStatus[]> {
  const [templates, existing] = await Promise.all([
    withBypassContext(async () => {
      const result = (await db.execute<{ profile: string }>(sql`
        select distinct o.settings->'sampleTemplate'->>'profileId' as profile
          from orgs o
         where o.env_kind in ('production', 'sandbox')
           and coalesce((o.settings->'sampleTemplate'->>'enabled')::boolean, false)
           and o.settings->'sampleTemplate'->>'profileId' in ${SAMPLE_COMPANY_PROFILES.map((profile) => profile.profileId)}
           and not (o.settings ? 'sampleCompany')
      `));
      return new Set(result.rows.map((row) => row.profile));
    }),
    withBypassContext(async () => {
      const result = (await db.execute<{ id: string; industry: string }>(sql`
        select o.id, o.settings->'sampleCompany'->>'industryKey' as industry
          from orgs o
          join user_org_access access
            on access.org_id = o.id
           and access.member_user_id = ${memberUserId}
           and access.is_active
         where o.env_kind = 'preview'
           and o.settings->'sampleCompany'->>'ownerUserId' = ${memberUserId}
      `));
      return new Map(result.rows.map((row) => [row.industry, row.id]));
    }),
  ]);
  return SAMPLE_COMPANY_PROFILES.map((profile) => ({
    ...profile,
    templateReady: templates.has(profile.profileId),
    existingOrgId: existing.get(profile.industryKey) ?? null,
  }));
}

function generationWindow(now = new Date()): { startDate: string; endDate: string } {
  const endDate = now.toISOString().slice(0, 10);
  // Three complete accounting-period identities are enough to demonstrate
  // opening activity, a prior close, and the current period without making a
  // first-run sample import wait on an unnecessarily large simulation.
  // Year is the wall-clock `now` (live clock in production), which cannot be below 100 — see the allow-list.
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return { startDate: start.toISOString().slice(0, 10), endDate };
}

async function generateTemplate(profileId: string): Promise<TemplateRow> {
  const runsRoot = mkdtempSync(join(tmpdir(), "openbooks-sample-template-"));
  try {
    const window = generationWindow();
    const provisioned = await provisionRun({
      profileId,
      seed: "openbooks-sample-v1",
      startDate: window.startDate,
      endDate: window.endDate,
      runsRoot,
    });
    const manifest = await runSimulatorThroughTransientDatabaseFailures(provisioned.runDir);
    if (manifest.status !== "completed" || manifest.defects.length > 0) {
      throw new SampleCompanyError(`sample template ${profileId} did not pass its simulator oracle`);
    }
    await markSimulationOraclePassed(provisioned.orgId, profileId);
    const generated = await templateRowForOrg(provisioned.orgId);
    if (!generated) {
      throw new SampleCompanyError(`sample template ${profileId} did not meet the minimum data coverage`);
    }
    assertTemplateCoverage(generated);
    return generated;
  } finally {
    // This exact path is created by mkdtemp above and contains only ephemeral
    // simulator manifests/checkpoints. The accounting tenant remains in Postgres.
    rmSync(runsRoot, { recursive: true, force: true });
  }
}

function isTransientDatabaseFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (
      /query read timeout|connection timeout|connection terminated|server closed the connection|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up/i.test(
        message,
      )
    ) return true;
    current = current instanceof Error && "cause" in current
      ? (current as Error & { cause?: unknown }).cause
      : null;
  }
  return false;
}

async function runOperationThroughTransientDatabaseFailures<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const maximumAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientDatabaseFailure(error) || attempt >= maximumAttempts) throw error;
      const delayMs = attempt * 1_000;
      console.error(
        `[sample-company] transient database failure during ${label}; retrying `
          + `(attempt ${attempt + 1}/${maximumAttempts})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function runSimulatorThroughTransientDatabaseFailures(
  runDir: string,
): Promise<Awaited<ReturnType<typeof autopilotRunToEnd>>> {
  const maximumAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await autopilotRunToEnd(runDir);
    } catch (error) {
      if (!isTransientDatabaseFailure(error) || attempt >= maximumAttempts) throw error;
      const delayMs = attempt * 1_000;
      console.error(
        `[sample-company] transient database failure; resuming simulator run `
          + `(attempt ${attempt + 1}/${maximumAttempts})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function markSimulationOraclePassed(orgId: string, profileId: string): Promise<void> {
  await withOrgTransaction(orgId, async () => {
    await db.transaction(async (tx) => {
      const before = (await tx.execute<{ value: unknown }>(sql`
        select settings->'sampleTemplateOracle' as value
          from orgs where id = ${orgId} for update
      `));
      const after = {
        version: 1,
        profileId,
        status: "passed",
        seed: "openbooks-sample-v1",
        verifiedAt: new Date().toISOString(),
      };
      await tx.execute(sql`
        update orgs
           set settings = jsonb_set(settings, '{sampleTemplateOracle}', ${JSON.stringify(after)}::jsonb, true),
               updated_at = now()
         where id = ${orgId}
      `);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, request_id)
        values (
          ${orgId}, 'orgs', ${orgId}, 'update',
          ${JSON.stringify({
            source: "sample_company_simulator",
            reason: "Simulation completed with no oracle defects",
            sampleTemplateOracle: { before: before.rows[0]?.value ?? null, after },
          })}::jsonb,
          ${`sample-template-oracle:${profileId}`}
        )
      `);
    });
  });
}

async function markTemplate(template: TemplateRow, profileId: string): Promise<void> {
  await withOrgTransaction(template.id, async () => {
    await db.transaction(async (tx) => {
      const before = (await tx.execute<{ value: unknown }>(sql`
        select settings->'sampleTemplate' as value from orgs where id = ${template.id} for update
      `));
      const current = before.rows[0]?.value;
      const currentCoverage = current && typeof current === "object"
        ? (current as Record<string, unknown>).coverage
        : null;
      const coverageMatches = currentCoverage && typeof currentCoverage === "object"
        && Number((currentCoverage as Record<string, unknown>).documents) === template.documents
        && Number((currentCoverage as Record<string, unknown>).postedEntries) === template.postedEntries
        && Number((currentCoverage as Record<string, unknown>).parties) === template.parties
        && Number((currentCoverage as Record<string, unknown>).periods) === template.periods
        && Number((currentCoverage as Record<string, unknown>).adminRoles) === template.adminRoles;
      if (
        current
        && typeof current === "object"
        && (current as Record<string, unknown>).enabled === true
        && (current as Record<string, unknown>).profileId === profileId
        && coverageMatches
      ) return;
      const after = {
        enabled: true,
        profileId,
        version: 1,
        verifiedAt: new Date().toISOString(),
        coverage: {
          documents: template.documents,
          postedEntries: template.postedEntries,
          parties: template.parties,
          periods: template.periods,
          adminRoles: template.adminRoles,
        },
      };
      await tx.execute(sql`
        update orgs
           set settings = jsonb_set(settings, '{sampleTemplate}', ${JSON.stringify(after)}::jsonb, true),
               updated_at = now()
         where id = ${template.id}
      `);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes)
        values (
          ${template.id}, 'orgs', ${template.id}, 'update',
          ${JSON.stringify({
            sampleTemplate: { before: before.rows[0]?.value ?? null, after },
            reason: "verified synthetic company registered as a reusable sample template",
          })}::jsonb
        )
      `);
    });
  });
}

async function finalizePreview(args: FinalizeSampleCompanyArgs): Promise<void> {
  await withOrgTransaction(args.sandboxOrgId, async () => {
    await db.transaction(async (tx) => {
      const current = (await tx.execute<{ settings: Record<string, unknown> }>(sql`
        select settings from orgs where id = ${args.sandboxOrgId} for update
      `));
      const row = current.rows[0];
      if (!row) throw new SampleCompanyError("cloned sample organization disappeared during provisioning");

      const actingUserId = randomUUID();
      const role = (await tx.execute<{ id: string }>(sql`
        select id from app_roles
         where org_id = ${args.sandboxOrgId} and key = 'admin'
         limit 1
      `));
      if (!role.rows[0]) throw new SampleCompanyError("sample template has no administrator role");

      await tx.execute(sql`
        insert into users (id, org_id, email, name, password_hash, is_active, created_by, updated_by)
        values (
          ${actingUserId}, ${args.sandboxOrgId},
          ${`sample-${args.input.memberUserId}@openbooks.invalid`},
          ${args.input.memberName || "Sample company administrator"},
          'sample-company-direct-login-disabled', true, ${actingUserId}, ${actingUserId}
        )
      `);
      await tx.execute(sql`
        insert into role_assignments (org_id, user_id, role_id, created_by, updated_by)
        values (${args.sandboxOrgId}, ${actingUserId}, ${role.rows[0].id}, ${actingUserId}, ${actingUserId})
      `);

      const settings = { ...(row.settings ?? {}) };
      delete settings.simHarness;
      delete settings.sampleTemplate;
      settings.industry = args.input.industryKey;
      settings.features = { ...args.input.features };
      settings.workspaceProfile = {
        teamSize: "small",
        complexity: "growing",
        bookStart: "fresh",
        taxPosition: "unsure",
        monthlyActivity: "steady",
        closeCadence: "monthly",
        assessedAt: new Date().toISOString(),
        assessedBy: actingUserId,
      };
      settings.onboarding = {
        schemaVersion: 1,
        setupComplete: true,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        completedBy: actingUserId,
      };
      // SC-RESUME: this transaction completes the 'finalized' stage but
      // grants NO member access. Access is granted last, by
      // grantSampleCompanyAccess, only once numbering has reconciled — a
      // partial company must never carry an active user_org_access row.
      settings.sampleCompany = {
        version: 1,
        industryKey: args.input.industryKey,
        profileId: args.profileId,
        ownerUserId: args.input.memberUserId,
        requestedFromOrgId: args.input.sourceOrgId,
        templateOrgId: args.templateOrgId,
        createdAt: new Date().toISOString(),
        immutableSyntheticSource: true,
        provisioningStage: "finalized",
        finalizedBy: actingUserId,
      };

      const sampleName = args.companyName;
      await tx.execute(sql`
        update orgs
           set name = ${sampleName}, legal_name = ${args.companyName}, env_kind = 'preview',
               settings = ${JSON.stringify(settings)}::jsonb,
               updated_at = now(), updated_by = ${actingUserId}
         where id = ${args.sandboxOrgId}
      `);
      await tx.execute(sql`
        update subsidiaries
           set name = ${args.companyName}, legal_name = ${args.companyName},
               updated_at = now(), updated_by = ${actingUserId}
         where org_id = ${args.sandboxOrgId} and parent_id is null
      `);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (
          ${args.sandboxOrgId}, 'orgs', ${args.sandboxOrgId}, 'insert',
          ${JSON.stringify({
            mode: "sample_company_clone",
            industryKey: args.input.industryKey,
            profileId: args.profileId,
            templateOrgId: args.templateOrgId,
            ownerUserId: args.input.memberUserId,
            outboundEffects: "disabled",
          })}::jsonb,
          ${actingUserId}
        )
      `);
    });
  });
}

/**
 * Grant the requesting member access to their company and flip it ready in
 * one transaction. This is the LAST provisioning step by design: a partial
 * company (cloned or finalized but not yet reconciled) never carries an
 * active user_org_access row, so no user can enter it before it is ready,
 * and existingFor (which joins active access) can never return one. The
 * upsert keeps the grant idempotent for resumed retries.
 */
async function grantSampleCompanyAccess(args: {
  sandboxOrgId: string;
  memberUserId: string;
}): Promise<void> {
  await withOrgTransaction(args.sandboxOrgId, async () => {
    await db.transaction(async (tx) => {
      const current = (await tx.execute<{ settings: Record<string, unknown> }>(sql`
        select settings from orgs where id = ${args.sandboxOrgId} for update
      `));
      const row = current.rows[0];
      if (!row) throw new SampleCompanyError("sample company disappeared during provisioning");
      const company = (row.settings ?? {}).sampleCompany;
      if (!company || typeof company !== "object") {
        throw new SampleCompanyError("sample company is missing its provisioning record");
      }
      const record = company as Record<string, unknown>;
      if (record.ownerUserId !== args.memberUserId) {
        throw new SampleCompanyError("sample company belongs to a different member");
      }
      const actingUserId = record.finalizedBy;
      if (typeof actingUserId !== "string" || actingUserId.length === 0) {
        throw new SampleCompanyError("sample company was never finalized");
      }
      await tx.execute(sql`
        insert into user_org_access
          (member_user_id, org_id, acting_user_id, is_active, created_by, updated_by)
        values (
          ${args.memberUserId}, ${args.sandboxOrgId}, ${actingUserId}, true,
          ${actingUserId}, ${actingUserId}
        )
        on conflict (member_user_id, org_id) do update
          set acting_user_id = excluded.acting_user_id, is_active = true,
              updated_at = now(), updated_by = excluded.updated_by
        where user_org_access.org_id = ${args.sandboxOrgId}
      `);
      const settings = { ...(row.settings ?? {}) };
      settings.sampleCompany = { ...record, provisioningStage: "ready" };
      const stamped = (await tx.execute(sql`
        update orgs
           set settings = ${JSON.stringify(settings)}::jsonb,
               updated_at = now(), updated_by = ${actingUserId}
         where id = ${args.sandboxOrgId}
      `)) as unknown as { rowCount?: number | null };
      if (stamped.rowCount !== 1) {
        throw new SampleCompanyError("sample company disappeared during provisioning");
      }
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (
          ${args.sandboxOrgId}, 'orgs', ${args.sandboxOrgId}, 'update',
          ${JSON.stringify({
            mode: "sample_company_ready",
            industryKey: record.industryKey,
            profileId: record.profileId,
            ownerUserId: args.memberUserId,
          })}::jsonb,
          ${actingUserId}
        )
      `);
    });
  });
}

export interface FinalizeSampleCompanyArgs {
  sandboxOrgId: string;
  templateOrgId: string;
  input: CreateSampleCompanyInput;
  companyName: string;
  profileId: string;
}

/**
 * Step seams for createSampleCompany. Every step is injectable for tests;
 * production always uses the real pipeline. This is what lets a regression
 * test force a failure after the clone (or inside numbering) and then retry
 * through the real resume path.
 */
export interface SampleCompanyProvisionDeps {
  prepareTemplate?: (industryKey: string) => Promise<PrepareSampleCompanyResult>;
  finalizeCompany?: (args: FinalizeSampleCompanyArgs) => Promise<void>;
  reconcileNumbering?: (orgId: string) => Promise<unknown>;
}

/**
 * Resume a partial company from its recorded stage, running only the stages
 * that never committed. Finalize and numbering are reported by their own
 * stage on failure, so the refusal stays truthful across retries; the
 * access grant is never staged — its specific errors (foreign record,
 * missing finalize) propagate as known refusals.
 */
async function resumePartialSampleCompany(args: {
  partial: PartialSampleCompany;
  input: CreateSampleCompanyInput;
  companyName: string;
  profileId: string;
  finalizeCompany: (step: FinalizeSampleCompanyArgs) => Promise<void>;
  reconcileNumbering: (orgId: string) => Promise<unknown>;
}): Promise<void> {
  const stage = args.partial.stage as SampleCompanyOrgStage;
  if (stage === "cloned") {
    await runProvisioningStage("finalize", () =>
      args.finalizeCompany({
        sandboxOrgId: args.partial.id,
        templateOrgId: args.partial.templateOrgId,
        input: args.input,
        companyName: args.companyName,
        profileId: args.profileId,
      }),
    );
  }
  if (stage === "cloned" || stage === "finalized") {
    await runProvisioningStage("numbering", () =>
      args.reconcileNumbering(args.partial.id),
    );
    await setSampleCompanyStage(args.partial.id, "numbering_reconciled");
  }
  await grantSampleCompanyAccess({
    sandboxOrgId: args.partial.id,
    memberUserId: args.input.memberUserId,
  });
}

export async function createSampleCompany(
  input: CreateSampleCompanyInput,
  deps: SampleCompanyProvisionDeps = {},
): Promise<CreateSampleCompanyResult> {
  const profile = SAMPLE_COMPANY_BY_INDUSTRY.get(input.industryKey);
  if (!profile) throw new SampleCompanyError(`unknown sample-company industry: ${input.industryKey}`);

  // The API does not accept a template/source organization from the client,
  // but the domain service still enforces access so internal callers cannot
  // accidentally turn the privileged clone kernel into a cross-tenant reader.
  await assertSampleRequestAccess(input);

  const alreadyPrepared = await existingFor(input.memberUserId, input.industryKey);
  if (alreadyPrepared) {
    return { orgId: alreadyPrepared.id, name: alreadyPrepared.name, created: false, templateGenerated: false };
  }
  // Step seams: every stage is injectable for tests; production always
  // uses the real pipeline.
  const prepareTemplate = deps.prepareTemplate
    ?? ((industryKey: string) => prepareSampleCompanyTemplate(industryKey));
  const finalizeCompany = deps.finalizeCompany
    ?? ((step: FinalizeSampleCompanyArgs) => finalizePreview(step));
  const reconcileNumbering = deps.reconcileNumbering
    ?? ((orgId: string) =>
      withOrgContext(orgId, () => reconcileDocumentSequences(db, orgId)));
  // Template preparation has its own profile-wide lock. Complete it before
  // taking the member lock so a burst of first-use requests cannot exhaust the
  // connection pool while holding one advisory lock and waiting for another.
  // OM-14: every unexpected failure below is reported by its pipeline stage
  // with a stable code and a fixed operator-facing message — never SQL text.
  const prepared = await runProvisioningStage("template", () =>
    prepareTemplate(input.industryKey),
  );

  const lockKey = `openbooks:sample-company:${input.memberUserId}:${input.industryKey}`;
  let lockClient = await pool.connect();
  let lockHealthy = true;
  const handleLockError = (error: Error) => {
    lockHealthy = false;
    console.error(
      `[sample-company] member lock connection was lost; it will be reacquired: ${error.message}`,
    );
  };
  const attachLockClient = () => {
    lockHealthy = true;
    lockClient.on("error", handleLockError);
  };
  const releaseLockClient = async () => {
    lockClient.off("error", handleLockError);
    if (lockHealthy) {
      await lockClient
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
        .catch(() => {});
    }
    lockClient.release(lockHealthy ? undefined : new Error("sample company member lock lost"));
  };
  const reacquireLockIfNeeded = async () => {
    if (lockHealthy) return;
    await releaseLockClient();
    lockClient = await pool.connect();
    attachLockClient();
    await lockClient.query("select pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
  };
  attachLockClient();
  try {
    await lockClient.query("select pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    const existing = await existingFor(input.memberUserId, input.industryKey);
    if (existing) {
      return { orgId: existing.id, name: existing.name, created: false, templateGenerated: false };
    }

    // SC-RESUME: a previous attempt may have committed the clone but failed
    // before the company was ready. Resume it from its recorded stage — a
    // retry that cloned again would strand a second company. A record that
    // cannot be resumed (unrecognized stage) is compensated through the
    // product's own sandbox deletion path before re-provisioning.
    const partial = await findPartialSampleCompany(input.memberUserId, input.industryKey);
    if (partial) {
      if (isSampleCompanyOrgStage(partial.stage) && partial.templateOrgId) {
        await resumePartialSampleCompany({
          partial,
          input,
          companyName: profile.companyName,
          profileId: profile.profileId,
          finalizeCompany,
          reconcileNumbering,
        });
        return {
          orgId: partial.id,
          name: profile.companyName,
          created: true,
          templateGenerated: prepared.generated,
        };
      }
      await deletePartialSampleOrg(partial.id);
    }

    const cloned = await runProvisioningStage("clone", () =>
      withBypassContext(() =>
        createSandbox({
          productionOrgId: prepared.templateOrgId,
          name: profile.companyName,
          tier: "full",
          masked: false,
          createdBy: null,
        }),
      ),
    );
    // Record the clone durably before any later stage can fail: this marker
    // is what the next retry resumes from.
    await stampClonedSampleCompany({
      sandboxOrgId: cloned.sandboxOrgId,
      industryKey: input.industryKey,
      profileId: profile.profileId,
      memberUserId: input.memberUserId,
      sourceOrgId: input.sourceOrgId,
      templateOrgId: prepared.templateOrgId,
    });
    await reacquireLockIfNeeded();
    const winnerBeforeFinalize = await existingFor(input.memberUserId, input.industryKey);
    if (winnerBeforeFinalize) {
      await withBypassContext(() => deleteSandbox(cloned.sandboxId));
      return {
        orgId: winnerBeforeFinalize.id,
        name: winnerBeforeFinalize.name,
        created: false,
        templateGenerated: false,
      };
    }
    await runProvisioningStage("finalize", () =>
      finalizeCompany({
        sandboxOrgId: cloned.sandboxOrgId,
        templateOrgId: prepared.templateOrgId,
        input,
        companyName: profile.companyName,
        profileId: profile.profileId,
      }),
    );
    // Sample-to-live handoff (OM-01): the clone carries the template's
    // documents, so advance its canonical sequences past the highest cloned
    // number per kind even if the copy did not carry the reconciled counters.
    // Forward-only and idempotent — a no-op when the counters already lead.
    await runProvisioningStage("numbering", () =>
      reconcileNumbering(cloned.sandboxOrgId),
    );
    await setSampleCompanyStage(cloned.sandboxOrgId, "numbering_reconciled");
    // Access is granted last: only a fully reconciled company becomes ready.
    await grantSampleCompanyAccess({
      sandboxOrgId: cloned.sandboxOrgId,
      memberUserId: input.memberUserId,
    });
    if (!lockHealthy) {
      await reacquireLockIfNeeded();
      const winner = await existingFor(input.memberUserId, input.industryKey);
      if (winner && winner.id !== cloned.sandboxOrgId) {
        await withBypassContext(() => deleteSandbox(cloned.sandboxId));
        return {
          orgId: winner.id,
          name: winner.name,
          created: false,
          templateGenerated: false,
        };
      }
      if (!lockHealthy) {
        throw new SampleCompanyError("sample company member lock could not be held through registration");
      }
    }
    return {
      orgId: cloned.sandboxOrgId,
      name: profile.companyName,
      created: true,
      templateGenerated: prepared.generated,
    };
  } finally {
    await releaseLockClient();
  }
}
