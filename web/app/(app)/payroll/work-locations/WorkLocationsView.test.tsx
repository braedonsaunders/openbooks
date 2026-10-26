import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";

await bootJsdomEnvironment({
  url: "http://localhost:4800/payroll/work-locations",
  matchMediaMatches: false,
});
stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(){},replace(){},refresh(){}}}" +
      "export function usePathname(){return window.location.pathname}" +
      "export function useSearchParams(){return new URLSearchParams(window.location.search)}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      "export const toast={success(){},error(m){globalThis.__toastErrors.push(m)},warning(){}}",
  },
});
const toastErrors: string[] = [];
Object.assign(globalThis, { __toastErrors: toastErrors });
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { WorkLocationsView } = await import("./WorkLocationsView");

const employment = "11111111-1111-4111-8111-111111111111";
const employees = [
  { employmentId: employment, employeeName: "Ada Lovelace", subsidiaryName: "Main Co" },
];
const row = {
  id: "alloc-1",
  region: "NY",
  subregion: null,
  serviceDays: 4,
  workShare: null,
  source: "hr_records",
  evidenceDocumentId: null,
  changeReason: "Remote week",
};

async function mount(t: TestContext, url: string, requests: string[]) {
  window.history.replaceState(null, "", url);
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const requested = String(input);
    requests.push(requested);
    return Response.json(
      requested.includes("employmentId=") ? { employees, rows: [row] } : { employees },
    );
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.replaceChildren();
    globalThis.fetch = prior;
    toastErrors.length = 0;
    window.history.replaceState(null, "", "/payroll/work-locations");
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <WorkLocationsView />
      </NextIntlClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test("an incomplete scope reads only the employee choices and never requests a refused row read", async (t) => {
  const requests: string[] = [];
  await mount(t, `/payroll/work-locations?employment=${employment}`, requests);
  assert.deepEqual(requests, ["/api/payroll/work-locations"]);
  assert.deepEqual(toastErrors, []);
  assert.ok(document.body.textContent?.includes(messages.payroll.workLocations.empty));
  // The employment filter sits on the list toolbar with the loaded choices.
  assert.ok(
    [...document.querySelectorAll("option")].some(
      (option) => option.textContent === "Ada Lovelace · Main Co",
    ),
  );
});

test("a complete scope lists its saved allocations with translated evidence", async (t) => {
  const requests: string[] = [];
  await mount(
    t,
    `/payroll/work-locations?employment=${employment}&from=2026-09-01&to=2026-09-15`,
    requests,
  );
  assert.equal(requests.length, 1);
  assert.match(
    requests[0]!,
    /employmentId=11111111-1111-4111-8111-111111111111&periodStart=2026-09-01&periodEnd=2026-09-15/,
  );
  const text = document.body.textContent ?? "";
  assert.ok(text.includes("NY"));
  assert.ok(text.includes("4 days"));
  assert.ok(text.includes(messages.payroll.workLocations.sources.hr_records));
});

test("the header request opens the editor prefilled from the list scope", async (t) => {
  const requests: string[] = [];
  await mount(
    t,
    `/payroll/work-locations?employment=${employment}&from=2026-09-01&to=2026-09-15&new=1`,
    requests,
  );
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, "the editor drawer is open");
  assert.equal(
    dialog.querySelector("#work-location-employment")?.textContent,
    "Ada Lovelace · Main Co",
  );
  assert.equal(
    (dialog.querySelector("#work-location-start") as HTMLInputElement).value,
    "09/01/2026",
  );
  assert.equal(
    (dialog.querySelector("#work-location-end") as HTMLInputElement).value,
    "09/15/2026",
  );
});
