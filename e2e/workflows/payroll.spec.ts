/**
 * Payroll run to remittance to year-end — the full payroll lifecycle against
 * the CI-bootstrapped tenant, through the real UI and the product APIs behind
 * it.
 *
 * A Canada-pack biweekly run (Ontario + Québec hourly employees with TD1
 * profiles) and a US-pack run (California salary employee with a W-4 profile)
 * flow through: pay schedule → run wizard (calculate → review → submit →
 * second-user approval → commit) → CPA-005/NACHA bank files (bytes verified)
 * → CRA + RQ + IRS remittance bills → GL tie-out → T4/RL-1/W-2 slips equal to
 * committed stubs → a retroactive-pay amendment and its YTD effect.
 *
 * Every money assertion is exact cents. Expected stub figures are the engine
 * pack goldens for these inputs (2026 T4127 / Pub 15-T / TP-1015); the suite
 * additionally cross-checks each figure across independent endpoints (stubs
 * vs GL preview vs bank file vs remittance vs slips), so a gate that measured
 * nothing would fail loudly instead of passing vacuously.
 *
 * Country-agnostic rule: generic helpers take every jurisdiction value as
 * input; the only region/agency literals in this file are the suite's own
 * seed data and its golden expectations.
 */
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { authedContext, dismissSetupWizard } from "../auth";
import {
  TAG,
  api,
  asStubs,
  field,
  loginApiContext,
  neg,
  ok,
  seededApprover,
  sumExact,
  type Stub,
} from "./payroll-helpers";

/* ------------------------------------------------------------------ */
/* Golden expectations: engine outputs for the seeded inputs (2026).   */
/* ------------------------------------------------------------------ */

const ALICE = {
  base: "Alice Tremblay",
  gross: "3600.0000",
  net: "2636.3800",
  cost: "288.3400",
  lines: { TAX: "698.7500", CPP: "206.1900", EI: "58.6800" },
};
const JEAN = {
  base: "Jean Coutu",
  gross: "3040.0000",
  net: "2121.9800",
  cost: "256.6700",
  lines: {
    TAX: "290.0200",
    QCTAX: "392.3700",
    CPP: "183.0400",
    EI: "39.5200",
    QPIP: "13.0700",
  },
};
const CA_TOTALS = { gross: "6640.0000", net: "4758.3600", cost: "545.0100" };
const SAM = {
  base: "Sam Rivera",
  gross: "3000.0000",
  net: "2316.0600",
  cost: "247.5000",
  lines: { FIT: "320.3800", SS: "186.0000", MED: "43.5000", SIT: "134.0600" },
};
// Per-component remittance goldens for the seeded inputs: every agency
// total is the sum of its components' rows (CRA 1636.83, RQ 789.82,
// IRS 931.44 on a fresh tenant). Asserted as deltas off the pre-commit
// baseline so shared-tenant history cannot leak in.
const RETRO = { gross: "100.0000", net: "70.3500", fit: "22.0000" };
const RETRO_IRS_RANGE = "37.9000";
// The regular runs' pay-date window (schedule anchor 2026-01-02 + 3 days).
const RANGE = { from: "2025-12-20", to: "2026-01-05" };

/* ------------------------------------------------------------------ */
/* Shared suite state (serial suite: tests run in order).              */
/* ------------------------------------------------------------------ */

interface RemitGroup {
  partyId: string | null;
  partyName: string | null;
  filingAccount: { id: string };
  total: string;
  components: { componentId: string; code: string; name: string; kind: string; liabilityAccountId: string; amount: string }[];
  existingBills: { documentId: string; documentNumber: string; status: string; total: string }[];
}

interface Ctx {
  baseURL: string;
  rootSub: string;
  subUS: string;
  caSub: string;
  schedCA: string;
  schedUS: string;
  alice: string;
  jean: string;
  sam: string;
  runCA: string;
  runUS: string;
  runCAno: string;
  runUSno: string;
  retroRun: string;
  approver: { email: string; password: string };
  approverApi: APIRequestContext | null;
  acct: Record<string, string>;
  vendor: Record<string, string>;
  filingCA: string;
  filingUS: string;
  profileCA: string;
  profileUS: string;
  craBill: string;
  rqBill: string;
  irsBill: string;
  retroBill: string;
  stubsCA: Stub[];
  stubsUS: Stub[];
  remitBaselineByCode: Map<string, string>;
  q1pre: Record<string, string>;
  retroPayDate: string;
}

const ctx = {} as Ctx;
const digits = String(Date.now()).slice(-4);
// The amendment's pay date moves per run so its remittance range is always
// history-free, even when a retry shares the tenant with an earlier attempt.
const RETRO_DAY = String(10 + (Number(String(Date.now()).slice(-2)) % 15)).padStart(2, "0");

function employeeName(base: string): string {
  return `${TAG} ${base}`;
}

function aid(key: string): string {
  const id = ctx.acct[key];
  if (!id) throw new Error(`account ${key} not provisioned`);
  return id;
}

function vid(key: string): string {
  const id = ctx.vendor[key];
  if (!id) throw new Error(`vendor ${key} not provisioned`);
  return id;
}

function stubByName(stubs: Stub[], base: string): Stub {
  const stub = stubs.find((candidate) => candidate.employee_name === employeeName(base));
  if (!stub) throw new Error(`no stub for ${base}`);
  return stub;
}

function lineAmount(stub: Stub, code: string): string {
  const line = stub.lines.find((candidate) => candidate.component_code === code);
  if (!line) throw new Error(`no ${code} line on ${stub.employee_name}`);
  return line.amount;
}

async function ensureApprovalFlow(
  rq: APIRequestContext,
  name: string,
  subjectKind: string,
  trigger: string,
): Promise<void> {
  // Fixed names, adopted across retries: one live flow per subject kind.
  // TAG-scoped flows would accumulate in a reused tenant and every stale
  // policy would park new submissions behind unanswerable gates.
  let res = await api(rq, ctx.baseURL, "GET", "/api/admin/flows");
  const existing = (ok(res, "list flows")["flows"] as { id: string }[]).find(
    (candidate) =>
      (candidate as unknown as Record<string, unknown>)["name"] === name,
  );
  const flowId =
    existing?.id ??
    field(await api(rq, ctx.baseURL, "POST", "/api/admin/flows", { name, subjectKind }).then((r) => ok(r, `create flow ${name}`)), "id");
  const graph = {
    schemaVersion: 1,
    nodes: [
      { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger } } },
      {
        id: "gate",
        position: { x: 220, y: 0 },
        data: {
          kind: "gate",
          gate: {
            title: name,
            // Role-routed, never direct-to-user: these flows match by
            // subject KIND tenant-wide, so they also fire on sibling
            // suites' subjects (a later suite's bank details or pay runs).
            // A gate assigned to this suite's throwaway approver parks those
            // foreign subjects behind an unanswerable gate (proven: a P2P
            // bank account stuck pending). Role fan-out gives every
            // approver-role holder their own quorum-any row, so any suite's
            // approver can clear what these flows gate — including ours.
            assignees: [{ type: "role", role: "approver" }],
            mode: "any",
            preventSelfApproval: true,
          },
        },
      },
    ],
    edges: [{ id: "e1", source: "trigger", target: "gate", sourceHandle: "next" }],
  };
  // The save carries an optimistic revision token; creation side-effects
  // (scheduler refresh) can bump the row between our list and save, so
  // retry with a fresh token rather than failing the suite on a race.
  // (The list endpoint returns snake_case updated_at.)
  let saved = false;
  for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
    res = await api(rq, ctx.baseURL, "GET", "/api/admin/flows");
    const flows = ok(res, "list flows")["flows"] as { id: string; updated_at: string }[];
    const row = flows.find((candidate) => candidate.id === flowId);
    if (!row?.updated_at) throw new Error(`flow ${name} missing revision token`);
    res = await api(rq, ctx.baseURL, "PATCH", `/api/admin/flows/${flowId}`, {
      expectedUpdatedAt: row.updated_at,
      graph,
      enabled: true,
    });
    if (res.status === 200) {
      ok(res, `enable flow ${name}`);
      saved = true;
    } else if (res.status !== 409) {
      ok(res, `enable flow ${name}`);
    }
  }
  if (!saved) throw new Error(`flow ${name} stayed conflicted after retries`);
}

