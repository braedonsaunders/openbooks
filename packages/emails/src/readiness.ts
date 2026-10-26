// One decision and one copy for "this organization cannot send email right now".
// Every refusal site (routes, workers, engine services) and the Admin → Email
// page read the same resolution, so the remedy they name is the one the
// organization can actually perform: its administrators configure delivery on
// the Admin → Email page. Delivery has no platform-wide provider, so no
// refusal may point at a platform setting.

import type { EmailTransportResolution } from "./transport";

/** A resolution that cannot produce a transport. */
export type EmailDeliveryBlock = Exclude<EmailTransportResolution, { state: "ready" }>;

/** Where an organization configures outbound email. */
export const EMAIL_SETUP_LOCATION = "Admin → Email";

/**
 * The refusal split into a headline and a remedy so title/remedy surfaces can
 * render each part; `emailDeliveryBlockedMessage` joins them for single-string
 * surfaces. The remedy always names a step an organization administrator can
 * take on the Admin → Email page.
 */
export function emailDeliveryBlockedParts(block: EmailDeliveryBlock): {
  summary: string;
  remedy: string;
} {
  if (block.state === "unconfigured") {
    return {
      summary: "Email delivery is not enabled for this organization.",
      remedy: `An administrator with setup access can choose a provider and turn delivery on in ${EMAIL_SETUP_LOCATION}.`,
    };
  }
  return {
    summary: `Email delivery cannot send: ${block.reason}.`,
    remedy: `An administrator with setup access can re-enter the provider settings in ${EMAIL_SETUP_LOCATION}.`,
  };
}

/** Single-string refusal for surfaces that show one message. */
export function emailDeliveryBlockedMessage(block: EmailDeliveryBlock): string {
  const { summary, remedy } = emailDeliveryBlockedParts(block);
  return `${summary} ${remedy}`;
}

/**
 * Readiness of an organization's outbound email, without transport secrets.
 * `ready` means a send can be attempted; anything else is a refusal.
 */
export type EmailDeliveryReadiness = { state: "ready" } | EmailDeliveryBlock;

/** Project a resolution onto the readiness the settings page may display. */
export function emailDeliveryReadiness(
  resolution: EmailTransportResolution,
): EmailDeliveryReadiness {
  return resolution.state === "ready" ? { state: "ready" } : resolution;
}
