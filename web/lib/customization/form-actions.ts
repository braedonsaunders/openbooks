import { FORM_ACTION_KEYS } from "@openbooks/customization";

/** One action key of the closed form-action vocabulary. */
export type FormActionKey = (typeof FORM_ACTION_KEYS)[number];

/**
 * The action keys a record kind's drawer implements, derived from what each
 * drawer's renderFormAction handles. The layout designer offers only these
 * toggles: offering post, void, gl_impact or delete for a kind whose drawer
 * renders none of them is a dead toggle — it saves OK and changes nothing.
 *
 * Kinds without an entry implement the full vocabulary (the document drawer
 * handles every key), so the designer offers everything.
 *
 * Keep in step with web/app/(app)/field-tickets/FieldTicketDrawer.tsx
 * renderFormAction: adding a handled case there without listing the key here
 * keeps its toggle hidden (fail closed); listing a key the drawer does not
 * handle reintroduces a dead toggle.
 */
const SUPPORTED_FORM_ACTIONS: Record<string, readonly FormActionKey[]> = {
  field_ticket: ["customize", "pdf", "workflow", "approval", "edit", "submit"],
};

/** The action toggles the layout designer may offer for a record type. */
export function supportedFormActionsFor(recordType: string): readonly FormActionKey[] {
  return SUPPORTED_FORM_ACTIONS[recordType] ?? FORM_ACTION_KEYS;
}
