/**
 * Line-contribution hooks: accounts and lines a domain supplies before the
 * kernel builds a document's entry. Ordering and installation: see
 * posting-contributors.ts.
 */
import type { SqlExecutor } from "../platform/db.ts";
import type { ContributedLine } from "./contributed-lines.ts";
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
}

export const postingLineHooks =
  postingContributorRegistry<PostingLineContributors>("line contribution");
