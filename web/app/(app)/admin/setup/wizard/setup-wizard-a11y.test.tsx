import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __wizardToasts: { kind: string; message: string }[] | undefined;
  var __wizardRouter: { push(url: string): void; refresh(): void } | undefined;
  var __wizardPath: string | undefined;
}

// the setup wizard pre-selects consequential defaults and renders
// Country/Currency/Fiscal selects whose current values an accessibility
// snapshot could not expose. The company step now states its selections as
// live text, fiscal months localize, and the review step badges every value
// still on its pre-selected default. This drives the real wizard
// welcome → review and asserts each of those properties in the DOM.

// jsdom first: the wizard reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/admin/setup/wizard", scrollIntoView: false, resizeObserver: false });
// Reduced-motion matches so step transitions swap synchronously: jsdom
// never completes the exit tween that AnimatePresence mode="wait" holds the
// next step behind.
window.matchMedia = ((query: string) => ({
  matches: String(query).includes("reduce"),
  media: String(query),
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof window.matchMedia;
if (typeof window.requestAnimationFrame !== "function") {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}
// jsdom ships no native <dialog> imperative API: WizardShell opens its modal
// through showModal/close. Mirror the open-attribute contract
// so the shell mounts exactly as in a browser.
const dialogProto = window.HTMLDialogElement?.prototype;
if (dialogProto && typeof dialogProto.showModal !== "function") {
  dialogProto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
}
if (dialogProto && typeof dialogProto.close !== "function") {
  dialogProto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
}

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../../testing/stub-modules");
stubModules({ navigation: "export function useRouter(){return globalThis.__wizardRouter}export function usePathname(){return globalThis.__wizardPath ?? '/'}export function useSearchParams(){return new URLSearchParams()}" });
registerHooks({
  resolve(specifier, context, next) {

    if (specifier.endsWith("sandbox-session")) return { shortCircuit: true, url: "data:text/javascript,export async function enterOrg(orgId,returnTo){globalThis.__wizardEnteredOrg={orgId,returnTo}}" };
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__wizardToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__wizardToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { SetupWizard } = await import("./SetupWizard");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
// Step transitions lock for 300ms against double-clicks; the walk waits it out.
const STEP_WAIT = 450;

const INDUSTRIES = [
  { key: "manufacturing", icon: "factory", category: "trade", features: {}, coa: [] },
  { key: "general_business", icon: "building", category: "general", features: {}, coa: [] },
] as never;

const TOGGLES = {
  inventory: false,
  timeTracking: false,
  multiSubsidiary: false,
  multiCurrency: false,
  projects: false,
  subscriptionBilling: false,
  orders: false,
  crm: false,
  bankFeeds: false,
  onlinePayments: false,
  fixedAssets: false,
  payroll: false,
};

// The registry tree for the toggled keys, with Field Tickets nested under
// Projects as the real registry declares it.
const FEATURE_ROWS = [
  { key: "multiSubsidiary", category: "finance" },
  { key: "multiCurrency", category: "finance" },
  { key: "bankFeeds", category: "finance" },
  { key: "fixedAssets", category: "finance" },
  { key: "crm", category: "sales" },
  { key: "orders", category: "sales" },
  { key: "subscriptionBilling", category: "billing" },
  { key: "onlinePayments", category: "billing" },
  { key: "inventory", category: "inventory" },
  { key: "projects", category: "projects" },
  { key: "timeTracking", category: "projects", parentKey: "projects" },
  { key: "fieldTickets", category: "projects", parentKey: "projects" },
  { key: "payroll", category: "people", recommends: ["timeTracking"] },
];

function mount() {
  globalThis.__wizardToasts = [];
  globalThis.__wizardRouter = { push() {}, refresh() {} };
  globalThis.__wizardPath = "/admin/setup/wizard";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return { host, root };
}

type WizardProps = Parameters<typeof SetupWizard>[0];

async function renderWizard(
  host: HTMLElement,
  root: ReturnType<typeof createRoot>,
  overrides: Partial<WizardProps> = {},
) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SetupWizard
          open
          launchActions={['invoice', 'migrate', 'demo']}
          industries={INDUSTRIES}
          initial={{
            name: "Acme",
            legalName: "",
            country: "US",
            baseCurrency: "USD",
            fiscalYearStartMonth: 1,
            timeZone: null,
            industry: null,
            workspaceProfile: {
              teamSize: "solo",
              complexity: "essentials",
              bookStart: "fresh",
              taxPosition: "unsure",
              monthlyActivity: "light",
              closeCadence: "monthly",
            },
            features: { ...TOGGLES },
            allFeatures: { ...TOGGLES },
          }}
          canSwitchIndustry
          isRerun={false}
          payrollPacks={[]}
          timeZones={["UTC", "America/Toronto"]}
          countryTimeZones={{}}
          featureRows={FEATURE_ROWS}
          {...overrides}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function cont() {
  const next = buttonsNamed("Continue")[0];
  assert.ok(next, "the wizard must offer Continue");
  assert.equal(next.disabled, false, "Continue must be enabled on this step");
  await act(async () => {
    next.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick(STEP_WAIT);
}

/** : the company step states its combobox selections as live text, so
 * the selected values survive an accessibility snapshot that cannot expose
 * a native select's current option. */
test("company selections are stated as announced text and track changes", async (t) => {
  const { host, root } = mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await renderWizard(host, root);
  await cont(); // welcome → company
  const country = document.getElementById("setup-country") as HTMLSelectElement;
  const currency = document.getElementById("setup-currency") as HTMLSelectElement;
  const fiscal = document.getElementById("setup-fiscal-month") as HTMLSelectElement;
  assert.ok(country && currency && fiscal, "country/currency/fiscal comboboxes must render with labels");
  assert.equal(country.getAttribute("aria-label"), null, "native selects carry their <label>, not a redundant override");
  const summary = document.querySelector('[aria-live="polite"]');
  assert.ok(summary, "the step must state its selections in a live region");
  const stated = summary.textContent ?? "";
  assert.match(stated, /United States/, "the country selection is stated by name");
  assert.match(stated, /USD/, "the currency selection is stated");
  assert.match(stated, /January/, "the fiscal-month selection is stated");
  // Changing a combobox restates the summary — the selected value stays announced.
  const eur = [...currency.options].find((option) => option.value === "EUR");
  assert.ok(eur, "EUR must be an offered currency");
  await act(async () => {
    currency.value = "EUR";
    currency.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await tick();
  assert.match(
    document.querySelector('[aria-live="polite"]')?.textContent ?? "",
    /Euro/,
    "the restated summary follows the new currency selection",
  );
});

/** : Skip is a deferral — the wizard lands on the canonical home and
 * names where setup resumes, instead of detouring into Setup. */
test("skipping lands on the canonical home naming the resume", async (t) => {
  const { host, root } = mount();
  globalThis.__wizardPath = "/dashboard";
  const pushes: string[] = [];
  let refreshes = 0;
  globalThis.__wizardRouter = {
    push(url: string) {
      pushes.push(url);
    },
    refresh() { refreshes++; },
  };
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await renderWizard(host, root);
  const skip = buttonsNamed("Skip for now")[0];
  assert.ok(skip, "the welcome step must offer Skip");
  await act(async () => {
    skip.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  assert.deepEqual(pushes, ["/dashboard"], "Skip lands on the canonical home, never Setup");
  assert.equal(refreshes, 1, "Skip rereads durable deferral even when already on the dashboard");
  const successes = (globalThis.__wizardToasts ?? []).filter((toast) => toast.kind === "success");
  assert.equal(successes.length, 1, "Skip names the resume in exactly one toast");
  assert.match(successes[0]!.message, /Company Setup/, "the toast says setup resumes from Company Setup");
});

/** TZ1: the company step offers the business time zone from the
 * server-declared list — never hardcoded here — and states it live. */
test("the company step offers exactly the server-declared time zones", async (t) => {
  const { host, root } = mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await renderWizard(host, root);
  await cont(); // welcome → company
  const zone = document.getElementById("setup-time-zone") as HTMLSelectElement;
  assert.ok(zone, "the company step must render a time-zone picker");
  assert.deepEqual(
    [...zone.options].map((option) => option.value),
    ["UTC", "America/Toronto"],
    "the picker offers the server-declared list, nothing hardcoded",
  );
  await act(async () => {
    zone.value = "America/Toronto";
    zone.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await tick();
  assert.match(
    document.querySelector('[aria-live="polite"]')?.textContent ?? "",
    /America\/Toronto/,
    "the restated summary follows the new time-zone selection",
  );
});

/** The zone follows the chosen country until the operator picks one: a US
 *  company never starts on a foreign browser zone such as Toronto. */
test("the business time zone defaults from the chosen country", async (t) => {
  const { host, root } = mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await renderWizard(host, root, {
    timeZones: ["UTC", "America/New_York", "America/Toronto"],
    countryTimeZones: {
      US: { zones: ["America/New_York"], primary: "America/New_York" },
      CA: { zones: ["America/Toronto"], primary: "America/Toronto" },
    },
  });
  await cont(); // welcome → company
  const zone = () => document.getElementById("setup-time-zone") as HTMLSelectElement;
  const country = document.getElementById("setup-country") as HTMLSelectElement;
  assert.equal(zone().value, "America/New_York", "a US company starts on a US zone");
  await act(async () => {
    country.value = "CA";
    country.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await tick();
  assert.equal(zone().value, "America/Toronto", "changing the country moves an unchosen zone with it");
  await act(async () => {
    zone().value = "UTC";
    zone().dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await tick();
  await act(async () => {
    country.value = "US";
    country.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await tick();
  assert.equal(zone().value, "UTC", "a zone the operator chose is never overwritten by a country change");
});

/** TZ1: apply sends the chosen business time zone to the wizard route. */
test("apply sends the chosen business time zone", async (t) => {
  const { host, root } = mount();
  const seen: { url: string; method: string; body: unknown }[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({ ok: true });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await renderWizard(host, root);
  await cont(); // welcome → company
  const zone = document.getElementById("setup-time-zone") as HTMLSelectElement;
  await act(async () => {
    zone.value = "America/Toronto";
    zone.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await tick();
  await cont(); // company → industry
  const card = [...document.querySelectorAll("button[aria-pressed]")].filter((b) =>
    b.textContent?.includes("Manufacturing"),
  )[0] as HTMLButtonElement;
  await act(async () => {
    card.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await cont(); // industry → profile
  await cont(); // profile → operations (optional rhythm deferred)
  await cont(); // operations → launch
  await cont(); // launch → review
  const launch = buttonsNamed("Set up my books")[0];
  assert.ok(launch, "the review step must offer to set up the books");
  await act(async () => {
    launch.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick(STEP_WAIT);
  await tick(STEP_WAIT);
  const puts = seen.filter((request) => request.method === "PUT");
  assert.equal(puts.length, 1, "applying writes the company once");
  assert.ok(buttonsNamed('Create your first invoice')[0], 'setup offers the first useful action');
  assert.ok(buttonsNamed('Continue with the setup checklist')[0], 'unfinished setup remains reachable');
  assert.equal(buttonsNamed('Import a bank statement').length, 0, 'unavailable actions are omitted');
  assert.equal(
    (puts[0]!.body as Record<string, unknown>).timeZone,
    "America/Toronto",
    "apply sends the chosen zone to the wizard route",
  );
});

/** : option cards expose their selection through aria-pressed, and are
 * keyboard-operable native buttons — the industry gate proves it. */
test("industry cards announce selection through aria-pressed", async (t) => {
  const { host, root } = mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await renderWizard(host, root);
  await cont(); // welcome → company
  await cont(); // company → industry
  const cards = [...document.querySelectorAll('button[aria-pressed]')].filter((b) =>
    b.textContent?.includes("Manufacturing"),
  ) as HTMLButtonElement[];
  assert.ok(cards.length > 0, "the manufacturing card must render as a pressable button");
  const card = cards[0]!;
  assert.equal(card.getAttribute("aria-pressed"), "false", "the card starts unpressed");
  assert.equal(card.disabled, false, "the card stays keyboard- and pointer-operable");
  await act(async () => {
    card.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  assert.equal(card.getAttribute("aria-pressed"), "true", "selecting the card announces pressed");
});

/** : the review step badges every value still on its pre-selected
 * default, while a deliberately changed value carries no badge. */
test("review badges click-through defaults and spares deliberate choices", async (t) => {
  const { host, root } = mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await renderWizard(host, root);
  await cont(); // welcome → company
  // Deliberately change the currency away from its USD default.
  const currency = document.getElementById("setup-currency") as HTMLSelectElement;
  await act(async () => {
    currency.value = "EUR";
    currency.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await tick();
  await cont(); // company → industry
  const card = [...document.querySelectorAll('button[aria-pressed]')].filter((b) =>
    b.textContent?.includes("Manufacturing"),
  )[0] as HTMLButtonElement;
  await act(async () => {
    card.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await cont(); // industry → profile (team/complexity stay default)
  await cont(); // profile → operations (activity/close stay default)
  await cont(); // operations → launch (books/tax stay default)
  await cont(); // launch → review
  const review = document.body.textContent ?? "";
  assert.match(review, /Review your setup/, "the walk must reach the review step");
  assert.match(review, /kept their pre-selected value/, "the review must explain the default badges");
  // Untouched consequentials carry the badge …
  assert.match(review, /Default/, "untouched defaults must be badged");
  // … while the deliberately changed currency row does not.
  const rows = [...document.querySelectorAll("div")].filter((div) =>
    div.textContent?.startsWith("Currency"),
  );
  const currencyRow = rows.find((div) => div.textContent?.includes("EUR"));
  assert.ok(currencyRow, "the review must show the changed EUR currency");
  assert.ok(
    !currencyRow.textContent?.includes("Default"),
    "a deliberately changed value must not wear the default badge",
  );
});


test("optional industry data installs a separate workspace and offers direct entry", async (t) => {
  const { host, root } = mount();
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return Response.json(String(input) === '/api/data/sample-companies' ? { ok: true, orgId: '00000000-0000-4000-8000-000000000003' } : { ok: true });
  }) as typeof fetch;
  t.after(async () => { globalThis.fetch = prior; await act(async () => { root.unmount(); }); host.remove(); });
  await renderWizard(host, root);
  await cont(); await cont();
  const industry = [...document.querySelectorAll('button[aria-pressed]')].find((button) => button.textContent?.includes('Manufacturing'))!;
  await act(async () => { industry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick();
  await cont(); await cont(); await cont();
  const sample = [...document.querySelectorAll('button[aria-pressed]')].find((button) => button.textContent?.includes('Create an industry sample company'));
  assert.ok(sample, 'launch offers the optional industry sample');
  assert.equal(sample.getAttribute('aria-pressed'), 'false');
  await act(async () => { sample.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(); await cont();
  await act(async () => { buttonsNamed('Set up my books')[0]!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(STEP_WAIT); await tick(STEP_WAIT);
  const installation = requests.filter((request) => request.url === '/api/data/sample-companies');
  assert.equal(installation.length, 1);
  assert.deepEqual(installation[0]!.body, { industry: 'manufacturing' });
  const enter = document.querySelector('form button[type="submit"]');
  assert.ok(enter, 'completion offers the server-authorized workspace entry action');
  assert.match(enter.textContent ?? '', /sample|demo|Explore/i);
  assert.equal(buttonsNamed(enter.textContent!.trim()).length, 1, 'completion offers one demo entry action');
  assert.ok(buttonsNamed('Create your first invoice')[0], 'the live-company next action remains available');
});

const switchNamed = (label: string) =>
  document.querySelector(`button[role="switch"][aria-label="${label}"]`) as HTMLButtonElement | null;

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
}

/** When no industry fits, the operator picks features on the same
 *  switchboard as Company Settings → Features: children hide and lock behind
 *  their parent, and what is applied is the resolved state on the neutral
 *  chart. */
test("none-of-these-fit picks features on the switchboard with parent rules enforced", async (t) => {
  const { host, root } = mount();
  const seen: { url: string; method: string; body: unknown }[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ ok: true });
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = prior;
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await renderWizard(host, root);
  await cont(); // welcome → company
  await cont(); // company → industry
  const custom = [...document.querySelectorAll("button[aria-pressed]")].find((button) =>
    button.textContent?.includes("None of these fit"),
  ) as HTMLButtonElement;
  assert.ok(custom, "the industry step offers a pick-my-own-features choice");
  await click(custom);
  assert.equal(custom.getAttribute("aria-pressed"), "true");
  await cont(); // industry → profile
  await cont(); // profile → features (the switchboard replaces Operations)
  assert.match(document.body.textContent ?? "", /Choose your features/);
  const projectsTab = [...document.querySelectorAll('button[role="tab"]')].find((tab) => tab.textContent?.startsWith("Projects"))!;
  await click(projectsTab);
  const projects = switchNamed("Projects & job costing");
  assert.ok(projects, "the Projects row renders");
  assert.equal(projects.getAttribute("aria-checked"), "false");
  assert.equal(switchNamed("Field tickets"), null, "a child stays hidden while its parent is off");
  await click(projects);
  const fieldTickets = switchNamed("Field tickets");
  assert.ok(fieldTickets && !fieldTickets.disabled, "turning the parent on reveals its children");
  await click(fieldTickets);
  assert.equal(switchNamed("Field tickets")?.getAttribute("aria-checked"), "true");
  await click(switchNamed("Projects & job costing")!);
  assert.equal(switchNamed("Field tickets"), null, "turning the parent off hides the child again");
  await cont(); // features → launch
  await cont(); // launch → review
  assert.match(document.body.textContent ?? "", /None — features chosen individually/);
  await click(buttonsNamed("Set up my books")[0]!);
  await tick(STEP_WAIT);
  await tick(STEP_WAIT);
  const put = seen.find((request) => request.method === "PUT");
  assert.ok(put, "applying writes the setup");
  const body = put.body as { industry: string; featureSelection: string; features: Record<string, boolean> };
  assert.equal(body.industry, "general_business", "the neutral base chart is installed");
  assert.equal(body.featureSelection, "custom");
  assert.equal(body.features.projects, false);
  assert.equal(body.features.fieldTickets, false, "a child of an off parent is applied off");
});

test("industry search finds the nearest templates by everyday words and offers the custom path on a miss", async (t) => {
  const { host, root } = mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await renderWizard(host, root);
  await cont(); // welcome → company
  await cont(); // company → industry
  const search = document.querySelector('input[type="text"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  const type = async (value: string) => {
    await act(async () => {
      setter.call(search, value);
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await tick();
  };
  const cards = () => [...document.querySelectorAll("button[aria-pressed]")].map((button) => button.textContent ?? "");
  await type("beverage");
  assert.ok(cards().some((text) => text.includes("Manufacturing")), "beverage reaches Manufacturing");
  await type("café");
  assert.ok(cards().some((text) => text.includes("General Business")), "café reaches General Business");
  await type("zzzz-nothing");
  assert.match(document.body.textContent ?? "", /No industry template matches/);
  assert.ok(cards().some((text) => text.includes("None of these fit")), "the custom path stays available on a miss");
});
