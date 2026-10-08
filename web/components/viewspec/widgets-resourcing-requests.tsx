import type { ComponentProps } from 'react'
import { RequestDrawer } from './native-widgets.client'

type RequestDrawerProps = ComponentProps<typeof RequestDrawer>

export const RESOURCING_REQUEST_WIDGETS = {
  'resourcing-request-drawer': (props: Record<string, unknown>) => {
    const drawer = props.drawer as RequestDrawerProps['drawer'] | undefined
    return drawer ? <RequestDrawer key={drawer.remountKey} drawer={drawer} /> : null
  },
}
