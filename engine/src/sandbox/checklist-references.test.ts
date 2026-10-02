import { checklistDocument, checklistStep } from "../testing/checklist-documents.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { emptyStepDesign } from "@openbooks/forms-core";
import { remapChecklistDocument, remapChecklistResponse } from "./checklist-references.ts";
const source = "10000000-0000-4000-8000-000000000001",
  target = "20000000-0000-4000-8000-000000000001";
const ids = {
  steps: new Map([[source, target]]),
  parties: new Map([[source, target]]),
  accounts: new Map([[source, target]]),
  departments: new Map([[source, target]]),
  subsidiaries: new Map([[source, target]]),
};
test("sandbox checklist rebasing preserves structure and moves every declared tenant reference", () => {
  const design = {
    ...emptyStepDesign(),
    dependencies: [source],
    condition: { op: "eq" as const, field: "departmentId", value: source },
    form: {
      schemaVersion: 1 as const,
      title: "Evidence",
      sections: [
        {
          id: "owner",
          fields: [
            {
              id: "person",
              type: "party" as const,
              label: "Person",
              defaultValue: { kind: "literal" as const, value: source },
            },
          ],
        },
        {
          id: "assets",
          repeating: true,
          fields: [{ id: "account", type: "gl_account" as const, label: "Account" }],
        },
      ],
    },
  };
  const document = checklistDocument({
    name: "Welcome", appliesTo: { employerSubsidiaryId: source, departmentId: source },
    steps: [checklistStep({ id: source, title: "Welcome colleague", description: null,
      ownerKind: "named_party", ownerPartyId: source, evidenceKind: "none", design })],
  });
  const result = remapChecklistDocument(document, ids);
  assert.equal(result.steps[0]?.id, target);
  assert.equal(result.appliesTo.departmentId, target);
  assert.equal(result.steps[0]?.ownerPartyId, target);
  assert.deepEqual(result.steps[0]?.design.dependencies, [target]);
  assert.deepEqual(result.steps[0]?.design.condition, {
    op: "eq",
    field: "departmentId",
    value: target,
  });
  assert.deepEqual(result.steps[0]?.design.form?.sections[0]?.fields[0]?.defaultValue, {
    kind: "literal",
    value: target,
  });
  const response = {
    person: source,
    assets: [{ account: source }],
    notes: "Keep the original description",
  };
  assert.deepEqual(remapChecklistResponse(response, design, ids), {
    person: target,
    assets: [{ account: target }],
    notes: response.notes,
  });
  assert.equal(response.person, source);
  assert.throws(
    () => remapChecklistResponse(response, design, { ...ids, parties: new Map() }),
    /Person.*no counterpart/,
  );
});
