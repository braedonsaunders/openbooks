import type { ScheduleActor } from "./boards.ts";
import type { ScheduleNotice } from "./entries.ts";

export interface DistributionDispatch {
  event: "on_submit" | "on_update" | "after_post";
  requestId: string;
  actor: ScheduleActor;
}
type Dispatcher = (
  input: DistributionDispatch,
) => Promise<{ failed: boolean; error: string | null; runs: number }>;
type BoardLifecycle = (input: {
  actor: ScheduleActor;
  boardId: string;
  from: string;
  through: string;
  subjectIds: readonly string[];
  event: "on_update" | "after_post";
  occurrence: string;
}) => Promise<{ message: string; remedy: string } | null>;
type NoticeDelivery = (input: {
  orgId: string;
  actorId: string;
  boardName: string;
  notices: readonly ScheduleNotice[];
}) => Promise<void>;
const runtime = globalThis as typeof globalThis & {
  __scheduleDispatch?: Dispatcher;
  __scheduleLifecycle?: BoardLifecycle;
  __scheduleNoticeDelivery?: NoticeDelivery;
};
export function registerScheduleDistributionHooks(
  dispatch: Dispatcher,
  lifecycle: BoardLifecycle,
): void {
  runtime.__scheduleDispatch = dispatch;
  runtime.__scheduleLifecycle = lifecycle;
}
export function dispatchScheduleDistribution(input: DistributionDispatch) {
  if (!runtime.__scheduleDispatch)
    throw new Error(
      "Schedule distribution is not available in this process. Install the native engine composition before sending.",
    );
  return runtime.__scheduleDispatch(input);
}
/** Optional authored Flows observe committed scheduling changes in the same transaction. */
export async function scheduleBoardLifecycle(input: Parameters<BoardLifecycle>[0]) {
  return runtime.__scheduleLifecycle ? runtime.__scheduleLifecycle(input) : null;
}

export function registerScheduleNoticeDelivery(delivery: NoticeDelivery): void {
  runtime.__scheduleNoticeDelivery = delivery;
}

/** Persist assignee notices when a Flow releases a governed schedule change. */
export async function deliverScheduleNotice(input: Parameters<NoticeDelivery>[0]): Promise<void> {
  if (!runtime.__scheduleNoticeDelivery) {
    throw new Error("Schedule notice delivery is not installed in this process.");
  }
  await runtime.__scheduleNoticeDelivery(input);
}
