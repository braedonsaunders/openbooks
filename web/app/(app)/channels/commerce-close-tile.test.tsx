import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

// The channels home keeps one collection (the channel cards): close checks
// live behind a summary count and open in a single filterable drawer list.
// A collapsed second list is no exemption, the summary never nests a Badge
// div inside a paragraph, and a clean day keeps proof review reachable.

// jsdom first: the tile reads browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/channels", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__closeRouter}" +
      "export function usePathname(){return '/channels'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(m){(globalThis.__closeToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__closeToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__closeToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { CommerceCloseTile } = await import("./CommerceCloseTile");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

declare global {
  var __closeRouter: { push(url: string): void; refresh(): void } | undefined;
  var __closeToasts: { kind: string; message: string }[] | undefined;
}

function check(code: string, count: number) {
  return {
    code,
    severity: "error",
    count,
    title: code,
    message: `${count} open`,
    details: {},
  };
}

function scriptFetch(payload: unknown) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === "/api/channels/completeness" && (!init?.method || init.method === "GET")) {
      return Response.json(payload);
    }
    return Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function renderTile() {
  globalThis.__closeRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CommerceCloseTile />
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

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

function buttonsMatching(pattern: RegExp): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter((b) =>
    pattern.test(b.textContent?.trim() ?? ""),
  ) as HTMLButtonElement[];
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

test("open checks open one filterable list, never stacked collections", async (t) => {
  const restoreFetch = scriptFetch({
    day: "2026-10-05",
    checks: [check("test-open-check", 2), check("test-proven-check", 0)],
  });
  t.after(restoreFetch);
  const { unmount } = await renderTile();
  t.after(unmount);

  // Summary names the open proof without nesting collections.
  assert.match(document.body.textContent ?? "", /test-open-check/);

  const review = buttonsNamed("Review");
  assert.equal(review.length, 1);
  await click(review[0]);

  // Exactly one check collection inside the drawer.
  assert.equal(document.querySelectorAll("ul").length, 1);
  // Default filter shows only the open check with its remedy link.
  assert.match(document.body.textContent ?? "", /test-open-check/);
  assert.doesNotMatch(document.body.textContent ?? "", /test-proven-check/);

  // The All filter reveals the proven check in the same single list.
  const all = buttonsMatching(/^All \(2\)$/);
  assert.equal(all.length, 1);
  await click(all[0]);
  assert.equal(document.querySelectorAll("ul").length, 1);
  assert.match(document.body.textContent ?? "", /test-proven-check/);
  assert.match(document.body.textContent ?? "", /Proven/);
});

test("a clean day still reaches proof review from the summary", async (t) => {
  const restoreFetch = scriptFetch({
    day: "2026-10-05",
    checks: [check("test-open-check", 0), check("test-proven-check", 0)],
  });
  t.after(restoreFetch);
  const { unmount } = await renderTile();
  t.after(unmount);

  assert.match(document.body.textContent ?? "", /fully in the books/);
  const review = buttonsNamed("Review");
  assert.equal(review.length, 1);
  await click(review[0]);

  // The default Open filter is empty on a clean day; All reveals one
  // collection with both proofs and no remedy links.
  const all = buttonsMatching(/^All \(2\)$/);
  assert.equal(all.length, 1);
  await click(all[0]);
  assert.equal(document.querySelectorAll("ul").length, 1);
  assert.match(document.body.textContent ?? "", /test-open-check/);
  assert.match(document.body.textContent ?? "", /test-proven-check/);
});
