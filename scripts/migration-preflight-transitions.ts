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

const PREREQUISITE_PUBLISHERS = new Map([
  ["generated/0568_payroll_employee_employer_assignments.sql", "9d7d85b95d5a03f9a099babf18bdc9d77f07c86451250fa131aef55d20db980e"],
  ["generated/0401_clone_authority_role_bypass.sql", "493512b3fe66d23eeac33e9df1479a558fe47f3d78d6ba7a8c89fb646c1ceb5a"],
  ["generated/0579_bound_sales_clone_source_matching.sql", "fa8012e50ece4b535b06c8b06651c873541625325d83b1e5b4304b2337dc143c"],
  ["generated/0605_payroll_adjudicated_holiday_obligations.sql", "9ff4c24b2bb9d2227d2985cde027e6c31c389cbb9ba276f3a85bb71a8c069928"],
  ["generated/0619_operating_profiles_production_extensions.sql", "42daad13839b4303794f5c7ede20d0c3a02387c789ae4db41316ea6c2a2728fa"],
  ["generated/0626_tenant_retirement.sql", "4da9e2c44bff6ed85de4fa5eebf94075070e86f0308f65e243bb5c3a22352988"],
  ["generated/0682_accounting_book_currency_and_account_maps.sql", "7fb0af515d76516b66c5026a28074860de8cae0899170cf670ae42e992b4c52e"],
  ["generated/0710_payroll_opening_legal_employer_authority.sql", "10081e407b35c0762496fd4400a8a0f479f06ecc1964e18a6904603b04efb23b"],
  ["generated/0719_payroll_opening_levy_source_authority.sql", "e22ac82217135ce739381cc215a387d60332c1ec64783c0a548f117ff9086c3e"],
  ["generated/0725_payroll_opening_levy_source_successors.sql", "29993271361b124a7c1bf9f50d0553bab5848476b486604d012367402918fc3e"],
  ["generated/0727_document_explicit_fx_rate_evidence.sql", "f7a2bc15649388124fdda0ad27ef9d4e48b4fb5e7769ea31de1f5197d76f28fe"],
]);
const PREREQUISITE_CONSUMERS = new Map<string, { source: string; preflight: string; prerequisites: ReadonlyMap<string, readonly string[]> }>([
  ["generated/0720_pay_component_statutory_treatment.sql", {
    source: "41cc73979c3678a97885c2818b50a27727c4b8faacdaa01c3fd266ab1d1bea8a",
    preflight: "9ae4c5b6eef09a6338af3ec3f5c582269f911c9d84d4ba93313d4e4eea49e0ba",
    prerequisites: new Map([
      ["0720.dated_worker_comp_assignment_source_missing:public.payroll_employee_employer_assignments is not available for the nullable dated group update", ["generated/0568_payroll_employee_employer_assignments.sql"]],
    ]),
  }],
  ["generated/0727_document_explicit_fx_rate_evidence.sql", {
    source: "f7a2bc15649388124fdda0ad27ef9d4e48b4fb5e7769ea31de1f5197d76f28fe",
    preflight: "ecebd9eb22dd14a94864828543034d36785a45037b8214b9a7082fdc7ad76bba",
    prerequisites: new Map([
      ["0727.clone_contract_missing:The native clone authority or sales source matching contract is unavailable", ["generated/0401_clone_authority_role_bypass.sql", "generated/0579_bound_sales_clone_source_matching.sql"]],
    ]),
  }],
  ["generated/0729_field_ticket_source_identity_certifications.sql", {
    source: "6cbdffcf621d9afee83748dcf0bf15a8a0c8b4efb5ed7bf1c8f011ea0f82f9b0",
    preflight: "c93c00441acc269fa3e0b0ada0408f79ac32acb54a3c825e35998508efbde347",
    prerequisites: new Map([
      ["0729.clone_prerequisite_missing:The native sandbox clone contract is unavailable", ["generated/0401_clone_authority_role_bypass.sql", "generated/0619_operating_profiles_production_extensions.sql"]],
      ["0729.retained_file_prerequisite_missing:The retained source file contract this migration pins is unavailable", ["generated/0605_payroll_adjudicated_holiday_obligations.sql"]],
      ["0729.retirement_prerequisite_missing:The tenant-retirement delete and fence contract is unavailable", ["generated/0626_tenant_retirement.sql"]],
    ]),
  }],
  ["generated/0726_payroll_ca_opening_reporting_source.sql", {
    source: "faebff8c40d76c240c18d3ef994d5d74e2195c9acf8d47d98cf74af1aaddd839",
    preflight: "17395df54ae1f85a0e3b14fa7d713f5a57f3fe6bc82dda12b25f72e329bf8f10",
    prerequisites: new Map([
      ["0726.current_levy_source_missing:public.payroll_opening_levy_source_authorities.supersedes_authority_id", ["generated/0725_payroll_opening_levy_source_successors.sql"]],
      ["0726.current_levy_source_missing:public.payroll_opening_source_children(uuid,uuid,uuid,integer)", ["generated/0719_payroll_opening_levy_source_authority.sql"]],
      ["0726.native_source_missing:public.payroll_opening_employer_authorities", ["generated/0710_payroll_opening_legal_employer_authority.sql"]],
    ]),
  }],
  ["generated/0728_scoped_close_and_settlement_fx_evidence.sql", {
    source: "0f57dbde70d4f44b2cae02823ed2b47891340707e6032c5697984160616bdbe7",
    preflight: "09dd878fa61abd688b6ace84ab1d3e779ae3f75847ae2040a4b2f8eeea28746f",
    prerequisites: new Map([
      ["0728.book_measurement_prerequisite_missing:The native book measurement currency contract is unavailable", ["generated/0682_accounting_book_currency_and_account_maps.sql"]],
      ["0728.retirement_wipe_contract_missing:The tenant retirement or sandbox wipe contract is unavailable", ["generated/0626_tenant_retirement.sql"]],
      ["0728.document_evidence_prerequisite_missing:public.documents.document_fx_rate_evidence", ["generated/0727_document_explicit_fx_rate_evidence.sql"]],
      ["0728.document_evidence_prerequisite_missing:public.documents.documents_fx_rate_evidence_bound", ["generated/0727_document_explicit_fx_rate_evidence.sql"]],
    ]),
  }],
]);

