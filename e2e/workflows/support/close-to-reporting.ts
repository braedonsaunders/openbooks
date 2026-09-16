/**
 * Shared seed + assertion helpers for the close-to-reporting E2E workflow.
 *
 * Strategy: deterministic DATA through the real product HTTP routes (the same
 * routes the UI calls — `page.request` with the authed session, `Origin`
 * header included because the API rejects browser calls without one), then
 * every workflow STATE asserted on real rendered pages. State transitions the
 * operator performs by hand (request approval, lock, publish, reopen request)
 * are driven both ways across the suite: the approval/lock/publish clicks go
 * through the UI, repetitive task completions and the second actor's steps go
 * through the same API routes those buttons call.
 *
 * The seeded ledger (all amounts exact decimals, single currency):
 *   sub A (root) / sub B (child) / primary book, period P (prior full month):
 *   - customer invoice sub A  12,000.00 revenue (4100), unpaid
 *   - customer invoice sub B   8,000.00 revenue (4000), unpaid
 *   - vendor bill sub A        5,000.00 expense (6100), unpaid
 *   - funding journal sub A   25,000.00 Dr cash (1000) / Cr capital (3000)
 *   - supplies journal sub B   1,500.00 Dr supplies (6300) / Cr cash
 *   - project revenue journal  5,000.00 Dr cash / Cr revenue (4100), project-tagged
 *   - project cost journal     2,000.00 Dr COGS (5000) / Cr cash, project-tagged
 *   - prior-period journal     6,000.00 Dr cash / Cr revenue (4100), in P-1
 *   - equipment 120,000.00 SL12 from P-01: 10,000.00 depreciation in P,
 *     posted to BOTH books by the product's depreciation run
 *   adjusting book, period P: only that 10,000.00 depreciation entry
 *   bank statement for cash (1000) covering P-1 + P, imported + matched +
 *   signed off, so the bank readiness gate is genuinely satisfied
 *
 * Consolidated primary-book period-P expectations:
 *   revenue 25,000.00 · expenses 18,500.00 · net 6,500.00 · AR 20,000.00 ·
 *   AP 5,000.00 · cash 32,500.00 · project margin 3,000.00
 * After the 750.00 freight-accrual adjusting entry: expenses 17,250.00,
 * net 5,750.00, accrued liabilities 750.00.
 */
import { expect, type APIRequestContext } from "@playwright/test";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { canonicalJson } from "../../../engine/src/canonical-json.ts";

export const ADMIN_EMAIL = process.env.E2E_EMAIL ?? "e2e@openbooks.test";
export const ADMIN_NAME = process.env.ADMIN_NAME ?? "E2E Admin";
export const ADMIN_PASSWORD = process.env.E2E_PASSWORD ?? "e2e-test-password-123";
export const APPROVER_EMAIL = process.env.E2E_APPROVER_EMAIL ?? "approver@openbooks.test";
export const APPROVER_PASSWORD = process.env.E2E_APPROVER_PASSWORD ?? "approver-test-password-123";

/** Prior full month (P) and the month before it (P-1) as ISO date ranges. */
export function targetPeriods(now = new Date()) {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const pEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const pStart = new Date(Date.UTC(pEnd.getUTCFullYear(), pEnd.getUTCMonth(), 1));
  const p1End = new Date(Date.UTC(pStart.getUTCFullYear(), pStart.getUTCMonth(), 0));
  const p1Start = new Date(Date.UTC(p1End.getUTCFullYear(), p1End.getUTCMonth(), 1));
  const name = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return {
    p: { from: iso(pStart), to: iso(pEnd), name: name(pStart) },
    p1: { from: iso(p1Start), to: iso(p1End), name: name(p1Start) },
  };
}

/** Exact seeded amounts (decimal strings, no floats anywhere). */
export const AMT = {
  invoiceA: "12000.00",
  invoiceB: "8000.00",
  billA: "5000.00",
  funding: "25000.00",
  supplies: "1500.00",
  projectRevenue: "5000.00",
  projectCost: "2000.00",
  priorRevenue: "6000.00",
  depreciation: "10000.00",
  adjusting: "750.00",
} as const;

/** Consolidated primary-book expectations for period P (pre-adjustment). */
export const EXPECT = {
  revenue: "25,000.00",
  expenses: "18,500.00",
  net: "6,500.00",
  ar: "20,000.00",
  ap: "5,000.00",
  cash: "32,500.00",
  projectRevenue: "5,000.00",
  projectCost: "2,000.00",
  projectMargin: "3,000.00",
  priorRevenue: "6,000.00",
  adjustingRevenue: "25,000.00",
  adjustingExpenses: "17,250.00",
  adjustingNet: "5,750.00",
  accrued: "750.00",
  adjustingBookExpense: "10,000.00",
  subANet: "0.00",
  subBNet: "6,500.00",
} as const;

export interface Seed {
  orgId: string;
  rootSubId: string;
  subBId: string;
  primaryBookId: string;
  adjustingBookId: string;
  periodId: string;
  priorPeriodId: string;
  customerAId: string;
  customerBId: string;
  vendorAId: string;
  projectId: string;
  assetId: string;
  runId: string;
  requestId: string;
  accounts: Record<string, string>;
}

