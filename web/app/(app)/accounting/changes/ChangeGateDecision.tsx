"use client";
import { useTranslations } from "next-intl";
import { GateActions, type DelegateOption } from "../../inbox/GateActions";

/**
 * The approval-gate decision for the change in its own drawer. Pending
 * accounting events decide through the same native gate path as the Inbox
 * (GateActions posts to /api/flows/gates/decide, reason on reject), so the
 * approver never has to leave the proposal to act on it.
 */
export function ChangeGateDecision({
  gateId,
  canAct,
  awaitingAnother,
  signatureRequired,
  canDelegate,
  users,
}: {
  gateId: string;
  /** The native gate check permits this viewer to decide. */
  canAct: boolean;
  /** The gate reaches this viewer but separation of duties reserves it. */
  awaitingAnother: boolean;
  signatureRequired: boolean;
  canDelegate: boolean;
  users: DelegateOption[];
}) {
  const tc = useTranslations("common");
  if (awaitingAnother && !canAct) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {tc("approvalFlow.awaitingAnother")}
      </p>
    );
  }
  if (!canAct) return null;
  return (
    <GateActions
      gateId={gateId}
      canDelegate={canDelegate}
      users={users}
      signatureRequired={signatureRequired}
    />
  );
}
