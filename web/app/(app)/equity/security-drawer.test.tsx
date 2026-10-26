import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

await bootJsdomEnvironment({ url: "http://localhost/equity", matchMediaMatches: false });
Object.assign(globalThis, { React });
window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0);
window.cancelAnimationFrame = (id) => window.clearTimeout(id);
stubModules({
  navigation: {
    source:
      'export function usePathname(){return window.location.pathname} export function useSearchParams(){return new URLSearchParams(window.location.search)} export function useRouter(){return {push(){},replace(){},refresh(){},prefetch(){}}} export function notFound(){throw new Error("not found")} export function redirect(){throw new Error("redirect")}',
  },
});
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const { default: messages } = await import("../../../messages/en");
const { MoneyProvider } = await import("../../../components/money-provider");
const { SecurityDrawer } = await import("./SecurityDrawer");
const { NewRecordDrawer } = await import("./NewRecordDrawer");
const { EquityRoundsPanel } = await import("./RoundsPanel");
type DrawerProps = import("./view").SecurityDrawerData;

const SUB = "a0000000-0000-4000-8000-000000000001";
const CERT = "s0000000-0000-4000-8000-000000000003";
const OPTION = "s0000000-0000-4000-8000-000000000005";

async function mount(node: React.ReactNode, url: string) {
  window.history.replaceState({}, "", url);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">{node}</MoneyProvider>
      </NextIntlClientProvider>,
    ),
  );
  return {
    root,
    host,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const text = (element: Element | null | undefined) =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const dialog = () => document.querySelector("[role=dialog]")!;

function restrictedCertificate(overrides: Partial<DrawerProps["detail"]> = {}): DrawerProps {
  return {
    context: {
      subsidiaryId: SUB,
      currency: "USD",
      asOf: "2026-12-15",
      canManage: true,
      actorId: "u0000000-0000-4000-8000-000000000001",
      pending: [],
      params: { sub: SUB, view: "securities" },
      list: { page: 1, query: "", sort: "default", dir: "asc" as const },
    },
    detail: {
      entity: { id: SUB, name: "Northstar Cloud", currency: "USD" },
      asOf: "2026-12-15",
      security: {
        id: CERT,
        security_number: "CS-0003",
        kind: "share",
        issue_date: "2024-06-27",
        currency: "USD",
        fx_rate: "1",
        quantity: "288000",
        price_per_share: "0.1200000000",
        consideration_amount: "34560.0000",
        journal_entry_id: "je-issue",
      },
      holderName: "Maya Chen",
      shareClass: { id: "cs", code: "CS", name: "Common Stock", kind: "common" },
      plan: null,
      round: null,
      state: {
        status: "outstanding",
        outstanding: "288000",
        vestedAvailable: "108000",
        unvested: "180000",
        consumed: {},
      },
      convertible: null,
      vesting: [{ date: "2025-06-27", quantity: "72000", cumulative: "72000" }],
      compensation: null,
      events: [
        {
          id: "ev1",
          kind: "repurchase",
          effective_on: "2026-03-31",
          quantity: "1000",
          amount: "120.0000",
          reason: "Departure buy-back",
          journal_entry_id: "je-event",
          journal_entry_number: "EQ-REP-0001",
          reversal_entry_id: null,
          reversal_entry_number: null,
          interest_accrual_entry_id: null,
          reversed_by_event_id: null,
          reversible: false,
        },
      ],
      source: null,
      resulting: [],
      exercisePrice: null,
      mfn: null,
      interest: null,
      earlyExercise: null,
      restricted: {
        sourceSecurityId: OPTION,
        sourceSecurityNumber: "OPT-0005",
        repurchaseBasis: "cost",
        vestedOnIssue: "0",
        restrictedShares: "180000",
        releasedShares: "108000",
        depositHeld: "18000.0000",
        depositUnvested: "21600.0000",
      },
      election83b: null,
      ...overrides,
    } as DrawerProps["detail"],
    releases: [
      {
        runId: "run-dec",
        throughDate: "2026-12-31",
        cumulativeShares: "108000",
        shares: "36000",
        deposit: "4320.0000",
        currency: "USD",
        journalEntryId: "je-release",
        entryNumber: "EQ-RSR-2026-12-31",
      },
    ],
    closeHref: `/equity?sub=${SUB}&view=securities`,
    holders: [],
    rounds: [],
    commonClasses: [],
    considerationAccounts: [],
  };
}

test("posted entries open over the drawer through the native journal-entry link, release entries included", async () => {
  const screen = await mount(
    <SecurityDrawer {...restrictedCertificate()} />,
    `/equity?sub=${SUB}&view=securities&security=${CERT}`,
  );
  try {
    const overview = text(dialog());
    assert.ok(
      overview.includes("Issue date") && overview.includes("Jun 27, 2024"),
      "the issue date reads natively",
    );
    assert.ok(overview.includes("$0.12"), "the price per share reads at reading precision");
    const links = [...dialog().querySelectorAll("a")].map((link): [string, string] => [
      text(link),
      link.getAttribute("href") ?? "",
    ]);
    const issuance = links.find(([label]) => label === "View entry")!;
    assert.ok(
      issuance[1].includes("txn=je-issue") && !issuance[1].includes("/journal?entry="),
      issuance[1],
    );
    const release = links.find(([label]) => label === "EQ-RSR-2026-12-31");
    assert.ok(
      release && release[1].includes("txn=je-release"),
      "the restricted-stock release posted by the run is linked",
    );
    assert.ok(
      overview.includes("Dec 31, 2026") &&
        overview.includes("36,000") &&
        overview.includes("$4,320.00"),
    );
    assert.ok(
      overview.includes("$18,000.00") && overview.includes("$21,600.00"),
      "the ledger deposit beside the deposit vesting leaves held",
    );
    const history = [...dialog().querySelectorAll("nav button[aria-pressed]")].find((tab) =>
      text(tab).startsWith("History"),
    )!;
    await act(async () => {
      (history as HTMLButtonElement).click();
    });
    const eventLink = [...dialog().querySelectorAll("a")].find(
      (link) => text(link) === "EQ-REP-0001",
    );
    assert.ok(eventLink?.getAttribute("href")?.includes("txn=je-event"));
    assert.ok(text(dialog()).includes("Mar 31, 2026"));
  } finally {
    await screen.close();
  }
});

test("an award shows its full grant-date value beside the cost expected after forfeitures", async () => {
  const props = restrictedCertificate({
    security: {
      id: OPTION,
      security_number: "OPT-0004",
      kind: "option",
      issue_date: "2024-06-27",
      currency: "USD",
      fx_rate: "1",
      quantity: "48000",
      fair_value_per_unit: "0.0568000000",
    },
    restricted: null,
    compensation: {
      grantDateValue: "2726.4000",
      expectedAfterForfeitures: "965.6000",
      recognized: "965.6000",
      posted: "965.6000",
    },
  });
  const screen = await mount(
    <SecurityDrawer {...props} releases={[]} />,
    `/equity?sub=${SUB}&view=securities&security=${OPTION}`,
  );
  try {
    const body = text(dialog());
    assert.ok(body.includes("Grant-date value$2,726.40"), body);
    assert.ok(body.includes("Expected after forfeitures$965.60"));
    assert.ok(body.includes("$0.0568"), "a fair value per unit reads at four places");
  } finally {
    await screen.close();
  }
});

test("a refused event pins its refusal and remedy beside the form until the next attempt", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: "Only 1,000 vested shares can be repurchased on Mar 31, 2026.",
        remedy: "Enter at most 1,000 shares.",
        code: "equity_quantity_exceeds",
      }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  const screen = await mount(
    <SecurityDrawer {...restrictedCertificate()} />,
    `/equity?sub=${SUB}&view=securities&security=${CERT}`,
  );
  try {
    const actionsTab = [...dialog().querySelectorAll("nav button[aria-pressed]")].find(
      (tab) => text(tab) === "Actions",
    ) as HTMLButtonElement;
    await act(async () => {
      actionsTab.click();
    });
    const voidTab = [...dialog().querySelectorAll("button[role=tab]")].find(
      (tab) => text(tab) === "Void",
    ) as HTMLButtonElement;
    await act(async () => {
      voidTab.click();
    });
    const reason = dialog().querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
        reason,
        "Issued to the wrong holder",
      );
      reason.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const submit = [...dialog().querySelectorAll("button")]
      .filter((button) => text(button) === "Void")
      .at(-1) as HTMLButtonElement;
    await act(async () => {
      submit.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const alert = dialog().querySelector("[role=alert]");
    assert.ok(text(alert).includes("Only 1,000 vested shares can be repurchased"), text(dialog()));
    assert.ok(
      text(alert).includes("Enter at most 1,000 shares."),
      "the remedy stays with the refusal",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      dialog().querySelector("[role=alert]"),
      "the refusal stays pinned after the notification fades",
    );
    // Another action starts clean: the refusal answered the void, not it.
    const other = [...dialog().querySelectorAll("button[role=tab]")].find(
      (tab) => text(tab) !== "Void",
    ) as HTMLButtonElement;
    await act(async () => {
      other.click();
    });
    assert.equal(
      dialog().querySelector("[role=alert]"),
      null,
      `switching to ${text(other)} clears the void's refusal`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await screen.close();
  }
});

const SAFE = "s0000000-0000-4000-8000-000000000007";
const VOIDED_SOURCE = "s0000000-0000-4000-8000-000000000008";
const REVERSED_SOURCE = "s0000000-0000-4000-8000-000000000009";
const VOID_ELECTION = "e0000000-0000-4000-8000-000000000001";

/** An MFN SAFE whose election adopted the terms of an instrument since voided. */
function mfnSafe(): DrawerProps {
  const props = restrictedCertificate({
    security: {
      id: SAFE,
      security_number: "SAFE-0003",
      kind: "safe",
      issue_date: "2025-02-01",
      currency: "USD",
      fx_rate: "1",
      consideration_amount: "500000.0000",
      mfn: true,
      valuation_cap: null,
      discount_percent: null,
      safe_type: "post_money",
    },
    restricted: null,
    state: null,
    vesting: [],
    events: [],
    convertible: {
      status: "outstanding",
      principal: "500000.0000",
      accruedInterest: "0.0000",
      convertingAmount: "500000.0000",
      endedOn: null,
      convertedOn: null,
      outstanding: "500000.0000",
      resultingSecurityId: null,
      resultingSecurityNumber: null,
      valuationCap: null,
      discountPercent: null,
      safeType: "post_money",
      electionId: null,
      issuedTerms: { valuationCap: null, discountPercent: null, safeType: "post_money" },
      invalidConversionTerms: null,
      conversionDrift: null,
    },
    mfn: {
      candidates: [],
      elections: [
        {
          id: "e-old",
          kind: "mfn_election",
          effectiveOn: "2025-04-01",
          sourceSecurityId: REVERSED_SOURCE,
          sourceSecurityNumber: "SAFE-0001",
          valuationCap: "40000000.0000",
          discountPercent: null,
          safeType: "post_money",
          before: { valuationCap: null, discountPercent: null, safeType: "post_money" },
          reversesAmendmentId: null,
          standing: "reversed",
          reversedOn: "2025-05-01",
          reason: "Adopted in error",
        },
        {
          id: "e-old-reversal",
          kind: "mfn_reversal",
          effectiveOn: "2025-05-01",
          sourceSecurityId: REVERSED_SOURCE,
          sourceSecurityNumber: "SAFE-0001",
          valuationCap: null,
          discountPercent: null,
          safeType: "post_money",
          before: { valuationCap: "40000000.0000", discountPercent: null, safeType: "post_money" },
          reversesAmendmentId: "e-old",
          standing: null,
          reversedOn: null,
          reason: "Adopted in error",
        },
        {
          id: VOID_ELECTION,
          kind: "mfn_election",
          effectiveOn: "2025-06-15",
          sourceSecurityId: VOIDED_SOURCE,
          sourceSecurityNumber: "SAFE-0005",
          valuationCap: "60000000.0000",
          discountPercent: "20.0000",
          safeType: "post_money",
          before: { valuationCap: null, discountPercent: null, safeType: "post_money" },
          reversesAmendmentId: null,
          standing: "source_void",
          reversedOn: null,
          reason: "Holder elected the better cap",
        },
      ],
    },
  });
  return { ...props, releases: [], context: { ...props.context, asOf: "2026-10-19" } };
}

async function reverseVoidSourceElection(response: { status: number; body: unknown }) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const screen = await mount(
    <SecurityDrawer {...mfnSafe()} />,
    `/equity?sub=${SUB}&view=securities&security=${SAFE}`,
  );
  try {
    const mfnTab = [...dialog().querySelectorAll("nav button[aria-pressed]")].find((tab) =>
      text(tab).startsWith("MFN"),
    ) as HTMLButtonElement;
    await act(async () => {
      mfnTab.click();
    });
    const rows = [...dialog().querySelectorAll("tbody tr")];
    const reversed = rows.find(
      (row) => text(row).includes("SAFE-0001") && text(row).includes("Reversed"),
    )!;
    assert.equal(
      [...reversed.querySelectorAll("button")].length,
      0,
      "a reversed election offers no second reversal",
    );
    const voided = rows.find((row) => text(row).includes("SAFE-0005"))!;
    assert.ok(text(voided).includes("Source void"), text(voided));
    const reverse = [...voided.querySelectorAll("button")].find(
      (button) => text(button) === "Reverse election",
    ) as HTMLButtonElement;
    assert.ok(
      reverse,
      "an election whose source is void offers the reversal its conversion refusal prescribes",
    );
    await act(async () => {
      reverse.click();
    });
    assert.ok(
      text(dialog()).includes("SAFE-0005 was voided"),
      "the form says why this election is reversed",
    );
    const submit = [...dialog().querySelectorAll("button")]
      .filter((button) => text(button) === "Reverse election")
      .at(-1) as HTMLButtonElement;
    assert.equal(submit.disabled, true, "a reversal needs its reason first");
    const reason = [...dialog().querySelectorAll("textarea")].at(-1) as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
        reason,
        "Source SAFE-0005 was voided",
      );
      reason.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      submit.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    return { requests, body: text(dialog()) };
  } finally {
    globalThis.fetch = originalFetch;
    await screen.close();
  }
}

