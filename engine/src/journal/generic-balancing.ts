import { sql } from "drizzle-orm";
import { fromUnits, toUnits } from "../money/money.ts";
import { parseMoney } from "../money/brands.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import type { BalancingLeg, BalancingLegProvider, BalancingLineView } from "./balancing-hooks.ts";
import { loadBookProfile, resolveBookBases } from "./book-basis.ts";
import { applyBookAccountMaps } from "./book-account-maps.ts";
import { PostingError } from "./posting-contracts.ts";

export interface GenericBalancingGroup {
  subsidiaryId: string;
  extraDims: Record<string, string>;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  classId: string | null;
  amount: bigint;
}

/** Full dimension tuples preserve every simultaneous balancing segment, including null assignments. */
export function genericBalancingGroups(
  lines: readonly BalancingLineView[],
): GenericBalancingGroup[] {
  const groups = new Map<string, GenericBalancingGroup>();
  for (const line of lines) {
    const dims = {
      subsidiaryId: line.subsidiaryId,
      departmentId: line.departmentId ?? null,
      projectId: line.projectId ?? null,
      locationId: line.locationId ?? null,
      classId: line.classId ?? null,
      extraDims: Object.fromEntries(
        Object.entries(line.extraDims ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    };
    const key = canonicalJson(dims);
    const group = groups.get(key) ?? { ...dims, amount: 0n };
    group.amount += toUnits(line.amount);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => group)
    .filter((group) => group.amount !== 0n);
}

const dimension = (line: BalancingLineView, key: string, storage: string | null): unknown => {
  if (!storage) return line.extraDims?.[key] ?? null;
  const builtin = {
    subsidiary_id: line.subsidiaryId,
    department_id: line.departmentId,
    project_id: line.projectId,
    location_id: line.locationId,
    class_id: line.classId,
  };
  return builtin[storage as keyof typeof builtin] ?? null;
};

/** Domain-specific providers run first; generic policies balance only the remaining segment obligations. */
export const genericSegmentBalancingProvider: BalancingLegProvider = async (runner, ctx, lines) => {
  const definitions = await runner.execute<{
    key: string;
    storage_column: string | null;
    default_value_id: string | null;
    account_id: string | null;
    priority: number | null;
  }>(
    sql`
    select d.key,d.storage_column,d.default_value_id::text as default_value_id,
           p.clearing_account_id as account_id,p.priority from segment_definitions d
    left join lateral (select clearing_account_id,priority from segment_balancing_policies
      where org_id=d.org_id and segment_key=d.key and effective_from<=${ctx.postingDate}::date order by effective_from desc limit 1) p on true
    where d.org_id=${ctx.orgId} and d.is_active and d.is_balancing order by p.priority nulls last,d.key`,
    "objects",
  );
  const effectiveLines = lines.map((line) => {
    const extraDims: Record<string, unknown> = { ...line.extraDims };
    for (const definition of definitions) {
      if (
        !definition.storage_column &&
        definition.default_value_id !== null &&
        !Object.prototype.hasOwnProperty.call(extraDims, definition.key)
      ) {
        extraDims[definition.key] = definition.default_value_id;
      }
    }
    return { ...line, extraDims };
  });
  const unbalanced = definitions.filter((definition) => {
    const totals = new Map<string, bigint>();
    for (const line of effectiveLines) {
      const key = canonicalJson([
        line.subsidiaryId,
        dimension(line, definition.key, definition.storage_column),
      ]);
      totals.set(key, (totals.get(key) ?? 0n) + toUnits(line.amount));
    }
    return [...totals.values()].some((amount) => amount !== 0n);
  });
  if (unbalanced.length === 0) return [];
  const missing = unbalanced.find((definition) => !definition.account_id);
  if (missing)
    throw new PostingError(
      `Balancing segment ${missing.key} has no clearing policy for ${ctx.postingDate}. Configure a policy in Setup → Segment balancing policies.`,
    );
  const policy = unbalanced[0]!;
  const bookId = ctx.bookId ?? (await activePostingPrimaryBookId(ctx.orgId, runner));
  const book = bookId ? await loadBookProfile(runner, ctx.orgId, bookId) : null;
  if (!book) throw new PostingError("Segment balancing requires an active posting book.");
  const groups = genericBalancingGroups(effectiveLines);
  const bases = await resolveBookBases(runner, {
    orgId: ctx.orgId,
    book,
    postingDate: ctx.postingDate,
    subsidiaryIds: groups.map((group) => group.subsidiaryId),
  });
  const legs: BalancingLeg[] = [];
  for (const group of groups) {
    const mapped = book.isPrimary
      ? { lines: [{ accountId: policy.account_id!, subsidiaryId: group.subsidiaryId }] }
      : await applyBookAccountMaps(runner, {
          orgId: ctx.orgId,
          bookId: book.id,
          bookLabel: book.code,
          postingDate: ctx.postingDate,
          entryLabel: "Segment balancing",
          lines: [{ accountId: policy.account_id!, subsidiaryId: group.subsidiaryId }],
        });
    const accountId = mapped.lines[0]!.accountId;
    const account = (
      await runner.execute<{ id: string }>(
        sql`select id from accounts where org_id=${ctx.orgId} and id=${accountId}
      and is_active and not is_summary and type in ('asset_current_other','asset_other','liability_current_other','liability_long_term')`,
        "objects",
      )
    )[0];
    if (!account)
      throw new PostingError(
        "The segment balancing clearing account is unavailable. Choose an active balance-sheet clearing account in Setup → Segment balancing policies.",
      );
    const amount = parseMoney(fromUnits(-group.amount));
    legs.push({
      accountId,
      amount,
      txnAmount: amount,
      fxRate: "1",
      currency: bases.get(group.subsidiaryId)!.bookCurrency,
      subsidiaryId: group.subsidiaryId,
      extraDims: group.extraDims,
      departmentId: group.departmentId,
      projectId: group.projectId,
      locationId: group.locationId,
      classId: group.classId,
      memo: `Balance segment ${policy.key}`,
    });
  }
  return legs;
};
