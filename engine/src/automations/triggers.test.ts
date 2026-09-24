import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPublishableAutomationActions,
  assertTriggerCanEnable,
  assertValidScheduleTrigger,
  eventSourcedTriggerRefusal,
  invalidScheduleCronReason,
  parseAutomationActions,
  parseAutomationConditions,
  parseAutomationRules,
  parseAutomationTrigger,
  AutomationContractError,
} from "./triggers.ts";
import { AUTOMATION_TRIGGER_KINDS } from "@openbooks/schema/src/hrm-automations.ts";

test("all six trigger kinds parse", () => {
  assert.equal(parseAutomationTrigger({ kind: "schedule", cron: "0 9 * * *", timezone: "UTC" }).kind, "schedule");
  assert.equal(
    parseAutomationTrigger({ kind: "date_relative", entity: "employment", dateField: "service_start", offsetDays: 3, direction: "before", atTime: "09:00" }).kind,
    "date_relative",
  );
  assert.equal(parseAutomationTrigger({ kind: "field_change", entity: "employment", field: "status" }).kind, "field_change");
  assert.equal(parseAutomationTrigger({ kind: "event", subjectKind: "x", eventKind: "approved" }).kind, "event");
  assert.equal(parseAutomationTrigger({ kind: "document", event: "signed" }).kind, "document");
  assert.equal(parseAutomationTrigger({ kind: "manual" }).kind, "manual");
});

test("trigger kind vocabulary matches the storage CHECK (0226)", () => {
  assert.deepEqual([...AUTOMATION_TRIGGER_KINDS].sort(), ["date_relative", "document", "event", "field_change", "manual", "schedule"]);
});

test("unknown trigger kind refuses with remedy", () => {
  assert.throws(
    () => parseAutomationTrigger({ kind: "webhook_inbound" }),
    (e: unknown) => e instanceof AutomationContractError && /invalid/.test((e as Error).message),
  );
});

test("bad at_time refuses", () => {
  assert.throws(
    () => parseAutomationTrigger({ kind: "date_relative", entity: "e", dateField: "f", offsetDays: 1, direction: "before", atTime: "9am" }),
    AutomationContractError,
  );
});

test("actions need at least one valid action", () => {
  assert.throws(() => parseAutomationActions([]), AutomationContractError);
  assert.throws(() => parseAutomationActions([{ kind: "fire_missiles" }]), AutomationContractError);
  const actions = parseAutomationActions([
    { kind: "send_notification", to: "manager", body: "hi" },
    { kind: "update_field", entity: "employment", field: "department_id", value: "x" },
  ]);
  assert.equal(actions.length, 2);
});

test("webhook actions refuse publishing with the transport named and a replacement", () => {
  const actions = parseAutomationActions([{ kind: "webhook", endpointKey: "crm" }]);
  assert.throws(
    () => assertPublishableAutomationActions(actions),
    (e: unknown) =>
      e instanceof AutomationContractError &&
      /no outbound webhook transport/.test((e as Error).message) &&
      /send_notification/.test((e as Error).message),
  );
  // Deliverable actions still publish.
  assertPublishableAutomationActions(
    parseAutomationActions([{ kind: "send_notification", to: "manager", body: "hi" }]),
  );
});

test("delay, approve_step and start_flow refuse publishing with named remedies", () => {
  const cases: { actions: unknown; pattern: RegExp }[] = [
    { actions: [{ kind: "delay", days: 3 }], pattern: /no resumable continuation/ },
    { actions: [{ kind: "approve_step" }], pattern: /cannot mint approval gates/ },
    { actions: [{ kind: "start_flow", subject: "onboarding" }], pattern: /no named dispatch/ },
  ];
  for (const { actions, pattern } of cases) {
    assert.throws(
      () => assertPublishableAutomationActions(parseAutomationActions(actions)),
      (e: unknown) => e instanceof AutomationContractError && pattern.test((e as Error).message),
    );
  }
  // Deliverable actions still publish.
  assertPublishableAutomationActions(
    parseAutomationActions([{ kind: "send_notification", to: "manager", body: "hi" }]),
  );
});

test("unknown send_email template keys refuse publishing with the valid keys named", () => {
  assert.throws(
    () => assertPublishableAutomationActions(
      parseAutomationActions([{ kind: "send_email", templateKey: "probe", to: "initiator" }]),
    ),
    (e: unknown) =>
      e instanceof AutomationContractError &&
      /unknown email template 'probe'/.test((e as Error).message) &&
      /automation_notice/.test((e as Error).message),
  );
  assertPublishableAutomationActions(
    parseAutomationActions([{ kind: "send_email", templateKey: "automation_notice", to: "initiator" }]),
  );
});

test("conditions default to empty (match-all)", () => {
  assert.equal(parseAutomationConditions({}).root, undefined);
  const rules = parseAutomationRules(null);
  assert.equal(rules.departmentId, undefined);
  assert.deepEqual(rules.attributes, []);
});

test("a schedule that cannot parse is refused at save with the value named", () => {
  // Parsing itself stays lenient (legacy rows must still read)…
  assert.equal(
    parseAutomationTrigger({ kind: "schedule", cron: "not-a-cron", timezone: "UTC" }).kind,
    "schedule",
  );
  // …while the save-time check refuses by name with the remedy.
  assert.equal(invalidScheduleCronReason("0 9 * * *", "UTC"), null);
  assert.match(invalidScheduleCronReason("not-a-cron", "UTC") ?? "", /cron 'not-a-cron' is not a valid cron expression/);
  assert.match(invalidScheduleCronReason("not-a-cron", "UTC") ?? "", /fix the cron and save again/);
  assert.match(invalidScheduleCronReason("0 9 * * *", "Nope/Zone") ?? "", /timezone 'Nope\/Zone' is not a valid IANA timezone/);
  assert.throws(
    () => assertValidScheduleTrigger(parseAutomationTrigger({ kind: "schedule", cron: "not-a-cron", timezone: "UTC" })),
    (e: unknown) =>
      e instanceof AutomationContractError && /cron 'not-a-cron' is invalid|not a valid cron expression/.test((e as Error).message),
  );
  // Non-schedule triggers are untouched by the cron check.
  assertValidScheduleTrigger(parseAutomationTrigger({ kind: "manual" }));
});

test("event-sourced triggers refuse enabling by name while drafts stay saveable", () => {
  // stageAutomationEvent's only production caller is nobody: no writer
  // stages field_change/event/document events, so enabling one would arm a
  // recipe that idles forever looking healthy.
  for (const kind of ["field_change", "event", "document"] as const) {
    const base =
      kind === "field_change"
        ? { kind, entity: "employment", field: "status" }
        : kind === "event"
          ? { kind, subjectKind: "hrm_employment_change_request", eventKind: "approved" }
          : { kind, event: "signed" as const };
    const trigger = parseAutomationTrigger(base);
    assert.match(eventSourcedTriggerRefusal(trigger) ?? "", new RegExp(`trigger kind '${kind}' is not available yet`));
    assert.match(eventSourcedTriggerRefusal(trigger) ?? "", /never fire/);
    assert.throws(() => assertTriggerCanEnable(trigger), AutomationContractError);
  }
  // Firable triggers are untouched: parsing stays lenient and enabling open.
  for (const trigger of [
    parseAutomationTrigger({ kind: "schedule", cron: "0 9 * * *", timezone: "UTC" }),
    parseAutomationTrigger({ kind: "manual" }),
  ]) {
    assert.equal(eventSourcedTriggerRefusal(trigger), null);
    assertTriggerCanEnable(trigger);
  }
});
