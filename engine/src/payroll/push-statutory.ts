import { cmp } from "../money.ts";
import { statutoryAssessment } from "./packs.ts";
import type { PushStatutoryFn, StubLine } from "./statutory-context.ts";

/** Build the `pushStatutory` closure used by every pack statutory pass. */
export function createPushStatutory(input: {
  country: string;
  lines: StubLine[];
  emittedEarningsAssessed: Set<string>;
  need: (systemKey: string, kind: string) => Record<string, unknown>;
}): PushStatutoryFn {
  const { country, lines, emittedEarningsAssessed, need } = input;
  return (
    systemKey, kind, description, amount, sequence,
    options = {},
  ) => {
    if (cmp(amount, "0") === 0) return;
    const assessedOn = statutoryAssessment(country, systemKey, kind);
    const slot = `${systemKey}:${kind}`;
    if (assessedOn === "earnings" && emittedEarningsAssessed.has(slot)) return;
    const c = need(systemKey, kind);
    let pushed = false;
    for (const allocation of options.allocations ?? [{ amount }]) {
      if (cmp(allocation.amount, "0") === 0) continue;
      lines.push({
        componentId: c.id as string, kind, description,
        amount: allocation.amount, sequence,
        projectId: allocation.projectId ?? null,
        departmentId: allocation.departmentId ?? null,
        assessedOn,
      });
      pushed = true;
    }
    if (assessedOn === "earnings" && pushed) emittedEarningsAssessed.add(slot);
  };
}
