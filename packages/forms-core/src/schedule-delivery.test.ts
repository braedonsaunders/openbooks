import test from "node:test";
import assert from "node:assert/strict";
import {
  automaticScheduleDeliverySchema,
  schedulePdfLayoutSchema,
} from "./schedule-delivery.ts";
const id = "00000000-0000-4000-8000-000000000001";
const policy = {
  operatorId: id,
  timeZone: "America/Toronto",
  days: 14,
  anchor: "week",
  weekStartsOn: 0,
  visibility: "board",
  recipientMode: "selected",
  additionalPartyIds: [id],
  includePdf: true,
};
test("selected contacts-only policy requires no employee cohort, permits optional PDF layout and rejects no-recipient rules", () => {
  const parsed = automaticScheduleDeliverySchema.parse(policy);
  assert.equal(parsed.cohort, undefined);
  assert.equal(parsed.recipientMode, "selected");
  assert.equal(
    automaticScheduleDeliverySchema.safeParse({
      ...policy,
      additionalPartyIds: [],
    }).success,
    false,
  );
  assert.equal(
    automaticScheduleDeliverySchema.safeParse({ ...policy, pdfLayout: null })
      .success,
    true,
  );
  assert.equal(
    automaticScheduleDeliverySchema.safeParse({
      ...policy,
      visibility: "personal",
    }).success,
    false,
  );
  assert.equal(
    automaticScheduleDeliverySchema.safeParse({
      ...policy,
      additionalPartyIds: [id, id],
    }).success,
    false,
  );
});
test("automatic-only and combined policies are explicit, independently validated choices with real timezone/layout refusals", () => {
  assert.equal(
    automaticScheduleDeliverySchema.safeParse({
      ...policy,
      recipientMode: "automatic",
      additionalPartyIds: [],
    }).success,
    true,
  );
  assert.equal(
    automaticScheduleDeliverySchema.safeParse({
      ...policy,
      recipientMode: "automatic",
    }).success,
    false,
  );
  assert.equal(
    automaticScheduleDeliverySchema.safeParse({
      ...policy,
      recipientMode: "combined",
    }).success,
    true,
  );
  assert.equal(
    automaticScheduleDeliverySchema.safeParse({
      ...policy,
      recipientMode: undefined,
    }).success,
    false,
  );
  assert.equal(
    automaticScheduleDeliverySchema.safeParse({
      ...policy,
      timeZone: "not/a-zone",
    }).success,
    false,
  );
  assert.equal(
    schedulePdfLayoutSchema.safeParse({
      paperSize: "tabloid",
      orientation: "landscape",
      marginMm: 8,
      density: "compact",
      daysPerSection: 14,
      detail: "assignments",
    }).success,
    true,
  );
  assert.equal(
    schedulePdfLayoutSchema.safeParse({
      paperSize: "tabloid",
      orientation: "landscape",
      marginMm: 0,
      density: "compact",
      daysPerSection: 13,
      detail: "assignments",
    }).success,
    false,
  );
});

test('native report presentation choices preserve tenant settings and refuse invalid color inputs', () => {
  const layout = { paperSize: 'a4', orientation: 'landscape', marginMm: 10, density: 'compact', daysPerSection: 7, detail: 'assignments', style: 'classic', accentColor: '#7c3aed', showLegend: false, shadeWeekends: false, colorTreatment: 'subtle', colorIntensity: 8 };
  const parsed = automaticScheduleDeliverySchema.parse({ ...policy, pdfLayout: layout });
  assert.deepEqual(parsed.pdfLayout, layout);
  assert.deepEqual(automaticScheduleDeliverySchema.parse(JSON.parse(JSON.stringify(parsed))).pdfLayout, layout);
  assert.equal(schedulePdfLayoutSchema.safeParse({ ...layout, accentColor: 'url(example)' }).success, false);
  assert.equal(schedulePdfLayoutSchema.safeParse({ ...layout, colorIntensity: 31 }).success, false);
  assert.equal(schedulePdfLayoutSchema.safeParse({ ...layout, colorTreatment: 'strong' }).success, true);
});
