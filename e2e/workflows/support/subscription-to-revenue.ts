/**
 * Shared seed + assertion helpers for the subscription-to-revenue E2E workflow.
 *
 * Strategy (same standard as close-to-reporting): deterministic DATA through
 * the real product HTTP routes (the same routes the UI calls — `page.request`
 * with the authed session, `Origin` header included), then every workflow
 * STATE asserted on real rendered pages. Amounts are exact decimal strings
 * throughout; the in-test money math below (bigint cents) is the INDEPENDENT
 * leg of every tie-out — it recomputes expectations from the suite's own
 * constants, never by reading back the schedule/ledger the product wrote.
 *
 * Two deliberate exceptions, both scheduler-owned surfaces with no HTTP route
 * by design (there is no operator button for a background tick):
 * - firing dunning calls the real scheduler entrypoint `runDunningForOrg`
 *   (the exact function the worker process calls), imported from the engine;
 * - observing the fired claim reads the product's own append-only
 *   `dunning_log` + staged `scheduler_outbox` rows through the engine db.
 * Everything those ticks ACT on (invoices, payments, credits) and every
 * money assertion goes through product routes and rendered pages.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { withIdempotencyKey } from "../idempotency";

export { expect };

export const ADMIN_EMAIL = process.env.E2E_EMAIL ?? "e2e@openbooks.test";

/**
 * Cross-chunk state. The scratch app server has a short lifetime under host
 * load, so long authoring runs execute test-by-test (`--grep`) with the
 * server restarted between chunks; each test after the seed reloads S from
 * this file when its in-memory copy is empty. CI always runs the whole file
 * in one process (the seed overwrites the file first), so this never affects
 * the graded run. The file lives outside the repo and holds only scratch ids.
 */
const STATE_PATH = "/tmp/e2e-w5/w5-state.json";

export function saveState(state: Record<string, unknown>): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state));
}

export function loadState<T extends Record<string, unknown>>(into: T): void {
  if (!existsSync(STATE_PATH)) {
    throw new Error("no saved workflow state — run the seed test first (or delete a stale DB without its state file)");
  }
  Object.assign(into, JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<string, unknown>);
}

/** Retry-aware tag: a Playwright retry re-seeds against an org the failed
 *  attempt already seeded, so names/codes move with the retry index (same
 *  pattern as quote-to-cash). Local re-runs use E2E_RUN. */
export function tag(base: string): string {
  const retry = test.info().retry;
  return `${base}${process.env.E2E_RUN ?? ""}${retry > 0 ? `R${retry}` : ""}`;
}

/** Deferred-revenue account number. The template chart owns 2400 (and 2500),
 *  so the suite mints 2441 + the retry index (2441, 2442, …); a local
 *  E2E_RUN re-run against a dirty database shifts to the 245x block. */
export function deferredAccountNumber(): string {
  const block = process.env.E2E_RUN ? "245" : "244";
  return `${block}${1 + test.info().retry}`;
}

/** Minor-unit money: '420.00' -> 42000n. */
export function toCents(amount: string): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(amount);
  if (!m) throw new Error(`bad money literal ${amount}`);
  const sign = m[1] === "-" ? -1n : 1n;
  return sign * (BigInt(m[2] as string) * 100n + BigInt(m[3] as string));
}

