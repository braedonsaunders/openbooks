import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
}

// A posted cash sale's till drop: the cashier records amount, drop date,
// bank destination and slip number as a native transfer from the Tenders
// tab. A refused drop must show the error WITH its remedy (the operator's
// next step), and with no configured deposit accounts the section names
// Company Settings instead of rendering a form that can only refuse.

// jsdom first: the section reads browser globals at render.
const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/cash-sales", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return '/cash-sales'}export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__drawerToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__drawerToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__drawerToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
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
const messages = (await import("../messages/en")).default;
const { CashDepositSection } = await import("./cash-deposit-section");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const SALE_ID = "11111111-1111-4111-8111-111111111111";
const BANK_A = "22222222-2222-4222-8222-222222222222";
const BANK_B = "33333333-3333-4333-8333-333333333333";

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      body = {};
    }
    calls.push({ url, body });
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = prior;
    },
  };
}

async function mount(props: {
  bankOptions: { value: string; label: string }[];
  sourceOptions?: { value: string; label: string }[];
  subsidiaryId?: string;
  mode?: "sale" | "till";
  modes?: ("sale" | "till")[];
}) {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CashDepositSection
          saleId={SALE_ID}
          currency="USD"
          defaultDate="2026-10-05"
          bankOptions={props.bankOptions}
          sourceOptions={props.sourceOptions ?? []}
          subsidiaryId={props.subsidiaryId}
          {...(props.mode ? { mode: props.mode } : {})}
          {...(props.modes ? { modes: props.modes } : {})}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return { host, root };
}

