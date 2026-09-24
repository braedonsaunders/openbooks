// Shared jsdom + module-shim harness for app behaviour tests (dashboard,
// orders, …).
//
// Real interfaces throughout: the real components, the real next-intl
// provider backed by the real locale catalogs, and the real MoneyProvider.
// Only the process boundary is scripted: next/link renders a real anchor
// (href preserved), next/dynamic renders its children (react-grid-layout
// positioning is not under test), next/navigation records pushes, sonner
// records toasts, and .css imports resolve empty. Browser measurement
// (ResizeObserver, clientWidth/Height, matchMedia, scrollIntoView) is
// controllable per test. promptDialog/confirmDialog answer from a scripted
// queue: they stand in for the OPERATOR's dialog choice (like scripted
// fetch stands in for the network), so tests assert on the wire request and
// the rendered refusal — never on what the mock was told.

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

declare global {
  var __dashRouter: { push(url: string): void; refresh(): void; pushes: string[] };
  var __dashToasts: { kind: string; message: string }[];
  var __promptAnswers: (string | null)[];
  var __confirmAnswer: boolean | undefined;
}

const root = pathToFileURL(process.cwd() + "/").href;

// jsdom first: components read browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4780/dashboard",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "self",
  "getComputedStyle",
]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.requestAnimationFrame !== "function") {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame;
}

// Controllable viewport: the grid picks phone/tablet/desktop from these.
const mediaMatches = new Map<string, boolean>();
const mediaListeners = new Map<string, Set<() => void>>();
export function setMediaQuery(query: string, matches: boolean): void {
  mediaMatches.set(query, matches);
  for (const notify of mediaListeners.get(query) ?? []) notify();
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: mediaMatches.get(query) ?? false,
    media: query,
    addEventListener(_type: string, listener: () => void) {
      const set = mediaListeners.get(query) ?? new Set<() => void>();
      set.add(listener);
      mediaListeners.set(query, set);
    },
    removeEventListener(_type: string, listener: () => void) {
      mediaListeners.get(query)?.delete(listener);
    },
  })) as typeof window.matchMedia;
}

// scrollIntoView recorder: the grid brings a just-added cell into view.
export const scrolledIntoView: Element[] = [];
Element.prototype.scrollIntoView = function () {
  scrolledIntoView.push(this);
};

// Controllable cell measurement for the ResizeObserver-driven tile pack.
let cellWidth = 256;
let cellHeight = 112;
Object.defineProperties(window.HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => cellWidth },
  clientHeight: { configurable: true, get: () => cellHeight },
});
let roCallback: (() => void) | null = null;
export const observedElements: Element[] = [];
class ControllableResizeObserver {
  constructor(callback: () => void) {
    roCallback = callback;
  }
  observe(target: Element): void {
    observedElements.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    roCallback = null;
  }
}
globals.ResizeObserver = ControllableResizeObserver;
export function setCellSize(width: number, height: number): void {
  cellWidth = width;
  cellHeight = height;
}
export function fireResize(): void {
  roCallback?.();
}

const LINK_MOCK = `export default function Link(p) { return globalThis.React.createElement('a', { href: p.href, className: p.className }, p.children) }`;
const NAV_MOCK = `export function useRouter() { return globalThis.__dashRouter }
export function redirect(url) { throw new Error('REDIRECT:' + url) }
export function notFound() { throw new Error('NOT_FOUND') }
export function usePathname() { return '/' }
export function useSearchParams() { return new URLSearchParams() }`;
const DYNAMIC_MOCK = `export default function dynamic() { return function DynamicStub(p) { return p.children ?? null } }`;
const SONNER_MOCK = `export const toast = { success(m) { (globalThis.__dashToasts ?? []).push({ kind: 'success', message: String(m) }) }, error(m) { (globalThis.__dashToasts ?? []).push({ kind: 'error', message: String(m) }) } }; export function Toaster() { return null }`;
const ACTIONS_MOCK = `export async function saveDashboardLayout() { return { ok: true } } export async function resetDashboardLayout() { return { ok: true } }`;
const PROMPT_MOCK = `export async function promptDialog() { const answers = globalThis.__promptAnswers ?? []; return answers.length > 0 ? answers.shift() : null }`;
const CONFIRM_MOCK = `export async function confirmDialog() { return globalThis.__confirmAnswer ?? true }`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    if (specifier === "next/link") {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(LINK_MOCK) };
    }
    if (specifier === "next/navigation") {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(NAV_MOCK) };
    }
    if (specifier === "next/dynamic") {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(DYNAMIC_MOCK) };
    }
    if (specifier === "sonner") {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(SONNER_MOCK) };
    }
    if (specifier.endsWith("dashboard/actions")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(ACTIONS_MOCK) };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(PROMPT_MOCK) };
    }
    if (specifier.endsWith("/lib/confirm")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(CONFIRM_MOCK) };
    }
    if (specifier.endsWith(".css")) {
      return { shortCircuit: true, url: "data:text/javascript,export default {}" };
    }
    if (specifier.startsWith("@/")) {
      const path = root + "web/" + specifier.slice(2);
      for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
      }
      return next(path, context);
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
const { MoneyProvider } = await import("@/components/money-provider");

export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

export type DashMessages = Record<string, unknown>;

export async function mountDashboard(
  ui: React.ReactElement,
  messages: DashMessages,
  locale = "en",
): Promise<{ host: HTMLDivElement; unmount: () => Promise<void> }> {
  globalThis.__dashRouter = {
    push(url: string) {
      globalThis.__dashRouter.pushes.push(url);
    },
    refresh() {},
    pushes: [],
  };
  globalThis.__dashToasts = [];
  scrolledIntoView.length = 0;
  observedElements.length = 0;
  globalThis.__promptAnswers = [];
  globalThis.__confirmAnswer = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const rootInstance = createRoot(host);
  await act(async () => {
    rootInstance.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">{ui}</MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    host,
    unmount: async () => {
      await act(async () => {
        rootInstance.unmount();
      });
      host.remove();
    },
  };
}

export async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

/** Script the network: every other request falls through to an empty object,
// like the sibling drawer tests. */
export function scriptFetch(
  handler: (url: string, init?: RequestInit) => Response | null,
): () => void {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

export function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

export function buttonsContaining(text: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement[];
}

export { act };
