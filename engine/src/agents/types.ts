import type { WorkItemSeverity } from "./measure.ts";
import type {
  ContinuousCloseAgentKey,
  ContinuousCloseDetectorPolicy,
} from "../continuous-close-config.ts";

/**
 * Background agent detector packs (collections, payables, reconciliation,
 * data hygiene, plus the original accounting/finance packs).
 *
 * Every pack is a pure detector function behind one shared signature so the
 * control plane (`runContinuousCloseAgent`) dispatches through the registry
 * in `registry.ts` instead of branching per agent. A pack never writes: it
 * returns finding drafts with exact materiality, an evidence packet, and a
 * PROPOSED command card the user confirms. Auto-resolution, persistence, and
 * enrichment stay in the control plane.
 */

export type AgentFindingEvidence = {
  kind: string;
  sourceType?: string | null;
  sourceId?: string | null;
  data: Record<string, unknown>;
};

/**
 * A reviewable next step the user confirms. `tool` names an application or
 * assistant tool the finding's evidence already justifies; `input` carries
 * the exact arguments. Packs propose — they never execute.
 */
export type AgentFindingProposal = {
  tool: string;
  input: Record<string, unknown>;
  label: string;
};

export type AgentFinding = {
  agentKey: ContinuousCloseAgentKey;
  findingType: string;
  fingerprint: string;
  severity: WorkItemSeverity;
  confidence: string;
  materiality: string;
  subjectType?: string | null;
  subjectId?: string | null;
  summary: Record<string, unknown>;
  evidence: AgentFindingEvidence[];
  /** Proposed command card; absent when no safe next step exists. */
  proposal?: AgentFindingProposal | null;
};

export type AgentPackFindings = (
  orgId: string,
  agentThreshold: string,
  detectors: ContinuousCloseDetectorPolicy[],
) => Promise<AgentFinding[]>;

/**
 * Detector data-source ports. Packs accept their rows through these adapters
 * so unit tests inject fixtures while the production adapters run the
 * canonical queries (each loader cites the screen/service it mirrors).
 */
export type AgentPackAdapters<TLoaders extends Record<string, unknown>> = {
  loaders: TLoaders;
};
