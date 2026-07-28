/**
 * Exhaustive project parity certificate.
 *
 * This is deliberately population-based, never sample-based. It inventories
 * every source project, customer invoice, project-tagged GL category, and
 * legacy field-ticket header, then compares them to one OpenBooks tenant using
 * exact numeric(19,4) arithmetic. Missing source layers are reported as
 * unproven gates; they are never silently omitted from the denominator.
 *
 * Customer data is written outside the repository by default.
 *
 * Usage:
 *   npx tsx --conditions=react-server src/validation/project-parity-certificate.ts \
 *     --org=<uuid> --allow-differences
 *
 * Optional:
 *   --refresh-source
 *   --refresh-project-gl-source
 *   --source-accounting-book=<NetSuite accounting book id>
 *   --source-projects=/path/projects.json
 *   --source-invoices=/path/invoices.json
 *   --source-invoice-lines=/path/invoice-lines.json
 *   --source-project-gl=/path/project-account-totals.json
 *   --legacy-tickets=/path/field-ticket-headers.tsv
 *   --legacy-crew=/path/field-ticket-crew.tsv
 *   --legacy-project-financials=/path/project-financials.json
 *   --out=/path/certificate.json
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../db.ts";
import { fromUnits, normalizeDecimal, toUnits } from "../money.ts";
import { sourceClient } from "../sync/source-client.ts";

type JsonRow = Record<string, unknown>;

type GateStatus = "exact" | "different" | "unproven";

interface GateResult {
  status: GateStatus;
  sourceCount: number | null;
  targetCount: number | null;
  exactCount: number | null;
  mismatchCount: number | null;
  targetOnlyCount?: number;
  detail?: string;
}

interface Difference {
  layer: string;
  sourceRef: string;
  field: string;
  source: string | null;
  target: string | null;
}

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split("=");
      return [key!, rest.length ? rest.join("=") : "true"];
    }),
);

const orgId = args.get("org") ?? process.env.TARGET_ORG;
if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
  throw new Error("--org=<uuid> is required");
}
const requestedSourceAccountingBook =
  args.get("source-accounting-book")?.trim() || null;

const paths = {
  sourceProjects:
    args.get("source-projects") ?? "/tmp/parity-ns-projects.json",
  sourceInvoices:
    args.get("source-invoices") ?? "/tmp/parity-ns-invoices.json",
  sourceInvoiceLines:
    args.get("source-invoice-lines") ??
    "/tmp/parity-source-invoice-lines.json",
  sourceProjectGl:
    args.get("source-project-gl") ??
    "/tmp/parity-ns-project-account-totals.json",
  legacyTickets: args.get("legacy-tickets") ?? "/tmp/ft-head.tsv",
  legacyCrew: args.get("legacy-crew") ?? "/tmp/ft-rows.tsv",
  legacyProjectFinancials:
    args.get("legacy-project-financials") ?? "/tmp/golden-cost.json",
  out:
    args.get("out") ??
    `/tmp/openbooks-project-parity-${orgId}-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`,
};

function readJson(path: string): JsonRow[] | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a JSON array`);
  return parsed as JsonRow[];
}

function fileHash(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalMoney(value: unknown): string {
  return fromUnits(toUnits(String(value ?? "0")));
}

function canonicalDecimal(value: unknown): string {
  return normalizeDecimal(String(value ?? "0"), 8);
}

function moneyEqual(left: unknown, right: unknown): boolean {
  return toUnits(String(left ?? "0")) === toUnits(String(right ?? "0"));
}

function normalizeSourceAccountType(value: unknown): string {
  const mapping: Record<string, string> = {
    Bank: "asset_bank",
    COGS: "cogs",
    Equity: "equity",
    Expense: "expense",
    Income: "income",
    OthCurrAsset: "asset_current_other",
    OthCurrLiab: "liability_current_other",
  };
  return mapping[String(value)] ?? `source:${String(value)}`;
}

function normalizeTargetAccountType(value: unknown): string {
  const raw = String(value);
  if (raw === "income_other") return "income";
  if (raw === "expense_other") return "expense";
  return raw;
}

function addAmount(
  map: Map<string, bigint>,
  key: string,
  amount: unknown,
): void {
  map.set(key, (map.get(key) ?? 0n) + toUnits(String(amount ?? "0")));
}

function duplicateKeys(rows: JsonRow[], key: (row: JsonRow) => string): Set<string> {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const row of rows) {
    const value = key(row);
    if (!value) continue;
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return duplicate;
}

async function retry<T>(fn: () => Promise<T>, attempts = 7): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const messages: string[] = [];
      const seen = new Set<unknown>();
      let current: unknown = error;
      while (current && !seen.has(current)) {
        seen.add(current);
        messages.push(
          current instanceof Error ? current.message : String(current),
        );
        current =
          typeof current === "object" && "cause" in current
            ? (current as { cause?: unknown }).cause
            : null;
      }
      if (
        !/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(
          messages.join("\n"),
        )
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 750 * (attempt + 1)),
      );
    }
  }
  throw last;
}

async function refreshProjectGlSource(
  client = sourceClient(),
): Promise<string> {
  // transactionline.netamount is not the posted amount for every NetSuite
  // special item. For example, a posting Markup line can carry foreignamount
  // while netamount is zero; transactionaccountingline is the authoritative
  // book impact. Never infer the ledger from the commercial line projection.
  const projectGlByBook = await client.query<JsonRow>(
    `select tal.accountingbook, tl.entity as project,
            a.accttype as accounttype, sum(tal.amount) as amount
       from transactionaccountingline tal
       join transactionline tl
         on tl.transaction = tal.transaction
        and tl.id = tal.transactionline
       join account a on a.id = tal.account
      where tl.entity in (select id from job)
        and tl.posting = 'T'
      group by tal.accountingbook, tl.entity, a.accttype`,
  );
  const books = [
    ...new Set(
      projectGlByBook
        .map((row) => String(row.accountingbook ?? ""))
        .filter(Boolean),
    ),
  ].sort();
  const sourceAccountingBook =
    requestedSourceAccountingBook ?? (books.length === 1 ? books[0]! : null);
  if (!sourceAccountingBook) {
    throw new Error(
      `NetSuite project GL contains ${books.length} accounting books (${books.join(
        ", ",
      )}); pass --source-accounting-book=<id> explicitly`,
    );
  }
  if (!books.includes(sourceAccountingBook)) {
    throw new Error(
      `NetSuite accounting book ${sourceAccountingBook} is absent; available books: ${books.join(
        ", ",
      )}`,
    );
  }
  writeFileSync(
    paths.sourceProjectGl,
    JSON.stringify(
      projectGlByBook.filter(
        (row) => String(row.accountingbook) === sourceAccountingBook,
      ),
    ),
  );
  return sourceAccountingBook;
}

async function refreshSource(): Promise<void> {
  const client = sourceClient();
  const projects = await client.query<JsonRow>(
    "select id, entityid, companyname, isinactive, jobbillingtype, parent from job",
  );
  writeFileSync(paths.sourceProjects, JSON.stringify(projects));
  const invoices = await client.query<JsonRow>(
    "select id, tranid, trandate, entity, foreigntotal, status, postingperiod from transaction where type = 'CustInvc'",
  );
  writeFileSync(paths.sourceInvoices, JSON.stringify(invoices));
  const invoiceLines = await client.query<JsonRow>(
    `select tl.transaction, tl.id, tl.mainline, tl.taxline, tl.item,
            tl.account, tl.expenseaccount, tl.netamount, tl.foreignamount,
            tl.quantity, tl.rate, BUILTIN.DF(tl.units) as units,
            tl.department, tl.entity, tl.subsidiary, tl.memo,
            tl.taxrate1, tl.taxcode
       from transactionline tl
       join transaction t on t.id = tl.transaction
      where t.type = 'CustInvc'
      order by tl.transaction, tl.id`,
  );
  writeFileSync(paths.sourceInvoiceLines, JSON.stringify(invoiceLines));
  await refreshProjectGlSource(client);
}

function parseLegacyTicketHeaders(path: string): JsonRow[] | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  return lines
    .map((line) => line.split("\t"))
    .filter((columns) => columns.length >= 13 && /^\d+$/.test(columns[0] ?? ""))
    .map((columns) => ({
      id: columns[0],
      number: columns[1],
      project: columns[2],
      begin: columns[5],
      end: columns[6],
      billed: columns[7],
      approved: columns[9],
    }));
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseLegacyCrew(
  path: string,
  tickets: JsonRow[] | null,
): Map<string, bigint> | null {
  if (!existsSync(path) || !tickets) return null;
  const ticketBegin = new Map(
    tickets.map((ticket) => [String(ticket.id), String(ticket.begin)]),
  );
  const cells = new Map<string, bigint>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const columns = line.split("\t");
    if (columns.length < 25 || !/^\d+$/.test(columns[0] ?? "")) continue;
    const ticketId = columns[0]!;
    const begin = ticketBegin.get(ticketId);
    if (!begin) continue;
    for (let day = 0; day < 7; day++) {
      for (const [offset, kind] of [
        [0, "regular"],
        [1, "overtime"],
        [2, "double_time"],
      ] as const) {
        const hours = toUnits(columns[4 + day * 3 + offset] ?? "0");
        if (hours === 0n) continue;
        const key = [
          ticketId,
          columns[1] ?? "",
          columns[2] ?? "",
          addDays(begin, day),
          kind,
        ].join("|");
        cells.set(key, (cells.get(key) ?? 0n) + hours);
      }
    }
  }
  return cells;
}

if (args.has("refresh-source")) {
  await refreshSource();
} else if (args.has("refresh-project-gl-source")) {
  await refreshProjectGlSource();
}

const sourceProjects = readJson(paths.sourceProjects);
const sourceInvoices = readJson(paths.sourceInvoices);
const sourceInvoiceLines = readJson(paths.sourceInvoiceLines);
const sourceProjectGl = readJson(paths.sourceProjectGl);
const sourceAccountingBooks = sourceProjectGl
  ? [
      ...new Set(
        sourceProjectGl
          .map((row) => String(row.accountingbook ?? ""))
          .filter(Boolean),
      ),
    ].sort()
  : [];
if (sourceAccountingBooks.length > 1) {
  throw new Error(
    `source project GL artifact spans accounting books ${sourceAccountingBooks.join(
      ", ",
    )}; provide a single-book artifact`,
  );
}
const legacyTickets = parseLegacyTicketHeaders(paths.legacyTickets);
const legacyCrew = parseLegacyCrew(paths.legacyCrew, legacyTickets);
const legacyProjectFinancials = readJson(paths.legacyProjectFinancials);

const target = await withOrgContext(orgId, async () => {
  const [org, projects, invoices, invoiceLines, tickets, projectGl, ticketCrew] = await Promise.all([
    retry(() => db.execute(sql`
      select id, name, env_kind from orgs where id = ${orgId}
    `)),
    retry(() => db.execute(sql`
      select id, code, name, is_active, custom->>'nsId' as source_id
        from projects where org_id = ${orgId}
    `)),
    retry(() => db.execute(sql`
      select id, document_number, document_date::text, total::text,
             project_id, custom->>'nsId' as source_id
        from documents
       where org_id = ${orgId} and kind = 'customer_invoice'
    `)),
    retry(() => db.execute(sql`
      select d.custom->>'nsId' as source_document_id,
             dl.custom->>'sourceLineRef' as source_line_id,
             dl.line_number, dl.quantity::text, dl.unit,
             dl.unit_price::text, dl.amount::text, dl.description,
             item.custom->>'nsId' as source_item_id,
             account.custom->>'nsId' as source_account_id,
             project.custom->>'nsId' as source_project_id,
             party.custom->>'nsId' as source_party_id
        from document_lines dl
        join documents d
          on d.id = dl.document_id and d.org_id = dl.org_id
        left join items item
          on item.id = dl.item_id and item.org_id = dl.org_id
        left join accounts account
          on account.id = dl.account_id and account.org_id = dl.org_id
        left join projects project
          on project.id = dl.project_id and project.org_id = dl.org_id
        left join parties party
          on party.id = dl.party_id and party.org_id = dl.org_id
       where dl.org_id = ${orgId}
         and d.kind = 'customer_invoice'
         and d.custom->>'nsId' is not null
    `)),
    retry(() => db.execute(sql`
      select d.id, d.document_number,
             d.custom->'legacy'->>'id' as legacy_id,
             p.custom->>'nsId' as source_project_id
        from documents d
        left join projects p on p.id = d.project_id and p.org_id = d.org_id
       where d.org_id = ${orgId} and d.kind = 'field_ticket'
    `)),
    retry(() => db.execute(sql`
      select p.custom->>'nsId' as source_project_id,
             a.type as account_type, sum(jl.amount)::text as amount
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join projects p on p.id = jl.project_id and p.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where jl.org_id = ${orgId} and je.status in ('posted', 'reversed')
         and p.custom->>'nsId' is not null
       group by p.custom->>'nsId', a.type
    `)),
    retry(() => db.execute(sql`
      select evidence.legacy_id, evidence.source_employee_id,
             evidence.source_item_id, evidence.worked_on,
             evidence.time_kind, sum(evidence.hours)::text as hours
        from (
          -- Approved commercial labor is frozen in its current evidence
          -- revision; later operational time changes cannot reinterpret it.
          select d.custom->'legacy'->>'id' as legacy_id,
                 employee.custom->>'nsId' as source_employee_id,
                 item.custom->>'nsId' as source_item_id,
                 line.worked_on::text as worked_on,
                 line.time_classification as time_kind,
                 line.hours as hours
            from documents d
            join field_ticket_labor_snapshots snapshot
              on snapshot.field_ticket_id = d.id
             and snapshot.org_id = d.org_id
             and snapshot.superseded_at is null
             and snapshot.evidence_basis = 'source_import'
             and snapshot.source_system = 'adminapp2'
            join field_ticket_labor_lines line
              on line.snapshot_id = snapshot.id
             and line.org_id = snapshot.org_id
             and line.field_ticket_id = snapshot.field_ticket_id
            join parties employee
              on employee.id = line.employee_party_id
             and employee.org_id = line.org_id
            left join items item
              on item.id = line.item_id
             and item.org_id = line.org_id
           where d.org_id = ${orgId}
             and d.kind = 'field_ticket'
             and d.status = 'approved'
             and d.custom->'legacy'->>'id' is not null

          union all

          -- A draft has no frozen customer-facing revision yet. Its editable
          -- labor source of truth is the atomic operational time ledger.
          select d.custom->'legacy'->>'id' as legacy_id,
                 employee.custom->>'nsId' as source_employee_id,
                 item.custom->>'nsId' as source_item_id,
                 time.worked_on::text as worked_on,
                 coalesce(time_type.classification, 'regular') as time_kind,
                 time.hours as hours
            from documents d
            join time_entries time
              on time.field_ticket_id = d.id
             and time.org_id = d.org_id
            join parties employee
              on employee.id = time.employee_party_id
             and employee.org_id = time.org_id
            left join items item
              on item.id = time.item_id
             and item.org_id = time.org_id
            left join time_types time_type
              on time_type.id = time.time_type_id
             and time_type.org_id = time.org_id
           where d.org_id = ${orgId}
             and d.kind = 'field_ticket'
             and d.status = 'draft'
             and d.custom->'legacy'->>'id' is not null
        ) evidence
       group by evidence.legacy_id, evidence.source_employee_id,
                evidence.source_item_id, evidence.worked_on,
                evidence.time_kind
    `)),
  ]);
  return {
    org: (org as unknown as { rows: JsonRow[] }).rows[0] ?? null,
    projects: (projects as unknown as { rows: JsonRow[] }).rows,
    invoices: (invoices as unknown as { rows: JsonRow[] }).rows,
    invoiceLines: (invoiceLines as unknown as { rows: JsonRow[] }).rows,
    tickets: (tickets as unknown as { rows: JsonRow[] }).rows,
    projectGl: (projectGl as unknown as { rows: JsonRow[] }).rows,
    ticketCrew: (ticketCrew as unknown as { rows: JsonRow[] }).rows,
  };
});

if (!target.org) throw new Error(`organization ${orgId} not found`);

const differences: Difference[] = [];
const gates: Record<string, GateResult> = {};

if (!sourceProjects) {
  gates.projectIdentity = {
    status: "unproven",
    sourceCount: null,
    targetCount: target.projects.length,
    exactCount: null,
    mismatchCount: null,
    detail: `missing ${paths.sourceProjects}`,
  };
} else {
  const sourceById = new Map(
    sourceProjects.map((row) => [String(row.id), row]),
  );
  const targetBySourceId = new Map(
    target.projects
      .filter((row) => row.source_id)
      .map((row) => [String(row.source_id), row]),
  );
  const sourceDupes = duplicateKeys(sourceProjects, (row) => String(row.id));
  const targetDupes = duplicateKeys(
    target.projects,
    (row) => String(row.source_id ?? ""),
  );
  const mismatchedSourceRefs = new Set<string>();
  for (const [sourceRef] of sourceById) {
    const found = targetBySourceId.get(sourceRef);
    if (!found) {
      differences.push({
        layer: "project_identity",
        sourceRef,
        field: "presence",
        source: "present",
        target: null,
      });
      mismatchedSourceRefs.add(sourceRef);
      continue;
    }
    for (const [field, sourceValue, targetValue] of [
      ["code", sourceById.get(sourceRef)?.entityid, found.code],
      ["name", sourceById.get(sourceRef)?.companyname, found.name],
      [
        "is_active",
        String(sourceById.get(sourceRef)?.isinactive) === "T" ? "false" : "true",
        String(found.is_active),
      ],
    ] as const) {
      if (String(sourceValue ?? "") === String(targetValue ?? "")) continue;
      differences.push({
        layer: "project_identity",
        sourceRef,
        field,
        source: String(sourceValue ?? ""),
        target: String(targetValue ?? ""),
      });
      mismatchedSourceRefs.add(sourceRef);
    }
  }
  for (const sourceRef of [...sourceDupes, ...targetDupes]) {
    differences.push({
      layer: "project_identity",
      sourceRef,
      field: "duplicate_source_identity",
      source: sourceDupes.has(sourceRef) ? "duplicate" : "unique",
      target: targetDupes.has(sourceRef) ? "duplicate" : "unique",
    });
    if (sourceById.has(sourceRef)) mismatchedSourceRefs.add(sourceRef);
  }
  const targetOnlyCount = [...targetBySourceId.keys()].filter(
    (sourceRef) => !sourceById.has(sourceRef),
  ).length;
  const mismatchCount = mismatchedSourceRefs.size;
  gates.projectIdentity = {
    status: mismatchCount === 0 ? "exact" : "different",
    sourceCount: sourceProjects.length,
    targetCount: target.projects.length,
    exactCount: sourceProjects.length - mismatchedSourceRefs.size,
    mismatchCount,
    targetOnlyCount,
    detail:
      "Target-only native or retained source tombstone projects are reported separately and do not reduce source-population coverage",
  };
}

if (!sourceInvoices) {
  gates.invoiceHeadersAndTotals = {
    status: "unproven",
    sourceCount: null,
    targetCount: target.invoices.length,
    exactCount: null,
    mismatchCount: null,
    detail: `missing ${paths.sourceInvoices}`,
  };
} else {
  const targetBySourceId = new Map(
    target.invoices
      .filter((row) => row.source_id)
      .map((row) => [String(row.source_id), row]),
  );
  let exact = 0;
  for (const source of sourceInvoices) {
    const sourceRef = String(source.id);
    const found = targetBySourceId.get(sourceRef);
    if (!found) {
      differences.push({
        layer: "invoice_header",
        sourceRef,
        field: "presence",
        source: String(source.tranid ?? sourceRef),
        target: null,
      });
      continue;
    }
    const sourceTotal = canonicalMoney(source.foreigntotal);
    const targetTotal = canonicalMoney(found.total);
    if (!moneyEqual(sourceTotal, targetTotal)) {
      differences.push({
        layer: "invoice_header",
        sourceRef,
        field: "total",
        source: sourceTotal,
        target: targetTotal,
      });
      continue;
    }
    exact++;
  }
  const mismatchCount = sourceInvoices.length - exact;
  const sourceIds = new Set(sourceInvoices.map((row) => String(row.id)));
  const targetOnlyCount = [...targetBySourceId.keys()].filter(
    (sourceRef) => !sourceIds.has(sourceRef),
  ).length;
  gates.invoiceHeadersAndTotals = {
    status: mismatchCount === 0 ? "exact" : "different",
    sourceCount: sourceInvoices.length,
    targetCount: target.invoices.length,
    exactCount: exact,
    mismatchCount,
    targetOnlyCount,
  };
}

if (!sourceProjectGl) {
  gates.projectGlByAccountCategory = {
    status: "unproven",
    sourceCount: null,
    targetCount: target.projectGl.length,
    exactCount: null,
    mismatchCount: null,
    detail: `missing ${paths.sourceProjectGl}`,
  };
} else {
  const sourceAmounts = new Map<string, bigint>();
  for (const row of sourceProjectGl) {
    addAmount(
      sourceAmounts,
      `${String(row.project)}|${normalizeSourceAccountType(row.accounttype)}`,
      row.amount,
    );
  }
  const targetAmounts = new Map<string, bigint>();
  for (const row of target.projectGl) {
    addAmount(
      targetAmounts,
      `${String(row.source_project_id)}|${normalizeTargetAccountType(row.account_type)}`,
      row.amount,
    );
  }
  // A posted entry and its linked reversal remain permanent ledger history.
  // Their fully offset category key is economically absent, not a target-only
  // "exact zero" that can inflate the source-population numerator.
  for (const [key, value] of sourceAmounts) {
    if (value === 0n) sourceAmounts.delete(key);
  }
  for (const [key, value] of targetAmounts) {
    if (value === 0n) targetAmounts.delete(key);
  }
  const keys = new Set([...sourceAmounts.keys(), ...targetAmounts.keys()]);
  let exact = 0;
  for (const key of keys) {
    const sourceAmount = sourceAmounts.get(key) ?? 0n;
    const targetAmount = targetAmounts.get(key) ?? 0n;
    if (sourceAmount === targetAmount) {
      exact++;
      continue;
    }
    differences.push({
      layer: "project_gl_category",
      sourceRef: key.split("|")[0]!,
      field: key.split("|")[1]!,
      source: fromUnits(sourceAmount),
      target: fromUnits(targetAmount),
    });
  }
  const targetOnlyCount = [...targetAmounts.keys()].filter(
    (key) => !sourceAmounts.has(key),
  ).length;
  gates.projectGlByAccountCategory = {
    status: exact === keys.size ? "exact" : "different",
    sourceCount: sourceAmounts.size,
    targetCount: targetAmounts.size,
    exactCount: exact,
    mismatchCount: keys.size - exact,
    targetOnlyCount,
    detail:
      "Signed functional-currency GL amounts grouped by project and normalized account category",
  };
}

if (!legacyTickets) {
  gates.fieldTicketHeaders = {
    status: "unproven",
    sourceCount: null,
    targetCount: target.tickets.length,
    exactCount: null,
    mismatchCount: null,
    detail: `missing ${paths.legacyTickets}`,
  };
} else {
  const byLegacyId = new Map(
    target.tickets
      .filter((row) => row.legacy_id)
      .map((row) => [String(row.legacy_id), row]),
  );
  const byNumber = new Map(
    target.tickets.map((row) => [String(row.document_number), row]),
  );
  let exact = 0;
  for (const ticket of legacyTickets) {
    const sourceRef = String(ticket.id);
    const targetTicket =
      byLegacyId.get(sourceRef) ?? byNumber.get(String(ticket.number));
    if (!targetTicket) {
      differences.push({
        layer: "field_ticket_header",
        sourceRef,
        field: "presence",
        source: String(ticket.number),
        target: null,
      });
      continue;
    }
    if (
      targetTicket.source_project_id &&
      String(targetTicket.source_project_id) !== String(ticket.project)
    ) {
      differences.push({
        layer: "field_ticket_header",
        sourceRef,
        field: "project",
        source: String(ticket.project),
        target: String(targetTicket.source_project_id),
      });
      continue;
    }
    exact++;
  }
  gates.fieldTicketHeaders = {
    status: exact === legacyTickets.length ? "exact" : "different",
    sourceCount: legacyTickets.length,
    targetCount: target.tickets.length,
    exactCount: exact,
    mismatchCount: legacyTickets.length - exact,
    targetOnlyCount: Math.max(0, target.tickets.length - exact),
  };
}

const sourceProjectCount = sourceProjects?.length ?? null;
const legacyFinancialCount = legacyProjectFinancials?.length ?? null;
gates.legacyProjectFinancialMeasures =
  legacyProjectFinancials && sourceProjectCount !== null
    ? {
        status:
          legacyFinancialCount === sourceProjectCount ? "different" : "unproven",
        sourceCount: legacyFinancialCount,
        targetCount: target.projects.length,
        exactCount: null,
        mismatchCount: null,
        detail:
          legacyFinancialCount === sourceProjectCount
            ? "Full-population source loaded; measure comparison implementation is required"
            : `Source financial measures cover ${legacyFinancialCount}/${sourceProjectCount} projects`,
      }
    : {
        status: "unproven",
        sourceCount: legacyFinancialCount,
        targetCount: target.projects.length,
        exactCount: null,
        mismatchCount: null,
        detail: `missing complete legacy project financial export (${paths.legacyProjectFinancials})`,
      };

if (!sourceInvoiceLines) {
  gates.invoiceLines = {
    status: "unproven",
    sourceCount: null,
    targetCount: target.invoiceLines.length,
    exactCount: null,
    mismatchCount: null,
    detail: `missing ${paths.sourceInvoiceLines}`,
  };
} else {
  const sourceDetail = sourceInvoiceLines.filter(
    (row) =>
      String(row.mainline).toUpperCase() === "F" &&
      String(row.taxline).toUpperCase() === "F",
  );
  const sourceByKey = new Map<string, JsonRow>();
  const expectedLineNumber = new Map<string, number>();
  const sourceByDocument = new Map<string, JsonRow[]>();
  for (const row of sourceDetail) {
    const documentRef = String(row.transaction);
    const lineRef = String(row.id);
    const key = `${documentRef}|${lineRef}`;
    if (sourceByKey.has(key)) {
      throw new Error(`duplicate source invoice line ${key}`);
    }
    sourceByKey.set(key, row);
    const group = sourceByDocument.get(documentRef) ?? [];
    group.push(row);
    sourceByDocument.set(documentRef, group);
  }
  for (const [documentRef, rows] of sourceByDocument) {
    rows.sort((left, right) => {
      const a = Number(left.id);
      const b = Number(right.id);
      return Number.isFinite(a) && Number.isFinite(b)
        ? a - b
        : String(left.id).localeCompare(String(right.id));
    });
    rows.forEach((row, index) =>
      expectedLineNumber.set(`${documentRef}|${String(row.id)}`, index + 1),
    );
  }
  const targetByKey = new Map<string, JsonRow>();
  let targetWithoutIdentity = 0;
  for (const row of target.invoiceLines) {
    if (!row.source_document_id || !row.source_line_id) {
      targetWithoutIdentity++;
      continue;
    }
    const key = `${String(row.source_document_id)}|${String(row.source_line_id)}`;
    if (targetByKey.has(key)) {
      differences.push({
        layer: "invoice_line",
        sourceRef: key,
        field: "duplicate_source_identity",
        source: "unique",
        target: "duplicate",
      });
      continue;
    }
    targetByKey.set(key, row);
  }
  const mismatchedSourceLines = new Set<string>();
  for (const [key, source] of sourceByKey) {
    const found = targetByKey.get(key);
    if (!found) {
      differences.push({
        layer: "invoice_line",
        sourceRef: key,
        field: "presence",
        source: "present",
        target: null,
      });
      mismatchedSourceLines.add(key);
      continue;
    }
    const sourceAmountUnits = -toUnits(
      String(source.foreignamount ?? source.netamount ?? "0"),
    );
    const rawQuantity =
      source.quantity == null || source.quantity === ""
        ? "1.00000000"
        : canonicalDecimal(source.quantity);
    const quantityMagnitude = rawQuantity.startsWith("-")
      ? rawQuantity.slice(1)
      : rawQuantity;
    const expectedQuantity = /^0(?:\.0+)?$/.test(quantityMagnitude)
      ? "1.00000000"
      : quantityMagnitude;
    const expectedAmount = fromUnits(sourceAmountUnits);
    const expectedRate =
      source.rate == null || source.rate === ""
        ? expectedAmount
        : canonicalDecimal(source.rate);
    const expectedAccount = String(
      source.expenseaccount ?? source.account ?? "",
    );
    for (const [field, sourceValue, targetValue] of [
      ["line_number", String(expectedLineNumber.get(key)), String(found.line_number)],
      ["item", String(source.item ?? ""), String(found.source_item_id ?? "")],
      ["account", expectedAccount, String(found.source_account_id ?? "")],
      ["quantity", expectedQuantity, canonicalDecimal(found.quantity)],
      ["unit", String(source.units ?? ""), String(found.unit ?? "")],
      ["unit_price", expectedRate, canonicalDecimal(found.unit_price)],
      ["amount", expectedAmount, canonicalMoney(found.amount)],
      ["description", String(source.memo ?? ""), String(found.description ?? "")],
    ] as const) {
      if (sourceValue === targetValue) continue;
      differences.push({
        layer: "invoice_line",
        sourceRef: key,
        field,
        source: sourceValue,
        target: targetValue,
      });
      mismatchedSourceLines.add(key);
    }
  }
  const targetOnlyCount =
    targetWithoutIdentity +
    [...targetByKey.keys()].filter((key) => !sourceByKey.has(key)).length;
  gates.invoiceLines = {
    status:
      mismatchedSourceLines.size === 0 && targetOnlyCount === 0
        ? "exact"
        : "different",
    sourceCount: sourceByKey.size,
    targetCount: target.invoiceLines.length,
    exactCount: sourceByKey.size - mismatchedSourceLines.size,
    mismatchCount: mismatchedSourceLines.size + targetOnlyCount,
    targetOnlyCount,
    detail:
      "Every source customer-invoice detail line by stable identity, sequence, item, account, quantity, unit, rate, amount, and description",
  };
}
if (!legacyCrew) {
  gates.fieldTicketCrewAndHours = {
    status: "unproven",
    sourceCount: null,
    targetCount: target.ticketCrew.length,
    exactCount: null,
    mismatchCount: null,
    detail: `missing ${paths.legacyCrew} or ticket headers`,
  };
} else {
  const currentSourceTicketIds = new Set(
    legacyTickets!.map((ticket) => String(ticket.id)),
  );
  const targetCrew = new Map<string, bigint>();
  for (const row of target.ticketCrew.filter((candidate) =>
    currentSourceTicketIds.has(String(candidate.legacy_id)),
  )) {
    const key = [
      row.legacy_id,
      row.source_employee_id,
      row.source_item_id,
      row.worked_on,
      row.time_kind,
    ].map((value) => String(value ?? "")).join("|");
    addAmount(targetCrew, key, row.hours);
  }
  const keys = new Set([...legacyCrew.keys(), ...targetCrew.keys()]);
  let exact = 0;
  for (const key of keys) {
    const sourceHours = legacyCrew.get(key) ?? 0n;
    const targetHours = targetCrew.get(key) ?? 0n;
    if (sourceHours === targetHours) {
      exact++;
      continue;
    }
    differences.push({
      layer: "field_ticket_crew_hours",
      sourceRef: key,
      field: "hours",
      source: fromUnits(sourceHours),
      target: fromUnits(targetHours),
    });
  }
  gates.fieldTicketCrewAndHours = {
    status: exact === keys.size ? "exact" : "different",
    sourceCount: legacyCrew.size,
    targetCount: targetCrew.size,
    exactCount: exact,
    mismatchCount: keys.size - exact,
    detail:
      "Aggregated by legacy ticket, employee, item, work date, and regular/overtime/double-time tier",
  };
}

const strictPassed = Object.values(gates).every(
  (gate) => gate.status === "exact",
);
const certificate = {
  schemaVersion: 1,
  runId: randomUUID(),
  generatedAt: new Date().toISOString(),
  gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  org: {
    id: orgId,
    name: target.org.name,
    environment: target.org.env_kind,
  },
  strictPassed,
  sourceArtifacts: Object.fromEntries(
    Object.entries(paths)
      .filter(([key]) => key !== "out")
      .map(([key, path]) => [key, { path, sha256: fileHash(path) }]),
  ),
  sourceAccountingBook:
    sourceAccountingBooks[0] ?? requestedSourceAccountingBook,
  gates,
  differences,
};

writeFileSync(paths.out, JSON.stringify(certificate, null, 2));
console.log(`organization: ${String(target.org.name)} (${String(target.org.env_kind)})`);
for (const [name, gate] of Object.entries(gates)) {
  console.log(
    `${gate.status === "exact" ? "PASS" : gate.status === "different" ? "FAIL" : "UNPROVEN"} ${name}: ` +
      `source=${gate.sourceCount ?? "?"} target=${gate.targetCount ?? "?"} exact=${gate.exactCount ?? "?"}` +
      (gate.detail ? ` — ${gate.detail}` : ""),
  );
}
console.log(`differences: ${differences.length}`);
console.log(`certificate: ${paths.out}`);

if (!strictPassed && !args.has("allow-differences")) process.exitCode = 1;
