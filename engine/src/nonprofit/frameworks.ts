import { sql } from "drizzle-orm";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { db, inDbTransaction, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { fundFeatureOff, NonprofitError } from "./errors.ts";

export const NONPROFIT_FRAMEWORKS = {
  us_asc958: {
    key: "us_asc958",
    name: "US GAAP — ASC 958",
    classes: {
      without_donor_restrictions: "Without donor restrictions",
      with_donor_restrictions: "With donor restrictions",
    },
    releasePairs: [{ from: "with_donor_restrictions", to: "without_donor_restrictions" }],
    statementLabels: {
      financialPosition: "Statement of Financial Position",
      activities: "Statement of Activities",
      netAssets: "Net Assets",
    },
  },
  ew_sorp_frs102: {
    key: "ew_sorp_frs102",
    name: "England and Wales Charities SORP — FRS 102",
    classes: {
      unrestricted: "Unrestricted",
      restricted: "Restricted",
      endowment: "Endowment",
    },
    releasePairs: [{ from: "restricted", to: "unrestricted" }],
    statementLabels: {
      financialPosition: "Balance Sheet",
      activities: "Statement of Financial Activities",
      netAssets: "Funds",
    },
  },
} as const;

export type NonprofitFrameworkKey = keyof typeof NONPROFIT_FRAMEWORKS;
export type NonprofitFrameworkPack = (typeof NONPROFIT_FRAMEWORKS)[NonprofitFrameworkKey];

export interface NonprofitFrameworkRecord {
  orgId: string;
  framework: NonprofitFrameworkKey;
  setAt: string;
  setBy: string;
  reason: string;
}

function isFrameworkKey(value: unknown): value is NonprofitFrameworkKey {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(NONPROFIT_FRAMEWORKS, value);
}

export function frameworkPack(key: NonprofitFrameworkKey): NonprofitFrameworkPack {
  return NONPROFIT_FRAMEWORKS[key];
}

export function frameworkDeclaresRelease(
  key: NonprofitFrameworkKey,
  fromClass: string,
  toClass: string,
): boolean {
  return NONPROFIT_FRAMEWORKS[key].releasePairs.some(
    (pair) => pair.from === fromClass && pair.to === toClass,
  );
}

async function loadFramework(
  executor: SqlExecutor,
  orgId: string,
): Promise<NonprofitFrameworkRecord | null> {
  const row = (await executor.execute<{
    org_id: string;
    framework: string;
    set_at: string;
    set_by: string;
    reason: string;
  }>(sql`
    select org_id, framework, set_at::text, set_by::text, reason
      from nonprofit_frameworks
     where org_id = ${orgId}
  `)).rows[0];
  if (!row) return null;
  if (!isFrameworkKey(row.framework)) {
    throw new NonprofitError({
      message: `The configured nonprofit framework "${row.framework}" is not supported.`,
      status: 409,
      code: "nonprofit_framework_invalid",
      remedy: "Choose US ASC 958 or England and Wales Charities SORP FRS 102 with setFramework.",
    });
  }
  return {
    orgId: row.org_id,
    framework: row.framework,
    setAt: row.set_at,
    setBy: row.set_by,
    reason: row.reason,
  };
}

export async function getNonprofitFramework(
  orgId: string,
  executor: SqlExecutor = db,
): Promise<NonprofitFrameworkRecord | null> {
  return loadFramework(executor, orgId);
}

export async function requireNonprofitFramework(
  orgId: string,
  executor: SqlExecutor = db,
): Promise<NonprofitFrameworkRecord> {
  const record = await loadFramework(executor, orgId);
  if (!record) {
    throw new NonprofitError({
      message: "A nonprofit accounting framework has not been selected for this organization.",
      status: 409,
      code: "nonprofit_framework_not_set",
      remedy: "Select a supported framework with setFramework before creating fund releases.",
    });
  }
  return record;
}

function frameworkHistoryRefusal(lineCount: number): NonprofitError {
  return new NonprofitError({
    message: `The nonprofit framework cannot change while ${lineCount} posted fund-tagged journal line${lineCount === 1 ? "" : "s"} exist.`,
    status: 409,
    code: "nonprofit_framework_has_posted_history",
    remedy: "Continue with this framework, or use a separate organization for activity under another framework.",
  });
}

function frameworkGuardMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { message?: unknown; cause?: unknown };
  if (typeof candidate.message === "string" &&
    candidate.message.includes("nonprofit framework cannot change or be removed while")) {
    return candidate.message;
  }
  return frameworkGuardMessage(candidate.cause);
}

