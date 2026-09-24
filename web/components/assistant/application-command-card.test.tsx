import assert from "node:assert/strict";
import test from "node:test";

// F5-2: ApplicationCommandCard rendered ~10 hardcoded English strings while
// sibling cards translate through the assistant namespace. A non-en user
// facing a proposed (possibly destructive) command must read the confirm
// prompt, the review chrome and the outcome in their own locale.
//
// Only the network and the confirm modal are doubled. React, next-intl and
// the REAL French catalog run, so English copy fails every assertion below.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/assistant",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

declare global {
  var __accConfirmSeen: { message: unknown }[] | undefined;
  var __accAutoConfirm: boolean | undefined;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(opts){((globalThis.__accConfirmSeen??=[])).push({message:opts?.message ?? opts});return globalThis.__accAutoConfirm ?? true}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../messages/fr")).default;
const { ApplicationCommandCard } = await import("./application-command-card");
import type { ProposedApplicationCommand } from "./application-command-card";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const base: ProposedApplicationCommand = {
  toolName: "post_adjustment",
  title: "Ajustement congés",
  destructive: false,
  input: { account: "6130", amount: "100.00" },
  confirmToken: "tok-1",
};

function scriptFetch(handler: () => Promise<Response> | Response): () => void {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => handler()) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function mountFr(proposal: ProposedApplicationCommand) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
        <ApplicationCommandCard proposal={proposal} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => {
    await tick();
  });
  return { host, root };
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;
  assert.ok(found, `expected a button labelled ${JSON.stringify(label)} in ${JSON.stringify(host.textContent)}`);
  return found;
}

test("F5-2: the review chrome and discard outcome read French, never English", async () => {
  const restore = scriptFetch(() => Response.json({ ok: true }));
  try {
    const { host, root } = await mountFr(base);
    const text = host.textContent ?? "";
    assert.match(text, /Vérification requise/);
    assert.match(text, /Appliquer la commande/);
    assert.match(text, /rien ne change tant que vous ne l'appliquez pas/i);
    assert.ok(!text.includes("Review required"), "English review heading must not leak");
    assert.ok(!text.includes("Apply command"), "English apply label must not leak");

    await act(async () => {
      button(host, "Rejeter").click();
    });
    assert.match(host.textContent ?? "", /Commande rejetée/);
    assert.ok(!(host.textContent ?? "").includes("Command discarded"));
    await act(async () => {
      root.unmount();
    });
  } finally {
    restore();
  }
});

test("F5-2: the destructive confirm names the title in French and the outcome translates", async () => {
  globalThis.__accConfirmSeen = [];
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const restore = scriptFetch(() => pending);
  try {
    const { host, root } = await mountFr({ ...base, destructive: true });
    await act(async () => {
      button(host, "Appliquer la commande").click();
    });
    // The POST is still in flight, so the card must show the applying state.
    assert.match(host.textContent ?? "", /Application…/);
    assert.equal(globalThis.__accConfirmSeen?.length, 1, "destructive apply must confirm first");
    const message = String(globalThis.__accConfirmSeen?.[0]?.message ?? "");
    assert.match(message, /commande destructive/, "the confirm prompt must be French");
    assert.ok(message.includes(base.title), "the confirm prompt must name the command title");

    await act(async () => {
      release(Response.json({ ok: true }));
      await tick();
      await tick();
    });
    assert.match(host.textContent ?? "", /Commande appliquée/);
    assert.ok(!(host.textContent ?? "").includes("Command applied."));
    await act(async () => {
      root.unmount();
    });
  } finally {
    restore();
    globalThis.__accConfirmSeen = [];
  }
});

test("F5-2: failures translate, preferring the server's named refusal", async () => {
  // A refusal with no usable message falls back to the cataloged failure
  // copy, never to English literals.
  const restore = scriptFetch(() => new Response("{}", { status: 500 }));
  try {
    const { host, root } = await mountFr(base);
    await act(async () => {
      button(host, "Appliquer la commande").click();
      await tick();
      await tick();
    });
    assert.match(host.textContent ?? "", /Échec de la commande/);
    assert.ok(!(host.textContent ?? "").includes("Command failed"));
    await act(async () => {
      root.unmount();
    });
  } finally {
    restore();
  }

  const restoreNet = scriptFetch(() => Promise.reject(new Error("down")));
  try {
    const { host, root } = await mountFr(base);
    await act(async () => {
      button(host, "Appliquer la commande").click();
      await tick();
      await tick();
    });
    assert.match(host.textContent ?? "", /n'a pas pu être appliquée/);
    assert.ok(!(host.textContent ?? "").includes("could not be applied"));
    await act(async () => {
      root.unmount();
    });
  } finally {
    restoreNet();
  }
});
