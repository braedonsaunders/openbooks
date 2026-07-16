import type { FlowSubjectAdapter } from "./types.ts";
import { createDocumentsFlowAdapter } from "./documents-adapter.ts";
import { DOCUMENT_FLOW_KINDS, documentSubjectProfile } from "./subject-profiles.ts";
import type { FlowSubjectProfile } from "@openbooks/forms-core";

/**
 * subjectKind → FlowSubjectAdapter. Ported from beaconhs-platform's
 * lib/flows/registry.ts: the gate-resume path and every dispatch site rebuild
 * the right adapter from a stored subjectKind string. openbooks starts with
 * the one documents adapter covering every document kind; future adapters
 * (custom record types, parties, …) register here.
 */

const adapterCache = new Map<string, FlowSubjectAdapter>();

export function getFlowAdapter(subjectKind: string): FlowSubjectAdapter | null {
  if (!DOCUMENT_FLOW_KINDS.includes(subjectKind)) return null;
  let adapter = adapterCache.get(subjectKind);
  if (!adapter) {
    adapter = createDocumentsFlowAdapter(subjectKind);
    adapterCache.set(subjectKind, adapter);
  }
  return adapter;
}

/** Every subject kind flows can be authored over, with its profile (builder UI). */
export function listFlowSubjectProfiles(): FlowSubjectProfile[] {
  return DOCUMENT_FLOW_KINDS.map((kind) => documentSubjectProfile(kind));
}
