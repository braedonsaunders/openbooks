import assert from "node:assert/strict";
import test from "node:test";

// B3-NAV-01: the nav editor's save parsed the error body before checking
// the status, so a non-JSON 500 threw out of res.json() — no error toast,
// and setBusy(false) was skipped, wedging the editor. A dead network
// wedged it the same way (no try/catch at all). The refusal must surface
// and busy must always release.
//
// Only routing, toasts and the network are doubled. React, next-intl and
// the REAL English catalog run.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/navigation",
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

declare global {
  var __navToasts: { kind: string; message: string }[] | undefined;
  var __navRefreshed: number | undefined;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){globalThis.__navRefreshed=(globalThis.__navRefreshed??0)+1},replace(){},prefetch(){}}}export function usePathname(){return '/admin/navigation'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){((globalThis.__navToasts??=[])).push({kind:'success',message:String(m)})},error(m){((globalThis.__navToasts??=[])).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { NavEditor } = await import("./NavEditor");
const { defaultNavConfig } = await import("../../../../lib/nav/registry");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function scriptFetch(handler: () => Promise<Response> | Response): () => void {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => handler()) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function mountEditor() {
  globalThis.__navToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <NavEditor initial={defaultNavConfig()} apps={[]} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => {
    await tick();
  });
  return { host, root };
}

function saveButton(host: HTMLElement): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Save navigation") || (b.textContent ?? "").includes("Saving"),
  ) as HTMLButtonElement | undefined;
  assert.ok(found, `expected a save button in ${JSON.stringify((host.textContent ?? "").slice(0, 200))}`);
  return found;
}

function errorToasts(): string[] {
  return (globalThis.__navToasts ?? []).filter((t) => t.kind === "error").map((t) => t.message);
}

test("B3-NAV-01: a non-JSON 500 toasts the refusal and releases the editor", async () => {
  // An unhandled-throw 500 with an EMPTY body: the old else branch parsed
  // first and threw, so no toast ever rendered and busy never released.
  const restore = scriptFetch(() => new Response("", { status: 500 }));
  try {
    const { host, root } = await mountEditor();
    await act(async () => {
      saveButton(host).click();
      await tick();
      await tick();
    });

    const errors = errorToasts();
    assert.equal(errors.length, 1, `exactly one error toast must render, saw ${JSON.stringify(errors)}`);
    assert.match(errors[0]!, /Could not save/);

    const after = saveButton(host);
    assert.equal(after.disabled, false, "busy must release after a failed save");
    assert.ok((after.textContent ?? "").includes("Save navigation"));
    await act(async () => {
      root.unmount();
    });
  } finally {
    restore();
  }
});

test("B3-NAV-01: a dead network toasts and releases the editor", async () => {
  const restore = scriptFetch(() => Promise.reject(new Error("down")));
  try {
    const { host, root } = await mountEditor();
    await act(async () => {
      saveButton(host).click();
      await tick();
      await tick();
    });

    const errors = errorToasts();
    assert.equal(errors.length, 1, `exactly one error toast must render, saw ${JSON.stringify(errors)}`);
    assert.match(errors[0]!, /Could not save/);
    assert.equal(saveButton(host).disabled, false, "busy must release after a network failure");
    await act(async () => {
      root.unmount();
    });
  } finally {
    restore();
  }
});
