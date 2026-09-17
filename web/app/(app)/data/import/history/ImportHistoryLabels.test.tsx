import assert from "node:assert/strict";
import test from "node:test";

const en = (await import("../../../../../messages/en/data.json", { with: { type: "json" } })).default as Record<
  string,
  unknown
>;
const fr = (await import("../../../../../messages/fr/data.json", { with: { type: "json" } })).default as Record<
  string,
  unknown
>;
const es = (await import("../../../../../messages/es/data.json", { with: { type: "json" } })).default as Record<
  string,
  unknown
>;
const { dateTime } = await import("../../../../../lib/format");

function jobStatus(messages: Record<string, unknown>): Record<string, unknown> {
  const history = (messages.history ?? {}) as Record<string, unknown>;
  return (history.jobStatus ?? {}) as Record<string, unknown>;
}

test("F-t10-009: import-history job statuses are localized in en/fr/es", () => {
  for (const [locale, messages] of Object.entries({ en, fr, es })) {
    const statuses = jobStatus(messages);
    assert.equal(typeof statuses.committed, "string", `${locale} jobStatus.committed must exist`);
    assert.equal(typeof statuses.failed, "string", `${locale} jobStatus.failed must exist`);
    assert.ok(
      (statuses.committed as string).length > 0 && (statuses.failed as string).length > 0,
      `${locale} job statuses must not be empty`,
    );
  }
  // Actually translated — not the English enum echoed back.
  assert.notEqual(jobStatus(fr).committed, jobStatus(en).committed);
  assert.notEqual(jobStatus(fr).failed, jobStatus(en).failed);
  assert.notEqual(jobStatus(es).committed, jobStatus(en).committed);
  assert.notEqual(jobStatus(es).failed, jobStatus(en).failed);
});

test("F-t10-009: import-history timestamps follow the request locale", () => {
  const stamp = "2026-03-15T14:30:00.000Z";
  const fallback = dateTime(stamp);
  assert.notEqual(dateTime(stamp, "fr"), fallback, "fr timestamps must differ from the en-CA default");
  assert.notEqual(dateTime(stamp, "es"), fallback, "es timestamps must differ from the en-CA default");
  assert.match(dateTime(stamp, "fr"), /mars/i, "fr timestamp must use the French month name");
});
