import { JSDOM } from "jsdom";

export interface JsdomPresetOptions {
  html?: string;
  url?: string;
  /** Override the matchMedia stub's matched state. Defaults to true. */
  matchMediaMatches?: boolean;
  /** Install a recording scrollIntoView stub. Defaults to true. */
  scrollIntoView?: boolean;
  /** Install a no-op ResizeObserver. Defaults to true. */
  resizeObserver?: boolean;
}

export async function bootJsdomEnvironment(
  options: JsdomPresetOptions = {},
): Promise<void> {
  const dom = new JSDOM(
    options.html ?? "<!DOCTYPE html><html><body></body></html>",
    { url: options.url ?? "http://localhost/" },
  );
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
    "CustomEvent",
    "self",
    "getComputedStyle",
  ]) {
    if (globals[key] === undefined) globals[key] = domWindow[key];
  }
  if (options.scrollIntoView !== false) {
    const prototype = (globalThis as Record<string, unknown>).HTMLElement as
      | { prototype?: { scrollIntoView?: unknown } }
      | undefined;
    if (prototype?.prototype && typeof prototype.prototype.scrollIntoView !== "function") {
      prototype.prototype.scrollIntoView = function () {};
    }
  }
  if (options.resizeObserver !== false && globals.ResizeObserver === undefined) {
    globals.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (typeof dom.window.requestAnimationFrame !== "function") {
    dom.window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
      Number(setTimeout(() => cb(dom.window.performance.now()), 16));
    dom.window.cancelAnimationFrame = (id: number): void => {
      clearTimeout(id);
    };
  }
  if (globals.requestAnimationFrame === undefined) {
    globals.requestAnimationFrame = dom.window.requestAnimationFrame;
    globals.cancelAnimationFrame = dom.window.cancelAnimationFrame;
  }
  if (typeof window.matchMedia !== "function") {
    const matches = options.matchMediaMatches ?? true;
    window.matchMedia = (() => ({
      matches,
      media: "",
      addEventListener() {},
      removeEventListener() {},
    })) as typeof window.matchMedia;
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}
