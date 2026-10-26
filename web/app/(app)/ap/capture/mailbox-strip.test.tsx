import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { CaptureMailbox } from "./sections";

// The inbound-address strip above the capture queue, mounted under jsdom:
// the webhook URL (which carries the address token) appears only when the
// loader supplied it to an address administrator, every address names its
// owner and flags an owner who can no longer receive bills, and taking
// ownership goes through the address PATCH route with a stated reason.
const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/ap/capture",
  scrollIntoView: false,
  resizeObserver: false,
});

const state = {
  errors: [] as string[],
  successes: [] as string[],
  refreshes: 0,
  prompt: null as string | null,
  prompts: [] as Array<{ title: string }>,
};
Object.assign(globalThis, {
  __mailboxStripState: state,
  __captureTestRouter: {
    push() {},
    refresh() {
      state.refreshes += 1;
    },
    replace() {},
    back() {},
    prefetch() {},
  },
});
const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation:
    'export function useRouter(){return globalThis.__captureTestRouter}export function usePathname(){return "/ap/capture"}export function useSearchParams(){return new URLSearchParams()}',
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){globalThis.__mailboxStripState.successes.push(String(m))},error(m){globalThis.__mailboxStripState.errors.push(String(m))}};export function Toaster(){return null}",
      };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(options){const s=globalThis.__mailboxStripState;s.prompts.push(options);return s.prompt}",
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
const messages = (await import("../../../../messages/en")).default;
const { CaptureList } = await import("./sections");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const ADDRESS: CaptureMailbox = {
  id: "0190a1b2-0000-7000-8000-000000000001",
  label: "Bills",
  entity: "Northwind Ltd",
  emailAddress: "bills@inbound.example",
  webhookUrl: null,
  ownerName: "Dana Ruiz",
  ownerReady: true,
  canTakeOwnership: false,
};

async function mount(
  t: TestContext,
  mailboxes: CaptureMailbox[],
  handler?: (url: string, init?: RequestInit) => Response,
) {
  Object.assign(state, { errors: [], successes: [], refreshes: 0, prompt: null, prompts: [] });
  const prior = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (!handler) throw new Error(`unexpected fetch ${String(input)}`);
    return handler(String(input), init);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    globalThis.fetch = prior;
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CaptureList
          rows={[]}
          mailboxes={mailboxes}
          currentParams={{}}
          canCreate={false}
          uploadDisabled
          sort="received"
          dir="desc"
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, requests };
}

function button(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
}

test("a reader sees the address, its entity and owner, but no webhook URL and no ownership action", async (t) => {
  const { host } = await mount(t, [ADDRESS]);
  const text = host.textContent ?? "";
  assert.match(text, /Bills · Northwind Ltd/);
  assert.match(text, /bills@inbound\.example/);
  assert.match(text, /Owner: Dana Ruiz/);
  assert.equal(
    button(host, "Copy the Bills webhook URL"),
    undefined,
    "the token-bearing URL is never offered to a reader",
  );
  assert.equal(button(host, "Take ownership of the Bills address"), undefined);
  assert.doesNotMatch(text, /Owner cannot receive bills/);
});

test("an address whose owner cannot receive bills is flagged with the remedy", async (t) => {
  const { host } = await mount(t, [{ ...ADDRESS, ownerReady: false }]);
  const flag = [...host.querySelectorAll("*")].find(
    (node) => node.textContent === "Owner cannot receive bills",
  );
  assert.ok(flag, "the owner problem is visible on the address");
  assert.match(flag.getAttribute("title") ?? "", /Take ownership or re-create the address/);
});

test("an administrator copies the webhook URL and takes ownership with a reason through the address route", async (t) => {
  const admin = {
    ...ADDRESS,
    webhookUrl: "https://books.example/api/inbound/ap/abcdefghijklmnopqrstuvwxyz234567",
    canTakeOwnership: true,
    ownerReady: false,
  };
  const { host, requests } = await mount(t, [admin], () =>
    Response.json({ id: ADDRESS.id, ownerId: "me" }),
  );
  assert.ok(
    button(host, "Copy the Bills webhook URL"),
    "the administrator can copy the provider URL",
  );
  const take = button(host, "Take ownership of the Bills address");
  assert.ok(take);

  state.prompt = null;
  await click(take);
  assert.equal(requests.length, 0, "cancelling the reason prompt changes nothing");

  state.prompt = "Dana left the company";
  await click(take);
  assert.deepEqual(requests, [
    {
      url: `/api/ap-capture/mailboxes/${ADDRESS.id}`,
      method: "PATCH",
      body: { takeOwnership: true, reason: "Dana left the company" },
    },
  ]);
  assert.equal(state.prompts[0]?.title, "Take ownership of Bills");
  assert.deepEqual(state.successes, ["You now own this address"]);
  assert.equal(state.refreshes, 1, "the page reloads to show the new owner");
});

test("a refused ownership transfer shows the server reason and does not refresh", async (t) => {
  const { host } = await mount(t, [{ ...ADDRESS, canTakeOwnership: true }], () =>
    Response.json(
      { error: "To own this address you need permission to create bills in its legal entity" },
      { status: 422 },
    ),
  );
  state.prompt = "Covering for the owner";
  await click(button(host, "Take ownership of the Bills address")!);
  assert.deepEqual(state.errors, [
    "To own this address you need permission to create bills in its legal entity",
  ]);
  assert.equal(state.refreshes, 0);
});
