import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

// A deal due today is not overdue. `new Date('YYYY-MM-DD')` is UTC midnight,
// so comparing it against `new Date()` flagged every same-day close as
// overdue for the whole day. The board compares calendar days against the
// org's business day instead. Real component coverage (only the network is
// untouched — the board takes loader props): mount with a fixed business
// today and count the overdue badges.

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/crm/opportunities?view=board",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){},replace(){}}}export function usePathname(){return '/crm/opportunities'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const messagesDe = (await import("../../../messages/de")).default;
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { OpportunityKanbanBoard, OpportunityViewSwitcher } = await import("./OpportunityKanban");
type KanbanOpportunity = import("./OpportunityKanban").KanbanOpportunity;

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const STATUS = {
  id: "st-open",
  key: "open",
  name: "Open",
  sequence: 1,
  probability: 50,
  defaultForecastCategory: "pipeline",
  isClosed: false,
  isWon: false,
};

function opp(id: string, expectedCloseDate: string | null, overrides?: Partial<KanbanOpportunity>): KanbanOpportunity {
  return {
    id,
    opportunityNumber: `OPP-${id}`,
    title: `Deal ${id}`,
    partyId: null,
    partyName: null,
    primaryContactId: null,
    contactName: null,
    ownerUserId: null,
    ownerName: null,
    salesTeamName: null,
    statusId: STATUS.id,
    forecastCategory: "pipeline",
    probability: 50,
    currency: "USD",
    projectedAmount: "1000.0000",
    weightedAmount: "500.0000",
    expectedCloseDate,
    nextStep: null,
    winLossReason: null,
    updatedAt: "2026-09-17T12:00:00.000Z",
    isStagnant: false,
    linesCount: 0,
    ...overrides,
  };
}

async function renderBoard(t: TestContext, opportunities: KanbanOpportunity[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-17">
          <OpportunityKanbanBoard
            statuses={[STATUS]}
            opportunities={opportunities}
            canManage={false}
          />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  return host;
}

test("a deal due on the business day is not flagged overdue; yesterday is", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-17">
          <OpportunityKanbanBoard
            statuses={[STATUS]}
            opportunities={[opp("today", "2026-09-17"), opp("past", "2026-09-16"), opp("future", "2026-09-18")]}
            canManage={false}
          />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  const overdue = [...host.querySelectorAll(".text-rose-600")].filter((el) =>
    el.textContent?.includes("2026-09"),
  );
  assert.equal(overdue.length, 1, `exactly the past-due deal flags overdue, got ${overdue.map((el) => el.textContent)}`);
  assert.match(overdue[0]!.textContent ?? "", /2026-09-16/);
});

test("the board and view switcher use the selected locale", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="de" messages={messagesDe} timeZone="UTC">
        <BusinessDateProvider today="2026-09-17">
          <OpportunityViewSwitcher view="board" />
          <OpportunityKanbanBoard statuses={[STATUS]} opportunities={[]} canManage={false} />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  assert.match(host.textContent ?? "", /Liste/);
  assert.match(host.textContent ?? "", /Vertriebspipeline/);
  assert.match(host.textContent ?? "", /0 von 0 Verkaufschancen angezeigt/);
  assert.match(host.textContent ?? "", /Keine Verkaufschancen/);
  const filter = host.querySelector("input");
  assert.equal(filter?.placeholder, "Geschäfte nach Titel, Konto oder Verantwortlichem filtern …");
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
});

test("the win/loss reason dialog uses translated copy", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const closedLost = {
    ...STATUS,
    id: "closed-lost",
    name: "Closed Lost",
    sequence: 2,
    probability: 0,
    isClosed: true,
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="de" messages={messagesDe} timeZone="UTC">
        <BusinessDateProvider today="2026-09-17">
          <OpportunityKanbanBoard
            statuses={[STATUS, closedLost]}
            opportunities={[opp("lost", "2026-09-17")]}
            canManage
          />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  const stage = host.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    stage.value = closedLost.id;
    stage.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick();
  });
  assert.match(host.textContent ?? "", /Begründung für Gewinn oder Verlust erforderlich/);
  assert.match(host.textContent ?? "", /Begründung/);
  assert.match(host.textContent ?? "", /Phasenänderung bestätigen/);
  assert.equal(host.querySelector("textarea")?.placeholder, "z. B. wegen des Preises an einen Wettbewerber verloren; Budget gestrichen; Umfang reduziert …");
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
});

// UX-03: the forecast exclusion note links to the board with `undated=1`.
// The filtered board must name the filter and offer the way back; the
// unfiltered board must not carry the chip.
test("undated-only board names the filter with a show-all route", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-17">
          <OpportunityKanbanBoard
            statuses={[STATUS]}
            opportunities={[opp("dated", "2026-09-20")]}
            canManage={false}
            undatedOnly
            undatedLabel="Undated only"
            showAllLabel="Show all"
          />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  assert.ok(host.textContent?.includes("Undated only"), "the filter chip must render");
  assert.ok(host.textContent?.includes("Show all"), "the clear route must render");
});

test("unfiltered board carries no undated chip", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-17">
          <OpportunityKanbanBoard
            statuses={[STATUS]}
            opportunities={[opp("dated", "2026-09-20")]}
            canManage={false}
          />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  assert.ok(!host.textContent?.includes("Show all"), "no chip without the undated filter");
});

