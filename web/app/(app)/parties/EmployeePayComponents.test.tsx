// The recurring-components form's decimal and refusal contracts, proved by
// driving the real EmployeePayComponents panel — not by matching its source
// text or by executing an extracted copy of its submit closure.
//
// Defects covered: exact-decimal persistence (a valid numeric(19,4) override
// must reach the API as a canonical string, never through Number), and a
// refused save must pin the server's reason on the record until the next
// attempt, not toast-and-vanish.
import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __payComponentToasts: { kind: string; message: string }[] | undefined;
}

// jsdom first: the panel reads browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/entities/employees", matchMediaMatches: false });

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(m){(globalThis.__payComponentToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__payComponentToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__payComponentToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const enMessages = (await import("../../../messages/en")).default as Record<string, unknown>;
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { EmployeePayComponents } = await import("./EmployeePayComponents");

function msg(path: string): string {
  let node: unknown = enMessages;
  for (const part of path.split(".")) node = (node as Record<string, unknown>)[part];
  if (typeof node !== "string") throw new Error(`missing message ${path}`);
  return node;
}
const COPY = {
  add: msg("parties.drawer.payComponents.add"),
  saved: msg("parties.drawer.payComponents.saved"),
  saveFailed: msg("parties.drawer.payComponents.saveFailed"),
  title: msg("parties.drawer.payComponents.title"),
  save: msg("common.actions.save"),
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

interface PostedAssignment {
  url: string;
  body: Record<string, unknown>;
}

const COMPONENTS = [
  { id: "comp-coveralls", code: "COVERALLS", name: "Coveralls", kind: "deduction", basis: "fixed_amount", value: "25", paymentKind: "cash", country: "CA" },
];

async function renderPanel(posted: PostedAssignment[], postQueue: Response[], assignments: Record<string, unknown>[] = []) {
  globalThis.__payComponentToasts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.startsWith("/api/payroll/employee-components")) {
      if (init?.method === "POST") {
        posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        const next = postQueue.shift();
        return next ?? Response.json({ ok: true, id: "assignment-1" });
      }
      return Response.json({ assignments, components: COMPONENTS, employments: [] });
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
          <EmployeePayComponents partyId="employee-1" />
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

async function enabledButton(label: string): Promise<HTMLButtonElement> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined;
    if (button && !button.disabled) return button;
    if (Date.now() > deadline) throw new Error(`the ${label} action never became available`);
    await tick();
  }
}

/** A match outside any drawer still playing its exit animation. */
function live<T extends Element>(selector: string): T | null {
  return ([...document.querySelectorAll(selector)] as T[]).find((node) => !node.closest("[data-overlay-exiting]")) ?? null;
}

/** The list's top-right add action; enabled once the panel has loaded. */
function addButton(): Promise<HTMLButtonElement> {
  return enabledButton(COPY.add);
}

/** The assignment form lives in the Add drawer opened from the list. */
async function openAssignmentDrawer() {
  if (live("#employee-pay-value")) return;
  const add = await addButton();
  await act(async () => {
    add.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
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

async function chooseComponent() {
  await openAssignmentDrawer();
  const select = [...document.querySelectorAll("select")].find((candidate) =>
    !candidate.closest("[data-overlay-exiting]") && candidate.querySelector('option[value="comp-coveralls"]'),
  );
  assert.ok(select, "the form must offer a component picker");
  await act(async () => {
    setNativeSelect(select, "comp-coveralls");
    await tick();
  });
  await tick();
}

async function setValue(value: string) {
  const input = live<HTMLInputElement>("#employee-pay-value");
  assert.ok(input, "the form must offer an override value input");
  await act(async () => {
    setInputValue(input, value);
    await tick();
  });
  await tick();
}

async function clickAdd() {
  await openAssignmentDrawer();
  const button = await enabledButton(COPY.save);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
}

test("assigning posts canonical decimal strings and clears the value", async (t) => {
  const posted: PostedAssignment[] = [];
  const { done } = await renderPanel(posted, []);
  t.after(done);
  await chooseComponent();
  await setValue("0025.5000");
  await clickAdd();

  assert.equal(posted.length, 1, "one submit must post one payload");
  const body = posted[0]?.body;
  assert.ok(body, "the post must carry a payload");
  assert.equal(body.action, "save-assignment");
  assert.equal(body.componentId, "comp-coveralls");
  assert.equal(body.value, "25.5");
  assert.equal(typeof body.value, "string", "the override must stay decimal text, never a float");
  assert.equal(body.employmentId, null);
  assert.equal(body.runApplicability, "standard_runs");
  await openAssignmentDrawer();
  assert.equal(
    live<HTMLInputElement>("#employee-pay-value")?.value,
    "",
    "a saved assignment must clear the override",
  );
  const toasts = globalThis.__payComponentToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "success" && toast.message === COPY.saved),
    "a saved assignment must toast success",
  );
});

test("a refused save pins the server reason on the record", async (t) => {
  const posted: PostedAssignment[] = [];
  const refusal = "Route Assignment Employee already holds COVERALLS for 2026-01-01 to open — end that assignment before starting an overlapping one";
  const { done } = await renderPanel(posted, [Response.json({ error: refusal }, { status: 422 })]);
  t.after(done);
  await chooseComponent();
  await clickAdd();

  assert.equal(posted.length, 1);
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must stay visible on the record");
  assert.match(alert.textContent ?? "", /already holds COVERALLS/);
  const toasts = globalThis.__payComponentToasts ?? [];
  assert.ok(toasts.some((toast) => toast.kind === "error"), "the refusal must also toast an error");

  await clickAdd();
  assert.equal(posted.length, 2, "the next attempt must post again");
  assert.equal(document.querySelector('[role="alert"]'), null, "the next attempt must clear the pinned refusal");
});

test("existing assignments render their component and window", async (t) => {
  const posted: PostedAssignment[] = [];
  const { done } = await renderPanel(posted, [], [{
    id: "assignment-9", employeePartyId: "employee-1", employmentId: null,
    componentId: "comp-coveralls", componentCode: "COVERALLS", componentName: "Coveralls",
    componentKind: "deduction", componentBasis: "fixed_amount", value: null, componentValue: "25",
    effectiveFrom: "2026-01-01", effectiveTo: null, isCurrent: true,
  }]);
  t.after(done);
  await addButton();
  assert.match(document.body.textContent ?? "", /COVERALLS/);
  assert.match(document.body.textContent ?? "", new RegExp(COPY.title));
});


test("regular-only assignments retain the selected policy in the API and reset after saving", async (t) => {
  const posted: PostedAssignment[] = [];
  const { done } = await renderPanel(posted, []);
  t.after(done);
  await chooseComponent();
  const select = [...document.querySelectorAll('select')].find(candidate => candidate.querySelector('option[value="regular_only"]')) as HTMLSelectElement;
  assert.ok(select);
  await act(async () => { setNativeSelect(select, 'regular_only'); await tick(); });
  await clickAdd();
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.body.runApplicability, 'regular_only');
  await openAssignmentDrawer();
  const reopened = [...document.querySelectorAll('select')].find(candidate => !candidate.closest('[data-overlay-exiting]') && candidate.querySelector('option[value="regular_only"]')) as HTMLSelectElement;
  assert.equal(reopened.value, 'standard_runs');
});
