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

/** Most `ob.log` lines one guest run keeps. */
export const GUEST_LOG_MAX_ENTRIES = 200;
/** Most UTF-8 bytes of `ob.log` output one guest run keeps. */
export const GUEST_LOG_MAX_BYTES = 64 * 1024;

/**
 * Host-side `ob.log` sink shared by every sandbox. Guest code controls what it
 * logs and how often, so the host bounds both the entry count and the total
 * bytes it retains; once either bound is reached the sink records one
 * truncation line and stops rendering guest values at all, so further calls
 * cost the host nothing. `render` is only invoked while the sink is open.
 */
export function createGuestLogSink(lines: string[]): { append(render: () => string): void } {
  let bytes = 0;
  let closed = false;
  const close = (): void => {
    lines.push(`ob.log truncated after ${GUEST_LOG_MAX_ENTRIES} entries / ${GUEST_LOG_MAX_BYTES} bytes`);
    closed = true;
  };
  return {
    append(render) {
      if (closed) return;
      if (lines.length >= GUEST_LOG_MAX_ENTRIES || bytes >= GUEST_LOG_MAX_BYTES) return close();
      const line = render();
      const next = bytes + Buffer.byteLength(line, "utf8");
      if (lines.length + 1 > GUEST_LOG_MAX_ENTRIES || next > GUEST_LOG_MAX_BYTES) return close();
      lines.push(line);
      bytes = next;
    },
  };
}
