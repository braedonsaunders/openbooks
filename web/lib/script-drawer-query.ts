import { isUuid } from "./list-params";

const TRIGGER_MESSAGE_KEYS: Record<string, string> = {
  before_submit: "beforeSubmit",
  before_post: "beforePost",
  after_post: "afterPost",
  before_void: "beforeVoid",
  custom_gl_lines: "customGlLines",
  scheduled: "scheduled",
  endpoint: "endpoint",
  bulk: "bulk",
  client: "client",
};

export function scriptDrawerQueryId(scriptId: string | undefined): string | null {
  return scriptId && scriptId !== "new" && isUuid(scriptId) ? scriptId : null;
}

export function scriptTriggerMessageKey(trigger: string): string | null {
  return TRIGGER_MESSAGE_KEYS[trigger] ?? null;
}
