import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __designerRouter: { push(url: string): void; refresh(): void } | undefined;
}

// E50: the layout designer offered post, void, gl_impact and delete toggles
// for field tickets, but the field-ticket drawer's renderFormAction handles
// only customize, pdf, approval, submit and workflow — so those toggles saved
// OK and changed nothing (dead toggles). The designer must offer only the
// actions the kind's drawer implements.

// jsdom first: the designer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/customization?recordType=field_ticket&tab=forms&form=new",
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
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__designerRouter}export function usePathname(){return '/admin/customization'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
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
const messages = (await import("../../../../messages/en")).default;
const customizationMessages = (await import("../../../../messages/en/customization.json", { with: { type: "json" } })).default as {
  designer: { forms: { actionsSection: string } };
};
const commonMessages = (await import("../../../../messages/en/common.json", { with: { type: "json" } })).default as {
  actions: Record<string, string>;
};
const { FormDesigner } = await import("./FormDesigner");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Labels of the action-toggle rows in the designer's Record-actions section. */
async function offeredActionLabels(recordType: string, t: import("node:test").TestContext): Promise<string[]> {
  globalThis.__designerRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <FormDesigner recordType={recordType} def={null} headerDefs={[]} lineDefs={[]} subsidiaryEnabled={false} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  const heading = [...document.querySelectorAll("h3")].find(
    (h) => h.textContent === customizationMessages.designer.forms.actionsSection,
  );
  assert.ok(heading, "the designer must render a Record-actions section");
  const section = heading.parentElement!;
  const rows = [...section.querySelectorAll(":scope > div > div")];
  assert.ok(rows.length > 0, "the Record-actions section must list action rows");
  return rows.map((row) => row.querySelector("span")?.textContent ?? "");
}

test("field_ticket is offered only the actions its drawer implements", async (t) => {
  const labels = await offeredActionLabels("field_ticket", t);
  assert.deepEqual(labels, [
    commonMessages.actions.customize,
    commonMessages.actions.pdf,
    commonMessages.actions.workflowActions,
    commonMessages.actions.approvalActions,
    commonMessages.actions.edit,
    commonMessages.actions.submitForApproval,
  ]);
});

test("a full-vocabulary kind is still offered every action", async (t) => {
  const labels = await offeredActionLabels("vendor_bill", t);
  assert.equal(labels.length, 10);
  const post = commonMessages.actions.post;
  const del = commonMessages.actions.delete;
  assert.ok(typeof post === "string" && labels.includes(post));
  assert.ok(typeof del === "string" && labels.includes(del));
});

test("every removable header group exposes the translated delete action", async (t) => {
  globalThis.__designerRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <FormDesigner recordType="vendor_bill" def={null} headerDefs={[]} lineDefs={[]} subsidiaryEnabled={false} />
      </NextIntlClientProvider>,
    );
    await tick();
  });

  const addGroup = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Add group"));
  assert.ok(addGroup);
  await act(async () => {
    addGroup.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  const groupInputs = [...document.querySelectorAll<HTMLInputElement>('input[placeholder="Group label"]')];
  assert.ok(groupInputs.length > 1);
  assert.ok(groupInputs.every((input) => input.parentElement?.querySelector('button[aria-label="Delete"]')));
});
