import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __platformToasts: { kind: string; message: string }[] | undefined;
}

// POST /api/platform/connections/[id]/test refusing with 404/409/422
// or any non-JSON error body (500 HTML, gateway) — threw out of
// `await res.json` before the status was ever checked, so the operator saw
// a parse error instead of the refusal. test must check the status first
// and name the refusal through readApiErrorMessage.

// jsdom first: the client reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/sync", matchMediaMatches: false });

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
// The @openbooks/ui redirect is a worktree pin, not a stub shape: it stays
// in a local hook while navigation and sonner move to the shared helper.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    return next(specifier, context);
  },
});

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return '/sync'}export function useSearchParams(){return new URLSearchParams()}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      "export const toast={success(m){(globalThis.__platformToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__platformToasts??=[]).push({kind:'error',message:String(m)})},loading(){return 'tid'}};export function Toaster(){return null}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { PlatformClient } = await import("./PlatformClient");

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

const CONNECTION = {
  id: "c1",
  source: "manual",
  displayName: "Manual import",
  authKind: "token",
  status: "active",
  config: {},
  mirrorEnabled: false,
  mirrorSchedule: "daily",
  postedChangePolicy: "review_required",
  postedChangeAuthorizedAt: null,
  cursor: null,
  lastRunAt: null,
  lastError: null,
  hasSecrets: false,
};

async function renderClient() {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PlatformClient />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
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

for (const [name, respondTest, match, matchMessage, checkParseLeak] of [
  [
    "a non-JSON 500 on connection test toasts the refusal and releases the button",
    () =>
      new Response("<html><body>Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    /Connection failed/,
    "the operator must see the refused test, not a parse error",
    true,
  ],
  [
    "a named 422 refusal on connection test surfaces the server reason",
    () => Response.json({ error: "connector URL refused" }, { status: 422 }),
    /connector URL refused/,
    "the toast must carry the server's named refusal",
    false,
  ],
] as Array<[string, () => Response, RegExp, string, boolean]>) {
  test(name, async (t) => {
    globalThis.__platformToasts = [];
    const restoreFetch = scriptFetch((url, init) => {
      if (url === "/api/platform/connections" && (!init?.method || init.method === "GET")) {
        return Response.json({ connections: [CONNECTION], runs: [], sourceTypes: [], currencies: [] });
      }
      if (url === "/api/platform/connections/c1/test" && init?.method === "POST") {
        return respondTest();
      }
      return null;
    });
    t.after(restoreFetch);
    const { unmount } = await renderClient();
    t.after(unmount);

    const testButton = buttonsNamed("Test")[0];
    assert.ok(testButton, "the connection Test button must render once connections load");
    await click(testButton);
    await tick();
    await tick();

    const toasts = globalThis.__platformToasts ?? [];
    const errors = toasts.filter((toast) => toast.kind === "error");
    assert.ok(errors.length >= 1, `an error toast must fire, saw ${JSON.stringify(toasts)}`);
    const last = errors[errors.length - 1]?.message ?? "";
    assert.match(last, match, matchMessage);
    if (checkParseLeak) {
      assert.ok(
        !/SyntaxError|Unexpected token|json/i.test(last),
        `no JSON parse error may leak into the toast, saw: ${last}`,
      );
      const testAgain = buttonsNamed("Test")[0];
      assert.ok(testAgain && !testAgain.disabled, "the Test button must release so the operator can retry");
    }
  });
}
