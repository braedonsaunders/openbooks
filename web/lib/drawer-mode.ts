export type DrawerMode = 'view' | 'edit'

/**
 * A requested presentation mode never overrides lifecycle or permission
 * enforcement. Existing records default to view; editable creation flows may
 * opt into edit.
 */
export function initialDrawerMode(
  requested: DrawerMode | undefined,
  canEdit: boolean,
): DrawerMode {
  return requested === 'edit' && canEdit ? 'edit' : 'view'
}
