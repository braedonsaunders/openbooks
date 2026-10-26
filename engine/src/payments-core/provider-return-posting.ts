import { AsyncLocalStorage } from "node:async_hooks";
import { PaymentError } from "./payment-errors.ts";

const posting = new AsyncLocalStorage<{ orgId: string; documentId: string }>();

/** Staged return receipts post only as part of their owning financial command. */
export function withProviderReturnPosting<T>(orgId: string, documentId: string, work: () => T): T {
  return posting.run({ orgId, documentId }, work);
}

export function assertProviderReturnPosting(document: {
  id: string;
  orgId: string;
  custom: unknown;
}): void {
  if (
    !document.custom ||
    typeof document.custom !== "object" ||
    !("providerReturn" in document.custom)
  )
    return;
  const authority = posting.getStore();
  if (authority?.orgId !== document.orgId || authority.documentId !== document.id) {
    throw new PaymentError(
      "This receipt belongs to a provider return. Approve its receipt requests, then resume the refund or dispute review in Banking.",
    );
  }
}
