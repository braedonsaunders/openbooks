import assert from "node:assert/strict";
import test from "node:test";

// F4-8 (form half): the email settings form rendered zero next-intl copy —
// every label, hint and toast was an English literal. The form now resolves
// all of its own chrome through admin.email keys. (Provider/field labels
// come from the emails package's provider specs and stay data, like the
// example placeholders; the save/sendTest parse order is tracked allowlist
// debt and is untouched here.)

// jsdom first: the form reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/email",
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
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return '/admin/email'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}",
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
const messages = (await import("../../../../messages/fr")).default;
const { EmailSettingsForm } = await import("./EmailSettingsForm");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function renderForm() {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
        <EmailSettingsForm
          initial={{
            enabled: true,
            provider: "resend",
            fromName: "Compta",
            fromEmail: "rapports@exemple.fr",
            hasSecret: true,
            updatedAt: null,
          }}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
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

test("the email form renders French chrome with no English literals", async (t) => {
  const { unmount } = await renderForm();
  t.after(unmount);
  const text = document.body.textContent ?? "";
  for (const expected of [
    "Activer l'envoi d'e-mails",
    "Fournisseur",
    "Nom de l'expéditeur",
    "E-mail de l'expéditeur",
    "Répondre à (facultatif)",
    "enregistré",
    "Remplacer",
    "Enregistrer",
    "Envoyer un e-mail de test",
  ]) {
    assert.ok(text.includes(expected), `the French form must render ${JSON.stringify(expected)}`);
  }
  for (const leaked of [
    "Enable email delivery",
    "From name",
    "From email",
    "Reply-to (optional)",
    "stored",
    "Replace",
    "Save settings",
    "Send a test email",
    "Send test",
  ]) {
    assert.ok(!text.includes(leaked), `no English literal may leak into the French form: ${leaked}`);
  }
});
