import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

declare global {
  var __runTestRouter: { push(url: string): void; refresh(): void } | undefined;
  var __runTestToasts: { kind: string; message: string }[] | undefined;
}

// jsdom first: the builder reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/payments?view=runs&newRun=1",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof dom.window.requestAnimationFrame !== "function") {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame;
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame;
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
        url: "data:text/javascript,export function useRouter(){return globalThis.__runTestRouter}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__runTestToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__runTestToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { MoneyProvider } = await import("../../../components/money-provider");
const { RunBuilder } = await import("./RunBuilder");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function bill(open = "2500.00") {
  return {
    id: randomUUID(),
    document_number: "BILL-00003",
    vendor: "AWS",
    document_date: "2026-12-01",
    due_date: "2026-12-20",
    reference_number: null,
    open,
    currency: "USD",
    has_bank: true,
  };
}

function profile() {
  return {
    id: randomUUID(),
    name: "Fleet6 Operating",
    currency: "USD",
    format_name: "NACHA ACH credit",
    bank_number: "1000",
    bank_name: "Operating Cash",
  };
}

async function mountBuilder(selectedBills = [bill()]) {
  globalThis.__runTestRouter = { push() {}, refresh() {} };
  globalThis.__runTestToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <RunBuilder
            bills={selectedBills}
            bankProfiles={[profile()]}
            sp={{}}
            sort="due"
            dir="asc"
            toolbar={null}
            pagination={null}
            preselected={selectedBills}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root };
}

test('selected bill total retains exact ledger precision beyond JavaScript safe integers', async (t) => {
  const { host, root } = await mountBuilder([bill('9007199254740992.00'), bill('1.00')])
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  const total = document.querySelector('strong')
  assert.ok(total, 'the selected amount is emphasized in the summary')
  assert.match(total.textContent ?? '', /9,007,199,254,740,993\.00/)
})

async function chooseProfile() {
  // Open the bank-profile dropdown and pick the only profile. The menu
  // portals to document.body in both desktop and mobile modes.
  const trigger = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("Select a payment profile"),
  ) as HTMLButtonElement;
  assert.ok(trigger, "bank profile trigger must render");
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  const option = [...document.querySelectorAll('button[role="option"]')].find((el) =>
    el.textContent?.includes("Fleet6 Operating"),
  ) as HTMLButtonElement;
  assert.ok(option, "bank profile option must render");
  await act(async () => {
    option.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
}

async function clickCreate() {
  const create = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("Create payment run"),
  ) as HTMLButtonElement;
  assert.ok(create, "create button must render");
  assert.equal(create.disabled, false, "create must be enabled with a bill and profile selected");
  // Dispatch inside act; settle outside it so a rejection escaping the
  // handler cannot reject into act and poison later mounts.
  await act(async () => {
    create.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();
}

/** F-t04-005: a bill already in a draft run must explain the 422 in a persistent alert. */
test("a duplicate-in-draft rejection persists as a form-level alert", async (t) => {
  const calls: string[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${String(input)}`);
    return Response.json({ error: "BILL-00003 is already in draft run RUN-00001" }, { status: 422 });
  }) as typeof fetch;
  const { host, root } = await mountBuilder();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await chooseProfile();
  await clickCreate();
  await tick();
  assert.ok(calls.some((call) => call.startsWith("POST ")), "the blocked create must reach the API");
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the rejection must persist as a form-level alert");
  assert.match(alert.textContent ?? "", /already in draft run/i);
  const errors = (globalThis.__runTestToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "the rejection must also surface exactly one error toast");
  const create = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("Create payment run"),
  ) as HTMLButtonElement;
  assert.equal(create.disabled, false, "the button must release after the rejection");
});
