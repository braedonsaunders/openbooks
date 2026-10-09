import type { FlowExecCtx } from './types.ts';
type Handler = (input: {
  requestId: string;
  runId: string;
  ctx: FlowExecCtx;
}) => Promise<number>;
const runtime = globalThis as typeof globalThis & {
  __scheduleEmailHandler?: Handler;
};
export function registerScheduleEmailHandler(handler: Handler): void {
  runtime.__scheduleEmailHandler = handler;
}
export async function sendReviewedSchedule(
  input: Parameters<Handler>[0],
): Promise<number> {
  if (!runtime.__scheduleEmailHandler)
    throw new Error(
      'Native schedule email delivery is not installed in this process.',
    );
  return runtime.__scheduleEmailHandler(input);
}

type AutomaticHandler = (input: {
  boardId: string;
  runId: string;
  ctx: FlowExecCtx;
}) => Promise<number>;
const automaticRuntime = globalThis as typeof globalThis & {
  __automaticScheduleHandler?: AutomaticHandler;
};
export function registerAutomaticScheduleHandler(handler: AutomaticHandler) {
  automaticRuntime.__automaticScheduleHandler = handler;
}
export function sendAutomaticSchedule(input: Parameters<AutomaticHandler>[0]) {
  if (!automaticRuntime.__automaticScheduleHandler)
    throw new Error("Native automatic schedule delivery is not installed.");
  return automaticRuntime.__automaticScheduleHandler(input);
}
