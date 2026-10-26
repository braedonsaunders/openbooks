import { db } from "../platform/db.ts";
import { isIso4217CurrencyCode } from "../fx/currencies.ts";
import { docKindConfig } from "../records/document-kinds.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { DocumentDefaultsError, resolveTermsDueDate } from "./document-defaults.ts";

type PostingHeader = {
  kind: string;
  orgId: string;
  partyId: string | null;
  documentDate: string;
  dueDate: string | null;
  currency: string;
  documentNumber: string | null;
};

/**
 * The final header a document posts with, after scripts and flows have run,
 * and the terms-derived due date the posting stamps when it supplied one.
 *
 * A kind that declares dueDateFromTerms (invoices and bills) posts with a due
 * date: the one the document states, else the one its party's payment terms
 * (then the organization default) imply on the document date — the resolver
 * the drawer previews. With no terms at all the document is due on receipt,
 * its document date. The date is stamped with the posting, so the open item
 * and the document header agree and aging never sees an undated item.
 * Historical replay keeps the stored header untouched.
 *
 * The ledger boundary shares capture's ISO 4217 gate: no path posts a non-ISO
 * currency, whatever wrote the header (capture, API, sync, a before_post script
 * or flow). Shape is not membership: "ZZZ" is three uppercase letters and
 * denominates nothing, so it refuses here instead of posting untranslatable units.
 */
export async function finalizePostingHeader<T extends PostingHeader>(
  doc: T,
  migration: boolean,
): Promise<{ header: T; dueDateFromTerms: { dueDate: string } | null }> {
  let header = doc;
  let dueDateFromTerms: { dueDate: string } | null = null;
  if (!migration && docKindConfig(header.kind)?.dueDateFromTerms && header.dueDate == null) {
    try {
      dueDateFromTerms = await resolveTermsDueDate(db, header.orgId, {
        kind: header.kind,
        partyId: header.partyId,
        documentDate: header.documentDate,
      });
    } catch (error) {
      if (error instanceof DocumentDefaultsError) throw new PostingError(error.message);
      throw error;
    }
    dueDateFromTerms ??= { dueDate: header.documentDate };
    header = { ...header, dueDate: dueDateFromTerms.dueDate };
  }
  if (!isIso4217CurrencyCode(header.currency)) {
    throw new PostingError(
      `document ${header.documentNumber} has currency ${JSON.stringify(header.currency)} ` +
        `which is not an ISO 4217 code — correct the document currency to the 3-letter code before posting`,
    );
  }
  return { header, dueDateFromTerms };
}
