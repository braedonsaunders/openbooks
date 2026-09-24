// The wage-rate form's decimal and refusal contracts, proved by driving the
// real EmployeeWageRates component — not by matching its source text or by
// executing an extracted copy of its submit closure.
//
// Defects covered: exact-decimal persistence (valid numeric(19,4) text must
// reach the API as canonical strings, never through Number), F-t05-001 (a
// refused save must pin the server's reason on the record until the next
// attempt, not toast-and-vanish).
import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __wageToasts: { kind: string; message: string }[] | undefined;
}

// jsdom first: the panel reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/entities/employees",
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
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__wageToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__wageToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__wageToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
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
const enMessages = (await import("../../../messages/en")).default as Record<string, unknown>;
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { EmployeeWageRates } = await import("./EmployeeWageRates");

function msg(path: string): string {
  let node: unknown = enMessages;
  for (const part of path.split(".")) node = (node as Record<string, unknown>)[part];
  if (typeof node !== "string") throw new Error(`missing message ${path}`);
  return node;
}
const WAGES = {
  add: msg("parties.drawer.wages.add"),
  rateRequired: msg("parties.drawer.wages.rateRequired"),
  annualHoursRequired: msg("parties.drawer.wages.annualHoursRequired"),
  saveFailed: msg("parties.drawer.wages.saveFailed"),
  saved: msg("parties.drawer.wages.saved"),
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

interface PostedRate {
  url: string;
  body: Record<string, unknown>;
}

async function renderRates(posted: PostedRate[], postQueue: Response[]) {
  globalThis.__wageToasts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.startsWith("/api/admin/setup/labor-costing")) {
      if (init?.method === "POST") {
        posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        const next = postQueue.shift();
        return next ?? Response.json({});
      }
      return Response.json({ rates: [], currencies: ["CAD"], defaultCurrency: "CAD" });
    }
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <BusinessDateProvider today="2026-08-28">
          <EmployeeWageRates partyId="employee-1" />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return {
    done: async () => {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

async function addButton(): Promise<HTMLButtonElement> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === WAGES.add,
    ) as HTMLButtonElement | undefined;
    if (button && !button.disabled) return button;
    if (Date.now() > deadline) throw new Error("the wage form never finished loading");
    await tick();
  }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function setNativeSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

async function setRate(value: string) {
  const input = document.querySelector("#employee-wage-rate") as HTMLInputElement | null;
  assert.ok(input, "the form must offer a rate input");
  await act(async () => {
    setInputValue(input, value);
    await tick();
  });
  await tick();
}

async function setYearlyBasis(annualHours: string) {
  const basis = [...document.querySelectorAll("select")].find((candidate) =>
    [...candidate.options].some((option) => option.value === "year"),
  ) as HTMLSelectElement | undefined;
  assert.ok(basis, "the form must offer an hour/year basis");
  await act(async () => {
    setNativeSelect(basis, "year");
    await tick();
  });
  await tick();
  const hours = document.querySelector("#employee-wage-annual-hours") as HTMLInputElement | null;
  assert.ok(hours, "a yearly basis must ask for annual hours");
  await act(async () => {
    setInputValue(hours, annualHours);
    await tick();
  });
  await tick();
}

async function clickAdd() {
  const button = await addButton();
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
}

test("adding a rate posts canonical decimal strings and clears the form", async (t) => {
  const posted: PostedRate[] = [];
  const { done } = await renderRates(posted, []);
  t.after(done);
  await setRate("0012.3456");
  await setYearlyBasis("02080.1250");
  await clickAdd();

  assert.equal(posted.length, 1, "one submit must post one payload");
  const body = posted[0]?.body;
  assert.ok(body, "the post must carry a payload");
  assert.equal(body.action, "save-rate");
  assert.equal(body.rate, "12.3456");
  assert.equal(typeof body.rate, "string", "the rate must stay decimal text, never a float");
  assert.equal(body.annualHours, "2080.125");
  assert.equal(typeof body.annualHours, "string");
  assert.equal(
    (document.querySelector("#employee-wage-rate") as HTMLInputElement).value,
    "",
    "a saved rate must clear the form",
  );
  const toasts = globalThis.__wageToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "success" && toast.message === WAGES.saved),
    "a saved rate must confirm",
  );
});

test("large decimal text posts exactly, never rounded through Number", async (t) => {
  const posted: PostedRate[] = [];
  const { done } = await renderRates(posted, []);
  t.after(done);
  await setRate("9007199254740993.1234");
  await setYearlyBasis("9007199254740993.0001");
  await clickAdd();

  assert.equal(posted.length, 1, "one submit must post one payload");
  assert.equal(posted[0]?.body.rate, "9007199254740993.1234");
  assert.equal(posted[0]?.body.annualHours, "9007199254740993.0001");
});

test("exponent, NaN, and infinite input never posts", async (t) => {
  const posted: PostedRate[] = [];
  const { done } = await renderRates(posted, []);
  t.after(done);
  for (const invalid of ["1e3", "NaN", "Infinity", "-Infinity"]) {
    globalThis.__wageToasts = [];
    await setRate(invalid);
    await clickAdd();
    assert.equal(posted.length, 0, `${invalid} must not post`);
    const toasts = globalThis.__wageToasts ?? [];
    assert.ok(
      toasts.some((toast) => toast.kind === "error" && toast.message === WAGES.rateRequired),
      `${invalid} must explain the rate is invalid`,
    );

    globalThis.__wageToasts = [];
    await setRate("42.125");
    await setYearlyBasis(invalid);
    await clickAdd();
    assert.equal(posted.length, 0, `${invalid} annual hours must not post`);
    const hourToasts = globalThis.__wageToasts ?? [];
    assert.ok(
      hourToasts.some((toast) => toast.kind === "error" && toast.message === WAGES.annualHoursRequired),
      `${invalid} must explain the annual hours are invalid`,
    );
  }
});

// F-t05-001 read as a silent no-op: the refused save toasted a generic
// failure for 4 seconds and left nothing on the record. The refusal must
// render as a persistent alert carrying the server's reason, and clear only
// when the next mutation starts.
test("a refused save pins the server reason until the next attempt", async (t) => {
  const posted: PostedRate[] = [];
  const { done } = await renderRates(posted, [
    Response.json({ error: "Rate overlaps an existing rate" }, { status: 422 }),
    Response.json({}),
  ]);
  t.after(done);
  await setRate("42.125");
  await clickAdd();

  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must pin as an alert, not vanish with the toast");
  assert.match(alert.textContent ?? "", /Rate overlaps an existing rate/, "the alert must carry the server reason");
  assert.match(alert.textContent ?? "", new RegExp(WAGES.saveFailed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the alert keeps the familiar heading");
  const add = await addButton();
  assert.equal(add.disabled, false, "busy must release after the refusal");

  await clickAdd();
  assert.equal(document.querySelector('[role="alert"]'), null, "the next attempt must clear the pinned refusal");
  const toasts = globalThis.__wageToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "success" && toast.message === WAGES.saved),
    "the retry must confirm the save",
  );
});