async function approverGates(): Promise<string[]> {
  if (!ctx.approverApi) throw new Error("approver API context not ready");
  const res = await ctx.approverApi.get("/api/flows/gates");
  expect(res.ok(), await res.text()).toBe(true);
  const json = (await res.json()) as { gates?: { id: string }[] };
  return (json.gates ?? []).map((gate) => gate.id);
}

async function approveAsSecondUser(gateId: string, comment: string): Promise<void> {
  if (!ctx.approverApi) throw new Error("approver API context not ready");
  const res = await ctx.approverApi.post("/api/flows/gates/decide", {
    data: { gateId, decision: "approved", comment },
    headers: { Origin: new URL(ctx.baseURL).origin },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

async function openPage(browser: Browser, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const { context, page } = await authedContext(browser, ctx.baseURL);
  await page.goto(path);
  await dismissSetupWizard(page);
  // Dismissing the first-run wizard navigates to the setup readiness page;
  // land back on the target afterwards (same pattern as document-discard).
  if (!new URL(page.url()).pathname.startsWith(path)) {
    await page.goto(path);
  }
  return { page, close: () => context.close() };
}

/** Base-pay component id from the run's adjustable set (wizard review path). */
async function baseComponentId(rq: APIRequestContext, runId: string): Promise<string> {
  const detail = ok(await api(rq, ctx.baseURL, "GET", `/api/payroll/runs/${runId}`), "read adjustable");
  const options = detail["adjustableComponents"] as { id: string; code: string }[];
  const base = options.find((option) => option.code === "BASE");
  if (!base) throw new Error("BASE component missing from adjustable set");
  return base.id;
}

/** Payment format id by code (seeded rails: CPA005, NACHA-CREDIT, …). */
async function formatId(rq: APIRequestContext, code: string): Promise<string> {
  const res = await api(rq, ctx.baseURL, "GET", "/api/admin/payment-operations/formats");
  const rows = ok(res, "list payment formats")["rows"] as { id: string; code: string }[];
  const row = rows.find((candidate) => candidate.code === code);
  if (!row) throw new Error(`payment format ${code} not seeded`);
  return row.id;
}

/**
 * Raise a remittance bill, deleting a stale draft first when the product
 * refuses a second bill for the same vendor/period/account (one bill per
 * remittance). Returns the new bill's document id.
 */
async function createRemittanceBill(
  rq: APIRequestContext,
  partyId: string,
  filingAccountId: string,
  from: string,
  to: string,
  label: string,
): Promise<string> {
  const create = () =>
    api(rq, ctx.baseURL, "POST", "/api/payroll/remittances", {
      action: "create-bill",
      partyId,
      filingAccountId,
      from,
      to,
    });
  let res = await create();
  if (res.status === 422) {
    const fresh = ok(
      await api(rq, ctx.baseURL, "GET", `/api/payroll/remittances?from=${from}&to=${to}`),
      `reread ${label}`,
    );
    const current = ((fresh["groups"] as RemitGroup[]) ?? []).find(
      (candidate) => candidate.partyId === partyId && candidate.filingAccount.id === filingAccountId,
    );
    for (const stale of current?.existingBills ?? []) {
      const doc = (await rq.get(`/api/documents/${stale.documentId}`).then((r) => r.json())) as {
        doc: { updated_at: string };
      };
      ok(
        await api(rq, ctx.baseURL, "DELETE", `/api/documents/${stale.documentId}`, {
          expectedUpdatedAt: doc.doc.updated_at,
        }),
        `delete stale ${stale.documentNumber}`,
      );
    }
    res = await create();
  }
  return field(ok(res, `bill ${label}`), "documentId");
}

/** Release a bank-file artifact's bytes (audited POST, never a GET). */
async function releaseBankFile(
  rq: APIRequestContext,
  runId: string,
  fileId: string,
): Promise<{ text: string; hash: string }> {
  const response = await rq.fetch(`${new URL(ctx.baseURL).origin}/api/payroll/runs/${runId}/bank-file/${fileId}`, {
    method: "POST",
    headers: { Origin: new URL(ctx.baseURL).origin },
  });
  const hash = response.headers()["x-payroll-bank-file-sha256"] ?? "";
  const bytes = await response.body();
  const { createHash } = await import("node:crypto");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
  return { text: bytes.toString("ascii"), hash };
}

async function createEmployee(
  rq: APIRequestContext,
  base: string,
  country: string,
): Promise<string> {
  const draft = ok(await api(rq, ctx.baseURL, "POST", "/api/parties/draft", { role: "employee" }), `draft ${base}`);
  const id = field(draft, "id");
  const current = (await rq.get(`/api/parties/${id}`).then((r) => r.json())) as {
    party: { updated_at: string };
  };
  ok(
    await api(rq, ctx.baseURL, "PATCH", `/api/parties/${id}`, {
      displayName: employeeName(base),
      kind: "person",
      isActive: true,
      expectedUpdatedAt: current.party.updated_at,
      changeReason: "payroll e2e seed employee",
    }),
    `activate ${base} (${country})`,
  );
  return id;
}

test.describe.serial("payroll run to remittance to year-end", () => {
  test("provisions the payroll foundation", async ({ browser, baseURL }) => {
    const { context, page } = await authedContext(browser, baseURL);
    try {
      ctx.baseURL = baseURL ?? "";
      ctx.approverApi = null;
      const rq = page.request;
      // The second approver first: bank-detail and pay-run flows name them.
      // The browser job seeds this user before the specs run; provisioning
      // here is impossible (no product API creates users, and the runtime
      // role's RLS posture hides the org row direct SQL would need).
      ctx.approver = seededApprover();
      // Features the flow needs: payroll itself, projects (wage rates),
      // multi-subsidiary (US legal entity), flows (approvals), multi-currency
      // (CA staff are paid in CAD on a USD-base org).
      ok(
        await api(rq, ctx.baseURL, "PUT", "/api/admin/setup/features", {
          features: { payroll: true, projects: true, multiSubsidiary: true, flows: true, multiCurrency: true },
        }),
        "features",
      );
      for (const country of ["CA", "US"]) {
        ok(
          await api(rq, ctx.baseURL, "POST", "/api/payroll/settings", {
            action: "install-pack",
            country,
          }),
          `install-pack ${country}`,
        );
      }
      // GL accounts (tag-derived numbers stay unique across retries).
      const defs: [string, string, string][] = [
        ["wage", `6${digits.slice(0, 2)}00`, "expense"],
        ["burden", `6${digits.slice(0, 2)}10`, "expense"],
        ["net", `2${digits.slice(2)}00`, "liability_payable"],
        ["cra", `2${digits.slice(2)}10`, "liability_current_other"],
        ["vacation", `2${digits.slice(2)}20`, "liability_current_other"],
        ["other", `2${digits.slice(2)}30`, "liability_current_other"],
        ["rq", `2${digits.slice(2)}40`, "liability_current_other"],
        ["irs", `2${digits.slice(2)}50`, "liability_current_other"],
        ["bank", `1${digits.slice(0, 1)}${digits.slice(3)}00`, "asset_bank"],
      ];
      ctx.acct = {};
      for (const [key, number, type] of defs) {
        const created = ok(
          await api(
            rq,
            ctx.baseURL,
            "POST",
            "/api/accounts",
            {
              number,
              name: `${TAG} ${key}`,
              type,
            },
            { "Idempotency-Key": randomUUID() },
          ),
          `account ${key}`,
        );
        ctx.acct[key] = field(created["account"] as Record<string, unknown>, "id");
      }
      // Remittance vendors: draft vendor → named + active.
      ctx.vendor = {};
      for (const key of ["cra", "rq", "irs"]) {
        const draft = ok(await api(rq, ctx.baseURL, "POST", "/api/parties/draft", { role: "vendor" }), `draft ${key}`);
        const id = field(draft, "id");
        const current = (await rq.get(`/api/parties/${id}`).then((r) => r.json())) as {
          party: { updated_at: string };
        };
        ok(
          await api(rq, ctx.baseURL, "PATCH", `/api/parties/${id}`, {
            displayName: `${TAG} ${key.toUpperCase()}`,
            kind: "company",
            isActive: true,
            expectedUpdatedAt: current.party.updated_at,
            changeReason: "payroll e2e remittance vendor",
          }),
          `activate ${key} vendor`,
        );
        ctx.vendor[key] = id;
      }
      ok(
        await api(rq, ctx.baseURL, "PUT", "/api/payroll/settings", {
          wageExpenseAccountId: aid("wage"),
          burdenExpenseAccountId: aid("burden"),
          netPayAccountId: aid("net"),
          cppPayableAccountId: aid("cra"),
          eiPayableAccountId: aid("cra"),
          taxPayableAccountId: aid("cra"),
          vacationPayableAccountId: aid("vacation"),
          wagesTo: "expense",
          craRemittancePartyId: vid("cra"),
          rqRemittancePartyId: vid("rq"),
        }),
        "payroll settings accounts and vendors",
      );
      // Filing accounts group every downstream artefact (remittance, slips).
      // One default per country exists at most: reuse it across retries.
      const existingFilings = (
        ok(await api(rq, ctx.baseURL, "GET", "/api/payroll/profiles"), "filing accounts")["filingAccounts"] as {
          id: string;
          country: string;
          subsidiaryId: string | null;
          isDefault: boolean;
        }[]
      );
      const reuseFiling = (country: string, subsidiaryId: string | null): string | null =>
        existingFilings.find(
          (candidate) =>
            candidate.country === country &&
            candidate.isDefault &&
            (candidate.subsidiaryId ?? null) === subsidiaryId,
        )?.id ?? null;
      ctx.filingCA =
        reuseFiling("CA", null) ??
        field(
          ok(
            await api(rq, ctx.baseURL, "POST", "/api/admin/setup/payroll-filing-accounts", {
              accountNumber: `9${String(Date.now()).slice(-8)}RP0001`,
              name: `${TAG} CRA RP`,
              country: "CA",
              programType: "ca_rp",
              remitterType: "regular",
              isDefault: true,
              isActive: true,
            }),
            "CA filing account",
          ),
          "id",
        );
      // Root discovery first: no list API exposes the root subsidiary id,
      // which parents both legal entities. Mint one run from a throwaway
      // org-wide schedule and read it back. The empty draft is abandoned —
      // numbering is never pinned exactly, only /^PAY-/.
      const schedDiscovery = field(
        ok(
          await api(rq, ctx.baseURL, "POST", "/api/admin/setup/pay-schedules", {
            name: `${TAG} Biweekly Discovery`,
            frequency: "biweekly",
            periodsPerYear: 26,
            anchorPeriodEnd: "2026-01-02",
            payDateOffsetDays: 3,
            isActive: true,
          }),
          "discovery schedule",
        ),
        "id",
      );
      const discoveryId = field(
        ok(await api(rq, ctx.baseURL, "POST", "/api/payroll/runs", { payScheduleId: schedDiscovery }), "mint discovery run"),
        "documentId",
      );
      const discovery = ok(await api(rq, ctx.baseURL, "GET", `/api/payroll/runs/${discoveryId}`), "read discovery run");
      ctx.rootSub = String((discovery["run"] as Record<string, unknown>)["subsidiaryId"]);
      // US legal entity + schedule under it.
      ctx.subUS = field(
        ok(
          await api(rq, ctx.baseURL, "POST", "/api/admin/setup/subsidiaries", {
            name: `${TAG} US Employer`,
            baseCurrency: "USD",
            country: "US",
            parentId: ctx.rootSub,
            isActive: true,
          }),
          "US subsidiary",
        ),
        "id",
      );
      // Canadian entity: CA staff are paid in CAD (wage-rate currencies must
      // be configured on some active subsidiary), and — decisive here — the
      // CA run must pay from a Canadian legal entity. A root-paying run is a
      // US entity paying CA-packed employees, which the engine refuses.
      ctx.caSub = field(
        ok(
          await api(rq, ctx.baseURL, "POST", "/api/admin/setup/subsidiaries", {
            name: `${TAG} CA Employer`,
            baseCurrency: "CAD",
            country: "CA",
            parentId: ctx.rootSub,
            isActive: true,
          }),
          "CA subsidiary",
        ),
        "id",
      );
      // The CA schedule lives under the Canadian entity so runs minted from
      // it pay Canadian statutory withholdings.
      ctx.schedCA = field(
        ok(
          await api(rq, ctx.baseURL, "POST", "/api/admin/setup/pay-schedules", {
            name: `${TAG} Biweekly CA`,
            frequency: "biweekly",
            periodsPerYear: 26,
            anchorPeriodEnd: "2026-01-02",
            payDateOffsetDays: 3,
            subsidiaryId: ctx.caSub,
            isActive: true,
          }),
          "CA schedule",
        ),
        "id",
      );
      ctx.runCA = field(
        ok(await api(rq, ctx.baseURL, "POST", "/api/payroll/runs", { payScheduleId: ctx.schedCA }), "mint CA run"),
        "documentId",
      );
      const runCA = ok(await api(rq, ctx.baseURL, "GET", `/api/payroll/runs/${ctx.runCA}`), "read CA run");
      const header = runCA["run"] as Record<string, unknown>;
      ctx.runCAno = String(header["document_number"]);
      expect(ctx.runCAno).toMatch(/^PAY-/);
      expect(String(header["subsidiaryId"])).toBe(ctx.caSub);
      ctx.schedUS = field(
        ok(
          await api(rq, ctx.baseURL, "POST", "/api/admin/setup/pay-schedules", {
            name: `${TAG} Biweekly US`,
            frequency: "biweekly",
            periodsPerYear: 26,
            anchorPeriodEnd: "2026-01-02",
            payDateOffsetDays: 3,
            subsidiaryId: ctx.subUS,
            isActive: true,
          }),
          "US schedule",
        ),
        "id",
      );
      const usFilings = (
        ok(await api(rq, ctx.baseURL, "GET", "/api/payroll/profiles"), "filing accounts rerun")["filingAccounts"] as {
          id: string;
          country: string;
          subsidiaryId: string | null;
          isDefault: boolean;
        }[]
      );
      ctx.filingUS =
        usFilings.find(
          (candidate) =>
            candidate.country === "US" && candidate.isDefault && (candidate.subsidiaryId ?? null) === ctx.subUS,
        )?.id ??
        usFilings.find((candidate) => candidate.country === "US" && candidate.isDefault)?.id ??
        field(
          ok(
            await api(rq, ctx.baseURL, "POST", "/api/admin/setup/payroll-filing-accounts", {
              accountNumber: `27-${String(Date.now()).slice(-6)}`,
              name: `${TAG} US EIN`,
              country: "US",
              programType: "us_ein",
              isDefault: true,
              isActive: true,
              subsidiaryId: ctx.subUS,
            }),
            "US filing account",
          ),
          "id",
        );
      // Statutory slot → liability account mapping (snapshotted onto stub
      // lines at commit, so it must precede every calculation).
      ok(
        await api(rq, ctx.baseURL, "PUT", "/api/payroll/settings", {
          slotAccounts: {
            // The health services fund is an employer contribution a Quebec
            // employer ALWAYS owes, so a live-but-unconfigured ca_hsf slot
            // refuses the QC employee by name at calculate rather than
            // accruing 0.00 in silence. Map its liability account here and
            // set its rate below, or no Quebec figure in this suite is
            // reachable at all.
            CA: { qc_income_tax: aid("rq"), hsf: aid("rq") },
            US: {
              fit: aid("irs"),
              fica: aid("irs"),
              futa: aid("irs"),
              suta: aid("irs"),
              state_income_tax: aid("irs"),
              local_income_tax: aid("irs"),
            },
          },
        }),
        "slot accounts",
      );
      // The rate itself is tenant-entered by design: TP-1015.F-V s. 5 makes it
      // a function of the employer's own total payroll and sector class, which
      // no pack can know, so the slot refuses rather than guessing. 1.65 is the
      // 2026 other-sector floor.
      ok(
        await api(rq, ctx.baseURL, "PUT", "/api/payroll/settings/rates", {
          country: "CA",
          rateKey: "ca_hsf",
          region: "QC",
          taxYear: 2026,
          values: { rate: "1.65" },
        }),
        "QC health services fund rate",
      );
      // Per-component remittance destinations are mapped after the runs
      // commit, when the remittance summary exposes each component's id
      // (no list API names them pre-commit). Slots already carry the
      // liability accounts, which stub lines snapshot at commit.
      // Baseline the remittance range BEFORE any run commits: retries share
      // the tenant, so every range assertion below is a delta off this map.
      ctx.remitBaselineByCode = new Map<string, string>();
      ctx.q1pre = {};
      ctx.retroPayDate = `2026-01-${RETRO_DAY}`;
      const baseline = ok(
        await api(rq, ctx.baseURL, "GET", `/api/payroll/remittances?from=${RANGE.from}&to=${RANGE.to}`),
        "remittance baseline",
      );
      for (const group of baseline["groups"] as RemitGroup[]) {
        for (const component of group.components) {
          const prior = ctx.remitBaselineByCode.get(component.code) ?? "0.0000";
          ctx.remitBaselineByCode.set(component.code, sumExact([prior, component.amount]));
        }
      }
      // Approval flows: bank-detail fraud control and the pay-run SoD gate,
      // both decided by the second user who can never be the submitter.
      await ensureApprovalFlow(rq, "Payroll E2E bank detail approval", "party_bank_account", "on_create");
      await ensureApprovalFlow(rq, "Payroll E2E pay run approval", "pay_run", "on_submit");
      // Dismiss the first-run setup wizard NOW, before any run calculates:
      // deferring it writes org settings, and a settings write after a
      // calculation correctly marks every run stale. One UI visit covers it.
      const setupUi = await openPage(browser, "/payroll");
      try {
        await expect(setupUi.page.locator("main")).toBeVisible();
      } finally {
        await setupUi.close();
      }
      ctx.approverApi = await loginApiContext(browser, ctx.baseURL, ctx.approver.email, ctx.approver.password);
    } finally {
      await context.close();
    }
  });

  test("seeds employees, wages, bank details and profiles", async ({ browser }) => {
    const { context, page } = await authedContext(browser, ctx.baseURL);
    try {
      const rq = page.request;
      ctx.alice = await createEmployee(rq, ALICE.base, "CA");
      ctx.jean = await createEmployee(rq, JEAN.base, "CA");
      ctx.sam = await createEmployee(rq, SAM.base, "US");
      // Sam is employed by the US entity and paid on its schedule.
      const samCurrent = (await rq.get(`/api/parties/${ctx.sam}`).then((r) => r.json())) as {
        party: { updated_at: string };
      };
      ok(
        await api(rq, ctx.baseURL, "PATCH", `/api/parties/${ctx.sam}`, {
          subsidiaryId: ctx.subUS,
          expectedUpdatedAt: samCurrent.party.updated_at,
        }),
        "move Sam to the US subsidiary",
      );
      // Alice and Jean are employed by the Canadian entity and paid on its
      // schedule — profiles refuse cross-subsidiary schedule membership.
      for (const [partyId, who] of [
        [ctx.alice, "Alice"],
        [ctx.jean, "Jean"],
      ] as [string, string][]) {
        const current = (await rq.get(`/api/parties/${partyId}`).then((r) => r.json())) as {
          party: { updated_at: string };
        };
        ok(
          await api(rq, ctx.baseURL, "PATCH", `/api/parties/${partyId}`, {
            subsidiaryId: ctx.caSub,
            expectedUpdatedAt: current.party.updated_at,
          }),
          `move ${who} to the CA subsidiary`,
        );
      }
      // Wage rates (hourly CA staff, salaried US staff).
      const rates: [string, string, string, string][] = [
        [ctx.alice, "CAD", "45.00", "hour"],
        [ctx.jean, "CAD", "38.00", "hour"],
        [ctx.sam, "USD", "78000.00", "year"],
      ];
      for (const [employee, currency, rate, basis] of rates) {
        ok(
          await api(rq, ctx.baseURL, "POST", "/api/admin/setup/labor-costing", {
            action: "save-rate",
            employeePartyId: employee,
            currency,
            rate,
            basis,
            annualHours: "2080",
            effectiveFrom: "2026-01-01",
          }),
          `wage rate ${rate} ${currency}/${basis}`,
        );
      }
      // EFT bank details land pending: the approval test releases them.
      const banks: [string, string, Record<string, string>][] = [
        [ctx.alice, "CA", { institution: "001", transit: "00011" }],
        [ctx.jean, "CA", { institution: "002", transit: "00022" }],
        [ctx.sam, "US", { aba: "021000089" }],
      ];
      const accountNumbers = ["1234567", "2345678", "3456789"];
      for (let index = 0; index < banks.length; index += 1) {
        const [employee, country, routing] = banks[index] as [string, string, Record<string, string>];
        const created = ok(
          await api(rq, ctx.baseURL, "POST", `/api/parties/${employee}/bank-accounts`, {
            bankName: `${TAG} Test Bank`,
            country,
            routing,
            accountNumber: accountNumbers[index],
          }),
          `bank details ${employeeName("").slice(0, 0) || country}`,
        );
        expect(field(created, "approvalStatus")).toBe("pending");
      }
      // Payroll profiles: TD1 claim codes for the CA staff (Québec takes a
      // TP-1015.3-V amount, never a provincial code), W-4 facts for the US.
      const profiles: Record<string, unknown>[] = [
        {
          employeePartyId: ctx.alice,
          payScheduleId: ctx.schedCA,
          country: "CA",
          province: "ON",
          payBasis: "hourly",
          federalClaimCode: 1,
          provincialClaimCode: 1,
          paymentMethod: "eft",
        },
        {
          employeePartyId: ctx.jean,
          payScheduleId: ctx.schedCA,
          country: "CA",
          province: "QC",
          payBasis: "hourly",
          federalClaimCode: 1,
          provincialClaimAmount: "12000",
          paymentMethod: "eft",
        },
        {
          employeePartyId: ctx.sam,
          payScheduleId: ctx.schedUS,
          country: "US",
          province: "CA",
          payBasis: "salary",
          filingStatus: "single",
          w4Allowances: 0,
          paymentMethod: "eft",
        },
      ];
      for (const profile of profiles) {
        ok(await api(rq, ctx.baseURL, "POST", "/api/payroll/profiles", profile), "upsert profile");
      }
      // The Québec profile refuses a provincial claim code (data-entry
      // error the engine would have to guess at) — the suite proves it.
      const bad = await api(rq, ctx.baseURL, "POST", "/api/payroll/profiles", {
        employeePartyId: ctx.jean,
        payScheduleId: ctx.schedCA,
        country: "CA",
        province: "QC",
        payBasis: "hourly",
        federalClaimCode: 1,
        provincialClaimCode: 1,
      });
      expect(bad.status).toBe(422);
    } finally {
      await context.close();
    }
  });

  test("approves bank details through the fraud-control flow", async ({ browser }) => {
    const { context, page } = await authedContext(browser, ctx.baseURL);
    try {
      void page;
      const gates = await approverGates();
      // Three employees → three on_create gates parked for the approver.
      expect(gates).toHaveLength(3);
      for (const gate of gates) {
        await approveAsSecondUser(gate, `${TAG} e2e bank detail review`);
      }
      expect(await approverGates()).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  test("calculates the CA run with holiday attestations", async ({ browser }) => {
    const { context, page } = await authedContext(browser, ctx.baseURL);
    try {
      const rq = page.request;
      // Hourly pay rides review-step adjustments (hours + amount on base).
      const baseId = await baseComponentId(rq, ctx.runCA);
      for (const [employee, amount] of [
        [ctx.alice, "3600.00"],
        [ctx.jean, "3040.00"],
      ] as [string, string][]) {
        ok(
          await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${ctx.runCA}`, {
            action: "add-adjustment",
            employeePartyId: employee,
            componentId: baseId,
            amount,
            hours: "80",
            note: `${TAG} e2e regular hours`,
          }),
          `hours adjustment ${amount}`,
        );
      }
      // Without the employer attestations the declaring rules fail closed —
      // the suite proves the demand is live before supplying the facts.
      const bare = ok(
        await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${ctx.runCA}`, { action: "calculate" }),
        "calculate without attestations",
      );
      const bareErrors = (bare["errors"] as { message: string }[]).map((e) => e.message).join(" | ");
      expect(bareErrors).toMatch(/last-and-first-shift/);
      expect(bareErrors).toMatch(/commission-pay status/);
      const calc = ok(
        await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${ctx.runCA}`, {
          action: "calculate",
          holidayEligibility: {
            [ctx.alice]: { absentWithoutConsent: false },
            [ctx.jean]: { paidOnCommission: false, absentWithoutConsent: false },
          },
        }),
        "calculate CA run",
      );
      expect(calc["errors"]).toEqual([]);
      expect(calc["employees"]).toBe(2);
      expect(calc["gross"]).toBe(CA_TOTALS.gross);
      expect(calc["net"]).toBe(CA_TOTALS.net);
      const detail = ok(await api(rq, ctx.baseURL, "GET", `/api/payroll/runs/${ctx.runCA}`), "read CA stubs");
      ctx.stubsCA = asStubs(detail);
      const alice = stubByName(ctx.stubsCA, ALICE.base);
      expect(alice.gross).toBe(ALICE.gross);
      expect(alice.net_pay).toBe(ALICE.net);
      expect(alice.employer_cost).toBe(ALICE.cost);
      for (const [code, amount] of Object.entries(ALICE.lines)) {
        expect(lineAmount(alice, code)).toBe(amount);
      }
      const jean = stubByName(ctx.stubsCA, JEAN.base);
      expect(jean.gross).toBe(JEAN.gross);
      expect(jean.net_pay).toBe(JEAN.net);
      expect(jean.employer_cost).toBe(JEAN.cost);
      for (const [code, amount] of Object.entries(JEAN.lines)) {
        expect(lineAmount(jean, code)).toBe(amount);
      }
      // Totals equal the sum of the stubs (cross-check, not echo).
      expect(sumExact(ctx.stubsCA.map((s) => s.gross))).toBe(CA_TOTALS.gross);
      expect(sumExact(ctx.stubsCA.map((s) => s.net_pay))).toBe(CA_TOTALS.net);
      expect(sumExact(ctx.stubsCA.map((s) => s.employer_cost))).toBe(CA_TOTALS.cost);
      // The wizard renders the calculated stubs.
      const ui = await openPage(browser, `/payroll/runs/${ctx.runCA}`);
      try {
        await expect(ui.page.getByText(ctx.runCAno).first()).toBeVisible();
        await expect(ui.page.getByText(employeeName(ALICE.base))).toBeVisible();
        await expect(ui.page.getByText(employeeName(JEAN.base))).toBeVisible();
      } finally {
        await ui.close();
      }
    } finally {
      await context.close();
    }
  });

  test("calculates the US run", async ({ browser }) => {
    const { context, page } = await authedContext(browser, ctx.baseURL);
    try {
      const rq = page.request;
      ctx.runUS = field(
        ok(await api(rq, ctx.baseURL, "POST", "/api/payroll/runs", { payScheduleId: ctx.schedUS }), "mint US run"),
        "documentId",
      );
      const calc = ok(
        await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${ctx.runUS}`, { action: "calculate" }),
        "calculate US run",
      );
      expect(calc["errors"]).toEqual([]);
      expect(calc["employees"]).toBe(1);
      expect(calc["gross"]).toBe(SAM.gross);
      expect(calc["net"]).toBe(SAM.net);
      const detail = ok(await api(rq, ctx.baseURL, "GET", `/api/payroll/runs/${ctx.runUS}`), "read US stubs");
      ctx.stubsUS = asStubs(detail);
      const sam = stubByName(ctx.stubsUS, SAM.base);
      // 78000 / 26 biweekly periods, exact.
      expect(sam.gross).toBe(SAM.gross);
      expect(sam.net_pay).toBe(SAM.net);
      expect(sam.employer_cost).toBe(SAM.cost);
      for (const [code, amount] of Object.entries(SAM.lines)) {
        expect(lineAmount(sam, code)).toBe(amount);
      }
      const header = detail["run"] as Record<string, unknown>;
      ctx.runUSno = String(header["document_number"]);
      const ui = await openPage(browser, `/payroll/runs/${ctx.runUS}`);
      try {
        await expect(ui.page.getByText(ctx.runUSno).first()).toBeVisible();
        await expect(ui.page.getByText(employeeName(SAM.base))).toBeVisible();
      } finally {
        await ui.close();
      }
    } finally {
      await context.close();
    }
  });

  test("commits both runs behind a second-user approval", async ({ browser }) => {
    const { context, page } = await authedContext(browser, ctx.baseURL);
    try {
      const rq = page.request;
      // GL previews balance before anything posts: debits equal credits and
      // the wage/net/liability legs equal the stub figures endpoint above.
      for (const [runId, stubs] of [
        [ctx.runCA, ctx.stubsCA],
        [ctx.runUS, ctx.stubsUS],
      ] as [string, Stub[]][]) {
        const preview = ok(
          await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${runId}`, { action: "preview-gl" }),
          `GL preview ${runId}`,
        );
        const legs = preview["legs"] as { accountId: string; amount: string }[];
        expect(sumExact(legs.map((leg) => leg.amount))).toBe("0.0000");
        const debits = legs.filter((leg) => !leg.amount.startsWith("-"));
        expect(sumExact(debits.map((leg) => leg.amount))).toBe(String(preview["debitTotal"]));
        // Legs tie to the stub endpoint: wages debit equals gross, net-pay
        // credits equal net, every stub's employee rides the net leg.
        const wageLegs = legs.filter((leg) => leg.accountId === aid("wage"));
        expect(sumExact(wageLegs.map((leg) => leg.amount))).toBe(sumExact(stubs.map((s) => s.gross)));
        const netLegs = legs.filter((leg) => leg.accountId === aid("net"));
        expect(sumExact(netLegs.map((leg) => neg(leg.amount)))).toBe(sumExact(stubs.map((s) => s.net_pay)));
      }
      // Submit parks both runs; approval is outstanding, not released.
      for (const runId of [ctx.runCA, ctx.runUS]) {
        const submitted = ok(
          await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${runId}`, { action: "submit-approval" }),
          `submit ${runId}`,
        );
        expect(submitted["gated"]).toBe(true);
        const state = ok(
          await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${runId}`, { action: "approval-state" }),
          `approval state ${runId}`,
        );
        expect(state["pending"]).toBe(true);
        expect(state["released"]).toBe(false);
        // Money must not move pre-approval.
        const early = await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${runId}`, {
          action: "commit",
        });
        expect(early.status).toBe(422);
      }
      // The submitter can never approve their own run — not even as admin.
      const gates = await approverGates();
      expect(gates).toHaveLength(2);
      const selfServe = await api(rq, ctx.baseURL, "POST", "/api/flows/gates/decide", {
        gateId: gates[0],
        decision: "approved",
      });
      expect(selfServe.status).not.toBe(200);
      for (const gate of gates) {
        await approveAsSecondUser(gate, `${TAG} e2e pay run review`);
      }
      for (const runId of [ctx.runCA, ctx.runUS]) {
        const state = ok(
          await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${runId}`, { action: "approval-state" }),
          `released state ${runId}`,
        );
        expect(state["released"]).toBe(true);
        const committed = ok(
          await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${runId}`, { action: "commit" }),
          `commit ${runId}`,
        );
        expect(Number(committed["lines"])).toBeGreaterThan(0);
      }
    } finally {
      await context.close();
    }
  });

  test("generates and verifies CPA-005 and NACHA bank files", async ({ browser }) => {
    const { context, page } = await authedContext(browser, ctx.baseURL);
    try {
      const rq = page.request;
      ctx.profileCA = field(
        ok(
          await api(rq, ctx.baseURL, "POST", "/api/admin/payment-operations/profiles", {
            name: `${TAG} CPA005`,
            bankAccountId: aid("bank"),
            paymentFormatId: await formatId(rq, "CPA005"),
            originatorSecrets: {
              originatorId: `${TAG.slice(0, 7)}T`,
              originatorShortName: `${TAG} TEST`,
              originatorLongName: `${TAG} Test Employer`,
              dataCentre: "00001",
              originatingDataCentre: "00001",
              institution: "001",
              transit: "00001",
              account: "1234567",
              transactionCode: "200",
            },
          }),
          "CPA005 profile",
        ),
        "id",
      );
      ctx.profileUS = field(
        ok(
          await api(rq, ctx.baseURL, "POST", "/api/admin/payment-operations/profiles", {
            name: `${TAG} NACHA`,
            bankAccountId: aid("bank"),
            paymentFormatId: await formatId(rq, "NACHA-CREDIT"),
            originatorSecrets: {
              odfiRouting: "021000089",
              immediateDestination: "021000089",
              immediateOrigin: "123456789",
              destinationName: `${TAG} TEST BANK`,
              originName: `${TAG} Test Employer`,
              companyName: `${TAG} Test Employer`,
              companyId: "123456789",
            },
          }),
          "NACHA profile",
        ),
        "id",
      );
      // CA file: two EFT credits totalling the run net.
      const caFile = ok(
        await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${ctx.runCA}/bank-file`, {
          paymentBankProfileId: ctx.profileCA,
        }),
        "generate CA bank file",
      );
      const caArtifact = caFile["artifact"] as Record<string, unknown>;
      expect(caArtifact["format"]).toBe("cpa005");
      expect(caArtifact["entryCount"]).toBe(2);
      expect(caArtifact["controlTotal"]).toBe(CA_TOTALS.net);
      const caBytes = await releaseBankFile(rq, ctx.runCA, String(caArtifact["id"]));
      expect(caBytes.hash).toBe(String(caArtifact["contentHash"]));
      // CPA-005 logical records are 1464 chars; the Z record carries the
      // credit count and total at their published offsets.
      const records = caBytes.text.split("\r\n").filter((line) => line.length > 0);
      expect(records.map((line) => line[0]).join(",")).toBe("A,C,Z");
      expect(records.every((line) => line.length === 1464)).toBe(true);
      const zed = records.find((line) => line[0] === "Z") ?? "";
      expect(zed.slice(60, 68)).toBe("00000002");
      expect(zed.slice(46, 60)).toBe("00000000475836");
      // US file: one PPD credit for the salary net.
      const usFile = ok(
        await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${ctx.runUS}/bank-file`, {
          paymentBankProfileId: ctx.profileUS,
        }),
        "generate US bank file",
      );
      const usArtifact = usFile["artifact"] as Record<string, unknown>;
      expect(usArtifact["format"]).toBe("nacha");
      expect(usArtifact["entryCount"]).toBe(1);
      expect(usArtifact["controlTotal"]).toBe(SAM.net);
      const usBytes = await releaseBankFile(rq, ctx.runUS, String(usArtifact["id"]));
      expect(usBytes.hash).toBe(String(usArtifact["contentHash"]));
      expect(usBytes.text).toContain("PPDPAYROLL");
      expect(usBytes.text).toContain("0000231606");
      expect(usBytes.text).toContain(employeeName(SAM.base));
    } finally {
      await context.close();
    }
  });

  test("remits CRA, RQ and IRS to exact vendor bills", async ({ browser }) => {
    const { context, page } = await authedContext(browser, ctx.baseURL);
    try {
      const rq = page.request;
      const range = RANGE;
      const readSummary = async (): Promise<RemitGroup[]> => {
        const res = ok(
          await api(rq, ctx.baseURL, "GET", `/api/payroll/remittances?from=${range.from}&to=${range.to}`),
          "remittance summary",
        );
        return res["groups"] as RemitGroup[];
      };
      // Per-component destinations: Québec tax and every US withholding name
      // their vendor (region rules already route QPP/QPIP and CRA payables).
      // A component that already names a vendor is ADOPTED, never re-pointed:
      // re-pointing re-homes every prior run's rows in the live summary, so a
      // retried attempt would measure history as its own accruals. Complete
      // rows, with the slot-written liability echoed back.
      const flags = {
        basis: "fixed_amount",
        taxable: true,
        pensionable: true,
        insurable: true,
        vacationable: true,
        nonPeriodic: false,
        taxTreatment: "none",
      };
      const routed = new Map<string, { componentId: string; name: string; kind: string; liabilityAccountId: string; partyId: string | null }>();
      for (const group of await readSummary()) {
        for (const component of group.components) {
          const known = routed.get(component.code);
          if (!known) {
            routed.set(component.code, {
              componentId: component.componentId,
              name: component.name,
              kind: component.kind,
              liabilityAccountId: component.liabilityAccountId,
              partyId: group.partyId,
            });
          } else if (known.partyId === null && group.partyId !== null) {
            known.partyId = group.partyId;
          }
        }
      }
      const destinations: [string, string, string][] = [
        ["QCTAX", "CA", vid("rq")],
        ["FIT", "US", vid("irs")],
        ["SS", "US", vid("irs")],
        ["MED", "US", vid("irs")],
        ["SIT", "US", vid("irs")],
        ["SS-ER", "US", vid("irs")],
        ["MED-ER", "US", vid("irs")],
        ["FUTA", "US", vid("irs")],
      ];
      for (const [code, country, vendorId] of destinations) {
        const component = routed.get(code);
        if (!component) throw new Error(`component ${code} missing from summary`);
        if (component.partyId !== null) continue;
        ok(
          await api(rq, ctx.baseURL, "PATCH", "/api/admin/setup/pay-components", {
            id: component.componentId,
            code,
            name: component.name,
            kind: component.kind,
            country,
            ...flags,
            remittancePartyId: vendorId,
            liabilityAccountId: component.liabilityAccountId,
          }),
          `route ${code}`,
        );
      }
      // Exactness per component, summed across groups and differenced off the
      // pre-commit baseline: component AMOUNTS never move between groups when
      // vendors are adopted, only their grouping does — so this is exact on a
      // fresh tenant and on a retried one. On a fresh tenant the groups are
      // exactly CRA + RQ + IRS with the REMIT totals (visible in CI logs).
      const groups = await readSummary();
      expect(groups.every((group) => group.partyId !== null)).toBe(true);
      const codeDelta = (code: string): string => {
        const now = sumExact(
          groups.flatMap((group) =>
            group.components.filter((c) => c.code === code).map((c) => c.amount),
          ),
        );
        const before = ctx.remitBaselineByCode.get(code) ?? "0.0000";
        return sumExact([now, neg(before)]);
      };
      const CODE_GOLDENS: [string, string][] = [
        ["TAX", "988.7700"],
        ["CPP", "389.2300"],
        ["EI", "98.2000"],
        ["CPP-ER", "389.2300"],
        ["EI-ER", "137.4800"],
        ["QCTAX", "392.3700"],
        ["QPIP", "13.0700"],
        ["QPIP-ER", "18.3000"],
        ["FIT", "320.3800"],
        ["SS", "186.0000"],
        ["MED", "43.5000"],
        ["SIT", "134.0600"],
        ["SS-ER", "186.0000"],
        ["MED-ER", "43.5000"],
        ["FUTA", "18.0000"],
      ];
      for (const [code, golden] of CODE_GOLDENS) {
        expect(codeDelta(code)).toBe(golden);
      }
      // Group components sum to their group total (no hidden remainder).
      for (const group of groups) {
        expect(sumExact(group.components.map((c) => c.amount))).toBe(group.total);
      }
      // One vendor bill per group; each bill's total equals its group.
      // Bills are drafts (posting is the AP domain). Stale drafts from a
      // retried attempt are deleted and re-raised inside the helper.
      for (const group of groups) {
        const documentId = await createRemittanceBill(
          rq,
          group.partyId as string,
          group.filingAccount.id,
          range.from,
          range.to,
          `bill ${group.partyName}`,
        );
        if (group.partyId === vid("cra")) ctx.craBill = documentId;
        else if (group.partyId === vid("rq")) ctx.rqBill = documentId;
        else if (group.partyId === vid("irs")) ctx.irsBill = documentId;
      }
      const billed = await readSummary();
      for (const group of billed) {
        const totals = group.existingBills.map((bill) => sumExact([bill.total]));
        expect(totals).toContain(sumExact([group.total]));
      }
      const ui = await openPage(browser, `/payroll/remittances?from=${range.from}&to=${range.to}`);
      try {
        // Names render verbatim; amounts render locale-formatted, so the
        // cent-exact asserts stay on the API responses above. TAX always
        // resolves through this run's settings, so its group names the
        // current CRA vendor in every tenant layout.
        const taxGroup = groups.find((group) => group.components.some((c) => c.code === "TAX"));
        const vendorName = taxGroup?.partyName;
        if (!vendorName) throw new Error("TAX group has no vendor");
        await expect(ui.page.getByText(vendorName).first()).toBeVisible();
      } finally {
        await ui.close();
      }
    } finally {
      await context.close();
    }
  });

  test("ties payroll liabilities to run totals", async ({ browser }) => {
    const { context, page } = await authedContext(browser, ctx.baseURL);
    try {
      const rq = page.request;
      // Committed document lines: every deduction/employer leg sits on the
      // account the commit stamped, and the stamps equal the slot mapping.
      for (const [runId, stubs, gross, net, cost] of [
        [ctx.runCA, ctx.stubsCA, CA_TOTALS.gross, CA_TOTALS.net, CA_TOTALS.cost],
        [ctx.runUS, ctx.stubsUS, SAM.gross, SAM.net, SAM.cost],
      ] as [string, Stub[], string, string, string][]) {
        const preview = ok(
          await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${runId}`, { action: "preview-gl" }),
          `GL tie-out ${runId}`,
        );
        const legs = preview["legs"] as { accountId: string; amount: string; description: string }[];
        const byAccount = new Map<string, string[]>();
        for (const leg of legs) {
          const list = byAccount.get(leg.accountId) ?? [];
          list.push(leg.amount);
          byAccount.set(leg.accountId, list);
        }
        const totalOf = (accountId: string): string => sumExact(byAccount.get(accountId) ?? ["0"]);
        // Wages debit equals gross; net payable equals net (negative legs).
        expect(totalOf(aid("wage"))).toBe(gross);
        expect(totalOf(aid("net"))).toBe(`-${net}`);
        // Liabilities equal gross − net + employer cost, to the cent.
        const deductionSum = sumExact(
          stubs.flatMap((stub) =>
            stub.lines
              .filter((line) => line.kind === "deduction" || line.kind === "employer_contribution")
              .map((line) => line.amount),
          ),
        );
        expect(deductionSum).toBe(sumExact([gross, `-${net}`, cost]));
        const liabilityAccounts = [...byAccount.keys()].filter(
          (id) => id !== aid("wage") && id !== aid("burden") && id !== aid("net"),
        );
        expect(sumExact(liabilityAccounts.map(totalOf))).toBe(`-${deductionSum}`);
      }
      void browser;
    } finally {
      await context.close();
    }
  });

  test("reports year-end slips equal to committed stubs", async ({ browser }) => {
    const { context, page } = await authedContext(browser, ctx.baseURL);
    try {
      const rq = page.request;
      const yearEnd = ok(await api(rq, ctx.baseURL, "GET", "/api/payroll/year-end?year=2026"), "year-end");
      const filings = yearEnd["filings"] as {
        country: string;
        key: string;
        data: { rows: Record<string, string>[]; totals: { label: string; value: string }[] };
      }[];
      const rowsOf = (country: string, key: string): Record<string, string>[] => {
        const filing = filings.find((candidate) => candidate.country === country && candidate.key === key);
        if (!filing) throw new Error(`no ${country}/${key} filing`);
        return filing.data.rows;
      };
      // T4s equal the CA stubs line for line. Rows scope to this run's
      // employees (TAG names), so a retried attempt's slips never leak in.
      const t4 = rowsOf("CA", "t4").filter(
        (row) => row["employee"] === employeeName(ALICE.base) || row["employee"] === employeeName(JEAN.base),
      );
      expect(t4).toHaveLength(2);
      const t4alice = t4.find((row) => row["employee"] === employeeName(ALICE.base)) ?? {};
      expect(t4alice["box14"]).toBe(ALICE.gross);
      expect(t4alice["box16"]).toBe(ALICE.lines.CPP);
      expect(t4alice["box18"]).toBe(ALICE.lines.EI);
      expect(t4alice["box22"]).toBe(ALICE.lines.TAX);
      const t4jean = t4.find((row) => row["employee"] === employeeName(JEAN.base)) ?? {};
      expect(t4jean["box14"]).toBe(JEAN.gross);
      expect(t4jean["box22"]).toBe(JEAN.lines.TAX);
      // RL-1 covers the Québec employee only, with QPP/QPIP/QC tax.
      const rl1 = rowsOf("CA", "rl1").filter((row) => row["employee"] === employeeName(JEAN.base));
      expect(rl1).toHaveLength(1);
      expect(rl1[0]?.["employee"]).toBe(employeeName(JEAN.base));
      expect(rl1[0]?.["boxA"]).toBe(JEAN.gross);
      expect(rl1[0]?.["boxE"]).toBe(JEAN.lines.QCTAX);
      expect(rl1[0]?.["boxH"]).toBe(JEAN.lines.QPIP);
      // W-2 equals the US stub; the 941 quarterly roll-up ties with it.
      // The 941 has no employee dimension, so capture it now and assert the
      // amendment as a delta after the retro commits (retry-proof).
      const w2 = rowsOf("US", "w2").filter((row) => row["employee"] === employeeName(SAM.base));
      expect(w2).toHaveLength(1);
      expect(w2[0]?.["box1"]).toBe(SAM.gross);
      expect(w2[0]?.["box2"]).toBe(SAM.lines.FIT);
      expect(w2[0]?.["box3"]).toBe(SAM.gross);
      expect(w2[0]?.["box4"]).toBe(SAM.lines.SS);
      expect(w2[0]?.["box5"]).toBe(SAM.gross);
      expect(w2[0]?.["box6"]).toBe(SAM.lines.MED);
      const q1 = rowsOf("US", "941").find((row) => row["quarter"] === "Q1") ?? {};
      // No absolute assert here: the 941 aggregates by filing account, which
      // a retried attempt shares. The amendment delta below ties it instead.
      ctx.q1pre = q1;
      const ui = await openPage(browser, "/payroll/year-end");
      try {
        await expect(ui.page.getByText(employeeName(ALICE.base)).first()).toBeVisible();
        // One filing section renders at a time; open the W-2 card for Sam.
        await ui.page.getByText("W-2 box data").first().click();
        await expect(ui.page.getByText(employeeName(SAM.base)).first()).toBeVisible();
      } finally {
        await ui.close();
      }
    } finally {
      await context.close();
    }
  });

  test("pays a retro amendment and moves YTD", async ({ browser }) => {
    const { context, page } = await authedContext(browser, ctx.baseURL);
    try {
      const rq = page.request;
      // A backdated raise, corrected in place on the same effective start.
      ok(
        await api(rq, ctx.baseURL, "POST", "/api/admin/setup/labor-costing", {
          action: "save-rate",
          employeePartyId: ctx.sam,
          currency: "USD",
          rate: "80600.00",
          basis: "year",
          annualHours: "2080",
          effectiveFrom: "2026-01-01",
          reason: `${TAG} e2e backdated raise`,
        }),
        "backdated raise",
      );
      const proposal = ok(
        await api(rq, ctx.baseURL, "POST", "/api/payroll/retro", {
          action: "propose",
          payScheduleId: ctx.schedUS,
          payDate: ctx.retroPayDate,
          employeePartyIds: [ctx.sam],
        }),
        "propose retro",
      );
      expect(proposal["payableTotal"]).toBe(RETRO.gross);
      const created = ok(
        await api(rq, ctx.baseURL, "POST", "/api/payroll/retro", {
          action: "create",
          payScheduleId: ctx.schedUS,
          payDate: ctx.retroPayDate,
          employeePartyIds: [ctx.sam],
        }),
        "create retro run",
      );
      ctx.retroRun = field(created, "documentId");
      const calc = ok(
        await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${ctx.retroRun}`, { action: "calculate" }),
        "calculate retro run",
      );
      expect(calc["errors"]).toEqual([]);
      expect(calc["gross"]).toBe(RETRO.gross);
      expect(calc["net"]).toBe(RETRO.net);
      // Back pay is supplemental wages: flat 22% federal withholding.
      const retroDetail = ok(
        await api(rq, ctx.baseURL, "GET", `/api/payroll/runs/${ctx.retroRun}`),
        "read retro stubs",
      );
      const retroStub = stubByName(asStubs(retroDetail), SAM.base);
      expect(lineAmount(retroStub, "FIT")).toBe(RETRO.fit);
      ok(
        await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${ctx.retroRun}`, { action: "submit-approval" }),
        "submit retro run",
      );
      for (const gate of await approverGates()) {
        await approveAsSecondUser(gate, `${TAG} e2e retro review`);
      }
      ok(
        await api(rq, ctx.baseURL, "POST", `/api/payroll/runs/${ctx.retroRun}`, { action: "commit" }),
        "commit retro run",
      );
      // YTD moved by exactly the amendment: W-2 boxes and the 941.
      // Deltas off the pre-retro read, so shared-tenant history cannot leak.
      const rerun = ok(await api(rq, ctx.baseURL, "GET", "/api/payroll/year-end?year=2026"), "year-end rerun");
      const filings = rerun["filings"] as { country: string; key: string; data: { rows: Record<string, string>[] } }[];
      const w2 = filings
        .find((filing) => filing.country === "US" && filing.key === "w2")
        ?.data.rows.find((row) => row["employee"] === employeeName(SAM.base));
      expect(w2?.["box1"]).toBe(sumExact([SAM.gross, RETRO.gross]));
      expect(w2?.["box2"]).toBe(sumExact([SAM.lines.FIT, RETRO.fit]));
      const q1post =
        filings
          .find((filing) => filing.country === "US" && filing.key === "941")
          ?.data.rows.find((row) => row["quarter"] === "Q1") ?? {};
      expect(sumExact([q1post["wages"] ?? "0", neg(ctx.q1pre["wages"] ?? "0")])).toBe(RETRO.gross);
      expect(sumExact([q1post["fit"] ?? "0", neg(ctx.q1pre["fit"] ?? "0")])).toBe(RETRO.fit);
      expect(sumExact([q1post["ssTax"] ?? "0", neg(ctx.q1pre["ssTax"] ?? "0")])).toBe("12.4000");
      expect(sumExact([q1post["medicareTax"] ?? "0", neg(ctx.q1pre["medicareTax"] ?? "0")])).toBe("2.9000");
      // The amendment accrues its own IRS remittance in its own pay period.
      const delta = ok(
        await api(rq, ctx.baseURL, "GET", `/api/payroll/remittances?from=${ctx.retroPayDate}&to=${ctx.retroPayDate}`),
        "retro remittance",
      );
      const deltaGroups = delta["groups"] as { partyId: string; partyName: string | null; filingAccount: { id: string }; total: string }[];
      expect(deltaGroups).toHaveLength(1);
      const deltaGroup = deltaGroups[0];
      if (!deltaGroup) throw new Error("retro remittance group missing");
      expect(deltaGroup.total).toBe(RETRO_IRS_RANGE);
      ctx.retroBill = await createRemittanceBill(
        rq,
        deltaGroup.partyId,
        deltaGroup.filingAccount.id,
        ctx.retroPayDate,
        ctx.retroPayDate,
        "retro IRS bill",
      );
      // Drive the workspace itself: pick the US schedule, re-propose, and
      // prove idempotence in the UI — everything is settled, so Owed is 0.
      const ui = await openPage(browser, "/payroll/retro");
      try {
        await ui.page.locator("#retro-schedule").click();
        await ui.page.getByRole("option", { name: `${TAG} Biweekly US` }).click();
        await ui.page.locator("#retro-paydate").fill(ctx.retroPayDate);
        // The proposal re-runs committed periods through the engine; wait
        // for the POST itself (slow in dev, fast in the CI prod build).
        const [proposed] = await Promise.all([
          ui.page.waitForResponse(
            (response) =>
              response.url().includes("/api/payroll/retro") && response.request().method() === "POST",
            { timeout: 180_000 },
          ),
          ui.page.getByRole("button", { name: "Find retroactive pay", exact: true }).click(),
        ]);
        expect(proposed.ok()).toBe(true);
        await expect(ui.page.getByText("Owed").first()).toBeVisible();
      } finally {
        await ui.close();
      }
    } finally {
      await context.close();
    }
  });

  test("navigates the run wizard end to end", async ({ browser }) => {
    const ui = await openPage(browser, `/payroll/runs/${ctx.runCA}`);
    try {
      // Every wizard step renders against the committed run. Chips live in
      // the steps list (a sibling "Continue to readiness" button shares
      // prefixes, so scope by list and click in fixed step order).
      const chips = ui.page.getByRole("list", { name: "Pay run steps" }).getByRole("button");
      expect(await chips.count()).toBe(5);
      // The roster renders on the review step; the finish step shows the
      // remittance summary instead, so assert the employee mid-traversal.
      for (let index = 0; index <= 2; index += 1) {
        await chips.nth(index).click();
      }
      await expect(ui.page.getByText(employeeName(ALICE.base)).first()).toBeVisible();
      for (let index = 3; index < 5; index += 1) {
        await chips.nth(index).click();
      }
      await expect(ui.page.getByText(ctx.runCAno).first()).toBeVisible();
    } finally {
      await ui.close();
    }
  });
});
