import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

// The lease drawer was hard-coded English and parsed mutation
// responses before checking the status. Mounts the real LeaseDrawer under
// jsdom and asserts the summary chrome renders through the catalog (en)
// and a failed commence toasts the translated fallback with the status.
const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/assets/leases?lease=00000000-0000-0000-0000-000000000001",
  matchMediaMatches: false,
  scrollIntoView: false,
  resizeObserver: false,
});

const script = {
  errors: [] as string[],
};
Object.assign(globalThis, {
  __leasesTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
});
const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation:
    'export function useRouter(){return globalThis.__leasesTestRouter}export function usePathname(){return "/assets/leases"}export function useSearchParams(){return new URLSearchParams()}',
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(m){(globalThis.__leasesErrorToasts ?? []).push(String(m))}};export function Toaster(){return null}",
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
const messages = (await import("../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { BusinessDateProvider } = await import("../../../../components/business-date-provider");
const { LeaseDrawer } = await import("./LeaseDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const payload = {
  lease: {
    id: "00000000-0000-0000-0000-000000000001",
    lease_number: "L-001",
    description: "Head office",
    status: "draft",
    subsidiary_id: "00000000-0000-0000-0000-000000000002",
    commencement_on: "2026-01-01",
    term_periods: 12,
    payment_frequency: "monthly",
    payment_timing: "arrears",
    payment_amount: "1000.00",
    annual_discount_rate_percent: "5.00",
    classification: "operating",
    initial_liability: null,
    initial_rou_asset: null,
    revision: 1,
    classification_inputs: {},
  },
  schedule: [
    {
      id: "00000000-0000-0000-0000-000000000003",
      sequence: 1,
      revision: 1,
      due_on: "2026-01-31",
      period_end: "2026-01-31",
      payment: "1000.00",
      interest: "4.07",
      amortization: null,
      single_cost: null,
      payment_posted: false,
      accrual_posted: false,
      superseded: false,
    },
  ],
  changes: [],
} as unknown as Parameters<typeof LeaseDrawer>[0]["payload"];

async function mount(
  t: TestContext,
  responder: () => Response,
  view: Parameters<typeof LeaseDrawer>[0]["payload"] = payload,
): Promise<void> {
  script.errors = [];
  (globalThis as Record<string, unknown>).__leasesErrorToasts = script.errors;
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => responder()) as typeof fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const rootHandle = createRoot(host);
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount();
    });
    host.remove();
    for (const node of [...document.body.children]) node.remove();
  });
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-01">
            <LeaseDrawer payload={view} canManage accounts={[]} subsidiaries={[]} />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    for (let i = 0; i < 6; i++) await tick();
  });
}

function clickByText(text: string): void {
  const el = [...document.querySelectorAll("button")].find((b) => b.textContent === text);
  assert.ok(el, `a "${text}" button must render`);
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

test("the lease summary chrome renders translated", async (t) => {
  await mount(t, () => Response.json({}));
  const text = document.body.textContent ?? "";
  assert.ok(text.includes("Payment and accrual history"), "the schedule title must render");
  assert.ok(text.includes("Initial unpaid liability"), "the liability label must render");
  assert.ok(text.includes("Not commenced"), "the uncommenced fallback must render");
  assert.ok(text.includes("Commence lease"), "the commence action must render");
  assert.ok(text.includes("Planned"), "the schedule status must render");
  assert.ok(!/leases\.[a-zA-Z]+/.test(text), "no untranslated key path may leak into the chrome");
});

test("a failed commence toasts the translated fallback with the status", async (t) => {
  await mount(
    t,
    () =>
      new Response("<html>Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
  );
  await act(async () => {
    clickByText("Commence lease");
    for (let i = 0; i < 6; i++) await tick();
  });
  assert.deepEqual(script.errors, ["Lease action failed (status 502)"]);
});

test("the economic life input keeps numeric values without rendering NaN", async (t) => {
  const activePayload = {
    ...payload,
    lease: { ...payload.lease, status: "active" },
  } as Parameters<typeof LeaseDrawer>[0]["payload"];
  await mount(t, () => Response.json({}), activePayload);
  await act(async () => {
    clickByText("Change / terminate");
    await tick();
  });
  const life = document.querySelector<HTMLInputElement>('input[type="number"]');
  assert.ok(life);
  assert.equal(life.type, "number");
  assert.notEqual(life.value, "NaN");
});

test("a separate lease form exposes and submits both classification thresholds", async (t) => {
  const activePayload = {
    ...payload,
    lease: { ...payload.lease, status: "active" },
  } as Parameters<typeof LeaseDrawer>[0]["payload"];
  const submitted: { body?: Record<string, unknown> } = {};
  await mount(t, () => Response.json({ changeId: "change-1" }), activePayload);
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    submitted.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ changeId: "change-1" });
  }) as typeof fetch;
  await act(async () => {
    clickByText("Add separate lease");
    await tick();
  });
  const setInput = async (label: string, value: string) => {
    const input = [...document.querySelectorAll<HTMLInputElement>("input")].find(
      (candidate) => candidate.getAttribute("aria-label") === label,
    );
    assert.ok(input, `${label} input should be available`);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  };
  await setInput("Major part threshold (%)", "80");
  await setInput("Substantially all threshold (%)", "95");
  await act(async () => {
    clickByText("Create approval proposal");
    for (let i = 0; i < 6; i++) await tick();
  });
  const agreement = submitted.body?.separateLease as
    { agreement?: { classificationInputs?: Record<string, unknown> } } | undefined;
  assert.equal(agreement?.agreement?.classificationInputs?.termThresholdPercent, "80");
  assert.equal(agreement?.agreement?.classificationInputs?.pvThresholdPercent, "95");
});