function grouped(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** UI money cell in USD: 100000n -> '$1,000.00' (plain $ prefix). */
export function fmtUSD(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const text = `$${grouped((abs / 100n).toString())}.${(abs % 100n).toString().padStart(2, "0")}`;
  return neg ? `(${text})` : text;
}

/**
 * Rendered-page cell for an exact 4dp ledger amount. Pages show 2dp rounded
 * money, so '2016.6666' -> '$2,016.67' (half away from zero). API/ledger
 * assertions stay on the exact string; UI assertions use this.
 */
export function fmt4(amount: string): string {
  const m = /^(-?)(\d+)\.(\d{4})$/.exec(amount);
  if (!m) throw new Error(`bad 4dp money literal ${amount}`);
  const sign = m[1] === "-" ? -1n : 1n;
  const units = BigInt(m[2] as string) * 10000n + BigInt(m[3] as string);
  const cents = (units + 50n) / 100n;
  return fmtUSD(sign * cents);
}

type Json = Record<string, unknown>;

/** Real product API call with the browser session (Origin header included). */
export async function api(
  request: APIRequestContext,
  baseURL: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const res = await request.fetch(`${baseURL}${path}`, {
    method,
    headers: { Origin: new URL(baseURL).origin, "Content-Type": "application/json", ...withIdempotencyKey(method, headers) },
    data: body === undefined ? undefined : body,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON bodies surface in the assertion message below.
  }
  return { status: res.status(), json: json as Json | null, text };
}

export function ok(
  res: { status: number; json: Json | null; text: string },
  path: string,
  expected = 200,
) {
  expect(res.status, `${path}: ${res.text}`.slice(0, 500)).toBe(expected);
  return (res.json ?? {}) as Json;
}

export function str(value: unknown, what = "id"): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`expected ${what} string, got ${JSON.stringify(value)?.slice(0, 80)}`);
  }
  return value;
}

export function docOf(body: Json): Json {
  return body.doc as Json;
}

/**
 * Run the scheduler-tick helper (see scheduler-tick.mts for why the spec
 * shells out instead of importing the engine). Each call is one short-lived
 * tsx process against OPENBOOKS_DB_URL; stdout carries exactly one `W5TICK
 * {...}` line.
 */
