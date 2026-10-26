/**
 * Precondition hooks: refusals a domain raises, and state it must establish,
 * before a document's accounting transaction writes. A hook refuses with a
 * PostingError carrying its domain's message; the ledger propagates it
 * unchanged. Ordering and installation: see posting-contributors.ts.
 */
import type { SqlExecutor } from "../platform/db.ts";
import { postingContributorRegistry } from "./posting-contributors.ts";

export interface DocumentScriptUser {
  id: string;
  name: string;
  roles: string[];
}

/** What a document trigger script observes. */
export interface DocumentScriptContext {
  trigger: string;
  document: Record<string, unknown>;
  lines: Record<string, unknown>[];
  org: { id: string; name: string; baseCurrency: string };
  user?: DocumentScriptUser;
}

export interface DocumentScriptOutcome {
  name: string;
  status: "ok" | "aborted" | "error" | "timeout";
  set?: Record<string, unknown>;
  abortReason?: string;
}

/** Tenant trigger scripts a document lifecycle step runs. */
export interface DocumentScriptHooks {
  /** The acting user scripts run as; null for an absent or system actor. An inactive actor refuses. */
  resolveUser(orgId: string, actorId: string | null): Promise<DocumentScriptUser | null>;
  runTrigger(
    trigger: "before_post" | "after_post" | "before_void",
    ctx: DocumentScriptContext,
    targetId: string,
  ): Promise<DocumentScriptOutcome[]>;
}

/** Which stock leg a credit returns. */
export type ReturnSide = "purchase" | "sales";

/** The movement a credit line returns, as the operator chose it. */
export interface ReturnSourceSelection {
  side: ReturnSide;
  /** Null only for a walk-in cash refund returning a walk-in cash sale's goods. */
  partyId: string | null;
  itemId: string;
  stockLocationId: string;
  movementId: string;
  subsidiaryIds?: readonly string[] | null;
  lotId?: string | null;
  serialId?: string | null;
}

/** A document and its lines as a source-integrity check compares them with live state. */
export interface PostingSourceSnapshot {
  document: Record<string, unknown>;
  lines: Record<string, unknown>[];
}

export interface PostingPreconditions {
  scripting: DocumentScriptHooks & {
    /** Merge a before_post custom mutation without replacing protected posting controls. */
    mergeBeforePostCustomMutation(existing: unknown, mutation: unknown): Record<string, unknown>;
    /** The refusal message when automation changed a protected posting control, else null. */
    beforePostCustomControlsChanged(previous: unknown, next: unknown): string | null;
  };
  compliance: {
    /** Refuses a subcontractor bill a block_bill compliance requirement forbids. */
    assertBillPostingAllowed(input: {
      orgId: string;
      partyId: string;
      projectId: string | null;
      documentNumber: string;
      asOf: string;
    }): Promise<void>;
  };
  crm: {
    /** Make the party of a receivable document an active customer; reports whether the role is active. */
    establishCustomerRole(
      executor: SqlExecutor,
      input: {
        orgId: string;
        partyId: string;
        actorId: string;
        sourceKind: string;
        sourceId: string;
      },
    ): Promise<{ customerRoleActive: boolean }>;
  };
  payroll: {
    /**
     * Refuses, with a PayrollError, a remittance bill that no longer matches
     * the committed payroll it consumed. Other documents return.
     */
    assertRemittanceBillCurrent(
      orgId: string,
      documentId: string,
      executor: SqlExecutor,
    ): Promise<void>;
    /**
     * Refuses, with a DocumentEditError, an edit that changes a remittance
     * bill's stamped lines, currency or subsidiary. True for a remittance
     * bill, whose stored lines the editor keeps.
     */
    assertRemittanceBillEdit(
      executor: SqlExecutor,
      orgId: string,
      documentId: string,
      preparedLines: unknown[] | null,
      patch: { currency?: string | undefined; subsidiaryId?: string | null | undefined },
    ): Promise<boolean>;
  };
  inventory: {
    /** Match hand-coded received-stock bill lines to their purchase order lines. */
    matchBillLinesToOrders(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
      actorId: string | null,
    ): Promise<unknown>;
    assertBillReceiptsPostable(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
    ): Promise<void>;
    assertInvoiceIssuesPostable(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
    ): Promise<void>;
    assertVendorCreditReturnsPostable(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
      vendorId: string | null,
      subsidiaryId: string,
    ): Promise<void>;
    assertCustomerCreditReturnsPostable(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
      customerId: string | null,
      subsidiaryId: string,
    ): Promise<void>;
    /** Active warehouses, code-ordered. */
    activeStockLocations(orgId: string): Promise<{ id: string }[]>;
    /** The items among itemIds that carry a stock profile. */
    profiledItemIds(orgId: string, itemIds: string[]): Promise<Set<string>>;
    /** Refuses, with a DocumentEditError, a return source the picker would not offer. */
    assertReturnSourceSelectable(
      runner: SqlExecutor,
      orgId: string,
      selection: ReturnSourceSelection,
      lineLabel: string,
    ): Promise<void>;
  };
  "payments-core": {
    /** Refuses, with a PostingError, a provider-return receipt posted outside its governed release. */
    assertProviderReturnPosting(document: { id: string; orgId: string; custom: unknown }): void;
    /** Refuses, with a PostingError, a payment whose lines leave the accounts its funding allows. */
    assertReceiptFundingPosting(
      executor: SqlExecutor,
      document: {
        orgId: string;
        id: string;
        kind: string;
        subsidiaryId: string | null;
        currency: string;
        documentDate: string;
        postingDate?: string | null;
        custom: unknown;
      },
      actorId: string | null,
      actualAccountIds: readonly (string | null)[],
    ): Promise<void>;
  };
  tax: {
    /**
     * Refuses, with a PostingError, a document whose goods-tax selection or
     * cross-border supply evidence no longer matches its lines. persist
     * records the cross-border verdict inside the posting transaction.
     */
    assertSupplyEvidence(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
      options?: { persist?: boolean },
    ): Promise<void>;
  };
  projects: {
    /**
     * Refuses, with a PostingError, a generated bill or invoice whose economics
     * left its project billing source. lock re-reads the document under its
     * row lock inside the posting transaction.
     */
    assertGeneratedBillingPostable(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
      source: PostingSourceSnapshot,
      lock?: boolean,
    ): Promise<void>;
  };
  "contractor-withholding": {
    /**
     * Refuses, with a PostingError naming its remedy, a withholding remittance
     * or deposit bill that no longer matches its captured source.
     */
    assertSourcesCurrent(
      runner: SqlExecutor,
      orgId: string,
      documentId: string,
      source: PostingSourceSnapshot,
    ): Promise<void>;
  };
}

export const postingPreconditionHooks =
  postingContributorRegistry<PostingPreconditions>("precondition");
