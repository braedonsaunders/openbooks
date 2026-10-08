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
