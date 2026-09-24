import assert from "node:assert/strict";
import test from "node:test";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/pdf-templates",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof dom.window.requestAnimationFrame !== "function") {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  dom.window.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
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

declare global {
  var __templateToasts: { kind: string; message: string }[] | undefined;
  var __templatePushes: string[] | undefined;
}
Object.assign(globalThis, {
  __templateToasts: [] as { kind: string; message: string }[],
  __templatePushes: [] as string[],
});

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
// @openbooks/* symlinks resolve to the MAIN checkout (stale); pin the real
// worktree copy so the test runs the code under test.
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(u){(globalThis.__templatePushes??=[]).push(String(u))},refresh(){},replace(){},prefetch(){}}}export function usePathname(){return '/admin/pdf-templates'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__templateToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__templateToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { PromptRoot } = await import("../../../../lib/prompt");
const { NewTemplateButton, DuplicateTemplateButton } = await import("./TemplateActions");
const { TemplatesList } = await import("./TemplatesList");

// F-x6-003: the starter row-level Duplicate button is a dead click — no
// dialog opens, so no request can ever fire. The button must open the name
// prompt (the request fires only after confirm).
test("F-x6-003: starter Duplicate opens the name prompt", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    // The provider's overloads only accept children inside the props object.
    /* eslint-disable react/no-children-prop */
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: React.createElement(
          React.Fragment,
          null,
          React.createElement(PromptRoot, {}),
          React.createElement(NewTemplateButton, {
            recordType: "customer_invoice",
            asDuplicateOfStarter: true,
            defaultName: "Customer invoice starter",
          }),
        ),
      }),
    );
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    const button = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Duplicate"),
    );
    assert.ok(button, "row Duplicate button must render");
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(
      document.body.querySelector('[role="dialog"]'),
      "name prompt dialog must open on click",
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});

// F-t13-001: the offered duplicate default must not collide — the org may
// already hold a template with the starter's name (unique index org + type +
// name), and saving a colliding default died on a storage 500. The prompt
// must pre-fill the first free name instead.
test("F-t13-001: starter Duplicate pre-fills a non-colliding name", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    /* eslint-disable react/no-children-prop */
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: React.createElement(
          React.Fragment,
          null,
          React.createElement(PromptRoot, {}),
          React.createElement(TemplatesList, {
            templates: [
              {
                id: "00000000-0000-4000-8000-000000000099",
                name: "Customer invoice starter",
                description: null,
                recordType: "customer_invoice",
                paperSize: "letter",
                orientation: "portrait",
                isActive: true,
                isDefault: false,
              },
            ],
            starters: [
              {
                recordType: "customer_invoice",
                label: "Customer invoice",
                sourceHtml: "<p>hi</p>",
                headerHtml: "",
                footerHtml: "",
                isEffectiveDefault: true,
              },
            ],
            recordTypes: [{ key: "customer_invoice", label: "Customer invoice" }],
          }),
        ),
      }),
    );
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    // The shared prompt module outlives each tree: an earlier test may have
    // left a request unsettled, and this tree's PromptRoot renders it on
    // mount. Dismiss it so the Duplicate click below starts clean. The 25ms
    // flush covers the rAF shim plus the request/effect round-trip even when
    // sibling files load the machine in a combined run.
    await act(async () => {
      const staleCancel = [...document.body.querySelectorAll('[role="dialog"] button')].find(
        (b) => b.textContent?.trim() === "Cancel",
      );
      staleCancel?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    assert.equal(
      document.body.querySelector('[role="dialog"]'),
      null,
      "stale prompt must be dismissed before the Duplicate click",
    );
    const buttons = [...host.querySelectorAll("button")].filter((b) =>
      b.textContent?.trim().startsWith("Duplicate"),
    );
    assert.ok(buttons.length > 0, "row Duplicate button must render");
    await act(async () => {
      buttons[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const input = document.body.querySelector('[role="dialog"] input') as HTMLInputElement | null;
    assert.ok(input, "name prompt dialog must open from the list row");
    assert.equal(input.value, "Customer invoice starter 2");
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});

// F4T2-5: the offered duplicate default carries no language — the persisted
// English "(copy)" is gone, so the default is the digits-only unique name.
test("F4T2-5: row Duplicate pre-fills a language-neutral unique name", async () => {
  (globalThis as Record<string, unknown>).__templateToasts = [];
  (globalThis as Record<string, unknown>).__templatePushes = [];
  globalThis.fetch = (async (url: unknown) => {
    assert.match(String(url), /\/api\/pdf-templates\/tid-1$/);
    return Response.json({
      row: {
        id: "tid-1",
        name: "My template",
        recordType: "customer_invoice",
        description: null,
        sourceHtml: "<p>x</p>",
        headerHtml: "",
        footerHtml: "",
        paperSize: "letter",
        orientation: "portrait",
        marginMm: 10,
      },
    });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    /* eslint-disable react/no-children-prop */
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: React.createElement(
          React.Fragment,
          null,
          React.createElement(PromptRoot, {}),
          React.createElement(DuplicateTemplateButton, {
            templateId: "tid-1",
            takenNames: new Set(["My template"]),
          }),
        ),
      }),
    );
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    await act(async () => {
      const staleCancel = [...document.body.querySelectorAll('[role="dialog"] button')].find(
        (b) => b.textContent?.trim() === "Cancel",
      );
      staleCancel?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const button = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Duplicate"),
    );
    assert.ok(button, "row Duplicate button must render");
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const input = document.body.querySelector('[role="dialog"] input') as HTMLInputElement | null;
    assert.ok(input, "name prompt dialog must open");
    assert.equal(input.value, "My template 2");
    assert.ok(!input.value.includes("(copy)"), "the default carries no persisted English");
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});

// F4T2-4: the duplicate round-trip checks the status before parsing, toasts
// the named refusal on failure, and never navigates to /undefined.
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set as
    | ((this: HTMLInputElement, value: string) => void)
    | undefined;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

test("F4T2-4: duplicate posts the copy and navigates to its id", async () => {
  (globalThis as Record<string, unknown>).__templateToasts = [];
  (globalThis as Record<string, unknown>).__templatePushes = [];
  const posted: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    if (String(url).endsWith("/api/pdf-templates/tid-1")) {
      return Response.json({
        row: {
          id: "tid-1",
          name: "My template",
          recordType: "customer_invoice",
          description: null,
          sourceHtml: "<p>x</p>",
          headerHtml: "",
          footerHtml: "",
          paperSize: "letter",
          orientation: "portrait",
          marginMm: 10,
        },
      });
    }
    posted.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ id: "new-9" });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    /* eslint-disable react/no-children-prop */
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: React.createElement(
          React.Fragment,
          null,
          React.createElement(PromptRoot, {}),
          React.createElement(DuplicateTemplateButton, {
            templateId: "tid-1",
            takenNames: new Set(["My template"]),
          }),
        ),
      }),
    );
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    await act(async () => {
      const staleCancel = [...document.body.querySelectorAll('[role="dialog"] button')].find(
        (b) => b.textContent?.trim() === "Cancel",
      );
      staleCancel?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const button = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Duplicate"),
    );
    assert.ok(button, "row Duplicate button must render");
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === "Save",
    );
    assert.ok(confirm, "the name prompt must offer confirm");
    // Type an explicit name: the offered default is F4T2-5's concern, and
    // this test pins the round-trip, not the default.
    const input = document.body.querySelector('[role="dialog"] input') as HTMLInputElement | null;
    assert.ok(input, "the name prompt must offer an input");
    setInputValue(input, "My template 2");
    await act(async () => {
      confirm.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    assert.equal(posted.length, 1, "confirming posts the copy once");
    assert.equal((posted[0] as { name?: unknown })?.name, "My template 2");
    assert.deepEqual(globalThis.__templatePushes, ["/admin/pdf-templates/new-9"]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});

test("F4T2-4: a non-JSON failure toasts instead of navigating nowhere", async () => {
  (globalThis as Record<string, unknown>).__templateToasts = [];
  (globalThis as Record<string, unknown>).__templatePushes = [];
  globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    /* eslint-disable react/no-children-prop */
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: React.createElement(
          React.Fragment,
          null,
          React.createElement(PromptRoot, {}),
          React.createElement(DuplicateTemplateButton, {
            templateId: "tid-1",
            takenNames: new Set(["My template"]),
          }),
        ),
      }),
    );
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    await act(async () => {
      const staleCancel = [...document.body.querySelectorAll('[role="dialog"] button')].find(
        (b) => b.textContent?.trim() === "Cancel",
      );
      staleCancel?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const button = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Duplicate"),
    );
    assert.ok(button, "row Duplicate button must render");
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const errors = (globalThis.__templateToasts ?? []).filter((t) => t.kind === "error");
    assert.equal(errors.length, 1, "the failure toasts exactly once");
    assert.match(errors[0]!.message, /Save failed \(status 500\)/);
    assert.deepEqual(globalThis.__templatePushes, [], "a failed duplicate navigates nowhere");
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});

