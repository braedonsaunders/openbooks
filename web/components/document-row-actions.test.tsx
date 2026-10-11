import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

declare global {
  var __docRowRouter: { push(): void; refresh(): void } | undefined;
  var __docRowToasts: { kind: string; message: string }[] | undefined;
  var __docRowPrompt: string | null | undefined;
}

// jsdom first: the row actions read browser globals at render.
const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills" });

stubModules({ navigation: { source: 'export function useRouter(){return globalThis.__docRowRouter}' }, intl: false, authz: false, features: false });

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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__docRowToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__docRowToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return globalThis.__docRowPrompt ?? null}",
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
const messages = (await import("../messages/en")).default;
const { DocumentRowActions } = await import("./document-row-actions");
const { DOC_KINDS } = await import("../lib/document-kinds");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const config = DOC_KINDS["vendor_bill"]!;
const transferConfig = DOC_KINDS["transfer"]!;

async function mountApprovedRow(canPost = true) {
  globalThis.__docRowRouter = {
    push() {},
    refresh() {},
  };
  globalThis.__docRowToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <DocumentRowActions id={randomUUID()} status="approved" config={config} openHref="/ap/bills/1" canPost={canPost} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root };
}

async function clickPost(host: HTMLElement) {
  const post = host.querySelector('button[aria-label="Post"]') as HTMLButtonElement;
  assert.ok(post, "post button must render");
  // Dispatch inside act; settle outside it so a rejection escaping the
  // handler cannot reject into act and poison later mounts.
  await act(async () => {
    post.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();
}

async function mountDraftTransferRow(canPost = true) {
  globalThis.__docRowRouter = {
    push() {},
    refresh() {},
  };
  globalThis.__docRowToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <DocumentRowActions id={randomUUID()} status="draft" config={transferConfig} openHref="/banking/transactions/1" canPost={canPost} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root };
}

/** row Post on an incomplete transfer draft 422s with a typed
 * engine reason — the same row-action path as must toast it and
 * persist it row-inline instead of failing silently. */
test("a 422 post refusal on a draft transfer names the missing legs", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ error: "transfer lines must name both the destination and the source account" }, { status: 422 })) as typeof fetch;
  const { host, root } = await mountDraftTransferRow();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await clickPost(host);
  await tick();
  const errors = (globalThis.__docRowToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "the refused transfer post must surface exactly one error toast");
  assert.match(errors[0]!.message, /destination and the source account/);
  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert, "the refused transfer post must persist a row-inline alert");
  assert.match(alert.textContent ?? "", /destination and the source account/);
});

/** a preparer without the post grant gets no enabled Post — the row
 * renders it disabled with the required grant named, so the two-person
 * handoff is visible before any click reaches the server. */
test("a preparer without ap.post sees a disabled Post naming the grant", async (t) => {
  let fetched = 0;
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched += 1;
    return Response.json({ ok: true }, { status: 200 });
  }) as typeof fetch;
  const { host, root } = await mountApprovedRow(false);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await tick();
  const enabledPost = host.querySelector('button[aria-label="Post"]') as HTMLButtonElement | null;
  assert.equal(enabledPost, null, "no enabled Post may be offered without ap.post");
  const blocked = host.querySelector('button[aria-label*="ap.post"]') as HTMLButtonElement | null;
  assert.ok(blocked, "the row must name the required ap.post grant");
  assert.equal(blocked.disabled, true, "the named-grant Post must be disabled");
  assert.match(blocked.title, /ap\.post/);
  assert.equal(fetched, 0, "rendering the blocked row must not call the API");
});

/** , banking namespaces: a gl.post transfer draft without the grant
 * names gl.post, not ap.post — the row resolves the grant by row kind. */
test("a transfer draft without gl.post names the gl.post grant", async (t) => {
  const { host, root } = await mountDraftTransferRow(false);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await tick();
  assert.equal(host.querySelector('button[aria-label="Post"]'), null, "no enabled Post may be offered without gl.post");
  const blocked = host.querySelector('button[aria-label*="gl.post"]') as HTMLButtonElement | null;
  assert.ok(blocked, "the transfer row must name the required gl.post grant");
  assert.equal(blocked.disabled, true, "the named-grant Post must be disabled");
});

/** a preparer without post rights still submits for approval — the
 * submit affordance is create-namespaced, not gated by the post grant. */
test("a draft bill without ap.post still offers Submit for approval", async (t) => {
  globalThis.__docRowRouter = { push() {}, refresh() {} };
  globalThis.__docRowToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <DocumentRowActions id={randomUUID()} status="draft" config={config} openHref="/ap/bills/1" canPost={false} />
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
  await tick();
  const submit = [...host.querySelectorAll("button")].find(
    (button) => (button.getAttribute("aria-label") ?? "").toLowerCase().includes("approv"),
  ) as HTMLButtonElement | undefined;
  assert.ok(submit, "the preparer must still be offered Submit for approval");
  assert.equal(submit.disabled, false, "Submit must stay enabled without the post grant");
});

