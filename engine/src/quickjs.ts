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
 *
 * Invariant: every context gets its own WebAssembly module. Contexts created
 * from one shared asyncify module all execute on the same WASM machine —
 * while one script is suspended (asyncify unwound, e.g. inside ob.query),
 * any other context's execution or runtime disposal corrupts the shared
 * machine and aborts the Node process ("Assertion failed: list_empty
 * (&rt->gc_obj_list)" in JS_FreeRuntime). Scripts genuinely run concurrently
 * here (before_post triggers during parallel postings, scheduled/bulk/endpoint
 * runs on the worker), so instantiating the embedded variant per context is
 * required for correctness; the cost is a few milliseconds of WASM
 * instantiation per script run.
 */
export async function newAsyncContext() {
  const module = await newQuickJSAsyncWASMModuleFromVariant(variant);
  return module.newContext();
}
