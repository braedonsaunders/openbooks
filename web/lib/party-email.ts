import { isValidEmailAddress } from "@openbooks/emails/delivery-input";

/**
 * A party's email address: blank, or one mailbox the house email validator
 * accepts (the same rule email delivery applies), so a party never stores a
 * value no message can be sent to. Shared by the party routes and the forms
 * that create parties.
 */
export function partyEmailInvalid(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  return trimmed !== "" && !isValidEmailAddress(trimmed);
}

export const PARTY_EMAIL_REFUSAL =
  "Enter a valid email address, such as name@example.com, or leave it blank.";
