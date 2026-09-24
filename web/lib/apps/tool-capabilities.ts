import type { AppHostAdapters, AppPlatformAdapter, AppStorageAdapter } from "@openbooks/engine/src/apps/runtime.ts";

/** Remove every mutating host capability before a manifest-declared read-only tool runs. */
export function readOnlyAppHostAdapters(adapters: AppHostAdapters): AppHostAdapters {
  const storage: Pick<AppStorageAdapter, "get" | "list"> = {
    get: adapters.storage.get,
    list: adapters.storage.list,
  };
  const platform = adapters.platform
    ? {
        ...(adapters.platform.query ? { query: adapters.platform.query } : {}),
        schema: adapters.platform.schema,
        list: adapters.platform.list,
        get: adapters.platform.get,
      }
    : undefined;
  return {
    storage: storage as AppStorageAdapter,
    ...(adapters.records ? { records: adapters.records } : {}),
    ...(platform ? { platform: platform as AppPlatformAdapter } : {}),
  };
}