// F3-73: cents survive the board. The old float formatter with
// maximumFractionDigits: 0 rendered 1234.56 as $1,235.
test("deal amounts keep their cents", async (t) => {
  const host = await renderBoard(t, [
    opp("cents", "2026-09-20", { projectedAmount: "1234.5600", weightedAmount: "0.0000" }),
  ]);
  assert.ok(host.textContent?.includes("$1,234.56"), `exact cents must render, got ${host.textContent}`);
});

// F3-73: binary floats smeared 0.10 + 0.20 into 0.30000000000000004. The
// column total sums exact decimal units instead.
test("column totals sum exactly", async (t) => {
  const host = await renderBoard(t, [
    opp("a", "2026-09-20", { projectedAmount: "0.1000", weightedAmount: "0.0000" }),
    opp("b", "2026-09-20", { projectedAmount: "0.2000", weightedAmount: "0.0000" }),
  ]);
  assert.ok(host.textContent?.includes("$0.30"), `total must be exactly $0.30, got ${host.textContent}`);
});

// F3-74: a mixed-currency column totals per currency. The old total priced
// every row in the first row's currency, so USD 1000 + EUR 2000 read $3,000.00.
test("mixed-currency columns total per currency", async (t) => {
  const host = await renderBoard(t, [
    opp("usd", "2026-09-20", { currency: "USD", projectedAmount: "1000.0000", weightedAmount: "0.0000" }),
    opp("eur", "2026-09-20", { currency: "EUR", projectedAmount: "2000.0000", weightedAmount: "0.0000" }),
  ]);
  const text = host.textContent ?? "";
  assert.ok(text.includes("$1,000.00"), `USD total must render, got ${text}`);
  assert.ok(text.includes("€2,000.00"), `EUR total must render separately, got ${text}`);
  assert.ok(!text.includes("$3,000.00"), `rows must not merge into one currency, got ${text}`);
});

// F3-74 (g58 CRM-UI1 overlap): totals sort by currency code so row order
// cannot move the figures. EUR sorts before USD in either input order.
test("mixed-currency totals sort by code regardless of row order", async (t) => {
  const eur = opp("eur", "2026-09-20", { currency: "EUR", projectedAmount: "2000.0000", weightedAmount: "0.0000" });
  const usd = opp("usd", "2026-09-20", { currency: "USD", projectedAmount: "1000.0000", weightedAmount: "0.0000" });
  const forward = await renderBoard(t, [eur, usd]);
  const fwd = forward.textContent ?? "";
  assert.ok(fwd.indexOf("€2,000.00") < fwd.indexOf("$1,000.00"), `sorted EUR before USD, got ${fwd}`);
  // Second render in reversed row order must keep the same sorted order.
  const host2 = document.createElement("div");
  document.body.appendChild(host2);
  const { createRoot: createRoot2 } = await import("react-dom/client");
  const root2 = createRoot2(host2);
  try {
    await act(async () => {
      root2.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <BusinessDateProvider today="2026-09-17">
            <OpportunityKanbanBoard statuses={[STATUS]} opportunities={[usd, eur]} canManage={false} />
          </BusinessDateProvider>
        </NextIntlClientProvider>,
      );
      await tick();
    });
    await tick();
    const rev = host2.textContent ?? "";
    assert.ok(rev.indexOf("€2,000.00") < rev.indexOf("$1,000.00"), `reversed rows keep sorted order, got ${rev}`);
  } finally {
    await act(async () => {
      root2.unmount();
    });
    host2.remove();
  }
});

// F3-73/74 (g58 overlap): above-2^53 amounts sum exactly, never through float.
test("column totals stay exact above 2^53", async (t) => {
  const host = await renderBoard(t, [
    opp("big-a", "2026-09-20", { projectedAmount: "9007199254740993.0000", weightedAmount: "0.0000" }),
    opp("big-b", "2026-09-20", { projectedAmount: "1.0000", weightedAmount: "0.0000" }),
    opp("frac-a", "2026-09-20", { projectedAmount: "0.1000", weightedAmount: "0.0000" }),
    opp("frac-b", "2026-09-20", { projectedAmount: "0.2000", weightedAmount: "0.0000" }),
  ]);
  const text = host.textContent ?? "";
  assert.ok(
    text.includes("$9,007,199,254,740,994.30"),
    `exact bigint total must render, got ${text}`,
  );
});

// F3-74 (g58 overlap): a missing currency is refused instead of invented.
// The loader guarantees one, so a blank is corruption that must be loud
// rather than silently priced as USD.
test("a missing currency throws instead of defaulting to USD", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const { createRoot: throwingRoot } = await import("react-dom/client");
  const root = throwingRoot(host);
  t.after(async () => {
    try {
      await act(async () => {
        root.unmount();
      });
    } catch {
      // The refused render already tore the tree down.
    }
    host.remove();
  });
  // React rethrows the render refusal out of act(): assert on that path,
  // not on an inner catch the reconciler bypasses.
  await assert.rejects(
    async () => {
      await act(async () => {
        root.render(
          <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <BusinessDateProvider today="2026-09-17">
              <OpportunityKanbanBoard
                statuses={[STATUS]}
                opportunities={[opp("blank", "2026-09-20", { currency: "" })]}
                canManage={false}
              />
            </BusinessDateProvider>
          </NextIntlClientProvider>,
        );
        await tick();
      });
      await tick();
    },
    /currency/i,
    "blank currency must be refused by name instead of priced as USD",
  );
});
