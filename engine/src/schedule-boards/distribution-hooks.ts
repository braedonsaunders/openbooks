import type { ScheduleActor } from './boards.ts';

export interface DistributionDispatch {
  event: 'on_submit' | 'on_update' | 'after_post';
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
  event: 'on_update' | 'after_post';
  occurrence: string;
}) => Promise<{ message: string; remedy: string } | null>;
const runtime = globalThis as typeof globalThis & {
  __scheduleDispatch?: Dispatcher;
  __scheduleLifecycle?: BoardLifecycle;
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
      'Schedule distribution is not available in this process. Install the native engine composition before sending.',
    );
  return runtime.__scheduleDispatch(input);
}
/** Optional authored Flows observe committed scheduling changes in the same transaction. */
export async function scheduleBoardLifecycle(
  input: Parameters<BoardLifecycle>[0],
) {
  return runtime.__scheduleLifecycle
    ? runtime.__scheduleLifecycle(input)
    : null;
}