test("an MFN election whose source is void reverses from the MFN terms through the governed reversal", async () => {
  const { requests, body } = await reverseVoidSourceElection({
    status: 201,
    body: { amendmentId: "r1", replayed: false, status: "applied", requestId: "q1" },
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]!.url,
    `/api/equity/securities/${SAFE}/mfn-elections/${VOID_ELECTION}/reversal`,
  );
  assert.equal(
    requests[0]!.body.effectiveOn,
    "2026-10-19",
    "the reversal is dated on the as-of date, after every recorded election",
  );
  assert.equal(requests[0]!.body.reason, "Source SAFE-0005 was voided");
  assert.match(
    String(requests[0]!.body.idempotencyKey),
    new RegExp(`^${VOID_ELECTION}:mfn-reversal:`),
  );
  assert.ok(
    !body.includes("was voided, so its terms no longer stand"),
    "the form closes once the reversal applies",
  );
});

test("a reversal an Equity action Flow holds for approval closes the form and refuses nothing", async () => {
  const { requests, body } = await reverseVoidSourceElection({
    status: 202,
    body: { amendmentId: null, replayed: false, status: "pending_approval", requestId: "q2" },
  });
  assert.equal(requests.length, 1);
  assert.equal(body.includes("The election could not be reversed."), false, body);
  assert.ok(
    !body.includes("was voided, so its terms no longer stand"),
    "the form closes once the Flow holds the reversal",
  );
});

