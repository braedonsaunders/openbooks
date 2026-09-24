import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the workspace reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/setup/project-types",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
// SearchSelect measures its trigger through matchMedia; jsdom has none.
if (typeof dom.window.matchMedia !== "function") {
  const stub = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  });
  dom.window.matchMedia = stub as unknown as typeof window.matchMedia;
  globals.matchMedia = stub;
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
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(
          "export function useRouter(){return {refresh(){},push(){},replace(){},back(){},forward(){}}};export function redirect(){throw new Error('redirect')};export function notFound(){throw new Error('notFound')}",
        ),
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
const messages = (await import("../../../../../messages/en")).default;
const { BusinessDateProvider } = await import("../../../../../components/business-date-provider");
const { ConfirmRoot } = await import("../../../../../lib/confirm");
const { ProjectTypesWorkspace } = await import("./ProjectTypesWorkspace");
import type { ProjectTypeRow } from "./ProjectTypesWorkspace";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// Minimal rows: the general tab (where the test edits) reads name/key/
// description/billingMethod/sortOrder plus invoicingProfile.billingProcedure.
// Nested profiles ride casts — the profitability tab is never opened here,
// and any edit trips the same full-draft dirty comparison.
function row(id: string, name: string): ProjectTypeRow {
  return {
    id,
    key: id,
    name,
    description: null,
    isBuiltIn: false,
    isActive: true,
    sortOrder: 10,
    billingMethod: "time_and_materials",
    financialProfile: {},
    financialProfileEffectiveFrom: null,
    invoicingProfile: { billingProcedure: "standard" },
    backupProfile: {},
  } as unknown as ProjectTypeRow;
}

const TYPES = [row("t1", "Alpha type"), row("t2", "Beta type")];

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-23">
          <ProjectTypesWorkspace types={TYPES} dimensions={[]} incomeAccounts={[]} fieldTicketsEnabled={false} />
          <ConfirmRoot />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root };
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === text);
  assert.ok(found, `a button reading exactly ${JSON.stringify(text)} must render`);
  return found as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
}

function setNativeValue(element: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function nameInput(host: HTMLElement): HTMLInputElement {
  const found = [...host.querySelectorAll("input")].find((i) =>
    ["Alpha type", "Beta type"].some((v) => (i as HTMLInputElement).value.startsWith(v)),
  ) as HTMLInputElement | undefined;
  assert.ok(found, "the editor name input must render");
  return found;
}

/** F4T2-11: switching types with unsaved edits prompts instead of silently
 * discarding the draft — cancel keeps the draft, confirm switches. */
test("switching types with unsaved edits prompts before discarding", async (t) => {
  const { host, root } = await mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await tick();
  const name = nameInput(host);
  assert.equal(name.value, "Alpha type");
  // Clean switch needs no confirmation.
  await click(buttonByText(host, "Beta type"));
  assert.equal(name.value, "Beta type");
  // Back to the first type, then dirty the draft.
  await click(buttonByText(host, "Alpha type"));
  await act(async () => {
    setNativeValue(name, "Alpha type edited");
  });
  await tick();
  // The dirty switch raises the house discard confirm instead of switching.
  await click(buttonByText(host, "Beta type"));
  assert.ok(
    document.body.textContent?.includes("You have unsaved changes"),
    "the discard confirm must open on a dirty switch",
  );
  assert.equal(name.value, "Alpha type edited", "cancel path: the draft must survive");
  // Confirming discards and switches.
  await click(buttonByText(document.body as unknown as HTMLElement, "Discard changes"));
  await tick();
  assert.equal(name.value, "Beta type", "confirm path: the switch completes");
});
