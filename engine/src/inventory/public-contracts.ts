/** Client-safe permission catalog; command implementations remain server-only. */
export { INVENTORY_ACTION_PERMISSIONS } from '../organization/permissions.ts'
export type { DisassemblyInput, DisassemblyResult } from './disassembly.ts'
export type { InventoryOperationOption } from './operation-options.ts'

export type { InventoryInquiry } from './inquiry.ts'

/**
 * Item kinds that can parent a bill of materials: assemblies built by the
 * shop floor and kits exploded at sale/issue. Raw materials, packaging, and
 * service kinds never qualify — the assembly picker offers only these, so a
 * recipe cannot start life on an item the build commands would not produce.
 */
export function isAssemblyCapableKind(kind: string | null | undefined): boolean {
  return kind === "assembly" || kind === "kit";
}