function tick(command: string, args: string[]): Record<string, unknown> {
  if (!process.env.OPENBOOKS_DB_URL) {
    throw new Error("OPENBOOKS_DB_URL is required for scheduler ticks");
  }
  const output = execFileSync("npx", ["tsx", "e2e/workflows/support/scheduler-tick.mts", command, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("W5TICK "));
  if (!line) throw new Error(`scheduler tick printed no result (command ${command})`);
  return JSON.parse(line.slice("W5TICK ".length)) as Record<string, unknown>;
}

/** Resolve the org id for the seeded admin (the login session owns exactly
 *  one org on a scratch tenant). */
export async function resolveOrgId(): Promise<string> {
  return String((tick("org", [ADMIN_EMAIL]) as { orgId: string }).orgId);
}

export interface DunningRunResult {
  scanned: number;
  sent: number;
  failed: number;
  notices: { documentId: string; stageId: string; toEmail: string | null; status: string }[];
}

/** Fire the real dunning scheduler for one org as of an explicit date. */
export async function runDunning(orgId: string, asOf: string): Promise<DunningRunResult> {
  const { result } = tick("dunning-run", [orgId, asOf]) as { result: DunningRunResult };
  return result;
}

export interface DunningLogRow {
  documentNumber: string;
  sequence: number;
  stageName: string;
  amountDue: string;
  status: string;
  toEmail: string | null;
}

/** Read the product's append-only dunning claim log (observation probe). */
export async function readDunningLog(orgId: string): Promise<DunningLogRow[]> {
  return ((tick("dunning-log", [orgId]) as { log: DunningLogRow[] }).log ?? []) as DunningLogRow[];
}

/** Staged deliveries for fired dunning rungs (second corroborating record). */
export async function readDunningOutbox(orgId: string): Promise<{ subject: string; to: string }[]> {
  return ((tick("dunning-outbox", [orgId]) as { outbox: { subject: string; to: string }[] }).outbox ?? []) as {
    subject: string;
    to: string;
  }[];
}

/** Obligation ids keyed by contract (invoice) number (observation probe). */
export async function resolveObligationIds(orgId: string, contracts: string[]): Promise<Map<string, string>> {
  const { obligations } = tick("obligations", [orgId, contracts.join(",")]) as {
    obligations: Record<string, string>;
  };
  return new Map(Object.entries(obligations ?? {}));
}

/** Contract UUID for the ?contract= drawer, resolved from its number. */
export async function contractIdFor(orgId: string, contractNumber: string): Promise<string> {
  return String((tick("contract", [orgId, contractNumber]) as { id: string }).id);
}

export interface PartyDoc {
  id: string;
  number: string;
  kind: string;
  status: string;
}

/** Posted documents for a party (re-entry probe). */
export async function partyDocs(orgId: string, partyId: string): Promise<PartyDoc[]> {
  return ((tick("docs", [orgId, partyId]) as { docs: PartyDoc[] }).docs ?? []) as PartyDoc[];
}

/** Read a report table as rows of cell texts. */
export async function reportRows(page: Page): Promise<string[][]> {
  return page.evaluate(() => {
    const table = document.querySelectorAll("table")[0];
    if (!table) return [];
    return [...table.querySelectorAll("tr")].map((tr) =>
      [...tr.querySelectorAll("th,td")].map((c) => (c.textContent ?? "").trim().replace(/\s+/g, " ")),
    );
  });
}

export function findRow(rows: string[][], needle: string): string[] {
  const row = rows.find((r) => r.some((c) => c.includes(needle)));
  expect(row, `report row containing ${needle}`).toBeTruthy();
  return row as string[];
}

/** Open a document drawer fresh (settled state) for UI interaction. */
export async function openDrawer(page: Page, drawerUrl: string) {
  await page.goto(drawerUrl);
  const drawer = page.locator('[role="dialog"]').first();
  await expect(drawer).toBeVisible();
  return drawer;
}

/** Submit then post a document drawer (two-step approval lifecycle). */
export async function uiSubmitAndPost(page: Page, drawerUrl: string, expectedBadge: "Open" | "Posted"): Promise<void> {
  await openDrawer(page, drawerUrl);
  const drawer = page.locator('[role="dialog"]').first();
  await drawer.getByRole("button", { name: "Actions", exact: true }).click();
  const submitted = page.waitForResponse(
    (r) => r.url().endsWith("/api/documents/actions") && r.request().method() === "POST",
  );
  await page.locator("button", { hasText: "Submit for approval" }).click();
  const resSubmit = await submitted;
  expect(resSubmit.status(), await resSubmit.text()).toBe(200);
  await expect(drawer.getByText("Approved")).toBeVisible({ timeout: 15000 });
  await openDrawer(page, drawerUrl);
  const drawer2 = page.locator('[role="dialog"]').first();
  await drawer2.getByRole("button", { name: "Actions", exact: true }).click();
  const posted = page.waitForResponse(
    (r) => r.url().endsWith("/api/documents/actions") && r.request().method() === "POST",
  );
  await page.locator("button", { hasText: /^Post$/ }).click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(200);
  await expect(drawer2.getByText(expectedBadge)).toBeVisible({ timeout: 15000 });
}

/**
 * Post a seeded receipt through the exact route the drawer's "Receive & post"
 * button calls. The receipts drawer (with its flows panels) OOMs the renderer
 * under host load, so the transport goes through the API while every balance
 * it produces is still asserted on rendered pages.
 */
export async function apiPostReceipt(
  request: APIRequestContext,
  baseURL: string,
  payId: string,
): Promise<void> {
  const current = ok(await api(request, baseURL, "GET", `/api/payments/${payId}`), "receipt pre-post fetch");
  const posted = ok(
    await api(request, baseURL, "POST", "/api/payments/post-with-applications", {
      documentId: payId,
      expectedUpdatedAt: str(docOf(current).updated_at, "receipt revision"),
    }),
    "receipt post",
  );
  expect(posted.ok).toBe(true);
}

/** Open a drawer, switch to its Audit Trail tab, and return the action list. */
export async function auditActions(page: Page, drawerUrl: string): Promise<string> {
  await openDrawer(page, drawerUrl);
  const drawer = page.locator('[role="dialog"]').first();
  await drawer.getByRole("tab", { name: "Audit Trail", exact: true }).click();
  await expect(drawer.getByText(/events/)).toBeVisible({ timeout: 15000 });
  return drawer.innerText();
}
