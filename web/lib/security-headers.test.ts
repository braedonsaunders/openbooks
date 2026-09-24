import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { NextRequest } from "next/server";

// House render guard: layout JSX may compile to the classic
// React.createElement transform (shared tsx cache hazard), which needs a
// global React. Every other render test does this.
const React = await import("react");
Object.assign(globalThis, { React });

test("Next.js applies the static security-header baseline to every route", async () => {
  const { default: config, securityHeaders } =
    await import("../next.config.mjs");

  const headers = config.headers;
  assert.equal(typeof headers, "function");
  assert.ok(headers);
  const routes = await headers();
  assert.deepEqual(routes, [{ source: "/(.*)", headers: securityHeaders }]);

  const values = new Map(securityHeaders.map(({ key, value }) => [key, value]));
  assert.equal(values.get("X-Content-Type-Options"), "nosniff");
  assert.equal(values.get("X-Frame-Options"), "DENY");
  assert.match(
    values.get("Strict-Transport-Security") ?? "",
    /max-age=63072000/,
  );
  assert.equal(values.has("Content-Security-Policy"), false);
});

test("production CSP uses a request nonce without insecure script fallbacks", async () => {
  const { buildContentSecurityPolicy } = await import("./content-security-policy.ts");
  const policy = buildContentSecurityPolicy("test-nonce-123456", false);

  assert.match(policy, /script-src 'self' 'nonce-test-nonce-123456' 'strict-dynamic'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /upgrade-insecure-requests/);
});

test("development CSP permits the evaluator required by Next.js", async () => {
  const { buildContentSecurityPolicy } = await import("./content-security-policy.ts");
  const policy = buildContentSecurityPolicy("test-nonce-123456", true);
  assert.match(policy, /script-src[^;]*'unsafe-eval'/);
});

// The proxy's request-header plumbing (x-nonce + CSP into the downstream
// request) is internal to NextResponse.next, so the test captures that seam:
// only the proxy module sees the recording pass-through, every other
// importer (including this file's own NextRequest) resolves real next/server.
const proxyKey = Symbol.for("openbooks.security-headers-proxy-test");
const proxyState: { nextCalls: Array<{ request?: { headers: Headers } }> } = { nextCalls: [] };
(globalThis as Record<symbol, unknown>)[proxyKey] = proxyState;

const proxyHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "next/server" &&
      String(context.parentURL ?? "").includes("/web/proxy.ts")
    ) {
      return { shortCircuit: true, url: `${new URL(import.meta.url).href}?mock=next-server`, format: "module" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("?mock=next-server")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import { NextResponse as RealNextResponse } from "next/server";
          export * from "next/server";
          const state = globalThis[Symbol.for("openbooks.security-headers-proxy-test")];
          export const NextResponse = new Proxy(RealNextResponse, {
            get(target, prop) {
              if (prop === "next") {
                return (init) => {
                  state.nextCalls.push(init ?? {});
                  return target.next(init);
                };
              }
              const value = Reflect.get(target, prop);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { proxy } = await import("../proxy.ts");
proxyHooks.deregister();

test("the request proxy sends the CSP and nonce to Next.js", async () => {
  proxyState.nextCalls = [];
  // /login is public: the proxy short-circuits before any session or
  // database touch, so this drives the real header plumbing only.
  const response = await proxy(new NextRequest("http://openbooks.test/login"));

  assert.equal(proxyState.nextCalls.length, 1);
  const forwarded = proxyState.nextCalls[0]!.request?.headers;
  assert.ok(forwarded, "the proxy forwards headers downstream");
  const nonce = forwarded.get("x-nonce");
  assert.ok(nonce && nonce.length >= 8, "the proxy mints a per-request nonce");
  const requestPolicy = forwarded.get("Content-Security-Policy");
  assert.ok(
    requestPolicy?.includes(`nonce-${nonce}`),
    "the downstream CSP carries the request nonce",
  );
  assert.equal(
    response.headers.get("Content-Security-Policy"),
    requestPolicy,
    "the response carries the same policy",
  );
});

// The root layout reads x-nonce from the request headers and hands it to
// its head-init <Script>. The render below drives the real layout and
// asserts on the emitted markup; only the framework and leaf-chrome
// boundaries are stubbed (CSS, next/script, next/headers, next-intl,
// sonner, and the provider/splash/dialog leaves).
const layoutKey = Symbol.for("openbooks.security-headers-layout-test");
const layoutState: { headers: Headers; scripts: Array<{ nonce?: string }> } = {
  headers: new Headers(),
  scripts: [],
};
(globalThis as Record<symbol, unknown>)[layoutKey] = layoutState;

const layoutMocks = new Map<string, string>([
  [
    "mock:css",
    "export default {}; export const __cssStub = true;",
  ],
  [
    "mock:next-script",
    `
      import { createElement } from "react";
      const state = globalThis[Symbol.for("openbooks.security-headers-layout-test")];
      export default function Script(props) {
        state.scripts.push(props);
        return createElement("script", { id: props.id, nonce: props.nonce });
      }
    `,
  ],
  [
    "mock:next-headers",
    `
      const state = globalThis[Symbol.for("openbooks.security-headers-layout-test")];
      export function headers() { return state.headers; }
    `,
  ],
  [
    "mock:next-intl",
    `
      import { createElement } from "react";
      export function NextIntlClientProvider(props) {
        return createElement("fragment-stub", null, props.children);
      }
    `,
  ],
  [
    "mock:next-intl-server",
    `
      export async function getLocale() { return "en"; }
      export async function getMessages() { return {}; }
      export async function getTranslations() { return (key) => key; }
    `,
  ],
  [
    "mock:sonner",
    `
      export function Toaster() { return null; }
    `,
  ],
  [
    "mock:app-leaves",
    `
      import { createElement } from "react";
      export function AppLinkProvider(props) {
        return createElement("fragment-stub", null, props.children);
      }
      export function SplashScreen() { return null; }
      export function ConfirmRoot() { return null; }
      export function PromptRoot() { return null; }
    `,
  ],
]);

const layoutMockUrl = (name: string) => `${new URL(import.meta.url).href}?layout-mock=${name}`;

const layoutHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./globals.css") return { shortCircuit: true, url: layoutMockUrl("mock:css") };
    if (specifier === "next/script") return { shortCircuit: true, url: layoutMockUrl("mock:next-script") };
    if (specifier === "next/headers") return { shortCircuit: true, url: layoutMockUrl("mock:next-headers") };
    if (specifier === "next-intl") return { shortCircuit: true, url: layoutMockUrl("mock:next-intl") };
    if (specifier === "next-intl/server") return { shortCircuit: true, url: layoutMockUrl("mock:next-intl-server") };
    if (specifier === "sonner") return { shortCircuit: true, url: layoutMockUrl("mock:sonner") };
    if (
      specifier === "../components/app-link-provider" ||
      specifier === "../components/brand-splash" ||
      specifier === "../lib/confirm" ||
      specifier === "../lib/prompt"
    ) {
      return { shortCircuit: true, url: layoutMockUrl("mock:app-leaves") };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const name = new URL(url).searchParams.get("layout-mock");
    const source = name ? layoutMocks.get(name) : undefined;
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { default: RootLayout } = await import("../app/layout.tsx");
layoutHooks.deregister();
const { renderToStaticMarkup } = await import("react-dom/server");

test("the root layout passes the request nonce to its custom script", async () => {
  layoutState.headers = new Headers({ "x-nonce": "layout-nonce-1" });
  layoutState.scripts = [];
  const html = renderToStaticMarkup(await RootLayout({ children: null }));

  assert.equal(layoutState.scripts.length, 1);
  assert.equal(layoutState.scripts[0]!.nonce, "layout-nonce-1");
  assert.match(html, /<script[^>]*nonce="layout-nonce-1"/);
});

test("the root layout omits the script nonce when the request carries none", async () => {
  layoutState.headers = new Headers();
  layoutState.scripts = [];
  const html = renderToStaticMarkup(await RootLayout({ children: null }));

  assert.equal(layoutState.scripts.length, 1);
  assert.equal(layoutState.scripts[0]!.nonce, undefined);
  assert.doesNotMatch(html, /nonce="/);
});
