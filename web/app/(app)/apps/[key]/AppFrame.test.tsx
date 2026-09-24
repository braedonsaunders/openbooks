import assert from "node:assert/strict";
import test from "node:test";
import type { AbstractIntlMessages } from "next-intl";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/apps/shop",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messagesEn = (await import("../../../../messages/en")).default as unknown as AbstractIntlMessages;
const messagesDe = (await import("../../../../messages/de")).default as unknown as AbstractIntlMessages;
const { AppFrame } = await import("./AppFrame");

const CONTEXT = {
  app: { id: "app-1", key: "shop", name: "Shop", versionId: "v1" },
  user: null,
};

type Posted = { ok: boolean; error?: unknown; result?: unknown };

async function renderFrame(options: { locale: string; messages: AbstractIntlMessages; previewDraftId?: string }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    /* eslint-disable react/no-children-prop */
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: options.locale,
        messages: options.messages,
        timeZone: "UTC",
        children: React.createElement(AppFrame, {
          appKey: "shop",
          context: CONTEXT,
          previewDraftId: options.previewDraftId,
        }),
      }),
    );
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const iframe = host.querySelector("iframe") as HTMLIFrameElement | null;
  assert.ok(iframe, "the frame must render");
  assert.ok(iframe.contentWindow, "the frame window must exist");
  const posted: Posted[] = [];
  (iframe.contentWindow as unknown as Record<string, unknown>).postMessage = (msg: unknown) => {
    posted.push(msg as Posted);
  };
  return {
    host,
    root,
    posted,
    async call(method: string) {
      await act(async () => {
        window.dispatchEvent(
          Object.assign(new window.Event("message"), {
            source: iframe.contentWindow,
            data: { __ob: true, type: "call", id: "r1", method, payload: {} },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

// F4T-10: a 200 with a non-JSON body is a failure, not a success — the
// sandbox must get ok:false with the named refusal, never ok:true with an
// empty result and never a SyntaxError string.
test("F4T-10: non-JSON success body refuses with the named error", async () => {
  globalThis.fetch = (async () =>
    new Response("not json", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
  const frame = await renderFrame({ locale: "en", messages: messagesEn });
  try {
    await frame.call("records.list");
    assert.equal(frame.posted.length, 1, "exactly one bridge result must post");
    assert.equal(frame.posted[0]!.ok, false, "a non-JSON body must not post success");
    assert.match(String(frame.posted[0]!.error ?? ""), /Bridge call failed/);
  } finally {
    await frame.unmount();
  }
});

// F4T-10: bridge refusals render in the operator locale — under de the
// unknown-method refusal names the method without hardcoded English.
test("F4T-10: unknown method refusal renders in the operator locale", async () => {
  globalThis.fetch = (async () => {
    throw new Error("fetch must not fire for an unknown method");
  }) as typeof fetch;
  const frame = await renderFrame({ locale: "de", messages: messagesDe });
  try {
    await frame.call("nope.not-a-method");
    assert.equal(frame.posted.length, 1, "exactly one bridge result must post");
    assert.equal(frame.posted[0]!.ok, false);
    const message = String(frame.posted[0]!.error ?? "");
    assert.ok(message.includes("nope.not-a-method"), `the method must be named, got ${message}`);
    assert.ok(!message.includes("unknown bridge method"), `no hardcoded English, got ${message}`);
  } finally {
    await frame.unmount();
  }
});

// F4T-10: the draft-preview refusal is operator-locale copy, not the
// hardcoded English sentence.
test("F4T-10: draft preview refusal renders in the operator locale", async () => {
  globalThis.fetch = (async () => {
    throw new Error("fetch must not fire for a draft preview");
  }) as typeof fetch;
  const frame = await renderFrame({ locale: "de", messages: messagesDe, previewDraftId: "draft-1" });
  try {
    await frame.call("records.list");
    assert.equal(frame.posted.length, 1, "exactly one bridge result must post");
    assert.equal(frame.posted[0]!.ok, false);
    const message = frame.posted[0]!.error;
    assert.equal(typeof message, "string", "the refusal must be readable copy");
    assert.notEqual(
      message,
      "Draft preview does not execute backend actions or access live data",
      "the refusal must not be the hardcoded English sentence",
    );
  } finally {
    await frame.unmount();
  }
});