function setInput(host: HTMLElement, label: string, value: string) {
  const input = [...host.querySelectorAll("input")].find((node) =>
    (node.getAttribute("aria-label") ?? "").startsWith(label),
  ) as HTMLInputElement | undefined;
  assert.ok(input, `expected an input labelled ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

function slipInput(host: HTMLElement): HTMLInputElement {
  const inputs = [...host.querySelectorAll("input")].filter(
    (node) =>
      !node.hasAttribute("data-date-field") &&
      node.getAttribute("type") !== "hidden" &&
      node.getAttribute("type") !== "checkbox",
  );
  assert.equal(inputs.length, 2, "amount and slip inputs must render");
  return inputs[1] as HTMLInputElement;
}

function recordButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === messages.ar.tenders.depositAction,
  );
  assert.ok(button, "expected a Record deposit button");
  return button as HTMLButtonElement;
}

test("no configured deposit accounts names Company Settings instead of a form", async (t) => {
  const { restore } = scriptFetch(() => null);
  t.after(restore);
  const { host, root } = await mount({ bankOptions: [] });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  const body = host.textContent ?? "";
  assert.ok(body.includes(messages.ar.tenders.depositNeedsSetup), "the setup remedy must render");
  assert.ok(body.includes("Company Settings"), "the remedy must name the screen that fixes it");
  assert.equal(
    [...host.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === messages.ar.tenders.depositAction,
    ).length,
    0,
    "no form means no Record button that could only refuse",
  );
});

test("a recorded drop toasts the transfer number and clears the form", async (t) => {
  const { calls, restore } = scriptFetch((url, init) => {
    if (url === `/api/cash-sales/${SALE_ID}/deposit` && init?.method === "POST") {
      return Response.json(
        {
          id: "44444444-4444-4444-8444-444444444441",
          documentNumber: "TRF-00007",
          posted: true,
          entryId: "55555555-5555-4555-8555-555555555555",
        },
        { status: 201 },
      );
    }
    return null;
  });
  t.after(restore);
  const { host, root } = await mount({
    bankOptions: [{ value: BANK_A, label: "1100 · Operating" }],
  });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  setInput(host, messages.ar.tenders.depositAmount, "50.00");
  await tick();
  act(() => {
    const slip = slipInput(host);
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      slip,
      "SLIP-1",
    );
    slip.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    recordButton(host).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  // The section loads the recorded drops with a GET on mount and again
  // after a write, so only the POST calls count as drop writes.
  const posts = calls.filter((call) => typeof call.body.amount === "string");
  assert.equal(posts.length, 1, "one drop POST must fire");
  assert.deepEqual(
    posts[0]?.body,
    { amount: "50.00", date: "2026-10-05", bankAccountId: BANK_A, slipNumber: "SLIP-1" },
    "the drop carries amount, date, destination and slip — and no source choice for a single till",
  );
  assert.ok(
    (globalThis.__drawerToasts ?? []).some(
      (toast) => toast.kind === "success" && toast.message.includes("TRF-00007"),
    ),
    "a recorded drop must toast the transfer number",
  );
  assert.ok(
    (host.textContent ?? "").includes("TRF-00007"),
    "the saved transfer number must stay visible beside the form",
  );
});

test("a refused drop shows the error with its remedy", async (t) => {
  const { restore } = scriptFetch((url, init) => {
    if (url === `/api/cash-sales/${SALE_ID}/deposit` && init?.method === "POST") {
      return Response.json(
        {
          error: "Drop exceeds undropped till cash of 12.00.",
          remedy: "Lower the amount or record a second drop.",
        },
        { status: 422 },
      );
    }
    return null;
  });
  t.after(restore);
  const { host, root } = await mount({
    bankOptions: [{ value: BANK_A, label: "1100 · Operating" }],
  });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  setInput(host, messages.ar.tenders.depositAmount, "50.00");
  await tick();
  await act(async () => {
    recordButton(host).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert, "a refused drop must render its refusal in the section");
  assert.ok(alert.textContent?.includes("12.00"), "the refusal names the undropped balance");
  assert.ok(
    alert.textContent?.includes("Lower the amount"),
    "the refusal carries the remedy, not just the error",
  );
  assert.ok(
    !(globalThis.__drawerToasts ?? []).some((toast) => toast.kind === "success"),
    "a refused drop must not toast success",
  );
});

test("two till accounts offer the source choice and send it", async (t) => {
  const { calls, restore } = scriptFetch((url, init) => {
    if (url === `/api/cash-sales/${SALE_ID}/deposit` && init?.method === "POST") {
      return Response.json(
        {
          id: "44444444-4444-4444-8444-444444444442",
          documentNumber: "TRF-00008",
          posted: true,
          entryId: "55555555-5555-4555-8555-555555555555",
        },
        { status: 201 },
      );
    }
    return null;
  });
  t.after(restore);
  const { host, root } = await mount({
    bankOptions: [
      { value: BANK_A, label: "1100 · Operating" },
      { value: BANK_B, label: "1110 · Savings" },
    ],
    sourceOptions: [
      { value: "till-1", label: "1000 · Till 1" },
      { value: "till-2", label: "1010 · Till 2" },
    ],
  });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  const selects = [...host.querySelectorAll("select")];
  const source = selects.find((node) => [...node.options].some((o) => o.value === "till-2")) as
    HTMLSelectElement | undefined;
  assert.ok(source, "two till accounts must offer the source choice");
  await act(async () => {
    source.value = "till-2";
    source.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick();
  });
  setInput(host, messages.ar.tenders.depositAmount, "20.00");
  await tick();
  await act(async () => {
    recordButton(host).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  // The section loads the recorded drops with a GET on mount, so the drop
  // write is the POST call, not necessarily the first fetch.
  const post = calls.find((call) => typeof call.body.amount === "string");
  assert.equal(post?.body?.sourceAccountId, "till-2", "the chosen till account must ride the drop");
});

test("a posted sale's till drop records against the till window, not the sale's own cash", async (t) => {
  const { calls, restore } = scriptFetch((url, init) => {
    if (url === "/api/cash-sales/till-drops" && init?.method === "POST") {
      return Response.json(
        {
          id: "44444444-4444-4444-8444-444444444443",
          documentNumber: "TRF-00009",
          posted: true,
          entryId: "55555555-5555-4555-8555-555555555555",
        },
        { status: 201 },
      );
    }
    return null;
  });
  t.after(restore);
  const { host, root } = await mount({
    bankOptions: [{ value: BANK_A, label: "1100 · Operating" }],
    sourceOptions: [{ value: "till-1", label: "1000 · Till 1" }],
    mode: "till",
    subsidiaryId: "00000000-0000-4000-8000-000000000123",
    modes: ["till", "sale"],
  });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  const scopes = [...host.querySelectorAll('input[type="radio"]')];
  assert.equal(scopes.length, 2, "a posted sale offers the till drop beside its own cash");
  setInput(host, messages.ar.tenders.depositAmount, "1009.50");
  await tick();
  await act(async () => {
    recordButton(host).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  const post = calls.find(
    (call) => call.url === "/api/cash-sales/till-drops" && typeof call.body.amount === "string",
  );
  assert.equal(post?.body.subsidiaryId, "00000000-0000-4000-8000-000000000123");
  assert.ok(
    calls.some((call) => call.url.includes("subsidiaryId=00000000-0000-4000-8000-000000000123")),
    "preview and recording use the same host-selected entity",
  );
  assert.equal(post?.body?.tillAccountId, "till-1", "a multi-day drop records against the till");
});

for (const mode of ["sale", "till"] as const) {
  for (const pendingApproval of [true, false]) {
    test(`${mode} deposit retains its saved identity and actual unposted outcome`, async (t) => {
      const postRefusal = pendingApproval
        ? "Waiting on the configured approval flow."
        : "The period is closed; request a controlled reopen in Banking.";
      const { calls, restore } = scriptFetch((_url, init) =>
        init?.method === "POST"
          ? Response.json(
              {
                id: "44444444-4444-4444-8444-444444444449",
                documentNumber: "TRF-00019",
                posted: false,
                entryId: null,
                ...(pendingApproval ? { pendingApproval: true } : {}),
                postRefusal,
              },
              { status: 201 },
            )
          : null,
      );
      t.after(restore);
      const { host, root } = await mount({
        bankOptions: [{ value: BANK_A, label: "Operating Bank" }],
        sourceOptions: [{ value: BANK_B, label: "Till" }],
        mode,
      });
      t.after(async () => {
        await act(async () => root.unmount());
        host.remove();
      });
      setInput(host, messages.ar.tenders.depositAmount, "50.00");
      await act(async () => {
        recordButton(host).click();
        await tick();
      });
      await tick();
      const notice = host.querySelector('[role="alert"]');
      assert.ok(
        notice?.textContent?.includes("TRF-00019"),
        "the saved transfer stays identifiable",
      );
      assert.ok(
        notice?.textContent?.includes(postRefusal),
        "the actual native refusal remains visible",
      );
      assert.ok(
        notice?.textContent?.includes(pendingApproval ? "awaiting approval" : "posting refused"),
      );
      assert.equal(
        (globalThis.__drawerToasts ?? []).filter((toast) => toast.kind === "success").length,
        0,
        "unposted is never presented as posted success",
      );
      assert.equal(
        calls.filter((call) => typeof call.body.amount === "string").length,
        1,
        "the saved drop is not retried",
      );
      const amount = host.querySelector(
        'input[aria-label="Amount (USD)"]',
      ) as HTMLInputElement | null;
      assert.equal(
        amount?.value,
        "",
        "a saved transfer clears its consumed amount even when posting is refused",
      );
    });
  }
}

test("a malformed successful outcome never implies the drop was posted", async (t) => {
  const { calls, restore } = scriptFetch((_url, init) =>
    init?.method === "POST"
      ? Response.json({ documentNumber: "TRF-00020", posted: "true" }, { status: 201 })
      : null,
  );
  t.after(restore);
  const { host, root } = await mount({ bankOptions: [{ value: BANK_A, label: "Operating Bank" }] });
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  setInput(host, messages.ar.tenders.depositAmount, "50.00");
  await act(async () => {
    recordButton(host).click();
    await tick();
  });
  await tick();
  assert.ok(
    host
      .querySelector('[role="alert"]')
      ?.textContent?.includes("Check Banking before recording it again"),
  );
  assert.equal(
    (globalThis.__drawerToasts ?? []).filter((toast) => toast.kind === "success").length,
    0,
  );
  assert.equal(calls.filter((call) => typeof call.body.amount === "string").length, 1);
});

test("a lost deposit response requires native readback before another command", async (t) => {
  const { calls, restore } = scriptFetch((_url, init) => {
    if (init?.method === "POST") throw new TypeError("Network response lost");
    return null;
  });
  t.after(restore);
  const { host, root } = await mount({ bankOptions: [{ value: BANK_A, label: "Operating Bank" }] });
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  setInput(host, messages.ar.tenders.depositAmount, "50.00");
  await act(async () => {
    recordButton(host).click();
    await tick();
  });
  await tick();
  assert.ok(
    host
      .querySelector('[role="alert"]')
      ?.textContent?.includes("Check Banking before recording it again"),
  );
  assert.equal(
    (globalThis.__drawerToasts ?? []).filter((toast) => toast.kind === "success").length,
    0,
  );
  assert.equal(
    calls.filter((call) => typeof call.body.amount === "string").length,
    1,
    "the caller never automatically replays an uncertain write",
  );
});
