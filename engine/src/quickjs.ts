import variant from "@jitl/quickjs-singlefile-browser-release-asyncify";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";

/**
 * QuickJS runtime factory used by every server-side sandbox.
 *
 * The default quickjs-emscripten entrypoint loads a neighbouring
 * `emscripten-module.wasm` at runtime. That file is easy for esbuild/Next
 * standalone tracing to omit, which made production posting fail as soon as a
 * before_post script ran. The single-file release variant embeds the WASM in
 * JavaScript, so the web and worker bundles are self-contained.
 */
const modulePromise = newQuickJSAsyncWASMModuleFromVariant(variant);

export async function newAsyncContext() {
  return (await modulePromise).newContext();
}