/** Missing prerequisites defer only to exact earlier pending publishers.
 * Existing objects, unknown prerequisites and data refusals keep their verdict.
 * The unchanged strict preflight runs again in its migration transaction. */
export function preflightNeedsPendingPrerequisite(
  evidence: Pick<PreflightTransitionEvidence, "migration" | "consumerSql" | "findings" | "published" | "pendingBeforeConsumer">
    & { recordedPrerequisites?: ReadonlyMap<string, string> },
): boolean {
  const consumer = PREREQUISITE_CONSUMERS.get(evidence.migration);
  if (!consumer || evidence.findings.length === 0
    || digest(evidence.consumerSql) !== consumer.preflight
    || digest(evidence.published.get(evidence.migration) ?? "") !== consumer.source) return false;
  return evidence.findings.every(finding => {
    if (finding.migration !== evidence.migration || finding.severity !== "refuse") return false;
    const publishers = consumer.prerequisites.get(`${finding.code}:${finding.subject}`);
    if (!publishers || !publishers.some(publisher => evidence.pendingBeforeConsumer.has(publisher))) return false;
    return publishers.every(publisher => {
      const expected = PREREQUISITE_PUBLISHERS.get(publisher);
      if (!evidence.pendingBeforeConsumer.has(publisher)
        && evidence.recordedPrerequisites?.get(publisher) !== expected) return false;
      const content = evidence.published.get(publisher);
      return content !== undefined && digest(content) === expected;
    });
  });
}
