'use client'

import { usePathname } from 'next/navigation'
import { PlatformMenu } from '@braedonsaunders/appkit-superadmin/react'

export function OpenBooksPlatformMenu() {
  return (
    <PlatformMenu
      pathname={usePathname() ?? ''}
      tenantHref="/"
      platformHref="/platform"
      tenantLabel="Organization workspace"
      tenantDescription="Modules for the current organization"
      platformDescription="Deployment-wide operator tools"
    />
  )
}
