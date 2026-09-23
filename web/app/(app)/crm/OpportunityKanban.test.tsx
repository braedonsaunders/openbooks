import assert from "node:assert/strict";
import test from "node:test";

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
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { OpportunityKanbanBoard } = await import("./OpportunityKanban");
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

function opp(id: string, expectedCloseDate: string | null): KanbanOpportunity {
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
  };
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
