import { PostingError } from "../journal/posting-contracts.ts";
import { postingEffectHooks } from "../journal/posting-effect-contributors.ts";
import {
  postingLineHooks,
  type PostingLineContributors,
} from "../journal/posting-line-contributors.ts";
import {
  postingPreconditionHooks,
  type DocumentScriptHooks,
  type PostingPreconditions,
} from "../journal/posting-preconditions.ts";
import { voidRemedyHooks } from "../journal/void-remedy-contributors.ts";
import {
  beforePostCustomControlsChanged,
  CustomGlLinesError,
  mergeBeforePostCustomMutation,
  resolveScriptUser,
  runCustomGlLineScripts,
  runTriggerScripts,
} from "./scripting.ts";

const triggers: DocumentScriptHooks = {
  resolveUser: (orgId, actorId) => resolveScriptUser(orgId, actorId, { required: false }),
  runTrigger: runTriggerScripts,
};

const preconditions: PostingPreconditions["scripting"] = {
  ...triggers,
  mergeBeforePostCustomMutation,
  beforePostCustomControlsChanged,
};

const lines: PostingLineContributors["scripting"] = {
  async runCustomGlLines(request) {
    try {
      return await runCustomGlLineScripts(request);
    } catch (error) {
      // The runner's script_runs rows roll back with the refused post; the
      // completed-run evidence rides on the refusal for out-of-band re-record.
      if (error instanceof CustomGlLinesError) {
        throw new PostingError(error.message, { customGlLineRuns: error.scriptRuns });
      }
      throw error;
    }
  },
};

/** Tenant scripts: before_post, custom_gl_lines, after_post and before_void triggers. */
export function registerScriptingPostingContributors(): void {
  postingPreconditionHooks.register("scripting", preconditions);
  postingLineHooks.register("scripting", lines);
  postingEffectHooks.register("scripting", triggers);
  voidRemedyHooks.register("scripting", triggers);
}
