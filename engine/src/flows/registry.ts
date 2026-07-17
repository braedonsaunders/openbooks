import type { FlowSubjectAdapter } from "./types.ts";
import { createDocumentsFlowAdapter } from "./documents-adapter.ts";
import { DOCUMENT_FLOW_KINDS, documentSubjectProfile } from "./subject-profiles.ts";
import {
  BANK_ACCOUNT_SUBJECT_KIND,
  bankAccountSubjectProfile,
  bankAccountsFlowAdapter,
} from "./bank-accounts-adapter.ts";
import type { FlowSubjectProfile } from "@openbooks/forms-core";

/**
 * subjectKind → FlowSubjectAdapter. Ported from beaconhs-platform's
 * lib/flows/registry.ts: the gate-resume path and every dispatch site rebuild
 * the right adapter from a stored subjectKind string. The documents adapter
 * covers every document kind; party_bank_account is the first non-document
 * subject (the replicated NetSuite bank-details approval); future adapters
 * (custom record types, …) register here.
 */

const adapterCache = new Map<string, FlowSubjectAdapter>();

export function getFlowAdapter(subjectKind: string): FlowSubjectAdapter | null {
  if (subjectKind === BANK_ACCOUNT_SUBJECT_KIND) return bankAccountsFlowAdapter;
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
  return [
    ...DOCUMENT_FLOW_KINDS.map((kind) => documentSubjectProfile(kind)),
    bankAccountSubjectProfile,
  ];
}
