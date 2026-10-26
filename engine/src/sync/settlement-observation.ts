import { createHash } from "node:crypto";
import { canonicalJson } from "../platform/canonical-json.ts";
import type { SourceApplicationLink } from "./source.ts";

export interface SettlementExclusion {
  paymentRef: string;
  appliedRef: string;
  paymentLineRef: string;
  appliedLineRef: string;
  amount: string;
  paymentPosting: "T" | "F";
  appliedPosting: "T" | "F";
  paymentStatus: string | null;
  appliedStatus: string | null;
  reason: "nonposting_payment" | "nonposting_target";
}

/** Repeated observations detect drift; they do not assert remote snapshot isolation. */
export interface SettlementObservation {
  version: 1;
  source: string;
  sourceAccount: string;
  bookRef: string;
  scope: { kind: "all" } | { kind: "references"; refs: string[] };
  consistency: "repeated_read";
  observedFrom: string;
  observedThrough: string;
  rawLinks: number;
  eligibleLinks: number;
  graphDigest: string;
  applicationsDigest: string;
  nonpostingRefs: string[];
  exclusions: SettlementExclusion[];
}

export function settlementDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function applicationLinksDigest(links: SourceApplicationLink[]): string {
  return settlementDigest(links.map((link) => canonicalJson(link)).sort());
}

/** Bind admitted amounts and accounts to the exact observed financial population. */
export function assertSettlementObservation(
  observation: SettlementObservation,
  source: string,
  links: SourceApplicationLink[],
  complete: boolean,
): void {
  if (
    observation.version !== 1 ||
    observation.source !== source ||
    observation.consistency !== "repeated_read" ||
    !observation.sourceAccount?.trim() ||
    !observation.bookRef?.trim() ||
    !/^[a-f0-9]{64}$/.test(observation.graphDigest) ||
    !Number.isSafeInteger(observation.rawLinks) ||
    observation.rawLinks < 0 ||
    observation.eligibleLinks !== links.length ||
    observation.rawLinks < links.length ||
    applicationLinksDigest(links) !== observation.applicationsDigest ||
    !Number.isFinite(Date.parse(observation.observedFrom)) ||
    !Number.isFinite(Date.parse(observation.observedThrough)) ||
    Date.parse(observation.observedFrom) > Date.parse(observation.observedThrough) ||
    (complete && observation.scope.kind !== "all")
  ) {
    throw new Error(
      "source settlement observation does not authorize this population; retry the sync",
    );
  }
  if (observation.scope.kind === "references") {
    const refs = new Set(observation.scope.refs);
    if (
      !refs.size ||
      links.some((link) => !refs.has(link.paymentRef) && !refs.has(link.appliedRef))
    ) {
      throw new Error("source settlement observation contains links outside its reference scope");
    }
  }
  const excludedRefs = new Set<string>();
  for (const exclusion of observation.exclusions) {
    if (exclusion.paymentPosting === "F") excludedRefs.add(exclusion.paymentRef);
    if (exclusion.appliedPosting === "F") excludedRefs.add(exclusion.appliedRef);
    if (
      !["T", "F"].includes(exclusion.paymentPosting) ||
      !["T", "F"].includes(exclusion.appliedPosting) ||
      (exclusion.paymentPosting === "T" && exclusion.appliedPosting === "T") ||
      exclusion.reason !==
        (exclusion.paymentPosting === "F" ? "nonposting_payment" : "nonposting_target")
    ) {
      throw new Error("source settlement exclusion has no explicit nonposting evidence");
    }
  }
  if (
    canonicalJson([...excludedRefs].sort()) !==
      canonicalJson([...new Set(observation.nonpostingRefs)].sort()) ||
    observation.exclusions.length + links.length > observation.rawLinks
  ) {
    throw new Error("source settlement exclusions do not match the observed population");
  }
}
