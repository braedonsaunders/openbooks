/**
 * HR-15 document_signature adapter — placeholder for HR-19 e-sign.
 *
 * The kind is registered now so filters, the registry, and the
 * signatures chip already know it; the list is empty and act() refuses
 * by name until HR-19 lands its signature-request table and service,
 * at which point this file grows a list() over that table and an act()
 * delegating to its service — never a second write path.
 */

import type { InboxAdapter } from "../registry.ts";
import type { InboxItem } from "../types.ts";

export const documentSignatureAdapter: InboxAdapter = {
  kind: "document_signature",
  async list(): Promise<InboxItem[]> {
    return [];
  },
  async act(): Promise<void> {
    throw new Error(
      "Document signatures are completed from the document itself; open the document to sign it.",
    );
  },
};
