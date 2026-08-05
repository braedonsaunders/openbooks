import type { Corpus, CorpusDocLine, CorpusEvent } from "../corpus-lib/types.ts";

/**
 * A replay dataset is a corpus plus the evidence a delete-and-rebuild
 * validation needs: each GL-affecting event carries its ORIGINAL posted
 * journal impact (`glLines`, signed, semantic keys) so the rebuild can
 * (a) fall back to a GL-faithful journal when a document kind cannot be
 * re-posted natively, and (b) audit any native repost against the original
 * projection. Fallbacks are counted, reported, and make validation fail; they
 * are diagnostic output, never proof of a native rebuild.
 */

export interface DatasetEvent {
  event: CorpusEvent;
  /** The original posted GL impact (signed, semantic account keys, project keys). */
  glLines?: CorpusDocLine[];
  /**
   * Provenance of a pure-GL event: journal entries with no source document
   * (engine postings such as labor costing, overhead application, revenue
   * recognition) are exported with their origin so the rebuild report can
   * say exactly what was replayed as GL rather than through a document.
   */
  origin?: string | null;
}

export interface ReplayDataset extends Omit<Corpus, "events"> {
  /** Sim provenance so the dataset is reproducible from source. */
  generator: { profileId: string; seed: string; startDate: string; endDate: string };
  events: DatasetEvent[];
}

export interface GoldenSnapshot {
  schemaVersion: 1;
  dataset: string;
  /** Signed (debit-positive) balance per semantic account key; zeros omitted. */
  trialBalance: Record<string, string>;
  /** Signed open balance per party per side; zeros omitted. */
  openBalances: Record<string, { ar?: string; ap?: string }>;
  /** Per-project (by key) cost / billed / margin, GL-derived. */
  projects: Record<string, { cost: string; billed: string; margin: string }>;
  counts: { events: number; documents: number; glOnlyEntries: number };
}
