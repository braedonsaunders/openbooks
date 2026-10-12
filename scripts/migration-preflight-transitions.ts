import { createHash } from "node:crypto";
import type { PreflightFinding } from "./migration-preflight.ts";

const CURRENT = "generated/0692_journal_instruction_modes.sql";
const NEXT = "generated/0699_financial_history_native_clone_guards.sql";
const BINDING = "generated/0702_journal_instruction_currency_binding.sql";
const SIGNATURE = "public.journal_instruction_line_guard()";
const IDENTITIES = new Map([
  [CURRENT, "e31bcb469f0082873620ec3cdca678a6f55ab043843da9f8147b6dc1aa7e7000"],
  [NEXT, "eb192fe9113093021a6b6998c18fb08f671e9a1a22182e4265bd2132fad67e5a"],
  [BINDING, "3b7ebba6fe31c5a9e8e8925a0fd894b35db029648737b2b5d28dc306d1274334"],
]);
const CONSUMERS = new Map([
  ["generated/0700_typed_currency_adjustment_fx_residual_guards.sql", {
    publishers: [CURRENT, NEXT],
    source: "3c1e27ef03f885cc6b07f8223e38a286d71947cb10f5f9de6e1173aefe33d0c1",
    preflight: "ce56c23c0e95667dc07abf491f07777ea500a6603377bbc5d133b41628991135",
    code: "0700.instruction_guard_definition", subject: "public.journal_instruction_line_guard",
  }],
  ["generated/0702_journal_instruction_currency_binding.sql", {
    publishers: [CURRENT, NEXT],
    source: "3b7ebba6fe31c5a9e8e8925a0fd894b35db029648737b2b5d28dc306d1274334",
    preflight: "99d4da6ba4bf4765d0d5c4d41eb4f8bb4916f5ed89a532c6f11efa7252dcc77f",
    code: "0702.instruction_guard_definition", subject: SIGNATURE,
  }],
  ["generated/0703_journal_measurement_and_instruction_guards.sql", {
    publishers: [CURRENT, NEXT, BINDING],
    source: "3a60b33ec04dd05de7bd219c4d2852439ac7c43a9ea1984a48f1bd895dbabae1",
    preflight: "b69de7302b10e43858b59d3d35bb14c3d32baa49c7a836b40cb6553b2a22c141",
    code: "0703.instruction_guard_definition", subject: SIGNATURE,
  }],
]);
const digest = (content: string) => createHash("sha256").update(content).digest("hex");

/** Extract only the declaration of the no-argument instruction guard. */
function instructionGuardBody(content: string): string | null {
  const declarations = [...content.matchAll(/CREATE(?: OR REPLACE)? FUNCTION public\.journal_instruction_line_guard\(\) RETURNS trigger\s+LANGUAGE plpgsql SET search_path=public,pg_catalog AS (\$[a-zA-Z_0-9]*\$)([\s\S]*?)\1;/g)];
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
 * This admits explicitly pinned consumers for deferred revalidation, never an unknown
 * body, an unrecorded schema object or a general function-name exemption. */
export function preflightNeedsRecordedGuardTransition(evidence: PreflightTransitionEvidence): boolean {
  const { migration, consumerSql, findings, published, recorded, pendingBeforeConsumer, currentBody } = evidence;
  const consumer = CONSUMERS.get(migration);
  if (!consumer || digest(consumerSql) !== consumer.preflight) return false;
  if (findings.length !== 1 || findings[0]!.severity !== "refuse"
    || findings[0]!.code !== consumer.code
    || findings[0]!.subject !== consumer.subject
    || findings[0]!.migration !== migration) return false;
  for (const filename of consumer.publishers) {
    const content = published.get(filename);
    if (content === undefined || digest(content) !== IDENTITIES.get(filename)) return false;
  }
  if (digest(published.get(migration) ?? "") !== consumer.source) return false;
  // No later recorded publisher may have changed the admitted overload.
  let latest: string | undefined;
  for (const [filename, content] of published) {
    if (!recorded.has(filename) || !/\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\s*\.\s*)?"?journal_instruction_line_guard"?\s*\(\s*\)/i.test(content)) continue;
    if (instructionGuardBody(content) === null) return false;
    if (digest(content) !== recorded.get(filename)) return false;
    latest = filename;
  }
  if (!latest) return false;
  const position = consumer.publishers.indexOf(latest);
  if (position < 0 || position === consumer.publishers.length - 1) return false;
  const original = instructionGuardBody(published.get(latest)!);
  const futureName = consumer.publishers.at(-1)!;
  const future = instructionGuardBody(published.get(futureName)!);
  if (original === null || future === null || original !== currentBody) return false;
  // Every intermediate publisher must be earlier pending, with its exact
  // published identity. The final strict consumer query is rerun at apply time.
  for (const filename of consumer.publishers.slice(position + 1)) {
    if (recorded.has(filename) || !pendingBeforeConsumer.has(filename)) return false;
  }
  const finalClause = consumerSql.slice(consumerSql.lastIndexOf(`SELECT '${consumer.code}'`));
  const expected = /\$expected\$([\s\S]*?)\$expected\$/.exec(finalClause)?.[1];
  return expected === future && finalClause.includes(`'${SIGNATURE}'::regprocedure`);
}

export const RECORDED_INSTRUCTION_GUARD_SIGNATURE = SIGNATURE;
