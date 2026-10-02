import { randomUUID } from 'node:crypto';
import { emptyStepDesign, type ChecklistDocument, type ChecklistStep, type FormSchemaV1 } from '@openbooks/forms-core';

/** A complete editable document; each test supplies the policy differences it exercises. */
export function checklistStep(overrides: Partial<ChecklistStep> = {}): ChecklistStep {
  return {
    id: randomUUID(), title: 'Review handbook', description: 'Review the approved handbook.',
    ownerKind: 'manager', ownerPartyId: null, dueOffsetDays: 0, required: true,
    evidenceKind: 'acknowledgement', design: emptyStepDesign(), ...overrides,
  };
}
export function checklistDocument(overrides: Partial<ChecklistDocument> = {}): ChecklistDocument {
  return {
    name: 'New colleague', kind: 'onboarding',
    appliesTo: { employerSubsidiaryId: null, departmentId: null },
    steps: [checklistStep()], ...overrides,
  };
}

export function requiredTextForm(title: string, section: string, id: string, label: string): FormSchemaV1 {
  return { schemaVersion: 1, title, sections: [{ id: section, fields: [{ id, label, type: 'text', required: true }] }] };
}
