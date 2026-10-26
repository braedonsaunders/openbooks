import { toUnits } from "../money/money.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { type Doc, type PostingDeps, PostingError } from "../journal/posting-contracts.ts";
import {
  ControlAccountsIncompleteError,
  loadControlAccountsForRoles,
} from "../records/control-accounts.ts";

/**
 * A cash sale or refund with nothing to tender records its quantities on the
 * statistical No-charge units control account. The account is resolved (and
 * validated as an active statistical account) only for such a document, so
 * every other cash document posts without the configuration. Unconfigured
 * reads as null; the posting rule refuses with the Setup remedy if the
 * document then has nothing but quantities to record.
 */
export async function withNoChargeUnitsAccount(
  runner: SqlExecutor,
  doc: Pick<Doc, "kind" | "orgId" | "total">,
  deps: PostingDeps,
): Promise<PostingDeps> {
  if (doc.kind !== "cash_sale" && doc.kind !== "cash_refund") return deps;
  if (
    deps.noChargeUnitsAccountId !== undefined ||
    (deps.cashTenders ?? []).length > 0 ||
    toUnits(doc.total) !== 0n
  )
    return deps;
  try {
    const mappings = await loadControlAccountsForRoles(runner, doc.orgId, ["noChargeUnits"]);
    return { ...deps, noChargeUnitsAccountId: mappings.noChargeUnits ?? null };
  } catch (error) {
    if (error instanceof ControlAccountsIncompleteError) {
      throw new PostingError(
        `${error.message} — choose an active statistical account for No-charge units in Setup → Company & Accounting → Control accounts, then post again`,
      );
    }
    throw error;
  }
}