test("a refused reversal keeps the form open with the refusal and its remedy", async () => {
  const { body } = await reverseVoidSourceElection({
    status: 409,
    body: {
      error: "A later MFN election on SAFE-0003 is recorded from 2026-07-01.",
      remedy: "Reverse the election of 2026-07-01 first, latest first.",
      code: "equity_mfn_reversal_has_dependents",
    },
  });
  assert.ok(body.includes("A later MFN election on SAFE-0003"), body);
  assert.ok(
    body.includes("Reverse the election of 2026-07-01 first"),
    "the remedy stays beside the form",
  );
  assert.ok(
    body.includes("was voided, so its terms no longer stand"),
    "the form stays open for another attempt",
  );
});

test("a new stakeholder with an address no message could be sent to is held at the form, with the reason beside the field", async () => {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    requests.push(String(url));
    return new Response("{}", { status: 201 });
  }) as typeof fetch;
  const data = {
    context: restrictedCertificate().context,
    kind: "stakeholder" as const,
    closeHref: `/equity?sub=${SUB}&view=stakeholders`,
    holderPartyId: null,
    securityKind: null,
    holders: [],
    classes: [],
    commonClasses: [],
    plans: [],
    rounds: [],
    considerationAccounts: [],
    currencies: [],
    canCreateParty: true,
  };
  const screen = await mount(
    <NewRecordDrawer data={data} />,
    `/equity?sub=${SUB}&view=stakeholders&new=stakeholder`,
  );
  try {
    const inputs = [...dialog().querySelectorAll("input")] as HTMLInputElement[];
    const type = async (input: HTMLInputElement, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    const name = inputs.find((input) => input.type !== "email")!;
    const email = inputs.find((input) => input.type === "email")!;
    await type(name, "QA Tester Alpha");
    await type(email, "not-an-email");
    const create = [...dialog().querySelectorAll("button")].find(
      (button) => text(button) === "Create and issue a security",
    ) as HTMLButtonElement;
    assert.equal(create.disabled, true, "the form will not submit an invalid address");
    assert.ok(text(dialog()).includes("Enter a valid email address"));
    assert.equal(email.getAttribute("aria-invalid"), "true");
    await type(email, "qa.alpha@example.com");
    assert.equal(create.disabled, false);
    assert.ok(!text(dialog()).includes("Enter a valid email address"));
    assert.deepEqual(requests, [], "nothing was sent while the address was invalid");
  } finally {
    globalThis.fetch = originalFetch;
    await screen.close();
  }
});

