import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __chargeToasts: { kind: string; message: string }[] | undefined;
}

// B2-PRJ-1: POST /api/project-charges failing with a non-JSON 500 (proxy or
// gateway HTML) threw out of `await res.json()` before any toast, and
// setBusy(false) never ran — the operator saw a stuck spinner instead of the
// refusal. The submit path must check the status first (naming the refusal
// through the translated fallback) and always release the button.

// jsdom first: the section reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/projects/p1",
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
const { pathToFileURL } = await import("node:url");
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
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return '/projects/p1'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__chargeToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__chargeToasts??=[]).push({kind:'error',message:String(m)})},loading(){return 'tid'}};export function Toaster(){return null}",
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
const { MoneyProvider } = await import("../../../../components/money-provider");
const { ChargesSection } = await import("./ChargesSection");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response> | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function renderSection() {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let formOpen = true;
  const onFormOpenChange = (open: boolean) => {
    formOpen = open;
  };
  const items = [{ id: "item-1", name: "Concrete", defaultCost: "10.00", defaultRate: "20.00" }];
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <ChargesSection
            projectId="p1"
            charges={[]}
            items={items}
            equipment={[]}
            operators={[]}
            absorption={{ recovered: "0", billValue: "0" }}
            formOpen={formOpen}
            onFormOpenChange={onFormOpenChange}
            showKpis={false}
            showList={false}
            equipmentEnabled={false}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

async function pickFirstItem() {
  const trigger = document.querySelector('button[aria-label="Resource / item"]');
  assert.ok(trigger, "the item picker trigger must render");
  await click(trigger);
  // The dropdown portals to <body>; poll for the option (framer-motion).
  let option: Element | null = null;
  for (let i = 0; i < 20 && !option; i += 1) {
    await tick();
    option =
      [...document.querySelectorAll('[role="option"]')].find(
        (o) => o.textContent?.trim() === "Concrete",
      ) ?? null;
  }
  assert.ok(option, "the Concrete option must appear after opening the picker");
  await click(option);
  await tick();
}

test("a non-JSON 500 on charge post toasts the refusal and releases the button", async (t) => {
  globalThis.__chargeToasts = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/project-charges" && init?.method === "POST") {
      return new Response("<html><body>Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderSection();
  t.after(unmount);
  await pickFirstItem();

  const post = buttonsNamed("Post charge")[0];
  assert.ok(post, "the Post charge button must render once an item is picked");
  await click(post);
  await tick();
  await tick();

  const toasts = globalThis.__chargeToasts ?? [];
  const errors = toasts.filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, `exactly one error toast must fire, saw ${JSON.stringify(toasts)}`);
  assert.match(errors[0]?.message ?? "", /Could not post charge/);
  assert.ok(
    !/json|SyntaxError|Unexpected token/i.test(errors[0]?.message ?? ""),
    "the operator must see the refusal, never a JSON parse error",
  );
  const postAgain = buttonsNamed("Post charge")[0];
  assert.ok(postAgain && !postAgain.disabled, "the button must release so the operator can retry");
});
