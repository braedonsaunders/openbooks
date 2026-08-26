import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

interface Query {
  text: string;
  values: unknown[];
}

interface ResetHarnessState {
  user: { id: string; org_id: string; name: string; email: string } | null;
  transport: { provider: string } | null;
  queries: Query[];
  transportLookups: string[];
  messageInputs: Array<{ recipientName: string; resetUrl: string; expiresMinutes: number }>;
  emailLogs: Array<Record<string, unknown>>;
  deliveries: Array<{ transport: unknown; message: Record<string, unknown> }>;
  sentMarks: Array<Record<string, unknown>>;
  failedMarks: Array<Record<string, unknown>>;
  uncertainMarks: Array<Record<string, unknown>>;
  execute(query: Query): Promise<{ rows: unknown[] }>;
}

const state: ResetHarnessState = {
  user: null,
  transport: null,
  queries: [],
  transportLookups: [],
  messageInputs: [],
  emailLogs: [],
  deliveries: [],
  sentMarks: [],
  failedMarks: [],
  uncertainMarks: [],
  async execute(query) {
    this.queries.push(query);
    if (query.text.includes("from users u")) {
      return { rows: this.user ? [this.user] : [] };
    }
    if (query.text.includes("select count(*)::int as n")) {
      return { rows: [{ n: 0 }] };
    }
    return { rows: [] };
  },
};

const stateKey = Symbol.for("openbooks.auth-reset-test");
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockSources = new Map<string, string>([
  ["mock:server-only", "export {}"],
  [
    "mock:drizzle-orm",
    `
      export function sql(strings, ...values) {
        return { text: strings.join('?'), values }
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.auth-reset-test')]
      export const db = { execute: (query) => state.execute(query) }
      export async function withBypass(callback) { return callback() }
    `,
  ],
  [
    "mock:emails",
    `
      const state = globalThis[Symbol.for('openbooks.auth-reset-test')]
      export function passwordResetEmail(input) {
        state.messageInputs.push(input)
        return { subject: 'Reset your password', html: input.resetUrl, text: input.resetUrl }
      }
      export async function sendVia(transport, message) {
        state.deliveries.push({ transport, message })
        return { kind: 'sent', providerMessageId: 'provider-message-1' }
      }
      export function deriveEmailDeliveryKey() {
        return \`obem_\${'a'.repeat(40)}\`
      }
    `,
  ],
  [
    "mock:email-config",
    `
      const state = globalThis[Symbol.for('openbooks.auth-reset-test')]
      export async function resolveOrgEmailTransport(orgId) {
        state.transportLookups.push(orgId)
        return state.transport
      }
      export async function insertEmailLog(row) {
        state.emailLogs.push(row)
        return 'email-log-1'
      }
      export async function markEmailSent(orgId, logId, providerMessageId) {
        state.sentMarks.push({ orgId, logId, providerMessageId })
      }
      export async function markEmailFailed(orgId, logId, error) {
        state.failedMarks.push({ orgId, logId, error })
      }
      export async function markEmailUncertain(orgId, logId, reason) {
        state.uncertainMarks.push({ orgId, logId, reason })
      }
    `,
  ],
  ["mock:email-tokens", "export function appBaseUrl() { return 'https://books.example.test' }"],
  [
    "mock:auth",
    `
      export function authContextHashes() {
        return { networkHash: 'network-hash', userAgentHash: 'user-agent-hash' }
      }
      export async function hashPassword() { return 'password-hash' }
    `,
  ],
  [
    "mock:auth-policy",
    `
      export function normalizeLoginEmail(email) {
        if (typeof email !== 'string') return null
        const normalized = email.trim().toLowerCase()
        return normalized || null
      }
    `,
  ],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocks: Record<string, string> = {
      "server-only": "mock:server-only",
      "drizzle-orm": "mock:drizzle-orm",
      "@openbooks/engine/src/db.ts": "mock:db",
      "@openbooks/emails": "mock:emails",
      "@openbooks/engine/src/email-config.ts": "mock:email-config",
      "@openbooks/engine/src/flows/email-tokens.ts": "mock:email-tokens",
      "./auth": "mock:auth",
      "./auth-policy": "mock:auth-policy",
    };
    const url = mocks[specifier];
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const authResetModuleUrl = "./auth-reset.ts?auth-reset-test";
const { requestPasswordReset } = await import(authResetModuleUrl) as typeof import("./auth-reset");

function resetState(): void {
  state.user = {
    id: "user-1",
    org_id: "org-1",
    name: "Ada Example",
    email: "ada@example.test",
  };
  state.transport = null;
  state.queries.length = 0;
  state.transportLookups.length = 0;
  state.messageInputs.length = 0;
  state.emailLogs.length = 0;
  state.deliveries.length = 0;
  state.sentMarks.length = 0;
  state.failedMarks.length = 0;
  state.uncertainMarks.length = 0;
}

function resetMutations(): Query[] {
  return state.queries.filter(({ text }) => (
    text.includes("insert into auth_password_resets")
    || text.includes("update auth_password_resets")
  ));
}

test("missing email transport neither issues nor logs a reset bearer credential", async (t) => {
  resetState();
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args.map(String).join(" ")));

  const result = await requestPasswordReset(" Ada@Example.Test ", {
    networkAddress: "192.0.2.1",
    userAgent: "reset-test",
  });

  const resetUrl = state.messageInputs[0]?.resetUrl;
  const rawToken = resetUrl ? new URL(resetUrl).searchParams.get("token") : null;
  assert.deepEqual({
    result,
    resetMutations: resetMutations().length,
    resetMessages: state.messageInputs.length,
    leakedCredential: warnings.some((warning) => (
      warning.includes("/login/reset")
      || warning.includes("token=")
      || Boolean(rawToken && warning.includes(rawToken))
    )),
  }, {
    result: undefined,
    resetMutations: 0,
    resetMessages: 0,
    leakedCredential: false,
  });
  assert.deepEqual(state.transportLookups, ["org-1"]);
  assert.equal(state.deliveries.length, 0);
});

test("configured email transport delivers a hashed one-use credential without enumerating users", async () => {
  resetState();
  state.transport = { provider: "test" };

  const knownResult = await requestPasswordReset("ada@example.test", {
    networkAddress: "192.0.2.1",
    userAgent: "reset-test",
  });

  assert.equal(knownResult, undefined);
  assert.equal(state.messageInputs.length, 1);
  assert.equal(state.deliveries.length, 1);
  assert.equal(state.emailLogs.length, 1);
  assert.deepEqual(state.sentMarks, [{
    orgId: "org-1",
    logId: "email-log-1",
    providerMessageId: "provider-message-1",
  }]);
  const resetUrl = state.messageInputs[0]!.resetUrl;
  const rawToken = new URL(resetUrl).searchParams.get("token");
  assert.ok(rawToken);
  const insert = state.queries.find(({ text }) => text.includes("insert into auth_password_resets"));
  assert.ok(insert);
  assert.ok(insert.values.includes(createHash("sha256").update(rawToken).digest("hex")));
  assert.ok(!insert.values.includes(rawToken));

  const sideEffectCount = state.queries.length + state.deliveries.length + state.emailLogs.length;
  state.user = null;
  const unknownResult = await requestPasswordReset("unknown@example.test", {
    networkAddress: "192.0.2.1",
    userAgent: "reset-test",
  });
  assert.equal(unknownResult, knownResult);
  assert.equal(state.queries.length + state.deliveries.length + state.emailLogs.length, sideEffectCount + 1);
});