test("a new award vests from its issue date until the operator sets another start", async () => {
  const data = {
    context: restrictedCertificate().context,
    kind: "security" as const,
    closeHref: `/equity?sub=${SUB}&view=securities`,
    holderPartyId: null,
    securityKind: "option" as const,
    holders: [],
    classes: [],
    commonClasses: [],
    plans: [],
    rounds: [],
    considerationAccounts: [],
    currencies: [],
    canCreateParty: true,
  };
  const screen = await mount(
    <NewRecordDrawer data={data} />,
    `/equity?sub=${SUB}&view=securities&new=security`,
  );
  try {
    const settle = async (input: HTMLInputElement, value: string) =>
      act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        input.blur();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const timeTab = [...dialog().querySelectorAll("button[role=tab]")].find(
      (tab) => text(tab) === "Time-based schedule",
    ) as HTMLButtonElement;
    await act(async () => {
      timeTab.click();
    });
    const dateInputs = () =>
      [
        ...dialog().querySelectorAll<HTMLInputElement>(
          "input[data-date-field], input[aria-haspopup=dialog], input",
        ),
      ].filter((input) => /\d/.test(input.value) && /\d{2,4}\D\d{1,2}\D\d{2,4}/.test(input.value));
    const [issue] = dateInputs();
    await settle(issue!, "2026-02-25");
    const [issued, vestingStart] = dateInputs();
    assert.equal(vestingStart!.value, issued!.value, "vesting starts on the issue date");
    await settle(vestingStart!, "2026-03-01");
    await settle(dateInputs()[0]!, "2026-02-20");
    const [, kept] = dateInputs();
    assert.notEqual(
      kept!.value,
      dateInputs()[0]!.value,
      "a start the operator set is kept when the issue date moves",
    );
  } finally {
    await screen.close();
  }
});

