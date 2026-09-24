import { JSDOM } from "jsdom";

export async function bootJsdomEnvironment(
  options: { html?: string; url?: string } = {},
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
    "self",
  ]) {
    if (globals[key] === undefined) globals[key] = domWindow[key];
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
    window.matchMedia = (() => ({
      matches: true,
      media: "",
      addEventListener() {},
      removeEventListener() {},
    })) as typeof window.matchMedia;
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}
