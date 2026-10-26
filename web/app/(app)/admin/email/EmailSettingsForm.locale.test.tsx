import assert from "node:assert/strict";
import test from "node:test";

// The email settings form rendered zero next-intl copy —
// every label, hint and toast was an English literal. The form now resolves
// all of its own chrome through admin.email keys. (Provider/field labels
// come from the emails package's provider specs and stay data, like the
// example placeholders; the save/sendTest parse order is tracked allowlist
// debt and is untouched here.)

// jsdom first: the form reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/admin/email",
  matchMediaMatches: false,
  resizeObserver: false,
});

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({ navigation: { pathname: "/admin/email" } });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
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

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/fr")).default;
const { EmailSettingsForm } = await import("./EmailSettingsForm");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function renderForm(
  readiness: NonNullable<React.ComponentProps<typeof EmailSettingsForm>["initial"]["readiness"]> = {
    state: "ready",
  },
  overrides: Partial<React.ComponentProps<typeof EmailSettingsForm>["initial"]> = {},
) {
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
            readiness,
            ...overrides,
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
    assert.ok(
      !text.includes(leaked),
      `no English literal may leak into the French form: ${leaked}`,
    );
  }
});

test("an organization that cannot send sees the state and the administrator's remedy in French", async (t) => {
  const copy = messages.admin.email.readiness;
  const unconfigured = await renderForm({ state: "unconfigured" });
  t.after(unconfigured.unmount);
  const banner = document.querySelector('[role="status"]');
  assert.ok(banner, "a refused organization must see the readiness banner");
  assert.ok(
    (banner.textContent ?? "").includes(copy.notEnabled),
    "the banner names the disabled state",
  );
  assert.ok(
    !(banner.textContent ?? "").includes("Email delivery is off"),
    "no English banner copy may leak",
  );

  const reason = "the stored provider credential could not be unsealed with the current data key";
  const unusable = await renderForm({ state: "unusable", reason });
  t.after(unusable.unmount);
  const unusableBanner = document.querySelector('[role="status"]');
  assert.ok(unusableBanner, "an unusable credential must be shown, not hidden");
  assert.ok(
    (unusableBanner.textContent ?? "").includes(copy.unusable),
    "the banner names the unusable state",
  );
  assert.ok(
    (unusableBanner.textContent ?? "").includes(copy.unusableDetail.replace("{reason}", reason)),
    "the banner carries the engine reason",
  );
});

test("a ready organization shows no readiness banner", async (t) => {
  const { unmount } = await renderForm({ state: "ready" });
  t.after(unmount);
  assert.equal(document.querySelector('[role="status"]'), null);
});

test("cleared provider fields remain explicit in the save payload", async (t) => {
  const priorFetch = globalThis.fetch;
  const payloads: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ enabled: true, provider: "smtp", hasSecret: true, updatedAt: "2" });
  }) as typeof fetch;
  const { unmount } = await renderForm(
    { state: "ready" },
    {
      provider: "smtp",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpUsername: "legacy-user",
    },
  );
  t.after(async () => {
    globalThis.fetch = priorFetch;
    await unmount();
  });

  await act(async () => {
    const textInputs = [...document.querySelectorAll("input")].filter(
      (input) => input.type === "text",
    );
    const numberInput = document.querySelector('input[type="number"]') as HTMLInputElement | null;
    assert.ok(textInputs.length >= 5, "the SMTP host and username fields are rendered");
    assert.ok(numberInput, "the SMTP port field is rendered");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(textInputs[3], "");
    textInputs[3]?.dispatchEvent(new window.Event("input", { bubbles: true }));
    setter?.call(numberInput, "");
    numberInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    setter?.call(textInputs[4], "");
    textInputs[4]?.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await act(async () => {
    const save = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Enregistrer",
    );
    assert.ok(save, "the settings form offers its save action");
    save.click();
    await tick();
  });

  assert.equal(payloads.length, 1, "saving issues one settings update");
  assert.equal(payloads[0]?.smtpHost, "", "clearing a provider text field sends the empty value");
  assert.equal(payloads[0]?.smtpPort, null, "clearing a numeric field sends an explicit null");
  assert.equal(payloads[0]?.smtpUsername, "", "clearing a username sends the empty value");
});
