import { createHash } from "node:crypto";
import { BenefitsError } from "./errors.ts";
import { canonicalRetainedJson } from "./retained-source.ts";
import { orgContext, pinnedTransactionExecutor, type SqlExecutor } from "../../platform/db.ts";

export interface SourceEvidenceAdmissionFacts {
  readonly orgId: string;
  readonly actorId: string;
  readonly programId: string;
  readonly programRevision: number;
  readonly employmentId: string;
  readonly legalPayerId: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly currency: string;
  readonly value: string;
  readonly sourceKey: string;
  readonly requestKey: string;
  readonly sourceEvidenceClass: string;
  readonly sourcePaidDate: string | null;
}

interface AdmissionRecord {
  readonly executor: SqlExecutor;
  readonly facts: SourceEvidenceAdmissionFacts;
  readonly snapshot: Record<string, unknown>;
  readonly digest: string;
  consumed: boolean;
}

// These object identities exist only after the locked settlement service has
// read Cabinet bytes and completed native admission. Plain JSON cannot mint
// an equivalent capability, and the module is intentionally not re-exported
// from the HRM public surface.
const admitted = new WeakMap<object, AdmissionRecord>();

function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Mint only inside the active native command transaction. The snapshot is copied and frozen. */
export function mintSourceEvidenceAdmission(input: {
  readonly executor: SqlExecutor;
  readonly facts: SourceEvidenceAdmissionFacts;
  readonly snapshot: Record<string, unknown>;
}): { readonly token: object; readonly snapshot: Record<string, unknown> } {
  const executor = pinnedTransactionExecutor();
  const scope = orgContext.getStore();
  if (
    !executor ||
    executor !== input.executor ||
    !scope ||
    scope.bypass ||
    scope.orgId !== input.facts.orgId
  ) {
    throw new BenefitsError(
      "REFUSED",
      "source-evidenced obligations require their active organization command transaction",
    );
  }
  const snapshot = structuredClone(input.snapshot);
  const frozen = deepFreezeJson(snapshot);
  const token = Object.freeze({});
  admitted.set(token, {
    executor,
    facts: Object.freeze({ ...input.facts }),
    snapshot: frozen,
    digest: createHash("sha256").update(canonicalRetainedJson(frozen), "utf8").digest("hex"),
    consumed: false,
  });
  return { token, snapshot: frozen };
}

/** Consume once and bind every award fact to the exact still-active transaction. */
export function consumeSourceEvidenceAdmission(input: {
  readonly executor: SqlExecutor;
  readonly token: unknown;
  readonly facts: SourceEvidenceAdmissionFacts;
  readonly snapshot: unknown;
}): Record<string, unknown> {
  const record =
    input.token !== null && typeof input.token === "object" ? admitted.get(input.token) : undefined;
  const scope = orgContext.getStore();
  if (
    !record ||
    record.consumed ||
    pinnedTransactionExecutor() !== record.executor ||
    input.executor !== record.executor ||
    !scope ||
    scope.bypass ||
    scope.orgId !== record.facts.orgId ||
    canonicalRetainedJson(input.facts) !== canonicalRetainedJson(record.facts) ||
    input.snapshot !== record.snapshot ||
    createHash("sha256").update(canonicalRetainedJson(record.snapshot), "utf8").digest("hex") !==
      record.digest
  ) {
    throw new BenefitsError(
      "REFUSED",
      "source-evidenced obligations require the locked native retained-source service",
    );
  }
  record.consumed = true;
  admitted.delete(input.token as object);
  return record.snapshot;
}
