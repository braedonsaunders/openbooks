# OpenBooks NetSuite extraction bridge

This SuiteCloud account-customization project installs the pull-only extraction
layer used by the OpenBooks NetSuite connector. It deploys one RESTlet, one
on-demand Map/Reduce script, and a private File Cabinet job directory. It does
not deploy Client Scripts, User Events, workflows, or transaction hooks.

## Prerequisites

- NetSuite SuiteCloud Development Framework and Token-Based Authentication are
  enabled.
- SuiteCloud CLI for Node.js and Java 17 or newer are installed locally.
- The deploying administrator has created a SuiteCloud CLI authentication ID.
- A dedicated integration role can read the accounting records in scope.

The runtime integration role needs RESTlet and SuiteAnalytics Workbook access,
Documents and Files, Accounting Lists, Deleted Records, Accounting Periods,
Accounts, and read access to the transaction and master-record types being
migrated. Limit subsidiary access to the books intentionally placed in scope.
The bridge only writes its temporary request and chunk files beneath
`SuiteScripts/OpenBooks/Jobs`; it never writes a business transaction.

The RESTlet also exposes a bounded, read-only attachment inventory for vendor
bills and expense reports. It includes both Files-subtab relationships and
expense-line receipt images, then returns authenticated file content to the
tenant worker for idempotent import into object storage.

## Validate and deploy

Set `defaultAuthId` in `project.json` to the administrator authentication ID,
then run from this directory:

~~~sh
suitecloud project:validate
suitecloud project:deploy --validate
~~~

The stable deployed IDs are:

- RESTlet script: `customscript_openbooks_bridge_rl`
- RESTlet deployment: `customdeploy_openbooks_bridge_rl`
- Map/Reduce script: `customscript_openbooks_export_mr`
- Map/Reduce deployment: `customdeploy_openbooks_export_mr`

Enter the account ID, SuiteTalk host, base currency, and RESTlet IDs in the
tenant's OpenBooks connection workspace. Enter TBA consumer and token values in
the secret fields there; do not put credentials in this project or environment
files.

## Upgrade and removal

Deploy the newer project in place. The RESTlet reports a wire-schema version,
and OpenBooks refuses incompatible versions before extracting data. Export
files are job-scoped and can be deleted through the authenticated cleanup
operation after a completed or failed run.

To remove the bridge, first disable its OpenBooks connection and let active
exports finish. Then remove the two script deployments and the
`SuiteScripts/OpenBooks` File Cabinet directory through the NetSuite
administrator UI.
