/**
 * Evidence provenance for trust artifacts (conformance, controls, harness
 * checkpoint, mutation report).
 *
 * Every published component embeds the commit it was produced from
 * (`gitSha`), the CI run that produced it (`runId`), and a sha256 over its
 * case payload (`casesSha256`), so the trust publisher can reject
 * mixed-source evidence instead of labelling it with one commit's SHA.
 *
 * The source commit prefers OPENBOOKS_SOURCE_SHA: on a `workflow_run` the
 * checkout may be pinned to the triggering run's commit while GITHUB_SHA
 * still names the workflow's own tip, so the CI default is wrong there and
 * the workflow must pass the true source explicitly.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

/** The commit the current evidence describes. */
export function sourceSha(repoRoot?: string): string | null {
  const prefix = repoRoot ? ["-C", repoRoot] : [];
  let head: string;
  let dirty: boolean;
  try {
    head = execFileSync("git", [...prefix, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    dirty = execFileSync("git", [...prefix, "status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return null;
  }
  const declared = process.env.OPENBOOKS_SOURCE_SHA?.trim() || process.env.GITHUB_SHA?.trim();
  if (declared && declared !== head) {
    throw new Error("evidence source does not match the checked-out full commit; check out the declared source before running verification");
  }
  // An uncommitted implementation is not the tree identified by HEAD. A local
  // report may still be useful, but it cannot carry publishable commit evidence.
  return !dirty && /^[a-f0-9]{40}$/.test(head) ? head : null;
}

/** The CI run that produced the current evidence, if any. */
export function runId(): string | null {
  return process.env.GITHUB_RUN_ID?.trim() || null;
}

/**
 * Tamper-evident digest over a report's case payload. Computed over
 * JSON.stringify of the exact array serialized into the artifact, so the
 * publisher can recompute it after parsing — plain objects, arrays,
 * strings, numbers, booleans, and null all round-trip exactly.
 */
export function caseDigest(cases: unknown): string {
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex");
}
