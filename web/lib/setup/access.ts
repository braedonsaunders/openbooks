import type { SetupEntity } from "./types";

/** The permission used to render write controls for a rehomed setup section. */
export function setupSectionManagePermission(entity: Pick<SetupEntity, "command">): string {
  return entity.command?.permission ?? "admin.setup.manage";
}
