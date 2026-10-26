import { sql } from "drizzle-orm";
import type { BalancingLegProvider } from "../journal/balancing-hooks.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import {
  assertNoSegmentDependencyViolations,
  loadSegmentDependencyRules,
  SegmentDependencyError,
} from "../organization/segment-dependencies.ts";

/**
 * Chart policies enforced inside the posting kernel's integrity seam, which
 * both journal writers (document posting and direct postings) call on their
 * final line set — so screens, the API, imports, scripts and jobs all meet
 * the same refusal before anything is written. Neither provider adds legs.
 */

/**
 * A merged account refuses every new posting, naming its survivor. The
 * storage guard refuses the same lines; this states it with account numbers
 * and the remedy before the write.
 */
export const mergedAccountPostingProvider: BalancingLegProvider = async (runner, ctx, lines) => {
  const ids = [...new Set(lines.map((line) => line.accountId))];
  if (ids.length === 0) return [];
  const merged = (
    await runner.execute<{
      id: string;
      label: string;
      survivor_id: string;
      survivor_label: string;
      merged_on: string;
    }>(
      sql`
    select a.id, concat_ws(' · ', a.number, a.name) as label,
           t.id as survivor_id, concat_ws(' · ', t.number, t.name) as survivor_label,
           a.merged_at::date::text as merged_on
      from accounts a
      join accounts t on t.org_id = a.org_id and t.id = a.merged_into_id
     where a.org_id = ${ctx.orgId} and a.id in ${ids} and a.merged_into_id is not null
     order by a.number nulls last, a.id
     limit 1`,
      "objects",
    )
  )[0];
  if (!merged) return [];
  throw new PostingError(
    `Account ${merged.label} was merged into ${merged.survivor_label} on ${merged.merged_on}; it no longer accepts postings. Post to ${merged.survivor_label} instead — a document posted earlier to the merged account is corrected with a journal entry on the surviving account.`,
    {
      details: {
        code: "account_merged",
        accountId: merged.id,
        survivorAccountId: merged.survivor_id,
      },
    },
  );
};

/**
 * Segment value dependencies at the posting boundary. Reversals restore an
 * existing posting and an account merge relocates existing balances, so
 * neither is re-evaluated; regeneration replays history and is exempt like
 * every policy provider.
 */
export const segmentDependencyPostingProvider: BalancingLegProvider = async (
  runner,
  ctx,
  lines,
) => {
  if (
    ctx.regeneration ||
    ctx.reversesEntryId ||
    ctx.origin === "account_merge" ||
    lines.length === 0
  )
    return [];
  const rules = await loadSegmentDependencyRules(runner, ctx.orgId, { onDate: ctx.postingDate });
  if (rules.length === 0) return [];
  try {
    assertNoSegmentDependencyViolations(
      rules,
      lines.map((line, index) => ({
        label: `Journal line ${index + 1}`,
        dims: {
          subsidiaryId: line.subsidiaryId,
          departmentId: line.departmentId ?? null,
          projectId: line.projectId ?? null,
          locationId: line.locationId ?? null,
          classId: line.classId ?? null,
          extraDims: line.extraDims ?? null,
        },
      })),
      ctx.postingDate,
    );
  } catch (error) {
    if (error instanceof SegmentDependencyError) {
      throw new PostingError(`${error.message}`, {
        details: { code: error.code, ...error.details },
      });
    }
    throw error;
  }
  return [];
};
