import { createHash } from "node:crypto";
import type { PreflightFinding } from "./migration-preflight.ts";

const CURRENT = "generated/0692_journal_instruction_modes.sql";
const NEXT = "generated/0699_financial_history_native_clone_guards.sql";
const CONSUMER = "generated/0700_typed_currency_adjustment_fx_residual_guards.sql";
const SIGNATURE = "public.journal_instruction_line_guard()";
const IDENTITIES = new Map([
  [CURRENT, "e31bcb469f0082873620ec3cdca678a6f55ab043843da9f8147b6dc1aa7e7000"],
  [NEXT, "eb192fe9113093021a6b6998c18fb08f671e9a1a22182e4265bd2132fad67e5a"],
  [CONSUMER, "3c1e27ef03f885cc6b07f8223e38a286d71947cb10f5f9de6e1173aefe33d0c1"],
]);
const PREFLIGHT = "ce56c23c0e95667dc07abf491f07777ea500a6603377bbc5d133b41628991135";
const digest = (content: string) => createHash("sha256").update(content).digest("hex");

/** Extract only the declaration of the no-argument instruction guard. */
function instructionGuardBody(content: string): string | null {
  const declarations = [...content.matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.journal_instruction_line_guard\(\) RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS (\$[a-zA-Z_0-9]*\$)([\s\S]*?)\1;/g)];
  return declarations.length === 1 ? declarations[0]![2]! : null;
}

export type PreflightTransitionEvidence = {
  migration: string;
  consumerSql: string;
  findings: readonly PreflightFinding[];
  published: ReadonlyMap<string, string>;
  recorded: ReadonlyMap<string, string>;
  pendingBeforeConsumer: ReadonlySet<string>;
  currentBody: string | null;
};

/** A future exact publisher may legitimately replace an exact recorded guard.
 * This admits one known transition for deferred revalidation, never an unknown
 * body, an unrecorded schema object or a general function-name exemption. */
export function preflightNeedsRecordedGuardTransition(evidence: PreflightTransitionEvidence): boolean {
  const { migration, consumerSql, findings, published, recorded, pendingBeforeConsumer, currentBody } = evidence;
  if (migration !== CONSUMER || digest(consumerSql) !== PREFLIGHT || !pendingBeforeConsumer.has(NEXT)
    || recorded.has(NEXT) || recorded.get(CURRENT) !== IDENTITIES.get(CURRENT)) return false;
  if (findings.length !== 1 || findings[0]!.severity !== "refuse"
    || findings[0]!.code !== "0700.instruction_guard_definition"
    || findings[0]!.subject !== "public.journal_instruction_line_guard"
    || findings[0]!.migration !== migration) return false;
  for (const [filename, expected] of IDENTITIES) {
    const content = published.get(filename);
    if (content === undefined || digest(content) !== expected) return false;
  }
  const original = instructionGuardBody(published.get(CURRENT)!);
  const future = instructionGuardBody(published.get(NEXT)!);
  if (original === null || future === null || original !== currentBody) return false;
  // No later recorded publisher may have changed the admitted overload.
  let latest: string | undefined;
  for (const [filename, content] of published) {
    if (!recorded.has(filename) || !/\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\s*\.\s*)?"?journal_instruction_line_guard"?\s*\(\s*\)/i.test(content)) continue;
    if (instructionGuardBody(content) === null) return false;
    if (digest(content) !== recorded.get(filename)) return false;
    latest = filename;
  }
  if (latest !== CURRENT) return false;
  const finalClause = consumerSql.slice(consumerSql.lastIndexOf("SELECT '0700.instruction_guard_definition'"));
  const expected = /\$expected\$([\s\S]*?)\$expected\$/.exec(finalClause)?.[1];
  return expected === future && finalClause.includes(`'${SIGNATURE}'::regprocedure`);
}

export const RECORDED_INSTRUCTION_GUARD_SIGNATURE = SIGNATURE;
