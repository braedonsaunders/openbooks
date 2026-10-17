import type { ComponentProps } from 'react'
import {
  EquityAsOf,
  EquityCapTablePanel,
  EquityCompensationPanel,
  EquityPlansPanel,
  EquityRoundsPanel,
  EquitySecuritiesPanel,
  EquityStakeholdersPanel,
  EquityWaterfallPanel,
} from '../../app/(app)/equity/EquityPanels'
import { NewRecordButton } from '../../app/(app)/equity/NewRecordButton'
import { SecurityDrawer } from '../../app/(app)/equity/SecurityDrawer'
import { str, type WidgetRenderer } from './widget-props'

/** Equity & cap table adapters: compose the native workspace components without changing their props. */
export const EQUITY_WIDGETS = {
  'equity-as-of': (props) => <EquityAsOf value={str(props, 'value') ?? ''} label={str(props, 'label') ?? ''} />,
  'equity-new': (props) => <NewRecordButton data={(props.data as ComponentProps<typeof NewRecordButton>['data']) ?? null} />,
  'equity-cap-table': (props) => <EquityCapTablePanel view={(props.view as ComponentProps<typeof EquityCapTablePanel>['view']) ?? null} />,
  'equity-securities': (props) => <EquitySecuritiesPanel view={(props.view as ComponentProps<typeof EquitySecuritiesPanel>['view']) ?? null} />,
  'equity-stakeholders': (props) => <EquityStakeholdersPanel view={(props.view as ComponentProps<typeof EquityStakeholdersPanel>['view']) ?? null} />,
  'equity-plans': (props) => <EquityPlansPanel view={(props.view as ComponentProps<typeof EquityPlansPanel>['view']) ?? null} />,
  'equity-rounds': (props) => <EquityRoundsPanel view={(props.view as ComponentProps<typeof EquityRoundsPanel>['view']) ?? null} />,
  'equity-waterfall': (props) => <EquityWaterfallPanel view={(props.view as ComponentProps<typeof EquityWaterfallPanel>['view']) ?? null} />,
  'equity-compensation': (props) => <EquityCompensationPanel view={(props.view as ComponentProps<typeof EquityCompensationPanel>['view']) ?? null} />,
  /** No remount key: the drawer resets through its close navigation. */
  'equity-security-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof SecurityDrawer> | null
    if (!drawer) return null
    return <SecurityDrawer {...drawer} />
  },
} satisfies Record<string, WidgetRenderer>
