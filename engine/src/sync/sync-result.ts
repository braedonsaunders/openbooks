import { type SyncContentKey } from "./connection-settings.ts";
import { type EntityLoadStats } from "./migrate.ts";
import { type ApplyStats } from "./applications.ts";
import { type TrueUpStats } from "./trueup.ts";
import { type SourceEvidenceOutcome } from "./source-evidence.ts";
import type { SourceOperationalSyncResult } from "./source.ts";
import { type SettlementObservation } from "./settlement-observation.ts";
import { type ProjectFinancialInputSyncResult } from "./project-financial-inputs.ts";
import { type ImportSummary } from "./netsuite-attachments.ts";
import {
  type AccountMonthVerification,
  type ProjectAccountMonthVerification,
} from "./verification.ts";

/** Result and option contracts for source synchronization and financial checks. */
export interface SyncResult {
  runId: string;
  kind: "incremental" | "full_migration" | "targeted_repair";
  entities?: EntityLoadStats;
  docsNew: number;
  docsAmended: number;
  docsUnchanged: number;
  ordersNew: number;
  docsFailed: number;
  sourceUnbuildable: number;
  skipped: string[];
  /** Still unresolved after auto-mirroring (kept by controller disposition or
   * a deletion that could not be mirrored — these fail verification). */
  deletedAtSource: string[];
  /** Source deletions mirrored automatically this run (guarded delete). */
  autoResolvedDeletions: string[];
  /** Source-asserted party merges applied this run (absorbed → survivor refs).
   * Optional: runs persisted before this contract lack the key. */
  partyMerges?: { absorbedRef: string; survivorRef: string }[];
  /** Source parties that vanished while still referenced, held for review.
   * Optional: runs persisted before this contract lack the key. */
  partyHolds?: string[];
  /** Source cleared-evidence outcome (stamps, refresh, sign-offs, skips).
   * Null for targeted repairs, which stay side-effect-minimal.
   * Optional: runs persisted before this contract lack the key. */
  sourceEvidence?: SourceEvidenceOutcome | null;
  excludedPopulations?: SyncContentKey[];
  settlementObservation?: SettlementObservation;
  attachments?: ImportSummary;
  projectFinancials?: ProjectFinancialInputSyncResult;
  operationalRecords?: SourceOperationalSyncResult;
  applications: ApplyStats | null;
  trueUp: TrueUpStats | null;
  tb: {
    accounts: number;
    matches: number;
    mismatches: { accountRef: string; ours: string; theirs: string }[];
  };
  openItems: {
    checked: number;
    matches: number;
    mismatches: { ref: string; ours: string; theirs: string }[];
  } | null;
  /** Mandatory month-bucketed activity gate (catches date-allocation drift). */
  periods: AccountMonthVerification;
  /** Verifies project, posting-account, and month balances when exposed by the connector. */
  projectPeriods: ProjectAccountMonthVerification | null;
  /** Confirms requested buildable documents have their exact canonical content. */
  targetedDocuments?: {
    checked: number;
    matches: number;
    mismatches: {
      sourceRef: string;
      reason: "missing_target" | "canonical_content";
    }[];
  } | null;
  syncedThrough: string;
  durationMs: number;
}

export interface SourceLedgerVerification {
  tb: SyncResult["tb"];
  openItems: SyncResult["openItems"];
  periods: SyncResult["periods"];
  projectPeriods: SyncResult["projectPeriods"];
}

export interface SyncOptions {
  kind?: "incremental" | "full_migration" | "targeted_repair";
  orgId: string;
  connectionId: string;
  /** "auto" resumes from the watermark; null = all history; Date = explicit. */
  since?: Date | null | "auto";
  loadEntitiesFirst?: boolean;
  /** Bounded source population; requires nativeChangesByRefs and never advances the cursor. */
  sourceRefs?: string[];
  /** Controller authorization for guarded append-only posted-source corrections. */
  postedChangeAuthorization?: {
    actorId: string;
    authorizedAt: Date;
  };
}