test("a round opens in its drawer with its pre-money basis, refuses a void while live securities stand, and lists voided rounds for history", async () => {
  const ROUND = "d0000000-0000-4000-8000-000000000001";
  const VOID = "d0000000-0000-4000-8000-000000000002";
  const view = {
    context: { ...restrictedCertificate().context, params: { sub: SUB, view: "rounds" } },
    structure: {
      entity: { id: SUB, name: "Northstar Cloud", currency: "USD" },
      classes: [{ id: "sa", code: "SERIESA", name: "Series A Preferred", kind: "preferred" }],
      plans: [],
      rounds: [
        {
          id: ROUND,
          name: "Series A",
          shareClassId: "sa",
          closedOn: "2025-09-30",
          pricePerShare: "3.2000000000",
          preMoneyValuation: "53200000.0000",
          currency: "USD",
          raised: "14000000.0000",
          sharesIssued: "4375000",
          preMoneyBasisReason: null,
          fullyDilutedBefore: "16625000",
          impliedPreMoney: "53200000.0000",
          liveSecurities: [{ id: "s-a1", securityNumber: "SERIESA-0001" }],
          amendments: [],
          conversionDrift: [],
          preMoneyDrift: null,
        },
      ],
      voidedRounds: [
        {
          id: VOID,
          name: "QA Series A-2",
          closedOn: "2026-10-01",
          pricePerShare: "3.5000000000",
          preMoneyValuation: "1000.0000",
          currency: "USD",
          voidedOn: "2026-10-19",
          reason: "Recorded in error",
        },
      ],
    },
    modelOpen: false,
    modelHref: "/equity?model=round",
    modelCloseHref: "/equity",
    roundId: ROUND,
    roundCloseHref: `/equity?sub=${SUB}&view=rounds`,
  } as unknown as React.ComponentProps<typeof EquityRoundsPanel>["view"];
  const screen = await mount(
    <EquityRoundsPanel view={view} />,
    `/equity?sub=${SUB}&view=rounds&round=${ROUND}`,
  );
  try {
    const rows = [...screen.host.querySelectorAll("tbody tr")].map((row) => text(row));
    assert.ok(
      rows.some((row) => row.startsWith("QA Series A-2Voided")),
      JSON.stringify(rows),
    );
    const body = text(dialog());
    assert.ok(body.includes("SERIESA · closed Sep 30, 2025"));
    assert.ok(body.includes("Price × fully diluted before$53,200,000.00"));
    assert.ok(body.includes("SERIESA-0001"), "the securities that lock the round are named");
    const voidTab = [...dialog().querySelectorAll("button[role=tab]")].find(
      (tab) => text(tab) === "Void round",
    ) as HTMLButtonElement;
    await act(async () => {
      voidTab.click();
    });
    assert.ok(
      text(dialog()).includes("A round can be voided only when no live security stands in it"),
    );
    const reason = dialog().querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
        reason,
        "Recorded against the wrong class",
      );
      reason.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const submit = [...dialog().querySelectorAll("button")]
      .filter((button) => text(button) === "Void round")
      .at(-1) as HTMLButtonElement;
    assert.equal(submit.disabled, true, "a round with live securities cannot be voided");
  } finally {
    await screen.close();
  }
});

test("a missing security keeps its requested drawer shell with a refusal and retry", async () => {
  const screen = await mount(
    <SecurityDrawer
      {...{
        securityId: "00000000-0000-4000-8000-000000000000",
        closeHref: "/equity?view=securities",
        refusal: {
          message: "This security was not found.",
          remedy: "Select a security in this legal entity.",
        },
      }}
    />,
    "/equity?view=securities&security=00000000-0000-4000-8000-000000000000",
  );
  try {
    assert.equal(document.querySelectorAll("[role=dialog]").length, 1);
    assert.match(text(dialog()), /This security was not found/);
    assert.match(text(dialog()), /Select a security in this legal entity/);
    const retry = Array.from(dialog().querySelectorAll("button")).find(
      (button) => text(button) === "Retry",
    );
    assert.ok(retry);
    await act(async () => retry.click());
    assert.equal(document.querySelectorAll("[role=dialog]").length, 1);
  } finally {
    await screen.close();
  }
});
