export type AssetWorkspaceTab = 'register' | 'tax-depreciation' | 'equipment'

/**
 * One route switcher for the fixed-asset register, tax depreciation, and
 * equipment register. Feature-disabled destinations are omitted so the
 * shared header strip never offers a route the viewer cannot open.
 */
export function assetWorkspaceTabs({
  active,
  registerLabel,
  taxDepreciationLabel,
  equipmentLabel,
  showFixedAssets,
  showEquipment,
}: {
  active: AssetWorkspaceTab
  registerLabel: string
  taxDepreciationLabel: string
  equipmentLabel: string
  showFixedAssets: boolean
  showEquipment: boolean
}) {
  return [
    ...(showFixedAssets
      ? [
          { key: 'register', href: '/assets', label: registerLabel, active: active === 'register' },
          {
            key: 'tax-depreciation',
            href: '/assets?tab=tax-depreciation',
            label: taxDepreciationLabel,
            active: active === 'tax-depreciation',
          },
        ]
      : []),
    ...(showEquipment
      ? [
          {
            key: 'equipment',
            href: '/assets/equipment',
            label: equipmentLabel,
            active: active === 'equipment',
          },
        ]
      : []),
  ]
}
