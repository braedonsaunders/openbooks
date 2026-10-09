import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { ContractorWithholdingError } from "./scheme.ts";

type Row = Record<string, unknown>;
export type AuthoritySourceKey = "withholdingDeposit" | "withholdingRemittance";
const sourceKeys: AuthoritySourceKey[] = ["withholdingDeposit", "withholdingRemittance"];
const headerFields = ["kind", "partyId", "subsidiaryId", "currency", "documentDate", "postingDate", "dueDate", "fxRate", "subtotal", "taxTotal", "total", "projectId", "departmentId", "locationId", "classId", "paymentCardId", "extraDims"];
const lineFields = ["accountId", "itemId", "description", "quantity", "unit", "unitPrice", "amount", "taxCodeId", "taxGroupId", "taxInputAmount", "taxAmount", "taxOverridden", "withholdingTreatment", "withholdingMaterialsCost", "marketplaceFacilitator", "partyId", "departmentId", "projectId", "locationId", "classId", "subsidiaryId", "stockLocationId", "extraDims", "custom", "workFrom", "workTo", "distributionGroupId", "distributionRuleId", "distributionVersionId", "distributionLocked"];
const decimals = new Set(["fxRate", "subtotal", "taxTotal", "total", "quantity", "unitPrice", "amount", "taxInputAmount", "taxAmount", "withholdingMaterialsCost"]);
const refusal = (): never => { throw new ContractorWithholdingError("A withholding authority document retains its captured source, financial lines, authority, legal entity, dates and captured exchange rate.", "Delete or void the authority document and prepare its replacement from Contractor withholding."); };
function camel(row: Row): Row { return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value])); }
function canonical(value: unknown): string {
  if (value == null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function valueKey(row: Row, key: string): string {
  const value = row[key] ?? (["extraDims", "custom"].includes(key) ? {} : ["taxOverridden", "distributionLocked"].includes(key) ? false : null);
  if (value == null) return "null";
  if (decimals.has(key)) {
    const decimal = canonicalDecimal(value, ["fxRate", "quantity", "unitPrice"].includes(key) ? 10 : 4);
    if (decimal === null) return refusal();
    return decimal;
  }
  return canonical(value instanceof Date && key.endsWith("Date") ? value.toISOString().slice(0, 10) : value);
}
function selectFields(row: Row, keys: string[]): Row { return Object.fromEntries(keys.map(key => [key, row[key] ?? null])); }
interface FinancialSnapshot { header: Row; lines: Row[] }
export interface AuthorityPostingInput { document: Row; lines: Row[] }
async function readSnapshot(tx: SqlExecutor, orgId: string, id: string): Promise<{ financial: FinancialSnapshot; custom: Row }> {
  const document = (await tx.execute<Row>(sql`select *, document_date::text as document_date, posting_date::text as posting_date, due_date::text as due_date,
    fx_rate::text as fx_rate, subtotal::text as subtotal, tax_total::text as tax_total, total::text as total
    from documents where org_id=${orgId} and id=${id} for share`)).rows[0];
  if (!document) return refusal();
  const lines = (await tx.execute<Row>(sql`select *, quantity::text as quantity, unit_price::text as unit_price, amount::text as amount,
    tax_input_amount::text as tax_input_amount, tax_amount::text as tax_amount, withholding_materials_cost::text as withholding_materials_cost,
    work_from::text as work_from, work_to::text as work_to from document_lines where org_id=${orgId} and document_id=${id} order by line_number`)).rows;
  const components = (await tx.execute(sql`select c.id from document_line_tax_components c join document_lines l on l.org_id=c.org_id and l.id=c.document_line_id where l.org_id=${orgId} and l.document_id=${id} limit 1`)).rows;
  if (components.length) return refusal();
  return { financial: { header: selectFields(camel(document), headerFields), lines: lines.map(line => selectFields(camel(line), ["id", "lineNumber", ...lineFields])) }, custom: document.custom as Row };
}
function sameFields(before: Row, after: Row, keys: string[]): boolean { return keys.every(key => valueKey(before, key) === valueKey(after, key)); }
function sameSnapshot(before: FinancialSnapshot, after: FinancialSnapshot): boolean {
  return sameFields(before.header, after.header, headerFields) && before.lines.length === after.lines.length && before.lines.every((line, index) => sameFields(line, after.lines[index]!, ["id", "lineNumber", ...lineFields]));
}

/** Capture exact document economics and source evidence in the native creation transaction. */
export async function captureAuthoritySourceIntegrity(tx: SqlExecutor, orgId: string, id: string, key: AuthoritySourceKey, actorId: string): Promise<void> {
  const live = await readSnapshot(tx, orgId, id);
  const source = live.custom?.[key];
  if (!source || typeof source !== "object" || Array.isArray(source)) return refusal();
  const captured = { ...source, financialSnapshot: live.financial };
  const write = await tx.execute(sql`update documents set custom=jsonb_set(custom,ARRAY[${key}]::text[],${JSON.stringify(captured)}::jsonb) where org_id=${orgId} and id=${id} and status='draft'`);
  if (write.rowCount !== 1) return refusal();
  const audit = await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'documents',${id},'insert',${JSON.stringify({ reason: "authority_source_captured", sourceKey: key, source: captured })}::jsonb,${actorId})`);
  if (audit.rowCount !== 1) return refusal();
}

/** Creation audit is independent authority: a custom-field writer cannot replace its own evidence. */
export async function assertAuthoritySourceCurrent(tx: SqlExecutor, orgId: string, id: string, key: AuthoritySourceKey, input?: AuthorityPostingInput): Promise<FinancialSnapshot> {
  const live = await readSnapshot(tx, orgId, id);
  const audits = (await tx.execute<{ source: Row }>(sql`select changes->'source' as source from audit_log where org_id=${orgId} and table_name='documents' and row_id=${id} and action='insert' and changes->>'reason'='authority_source_captured' and changes->>'sourceKey'=${key}`)).rows;
  if (audits.length !== 1 || canonical(audits[0]!.source) !== canonical(live.custom?.[key])) return refusal();
  const financial = audits[0]!.source.financialSnapshot as FinancialSnapshot | undefined;
  if (!financial || !Array.isArray(financial.lines) || !financial.header || !sameSnapshot(financial, live.financial)) return refusal();
  if (input && !sameSnapshot(financial, { header: input.document, lines: input.lines })) return refusal();
  return live.financial;
}

/** Caller holds the revision lock. Equivalent editor input keeps original line IDs and evidence. */
export async function assertAuthoritySourceEdit(tx: SqlExecutor, orgId: string, id: string, key: AuthoritySourceKey, lines: unknown[] | null, patch: Row): Promise<void> {
  const before = await assertAuthoritySourceCurrent(tx, orgId, id, key);
  const after = { ...before.header, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
  if (!sameFields(before.header, after, headerFields)) return refusal();
  if (patch.custom && typeof patch.custom === "object") {
    const custom = patch.custom as Row;
    if (sourceKeys.some(sourceKey => Object.hasOwn(custom, sourceKey))) {
      const stored = (await tx.execute<{ custom: Row }>(sql`select custom from documents where org_id=${orgId} and id=${id}`)).rows[0]?.custom;
      if (sourceKeys.some(sourceKey => Object.hasOwn(custom, sourceKey) && canonical(custom[sourceKey]) !== canonical(stored?.[sourceKey]))) return refusal();
    }
  }
  if (!lines) return;
  if (lines.length !== before.lines.length) return refusal();
  for (const [index, incoming] of lines.entries()) {
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return refusal();
    const original = before.lines[index]!, submitted = incoming as Row;
    const candidate = { ...original, ...submitted };
    // Untaxed generated lines do not consume tax-input bases. The native AP
    // editor presents the base amount even when the generator stored null.
    if (!original.taxCodeId && !original.taxGroupId && !candidate.taxCodeId && !candidate.taxGroupId) candidate.taxInputAmount = original.taxInputAmount;
    if (!sameFields(original, candidate, lineFields)) return refusal();
  }
}
