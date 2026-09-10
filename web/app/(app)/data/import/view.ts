import 'server-only'

import { page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'

/**
 * The data-import wizard, split into a loader and a spec.
 *
 * The native page is a permission gate around a single client component:
 * `await requirePermission('data.import')` then `<ImportWizard />`. The
 * wizard owns four freely-navigable steps, a file input, pasted-text state,
 * per-column mapping selects, and the parse / preview / commit fetch flows
 * plus a sample-company flow — all `useState` plus `fetch`, which the spec
 * has no vocabulary for. So the whole wizard is ONE widget binding loader
 * data to the shared `ImportWizard` both branches render (the same call the
 * pay-run conversion made for `RunWizard`).
 *
 * The loader reproduces the native server logic VERBATIM — the gate — and
 * returns no rows, because the page renders none server-side: the resource
 * list and the sample-company profiles both load client-side inside the
 * wizard, identically on both paths.
 */

export interface DataImportData {
  // Intentionally fieldless. The native page's only server logic is the
  // `data.import` permission gate above; everything the wizard shows arrives
  // through its own client fetches, so there is no presentation-ready data
  // for the loader to compute.
}

export async function loadDataImport(): Promise<DataImportData> {
  await requirePermission('data.import')
  return {}
}

export function dataImportSpec(): PageSpec {
  return page({
    // `bare`: the wizard owns its own WizardLayout shell (sticky header,
    // scroll region, footer bar). Wrapping it in a second ListPageLayout
    // would nest the chrome and the DOM would no longer match byte for byte.
    layout: 'bare',
    body: [
      // The wizard takes no props: step state, file bytes, mapping and both
      // fetch flows all live inside the shared client component.
      widgetBlock('import-wizard', {}),
    ],
  })
}