export async function setFramework(input: {
  orgId: string;
  framework: NonprofitFrameworkKey;
  actorId: string;
  reason: string;
}): Promise<NonprofitFrameworkRecord> {
  if (!isFrameworkKey(input.framework)) {
    throw new NonprofitError({
      message: "The nonprofit framework is not supported.",
      status: 422,
      code: "nonprofit_framework_invalid",
      remedy: "Choose US ASC 958 or England and Wales Charities SORP FRS 102.",
      field: "framework",
    });
  }
  if (!input.actorId) {
    throw new NonprofitError({
      message: "A user must be identified when setting the nonprofit framework.",
      status: 422,
      code: "nonprofit_framework_actor_required",
      remedy: "Sign in with an organization user and retry.",
      field: "actorId",
    });
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new NonprofitError({
      message: "A reason is required when setting the nonprofit framework.",
      status: 422,
      code: "nonprofit_framework_reason_required",
      remedy: "Enter the reason for selecting or changing the framework.",
      field: "reason",
    });
  }

  try {
    return await withOrgTransaction(input.orgId, () =>
      inDbTransaction(async (tx) => {
        if (!(await lockAndCheckOrgFeature(tx, input.orgId, "fundAccounting"))) {
          throw fundFeatureOff();
        }

        const existing = await loadFramework(tx, input.orgId);
        if (existing && existing.framework !== input.framework) {
          const count = (await tx.execute<{ line_count: string }>(sql`
            select count(*)::text as line_count
              from journal_lines jl
              join journal_entries je
                on je.org_id = jl.org_id and je.id = jl.entry_id
             where jl.org_id = ${input.orgId}
               and jl.extra_dims ? 'fund'
               and je.status is distinct from 'draft'
          `)).rows[0]?.line_count ?? "0";
          const lineCount = Number(count);
          if (lineCount > 0) throw frameworkHistoryRefusal(lineCount);
        }

        const saved = (await tx.execute<{
          id: string;
          framework: string;
          set_at: string;
          set_by: string;
          reason: string;
        }>(sql`
          insert into nonprofit_frameworks
            (org_id, framework, set_at, set_by, reason, created_by, updated_by)
          values (
            ${input.orgId}, ${input.framework}, now(), ${input.actorId}, ${reason},
            ${input.actorId}, ${input.actorId}
          )
          -- The singleton upsert serializes setup writers and returns the row that was saved.
          on conflict (org_id) do update
            set framework = excluded.framework,
                set_at = excluded.set_at,
                set_by = excluded.set_by,
                reason = excluded.reason,
                updated_at = now(),
                updated_by = excluded.updated_by
          returning id, framework, set_at::text, set_by::text, reason
        `)).rows[0];
        if (!saved) {
          throw new NonprofitError({
            message: "The nonprofit framework was not saved.",
            status: 409,
            code: "nonprofit_framework_write_missing",
            remedy: "Retry the framework change after checking the nonprofit setup record.",
          });
        }

        await tx.execute(sql`
          insert into audit_log
            (org_id, table_name, row_id, action, changes, actor_id)
          values (
            ${input.orgId}, 'nonprofit_frameworks', ${saved.id},
            ${existing ? "update" : "insert"},
            ${JSON.stringify({
              before: existing,
              after: {
                framework: saved.framework,
                setAt: saved.set_at,
                setBy: saved.set_by,
                reason: saved.reason,
              },
              reason,
            })}::jsonb,
            ${input.actorId}
          )
        `);
        return {
          orgId: input.orgId,
          framework: saved.framework as NonprofitFrameworkKey,
          setAt: saved.set_at,
          setBy: saved.set_by,
          reason: saved.reason,
        };
      }),
    );
  } catch (error) {
    const guardMessage = frameworkGuardMessage(error);
    if (guardMessage) {
      const count = Number(
        guardMessage.match(/while\s+(\d+)/)?.[1] ?? 0,
      );
      throw frameworkHistoryRefusal(count);
    }
    throw error;
  }
}