// Same contract through the real list row (PagedTable cell): the starter
// row's Duplicate must reach the same prompt.
test("F-x6-003: starter row Duplicate opens the name prompt in the list", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    // The provider's overloads only accept children inside the props object.
    /* eslint-disable react/no-children-prop */
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: React.createElement(
          React.Fragment,
          null,
          React.createElement(PromptRoot, {}),
          React.createElement(TemplatesList, {
            templates: [],
            starters: [
              {
                recordType: "customer_invoice",
                label: "Customer invoice",
                sourceHtml: "<p>hi</p>",
                headerHtml: "",
                footerHtml: "",
                isEffectiveDefault: true,
              },
            ],
            recordTypes: [{ key: "customer_invoice", label: "Customer invoice" }],
          }),
        ),
      }),
    );
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    const buttons = [...host.querySelectorAll("button")].filter((b) =>
      b.textContent?.trim().startsWith("Duplicate"),
    );
    assert.ok(buttons.length > 0, "row Duplicate button must render");
    await act(async () => {
      buttons[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(
      document.body.querySelector('[role="dialog"]'),
      "name prompt dialog must open from the list row",
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});

// F4T-15: paper-size names come from the catalog, never hardcoded English —
// under fr a letter/landscape row renders "Lettre · Paysage", not "Letter".
test("F4T-15: paper names render in the operator locale", async () => {
  const messagesFr = (await import("../../../../messages/fr")).default;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    /* eslint-disable react/no-children-prop */
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "fr",
        messages: messagesFr,
        timeZone: "UTC",
        children: React.createElement(TemplatesList, {
          templates: [
            {
              id: "00000000-0000-4000-8000-000000000097",
              name: "Facture",
              description: null,
              recordType: "customer_invoice",
              paperSize: "letter",
              orientation: "landscape",
              isActive: true,
              isDefault: false,
            },
          ],
          starters: [],
          recordTypes: [{ key: "customer_invoice", label: "Facture client" }],
        }),
      }),
    );
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    const paperCell = [...host.querySelectorAll("span")].find((s) =>
      s.textContent?.includes("·"),
    );
    assert.ok(paperCell, "the paper cell must render");
    assert.ok(
      !paperCell.textContent?.includes("Letter"),
      `paper name must not be hardcoded English, got ${paperCell.textContent}`,
    );
    assert.ok(
      paperCell.textContent?.includes("Lettre"),
      `paper name must render in French, got ${paperCell.textContent}`,
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
});
