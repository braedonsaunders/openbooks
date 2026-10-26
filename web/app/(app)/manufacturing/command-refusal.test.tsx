import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from "../../../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env.ts";

declare global {
  var __mfgRouter: { push(url: string): void; refresh(): void } | undefined;
  var __mfgToasts: { kind: string; message: string }[] | undefined;
}

// A refused work-order release pins the server's message and remedy in the
// command form and toasts, and the form stays open for review: the operator
// never loses the draft to a silent close on a 422. Lives here because the
// release command (reason field optional) is the shape that once went
// silent — a bare fallback or a closed form would both fail this test.

// jsdom first: the form reads browser globals at render.
const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({
  url: "http://localhost:4800/manufacturing/work-orders",
  matchMediaMatches: false,
});

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__mfgRouter}export function usePathname(){return '/manufacturing/work-orders'}export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__mfgToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__mfgToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__mfgToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
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
const messages = (await import("../../../messages/en")).default;
const { CommandForm } = await import("./CommandForm");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function scriptFetch(handler: (url: string, init?: RequestInit) => void | Response | null) {
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

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

test("a refused release pins message and remedy and keeps the form open", async (t) => {
  globalThis.__mfgRouter = { push() {}, refresh() {} };
  globalThis.__mfgToasts = [];
  const orderId = randomUUID();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/manufacturing/work-orders/${orderId}/release` && init?.method === "POST") {
      return Response.json(
        {
          error: "Work center ROAST-01 for operation 10 of work order WO-00003 has no department.",
          code: "work_center_department_required",
          remedy: "Assign a department to work center ROAST-01 in Manufacturing → Work centers.",
        },
        { status: 422 },
      );
    }
    return null;
  });
  t.after(restoreFetch);

  let saved = 0;
  let cancelled = false;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CommandForm
          command={{
            key: "release",
            path: `/api/manufacturing/work-orders/${orderId}/release`,
            fields: [{ key: "reason", type: "reason", required: false, nullable: true }],
          }}
          onSaved={async () => {
            saved += 1;
          }}
          onCancel={() => {
            cancelled = true;
          }}
          onReview={() => {}}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  const release = buttonsNamed("Release")[0];
  assert.ok(release, "the release command must offer Release");
  await act(async () => {
    release.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();

  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the release refusal must pin as an alert, not vanish");
  assert.match(
    alert.textContent ?? "",
    /ROAST-01.*has no department/,
    "the alert must carry the server message",
  );
  assert.match(
    alert.textContent ?? "",
    /Manufacturing → Work centers/,
    "the alert must carry the remedy",
  );
  const toasts = globalThis.__mfgToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /ROAST-01/.test(toast.message)),
    "the release refusal must also toast",
  );
  assert.equal(saved, 0, "a refused release must not resolve as saved");
  assert.equal(cancelled, false, "a refused release must keep the form open");
  assert.ok(buttonsNamed("Cancel")[0], "the form must still offer Cancel after the refusal");
});