/** POST/PUT/PATCH with the browser session; fails the test on transport errors. */
export async function api(
  request: APIRequestContext,
  baseURL: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) {
  const res = await request.fetch(`${baseURL}${path}`, {
    method,
    headers: { Origin: new URL(baseURL).origin, "Content-Type": "application/json" },
    data: body === undefined ? undefined : body,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON bodies surface in the assertion message below.
  }
  return { status: res.status(), json: json as Record<string, unknown> | null, text };
}

export function ok(
  res: { status: number; json: Record<string, unknown> | null; text: string },
  path: string,
  expected = 200,
) {
  expect(res.status, `${path}: ${res.text}`.slice(0, 500)).toBe(expected);
  return res.json ?? {};
}

/** Assert a UI-triggered API response is 200, quoting the body on failure. */
export async function expectOkResponse(
  res: { status(): number; text(): Promise<string> },
  label: string,
): Promise<string> {
  const text = await res.text();
  expect(res.status(), `${label}: ${text}`.slice(0, 500)).toBe(200);
  return text;
}

export function field(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  expect(typeof value, `${path}.${key}`).toBe("string");
  return value as string;
}

export async function revisionToken(
  request: APIRequestContext,
  baseURL: string,
  path: string,
  pick: (doc: Record<string, unknown>) => string,
) {
  const res = await api(request, baseURL, "GET", path);
  const body = ok(res, path);
  return pick(body as Record<string, unknown>);
}

/** Decode the product's PDF exports (hex TJ arrays in Flate streams) to text. */
export function extractPdfText(buffer: Buffer): string {
  const parts: string[] = [];
  const raw = buffer.toString("latin1");
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let data: Buffer;
    try {
      data = inflateSync(Buffer.from(match[1]!, "latin1"));
    } catch {
      continue;
    }
    const text = data.toString("latin1");
    for (const hex of text.matchAll(/<([0-9A-Fa-f]+)>/g)) {
      const h = hex[1]!;
      if (h.length % 2 === 0 && h.length >= 2) parts.push(Buffer.from(h, "hex").toString("latin1"));
    }
    for (const lit of text.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      parts.push(
        lit[0]!
          .slice(1, -1)
          .replace(/\\([nrtbf()\\])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[c] ?? c),
      );
    }
  }
  return parts.join("");
}

/** sha256 of the engine's canonical JSON (mirrors publishCloseRun's binder hash). */
export function binderHash(binder: unknown): string {
  return createHash("sha256").update(canonicalJson(binder), "utf8").digest("hex");
}

export { expect };

export interface SeedJournalLine {
  account: string;
  amount: string;
  description: string;
  projectId?: string;
}

/** Post one manual journal through draft -> PATCH -> post. Returns the document id. */
export async function postSeedJournal(
  request: APIRequestContext,
  baseURL: string,
  accounts: Record<string, string>,
  args: { subsidiaryId: string; documentDate: string; memo: string; lines: SeedJournalLine[] },
) {
  const draft = ok(await api(request, baseURL, "POST", "/api/journals/draft", { subsidiaryId: args.subsidiaryId }), "journal draft");
  const id = field(draft, "id", "journal draft");
  const token = await revisionToken(request, baseURL, `/api/journals/${id}`, (d) =>
    field(d.doc as Record<string, unknown>, "updated_at", "journal"));
  ok(
    await api(request, baseURL, "PATCH", `/api/journals/${id}`, {
      expectedUpdatedAt: token,
      documentDate: args.documentDate,
      memo: args.memo,
      lines: args.lines.map((l) => ({
        accountId: field(accounts, l.account, "journal line"),
        description: l.description,
        amount: l.amount,
        ...(l.projectId ? { projectId: l.projectId } : {}),
      })),
    }),
    `journal ${args.memo}`,
  );
  const posted = ok(
    await api(request, baseURL, "POST", "/api/journals/actions", { action: "post", documentId: id }),
    `journal post ${args.memo}`,
  );
  expect(posted.ok).toBe(true);
  return id;
}

/** Fill one drawer document (invoice/bill) through draft -> PATCH, without posting. */
export async function draftSeedDocument(
  request: APIRequestContext,
  baseURL: string,
  kind: string,
  patch: Record<string, unknown>,
) {
  const draft = ok(await api(request, baseURL, "POST", "/api/documents/draft", { kind }), `${kind} draft`);
  const id = field(draft, "id", `${kind} draft`);
  const token = await revisionToken(request, baseURL, `/api/documents/${id}`, (d) =>
    d.doc ? field(d.doc as Record<string, unknown>, "updated_at", kind) : field(d, "updated_at", kind));
  ok(
    await api(request, baseURL, "PATCH", `/api/documents/${id}`, { expectedUpdatedAt: token, ...patch }),
    `${kind} fill`,
  );
  return id;
}

/** Post one drawer document (invoice/bill) through draft -> PATCH -> post. */
export async function postSeedDocument(
  request: APIRequestContext,
  baseURL: string,
  kind: string,
  patch: Record<string, unknown>,
) {
  const id = await draftSeedDocument(request, baseURL, kind, patch);
  const posted = ok(
    await api(request, baseURL, "POST", "/api/documents/actions", { action: "post", documentId: id }),
    `${kind} post`,
  );
  expect(posted.ok).toBe(true);
  return id;
}
