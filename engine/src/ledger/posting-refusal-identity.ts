import type { PostingError } from "../journal/posting-contracts.ts";

/**
 * A pre-post inventory refusal reaches the kernel wrapped as a PostingError
 * so the posting boundary speaks one error family — but the operator-facing
 * identity a typed refusal carries (its machine `code`, `remedy`, and
 * `details`, which the bill drawer reads to offer the matching next step)
 * must survive the wrap. Only string codes/remedies and plain-object
 * details pass through; anything else stays out of the response body.
 */
export function carryRefusalIdentity(refusal: PostingError, source: unknown): PostingError {
  const record = source as { code?: unknown; remedy?: unknown; details?: unknown } | null;
  const carried = refusal as PostingError & { code?: string; remedy?: string; details?: unknown };
  if (record && typeof record.code === "string" && record.code.trim() !== "") {
    carried.code = record.code;
  }
  if (record && typeof record.remedy === "string" && record.remedy.trim() !== "") {
    carried.remedy = record.remedy;
  }
  if (
    record &&
    record.details !== null &&
    typeof record.details === "object" &&
    !Array.isArray(record.details)
  ) {
    carried.details = record.details;
  }
  return refusal;
}
