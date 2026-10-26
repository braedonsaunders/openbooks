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
}

export const postingPreconditionHooks =
  postingContributorRegistry<PostingPreconditions>("precondition");
