/**
 * Restore source-exact commercial metadata and stable line provenance on
 * migrated customer invoices without re-posting, re-rendering, or replacing
 * stored document artifacts.
 *
 * This is deliberately NOT a document refresh. Before a line is eligible:
 * - source and target invoice line counts must agree;
 * - ordinal line number, posted amount, account, project, unit, and description
 *   must already agree with the source;
 * - every source item/account/project reference must resolve uniquely;
 * - the whole population must retain its preflight fingerprint under lock.
 *
 * Eligible writes are limited to item_id, quantity, unit_price, and the
 * custom.sourceLineRef identity. Complete transaction and line audit evidence
 * is written in the same transaction. Protected document/GL fingerprints must
 * be unchanged after the update. Files and PDFs are never read or written.
 *
 * Dry-run by default. Live writes require --apply --production --reason.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { fromUnits, normalizeDecimal, toUnits } from "../money.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
  type TransactionAuditSnapshot,
} from "../transaction-audit.ts";
import { resolveTargetOrg } from "./target-org.ts";

type JsonRow = Record<string, unknown>;
type Runner = Pick<typeof db, "execute">;

interface SourceLine {
  documentRef: string;
  sourceLineRef: string;
  itemRef: string | null;
  accountRef: string;
  projectRef: string | null;
  lineNumber: number;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  amount: string;
  description: string | null;
}

interface TargetLine {
  documentId: string;
  documentRef: string;
  documentNumber: string;
  documentStatus: string;
  lineId: string;
  lineNumber: number;
  sourceLineRef: string | null;
  itemId: string | null;
  itemRef: string | null;
  accountId: string;
  accountRef: string | null;
  projectId: string | null;
  projectRef: string | null;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  amount: string;
  description: string | null;
}

interface Candidate {
  documentId: string;
  documentRef: string;
  documentNumber: string;
  lineId: string;
  lineNumber: number;
  beforeSourceLineRef: string | null;
  afterSourceLineRef: string;
  beforeItemId: string | null;
  afterItemId: string | null;
  beforeQuantity: string;
  afterQuantity: string;
  beforeUnitPrice: string;
  afterUnitPrice: string;
}

interface Blocker {
  documentRef: string;
  sourceLineRef?: string;
  field: string;
  source: string | null;
  target: string | null;
  detail: string;
}

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split("=");
      return [key!, value.length ? value.join("=") : "true"];
    }),
);
const requestedOrgId =
  args.get("org") ?? process.env.TARGET_ORG ?? process.env.SANDBOX_ORG;
if (!requestedOrgId || !/^[0-9a-f-]{36}$/i.test(requestedOrgId)) {
  throw new Error("--org=<uuid> is required");
}
const orgId: string = requestedOrgId;
const sourcePath =
  args.get("source-invoice-lines") ?? "/tmp/parity-source-invoice-lines.json";
const outputPath =
  args.get("out") ??
  `/tmp/openbooks-invoice-line-commercial-provenance-${orgId}-${Date.now()}.json`;
const apply = args.get("apply") === "true";
const reason = args.get("reason")?.trim() ?? "";
const correctionActorId = args.get("actor") ?? "";
if (!existsSync(sourcePath)) {
  throw new Error(`missing source invoice-line artifact: ${sourcePath}`);
}
if (apply && (reason.length < 10 || reason.length > 500)) {
  throw new Error("--reason must be 10-500 characters when applying");
}
if (apply && !/^[0-9a-f-]{36}$/i.test(correctionActorId)) {
  throw new Error("--actor=<uuid> is required when applying");
}

const stableHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileHash = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

function canonicalQuantity(value: unknown): string {
  const raw =
    value == null || value === "" ? "1.00000000" : normalizeDecimal(String(value), 8);
  const magnitude = raw.startsWith("-") ? raw.slice(1) : raw;
  return /^0(?:\.0+)?$/.test(magnitude) ? "1.00000000" : magnitude;
}

function canonicalAmount(value: unknown): string {
  return fromUnits(-toUnits(String(value ?? "0")));
}

function sourceLines(): {
  byDocument: Map<string, SourceLine[]>;
  duplicateKeys: string[];
  sourceRows: number;
} {
  const raw = JSON.parse(readFileSync(sourcePath, "utf8")) as JsonRow[];
  if (!Array.isArray(raw)) throw new Error("source invoice-line artifact is not an array");
  const detail = raw.filter(
    (row) =>
      String(row.mainline).toUpperCase() === "F" &&
      String(row.taxline).toUpperCase() === "F",
  );
  const seen = new Set<string>();
  const duplicateKeys: string[] = [];
  const byDocument = new Map<string, SourceLine[]>();
  for (const row of detail) {
    const documentRef = String(row.transaction);
    const sourceLineRef = String(row.id);
    const key = `${documentRef}|${sourceLineRef}`;
    if (seen.has(key)) duplicateKeys.push(key);
    seen.add(key);
    const amount = canonicalAmount(row.foreignamount ?? row.netamount);
    const accountRef = String(row.expenseaccount ?? row.account ?? "");
    const lines = byDocument.get(documentRef) ?? [];
    lines.push({
      documentRef,
      sourceLineRef,
      itemRef: row.item == null || row.item === "" ? null : String(row.item),
      accountRef,
      projectRef: row.entity == null || row.entity === "" ? null : String(row.entity),
      lineNumber: 0,
      quantity: canonicalQuantity(row.quantity),
      unit: row.units == null || row.units === "" ? null : String(row.units),
      unitPrice:
        row.rate == null || row.rate === ""
          ? normalizeDecimal(amount, 8)
          : normalizeDecimal(String(row.rate), 8),
      amount,
      description: row.memo == null || row.memo === "" ? null : String(row.memo),
    });
    byDocument.set(documentRef, lines);
  }
  for (const lines of byDocument.values()) {
    lines.sort((left, right) => {
      const a = Number(left.sourceLineRef);
      const b = Number(right.sourceLineRef);
      return Number.isFinite(a) && Number.isFinite(b)
        ? a - b
        : left.sourceLineRef.localeCompare(right.sourceLineRef);
    });
    lines.forEach((line, index) => {
      line.lineNumber = index + 1;
    });
  }
  return { byDocument, duplicateKeys, sourceRows: detail.length };
}

async function uniqueRefMap(
  runner: Runner,
  table: "items" | "accounts" | "projects",
): Promise<{ values: Map<string, string>; duplicates: string[] }> {
  const result = await runner.execute(sql.raw(`
    select custom->>'nsId' as source_ref, min(id::text) as id,
           count(*)::int as matches
      from ${table}
     where org_id = '${orgId}'
       and custom->>'nsId' is not null
     group by custom->>'nsId'
  `));
  const rows = result.rows as Array<{
    source_ref: string;
    id: string;
    matches: number;
  }>;
  return {
    values: new Map(
      rows
        .filter((row) => Number(row.matches) === 1)
        .map((row) => [String(row.source_ref), String(row.id)]),
    ),
    duplicates: rows
      .filter((row) => Number(row.matches) !== 1)
      .map((row) => String(row.source_ref))
      .sort(),
  };
}

async function targetLines(
  runner: Runner,
  lock = false,
): Promise<TargetLine[]> {
  const result = await runner.execute(sql`
    select d.id as document_id, d.custom->>'nsId' as document_ref,
           d.document_number, d.status as document_status,
           line.id as line_id, line.line_number,
           line.custom->>'sourceLineRef' as source_line_ref,
           line.item_id, item.custom->>'nsId' as item_ref,
           line.account_id, account.custom->>'nsId' as account_ref,
           line.project_id, project.custom->>'nsId' as project_ref,
           line.quantity::text, line.unit, line.unit_price::text,
           line.amount::text, line.description
      from documents d
      join document_lines line
        on line.document_id = d.id and line.org_id = d.org_id
      left join items item
        on item.id = line.item_id and item.org_id = line.org_id
      join accounts account
        on account.id = line.account_id and account.org_id = line.org_id
      left join projects project
        on project.id = line.project_id and project.org_id = line.org_id
     where d.org_id = ${orgId}
       and d.kind = 'customer_invoice'
       and d.custom->>'nsId' is not null
     order by d.custom->>'nsId', line.line_number, line.id
     ${lock ? sql`for update of d, line` : sql``}
  `);
  return (result.rows as JsonRow[]).map((row) => ({
    documentId: String(row.document_id),
    documentRef: String(row.document_ref),
    documentNumber: String(row.document_number),
    documentStatus: String(row.document_status),
    lineId: String(row.line_id),
    lineNumber: Number(row.line_number),
    sourceLineRef: row.source_line_ref ? String(row.source_line_ref) : null,
    itemId: row.item_id ? String(row.item_id) : null,
    itemRef: row.item_ref ? String(row.item_ref) : null,
    accountId: String(row.account_id),
    accountRef: row.account_ref ? String(row.account_ref) : null,
    projectId: row.project_id ? String(row.project_id) : null,
    projectRef: row.project_ref ? String(row.project_ref) : null,
    quantity: normalizeDecimal(String(row.quantity), 8),
    unit: row.unit ? String(row.unit) : null,
    unitPrice: normalizeDecimal(String(row.unit_price), 8),
    amount: fromUnits(toUnits(String(row.amount))),
    description: row.description == null || row.description === "" ? null : String(row.description),
  }));
}

function planPopulation(
  source: ReturnType<typeof sourceLines>,
  target: TargetLine[],
  refs: {
    items: Map<string, string>;
    accounts: Map<string, string>;
    projects: Map<string, string>;
  },
): {
  candidates: Candidate[];
  blockers: Blocker[];
  sourceDocuments: number;
  targetSourceDocuments: number;
  retainedTargetOnlyDocuments: number;
  retainedTargetOnlyLines: number;
} {
  const blockers: Blocker[] = source.duplicateKeys.map((key) => ({
    documentRef: key.split("|")[0]!,
    sourceLineRef: key.split("|")[1],
    field: "source_identity",
    source: "duplicate",
    target: null,
    detail: "duplicate source line identity",
  }));
  const targetByDocument = new Map<string, TargetLine[]>();
  for (const line of target) {
    const lines = targetByDocument.get(line.documentRef) ?? [];
    lines.push(line);
    targetByDocument.set(line.documentRef, lines);
  }
  const candidates: Candidate[] = [];
  for (const [documentRef, desiredLines] of source.byDocument) {
    const currentLines = (targetByDocument.get(documentRef) ?? []).slice().sort(
      (left, right) =>
        left.lineNumber - right.lineNumber ||
        left.lineId.localeCompare(right.lineId),
    );
    if (currentLines.length !== desiredLines.length) {
      blockers.push({
        documentRef,
        field: "line_count",
        source: String(desiredLines.length),
        target: String(currentLines.length),
        detail: "source and target line counts must agree before ordinal pairing",
      });
      continue;
    }
    for (let index = 0; index < desiredLines.length; index += 1) {
      const desired = desiredLines[index]!;
      const current = currentLines[index]!;
      const expectedItemId = desired.itemRef
        ? (refs.items.get(desired.itemRef) ?? null)
        : null;
      const expectedAccountId = refs.accounts.get(desired.accountRef) ?? null;
      const expectedProjectId =
        desired.projectRef && refs.projects.has(desired.projectRef)
          ? refs.projects.get(desired.projectRef)!
          : null;
      for (const issue of [
        expectedAccountId
          ? null
          : {
              field: "account_mapping",
              source: desired.accountRef,
              target: null,
              detail: "source account does not resolve uniquely",
            },
        desired.itemRef && !expectedItemId
          ? {
              field: "item_mapping",
              source: desired.itemRef,
              target: null,
              detail: "source item does not resolve uniquely",
            }
          : null,
        current.lineNumber !== desired.lineNumber
          ? {
              field: "line_number",
              source: String(desired.lineNumber),
              target: String(current.lineNumber),
              detail: "target ordinal is not deterministic",
            }
          : null,
        expectedAccountId && current.accountId !== expectedAccountId
          ? {
              field: "account",
              source: desired.accountRef,
              target: current.accountRef,
              detail: "protected posting account differs at the source ordinal",
            }
          : null,
        toUnits(current.amount) !== toUnits(desired.amount)
          ? {
              field: "amount",
              source: desired.amount,
              target: current.amount,
              detail: "protected posted amount differs at the source ordinal",
            }
          : null,
        current.projectId !== expectedProjectId
          ? {
              field: "project",
              source: desired.projectRef,
              target: current.projectRef,
              detail: "protected project dimension differs at the source ordinal",
            }
          : null,
        current.unit !== desired.unit
          ? {
              field: "unit",
              source: desired.unit,
              target: current.unit,
              detail: "unit differs and is outside this correction's write scope",
            }
          : null,
        current.description !== desired.description
          ? {
              field: "description",
              source: desired.description,
              target: current.description,
              detail: "description differs and is outside this correction's write scope",
            }
          : null,
      ]) {
        if (!issue) continue;
        blockers.push({
          documentRef,
          sourceLineRef: desired.sourceLineRef,
          ...issue,
        });
      }
      if (
        !expectedAccountId ||
        (desired.itemRef && !expectedItemId) ||
        current.lineNumber !== desired.lineNumber ||
        current.accountId !== expectedAccountId ||
        toUnits(current.amount) !== toUnits(desired.amount) ||
        current.projectId !== expectedProjectId ||
        current.unit !== desired.unit ||
        current.description !== desired.description
      ) {
        continue;
      }
      if (
        current.sourceLineRef !== desired.sourceLineRef ||
        current.itemId !== expectedItemId ||
        current.quantity !== desired.quantity ||
        current.unitPrice !== desired.unitPrice
      ) {
        candidates.push({
          documentId: current.documentId,
          documentRef,
          documentNumber: current.documentNumber,
          lineId: current.lineId,
          lineNumber: current.lineNumber,
          beforeSourceLineRef: current.sourceLineRef,
          afterSourceLineRef: desired.sourceLineRef,
          beforeItemId: current.itemId,
          afterItemId: expectedItemId,
          beforeQuantity: current.quantity,
          afterQuantity: desired.quantity,
          beforeUnitPrice: current.unitPrice,
          afterUnitPrice: desired.unitPrice,
        });
      }
    }
  }
  const targetOnly = [...targetByDocument.entries()].filter(
    ([documentRef]) => !source.byDocument.has(documentRef),
  );
  return {
    candidates,
    blockers,
    sourceDocuments: source.byDocument.size,
    targetSourceDocuments: [...targetByDocument.keys()].filter((documentRef) =>
      source.byDocument.has(documentRef),
    ).length,
    retainedTargetOnlyDocuments: targetOnly.length,
    retainedTargetOnlyLines: targetOnly.reduce(
      (sum, [, lines]) => sum + lines.length,
      0,
    ),
  };
}

async function protectedFingerprint(
  runner: Runner,
  documentIds: string[],
  lock = false,
): Promise<string> {
  if (documentIds.length === 0) return stableHash([]);
  const ids = `{${documentIds.join(",")}}`;
  const documentState = await runner.execute(sql`
    select d.id as document_id, d.kind, d.status, d.document_date::text,
           d.posting_date::text, d.currency, d.fx_rate::text,
           d.subtotal::text, d.tax_total::text, d.total::text,
           d.open_balance::text, d.posted_entry_id,
           line.id as line_id, line.line_number, line.account_id,
           line.amount::text, line.tax_amount::text, line.tax_code_id,
           line.party_id, line.department_id, line.project_id,
           line.subsidiary_id, line.unit, line.description
      from documents d
      join document_lines line
        on line.document_id = d.id and line.org_id = d.org_id
     where d.org_id = ${orgId}
       and d.id = any(${ids}::uuid[])
     order by d.id, line.id
     ${lock ? sql`for share of d, line` : sql``}
  `);
  const ledgerState = await runner.execute(sql`
    select entry.source_document_id as document_id,
           entry.id as entry_id, entry.status as entry_status,
           entry.posting_date::text as entry_posting_date,
           journal.id as journal_line_id,
           journal.line_number as journal_line_number,
           journal.account_id as journal_account_id,
           journal.amount::text as journal_amount,
           journal.party_id as journal_party_id,
           journal.department_id as journal_department_id,
           journal.project_id as journal_project_id,
           journal.subsidiary_id as journal_subsidiary_id,
           journal.equipment_unit_id as journal_equipment_unit_id
      from journal_entries entry
      join journal_lines journal
        on journal.entry_id = entry.id and journal.org_id = entry.org_id
     where entry.org_id = ${orgId}
       and entry.source_document_id = any(${ids}::uuid[])
       and entry.status in ('posted', 'reversed')
     order by entry.source_document_id, entry.id, journal.id
     ${lock ? sql`for share of entry, journal` : sql``}
  `);
  const hash = createHash("sha256");
  hash.update("documents-and-lines\n");
  for (const row of documentState.rows) {
    hash.update(JSON.stringify(row));
    hash.update("\n");
  }
  hash.update("journal-entries-and-lines\n");
  for (const row of ledgerState.rows) {
    hash.update(JSON.stringify(row));
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const target = await resolveTargetOrg(orgId);
  if (apply && target.isProduction && !process.argv.includes("--production")) {
    throw new Error("--production is required for a live tenant");
  }
  const source = sourceLines();
  const [items, accounts, projects, currentTarget] = await Promise.all([
    uniqueRefMap(db, "items"),
    uniqueRefMap(db, "accounts"),
    uniqueRefMap(db, "projects"),
    targetLines(db),
  ]);
  const planned = planPopulation(source, currentTarget, {
    items: items.values,
    accounts: accounts.values,
    projects: projects.values,
  });
  for (const [table, duplicates] of [
    ["items", items.duplicates],
    ["accounts", accounts.duplicates],
    ["projects", projects.duplicates],
  ] as const) {
    for (const sourceRef of duplicates) {
      planned.blockers.push({
        documentRef: "*",
        field: `${table}_duplicate_mapping`,
        source: sourceRef,
        target: "multiple",
        detail: `duplicate ${table} source identity`,
      });
    }
  }
  const populationFingerprint = stableHash({
    sourceHash: fileHash(sourcePath),
    candidates: planned.candidates,
    blockers: planned.blockers,
  });
  const documentIds = [
    ...new Set(planned.candidates.map((candidate) => candidate.documentId)),
  ];
  const protectedBefore = await protectedFingerprint(db, documentIds);
  let protectedAfter = protectedBefore;
  let updatedLines = 0;
  let auditedLines = 0;
  let auditedDocuments = 0;
  if (apply) {
    if (planned.blockers.length > 0) {
      throw new Error(
        `refusing invoice-line provenance repair: ${planned.blockers.length} blockers`,
      );
    }
    const requestId = randomUUID();
    const actor = await db.execute(sql`
      select id from users
       where org_id = ${orgId}
         and id = ${correctionActorId}
         and is_active
    `);
    const actorId = String((actor.rows[0] as JsonRow | undefined)?.id ?? "");
    if (!actorId) {
      throw new Error(
        "correction actor is not an active user in the target organization",
      );
    }
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${`invoice-line-commercial-provenance:${orgId}`}, 0)
        )
      `);
      await tx.execute(sql`set local openbooks.amend = 'on'`);
      const [lockedItems, lockedAccounts, lockedProjects, lockedTarget] =
        await Promise.all([
          uniqueRefMap(tx, "items"),
          uniqueRefMap(tx, "accounts"),
          uniqueRefMap(tx, "projects"),
          targetLines(tx, true),
        ]);
      const lockedPlan = planPopulation(source, lockedTarget, {
        items: lockedItems.values,
        accounts: lockedAccounts.values,
        projects: lockedProjects.values,
      });
      const lockedFingerprint = stableHash({
        sourceHash: fileHash(sourcePath),
        candidates: lockedPlan.candidates,
        blockers: lockedPlan.blockers,
      });
      if (
        lockedFingerprint !== populationFingerprint ||
        lockedPlan.blockers.length > 0
      ) {
        throw new Error("population changed after preflight; rerun the plan");
      }
      const protectedLockedBefore = await protectedFingerprint(
        tx,
        documentIds,
        true,
      );
      if (protectedLockedBefore !== protectedBefore) {
        throw new Error(
          "protected document or GL state changed after preflight; rerun the plan",
        );
      }

      const beforeByDocument = new Map<string, TransactionAuditSnapshot>();
      for (const documentId of documentIds) {
        const before = await captureTransactionAuditSnapshot(tx, documentId);
        if (!before) throw new Error(`document ${documentId} disappeared`);
        beforeByDocument.set(documentId, before);
      }

      const changed = await tx.execute(sql`
        with source as (
          select *
            from jsonb_to_recordset(${JSON.stringify(planned.candidates)}::jsonb)
                 as candidate(
                   "lineId" uuid,
                   "afterSourceLineRef" text,
                   "afterItemId" uuid,
                   "afterQuantity" numeric,
                   "afterUnitPrice" numeric
                 )
        )
        update document_lines line
           set item_id = source."afterItemId",
               quantity = source."afterQuantity",
               unit_price = source."afterUnitPrice",
               custom = (coalesce(line.custom, '{}'::jsonb) - 'sourceLineRef')
                 || jsonb_build_object('sourceLineRef', source."afterSourceLineRef"),
               updated_at = now(),
               updated_by = ${actorId}
          from source
         where line.org_id = ${orgId}
           and line.id = source."lineId"
        returning line.id
      `);
      updatedLines = changed.rows.length;
      if (updatedLines !== planned.candidates.length) {
        throw new Error(
          `planned ${planned.candidates.length} line updates but wrote ${updatedLines}`,
        );
      }

      const lineAudit = await tx.execute(sql`
        with source as (
          select *
            from jsonb_to_recordset(${JSON.stringify(planned.candidates)}::jsonb)
                 as candidate(
                   "documentId" uuid,
                   "documentRef" text,
                   "documentNumber" text,
                   "lineId" uuid,
                   "lineNumber" integer,
                   "beforeSourceLineRef" text,
                   "afterSourceLineRef" text,
                   "beforeItemId" uuid,
                   "afterItemId" uuid,
                   "beforeQuantity" numeric,
                   "afterQuantity" numeric,
                   "beforeUnitPrice" numeric,
                   "afterUnitPrice" numeric
                 )
        )
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        select ${orgId}, 'document_lines', source."lineId", 'update',
               jsonb_build_object(
                 'mode', 'source_commercial_provenance_correction',
                 'reason', ${reason}::text,
                 'documentId', source."documentId",
                 'documentRef', source."documentRef",
                 'documentNumber', source."documentNumber",
                 'lineNumber', source."lineNumber",
                 'before', jsonb_build_object(
                   'sourceLineRef', source."beforeSourceLineRef",
                   'itemId', source."beforeItemId",
                   'quantity', source."beforeQuantity",
                   'unitPrice', source."beforeUnitPrice"
                 ),
                 'after', jsonb_build_object(
                   'sourceLineRef', source."afterSourceLineRef",
                   'itemId', source."afterItemId",
                   'quantity', source."afterQuantity",
                   'unitPrice', source."afterUnitPrice"
                 ),
                 'protectedFinancialFieldsChanged', false,
                 'storedArtifactsRegenerated', false
               ),
               ${actorId}, ${requestId}
          from source
        returning row_id
      `);
      auditedLines = lineAudit.rows.length;
      if (auditedLines !== planned.candidates.length) {
        throw new Error(
          `planned ${planned.candidates.length} line audits but wrote ${auditedLines}`,
        );
      }

      for (const documentId of documentIds) {
        const after = await captureTransactionAuditSnapshot(tx, documentId);
        if (!after) throw new Error(`document ${documentId} disappeared`);
        await recordTransactionAudit(tx, {
          orgId,
          documentId,
          action: "update",
          actorId,
          source: `source-commercial-provenance:${requestId}`,
          reason,
          before: beforeByDocument.get(documentId)!,
          after,
        });
        auditedDocuments += 1;
      }
      protectedAfter = await protectedFingerprint(tx, documentIds);
      if (protectedAfter !== protectedBefore) {
        throw new Error("protected document or GL state changed; rolling back");
      }
    });
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: {
      orgId: target.id,
      name: target.name,
      environment: target.envKind,
    },
    mode: apply ? "apply" : "plan",
    reason: apply ? reason : null,
    source: {
      path: sourcePath,
      sha256: fileHash(sourcePath),
      detailLines: source.sourceRows,
      documentsWithDetailLines: planned.sourceDocuments,
    },
    population: {
      targetSourceDocuments: planned.targetSourceDocuments,
      retainedTargetOnlyDocuments: planned.retainedTargetOnlyDocuments,
      retainedTargetOnlyLines: planned.retainedTargetOnlyLines,
      candidateLines: planned.candidates.length,
      affectedDocuments: documentIds.length,
      blockers: planned.blockers.length,
      populationFingerprint,
    },
    invariants: {
      protectedDocumentAndGlFingerprintBefore: protectedBefore,
      protectedDocumentAndGlFingerprintAfter: protectedAfter,
      protectedDocumentAndGlChanged: protectedBefore === protectedAfter ? 0 : 1,
      documentAmountsChanged: 0,
      documentAccountsChanged: 0,
      documentProjectsChanged: 0,
      journalLinesChanged: 0,
      documentFilesRead: 0,
      documentFilesWritten: 0,
      storedArtifactsRegenerated: 0,
      updatedLines,
      auditedLines,
      auditedDocuments,
    },
    blockers: {
      count: planned.blockers.length,
      sample: planned.blockers.slice(0, 100),
    },
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`report: ${outputPath}`);
  if (!apply && planned.blockers.length > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
