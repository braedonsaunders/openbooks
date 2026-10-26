/**
 * Line-contribution hooks: accounts and lines a domain supplies before the
 * kernel builds a document's entry. Ordering and installation: see
 * posting-contributors.ts.
 */
import type { SqlExecutor } from "../platform/db.ts";
import type { ContributedLine, PostContributionResult } from "./contributed-lines.ts";
import type { EntryLineInput, EntryPlan } from "./entry-allocation-plan.ts";
import type { CashPostingTender, CashSaleCloseout, KernelLine } from "./posting-contracts.ts";
import { postingContributorRegistry } from "./posting-contributors.ts";

export interface CustomGlLineRequest {
  orgId: string;
  document: Record<string, unknown>;
  documentLines: Record<string, unknown>[];
  /** The kernel's own lines, read-only to scripts. */
  kernelLines: Record<string, unknown>[];
  actorId: string | null;
  targetId: string;
}

/** A drop-ship line posted as agent: the vendor's share and the account it clears. */
export interface AgencyLinePosting {
  accountId: string;
  vendorAmount: string;
}

/** A document save's lines, as entry-mode allocation plans their split. */
export interface EntryAllocationRequest {
  orgId: string;
  documentId: string;
  kind: string;
  documentDate: string;
  /** Header dimensions the save supplies; unset ones fall back to the stored header. */
  header: {
    departmentId?: string | null;
    projectId?: string | null;
    locationId?: string | null;
    classId?: string | null;
    subsidiaryId?: string | null;
  };
  lines: EntryLineInput[];
  /** The stored line each submitted line re-saves, aligned with lines; null for a new line. */
  lineIds: (string | null)[];
  unsplitDistributionGroups?: string[];
}

/** The posting document as post-mode allocation rules read it. */
export interface PostContributionDocument {
  id: string;
  orgId: string;
  kind: string;
  postingDate: string | null;
  documentDate: string;
  currency: string;
  subsidiaryId: string | null;
}

export interface PostingLineContributors {
  scripting: {
    /**
     * custom_gl_lines script contributions. A refused script set throws a
     * PostingError carrying the completed-run evidence.
     */
    runCustomGlLines(request: CustomGlLineRequest): Promise<ContributedLine[]>;
  };
  "stored-value": {
    /** Liability account per invoice line that sells stored value. */
    liabilityByLine(
      runner: SqlExecutor,
      documentId: string,
      orgId: string,
    ): Promise<Map<string, string>>;
    /** Liability account of the store-credit program a credit memo issues into. */
    storeCreditLiability(runner: SqlExecutor, orgId: string, programId: string): Promise<string>;
  };
  inventory: {
    /** Drop-ship agency routing per line; an unroutable line refuses with a PostingError. */
    agencyByLine(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
    ): Promise<Map<string, AgencyLinePosting>>;
    /** The same routing for historical replay, refusing with inventory's own error. */
    replayAgencyByLine(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
    ): Promise<Map<string, AgencyLinePosting>>;
    /** Inventory asset account per vendor bill line that receives stock. */
    billInventoryAccounts(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
    ): Promise<Map<string, string>>;
    /** Return offset account per vendor credit line that returns stock. */
    vendorCreditReturnAccounts(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
    ): Promise<Map<string, string>>;
  };
  allocations: {
    /** Entry-mode split of a document save's lines; a refused plan throws a DocumentEditError. */
    planEntryAllocations(request: EntryAllocationRequest): Promise<EntryPlan>;
    /**
     * Post-mode rule contributions to the document's own entry; a refused
     * rule set throws a PostingError. Migration replay and automation-suppressed
     * postings contribute nothing.
     */
    collectPostContributions(
      runner: SqlExecutor,
      document: PostContributionDocument,
      kernelLines: KernelLine[],
      options: { migration?: boolean; suppressAutomation?: boolean; actorId: string | null },
      postingDate: string,
    ): Promise<PostContributionResult>;
    /** Refuses a contributor whose lines do not balance per subsidiary and book. */
    assertContributorBalance(lines: PostContributionResult["lines"]): void;
  };
  sales: {
    /**
     * The tenders a cash sale or refund settles with, each with its account; a
     * refused tender throws a PostingError. validateRefundLoads proves a
     * refund's stored-value loads before the posting writes.
     */
    cashTenders(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
      parent: {
        kind: "cash_sale" | "cash_refund";
        documentNumber: string;
        kindLabel: string;
        partyId: string | null;
        custom: unknown;
      },
      options?: { validateRefundLoads?: boolean },
    ): Promise<CashPostingTender[]>;
    /**
     * A cash sale's daily close-out (tips, processor fees, counted over/short)
     * with its control accounts; a refused close-out throws a PostingError
     * naming its Setup remedy. Null when the sale carries no close-out.
     */
    cashCloseout(
      runner: SqlExecutor,
      orgId: string,
      custom: unknown,
      tenders: readonly { kind: string; amountMinor: bigint }[],
    ): Promise<CashSaleCloseout | null>;
  };
}

export const postingLineHooks =
  postingContributorRegistry<PostingLineContributors>("line contribution");
