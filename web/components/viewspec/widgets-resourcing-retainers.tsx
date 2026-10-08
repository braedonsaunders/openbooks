import type { ComponentProps } from 'react'
import { RetainerDrawer } from './native-widgets.client'

type RetainerDrawerProps = ComponentProps<typeof RetainerDrawer>

export const RESOURCING_RETAINER_WIDGETS = {
  'resourcing-retainer-drawer': (props: Record<string, unknown>) => {
    const drawer = props.drawer as RetainerDrawerProps['drawer'] | undefined
    return drawer ? <RetainerDrawer key={drawer.remountKey} drawer={drawer} /> : null
  },
}