/** a refused Post must name the reason instead of failing silently. */
test("a 422 post refusal surfaces the typed server reason", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ error: "AP is closed for this period and accounting book" }, { status: 422 })) as typeof fetch;
  const { host, root } = await mountApprovedRow();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await clickPost(host);
  await tick();
  const errors = (globalThis.__docRowToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "the refused post must surface exactly one error toast");
  assert.match(errors[0]!.message, /AP is closed/i);
});

test("a non-JSON post failure still releases the button with an error", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>proxy boom</html>", { status: 500 })) as typeof fetch;
  const { host, root } = await mountApprovedRow();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await clickPost(host);
  await tick();
  const errors = (globalThis.__docRowToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "a failed post must surface an error toast");
  const post = [...host.querySelectorAll("button")][0] as HTMLButtonElement;
  assert.equal(post.disabled, false, "the post button must release after the failure");
});

/** A typed 422 post refusal must persist as a row-inline role=alert until the
 * next action — a 4s toast alone reads as "nothing happened". */
test("a 422 post refusal persists as a row-inline alert until the next action", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ error: "AP is closed for this period and accounting book" }, { status: 422 })) as typeof fetch;
  const { host, root } = await mountApprovedRow();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await clickPost(host);
  await tick();
  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert, "the refused post must persist a row-inline alert");
  assert.match(alert.textContent ?? "", /AP is closed/i);

  // The next action clears it: a successful post leaves no stale refusal.
  globalThis.fetch = (async () => Response.json({ ok: true }, { status: 200 })) as typeof fetch;
  await clickPost(host);
  await tick();
  assert.equal(host.querySelector('[role="alert"]'), null, "a later action must clear the refusal alert");
});

async function mountPendingBillRow() {
  globalThis.__docRowRouter = { push() {}, refresh() {} };
  globalThis.__docRowToasts = [];
  const id = randomUUID();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <DocumentRowActions id={id} status="pending_approval" config={config} openHref="/ap/bills/1" canPost={false} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root, id };
}

async function clickWithdraw(host: HTMLElement) {
  const withdraw = host.querySelector('button[aria-label="Withdraw submission"]') as HTMLButtonElement;
  assert.ok(withdraw, "a pending-approval row must offer Withdraw submission");
  await act(async () => {
    withdraw.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();
}

/** a pending-approval bill row offers Withdraw submission — the recall
 * posts the prompted reason to the native withdraw and toasts success. */
test("a pending-approval bill row withdraws with the prompted reason", async (t) => {
  const posted: unknown[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    posted.push(JSON.parse(String((init?.body as string) ?? "{}")));
    return Response.json({ ok: true }, { status: 200 });
  }) as typeof fetch;
  globalThis.__docRowPrompt = "billed the wrong vendor";
  const { host, root, id } = await mountPendingBillRow();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
    globalThis.__docRowPrompt = null;
  });
  await clickWithdraw(host);
  assert.deepEqual(posted, [{ action: "withdraw", documentId: id, reason: "billed the wrong vendor" }]);
  const successes = (globalThis.__docRowToasts ?? []).filter((toast) => toast.kind === "success");
  assert.equal(successes.length, 1, "the withdraw must surface exactly one success toast");
});

/** a withdraw the server refuses (a stranger's click) persists the typed
 * reason row-inline instead of reading as nothing happened. */
test("a refused row withdraw persists the server reason inline", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ error: "only the submitter or an approver may withdraw this submission" }, { status: 403 })) as typeof fetch;
  globalThis.__docRowPrompt = "changed my mind";
  const { host, root } = await mountPendingBillRow();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
    globalThis.__docRowPrompt = null;
  });
  await clickWithdraw(host);
  const errors = (globalThis.__docRowToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "the refused withdraw must surface exactly one error toast");
  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert, "the refused withdraw must persist a row-inline alert");
  assert.match(alert.textContent ?? "", /submitter or an approver/);
});

/** A 422 refusal naming a remedy renders both through the shared reader —
 * the unmatched-lines bill refusal names its purchase order twice, once as
 * the reason and once as the next step. */
test("a 422 post refusal renders the server remedy with the reason", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      {
        error: "vendor-bill line 1 (GRN-ETH-GUJI) is stock still open on purchase order PO-00002 line 1",
        code: "BILL_LINES_UNMATCHED",
        remedy: "Match this bill to purchase order PO-00002 (Match to purchase order), then post again",
      },
      { status: 422 },
    )) as typeof fetch;
  const { host, root } = await mountApprovedRow();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await clickPost(host);
  await tick();
  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert, "the refused post must persist a row-inline alert");
  assert.match(alert.textContent ?? "", /still open on purchase order PO-00002/);
  assert.match(alert.textContent ?? "", /Match this bill to purchase order PO-00002/);
});
