# integrations

Code that runs **inside a source system**, not inside OpenBooks.

Most connectors need nothing here. A connector is normally just a client module
in `engine/src/sync/` that talks to the source system's API from our side:

| Source | Connector | Anything to install in the source? |
| --- | --- | --- |
| NetSuite | `engine/src/sync/netsuite-source.ts` | **Yes** — see `netsuite-bridge/` |
| QuickBooks Online | `engine/src/sync/qbo-source.ts` | No |
| QuickBooks Desktop | `engine/src/sync/qbd-source.ts` | No — a local connector, not source-side code |
| Xero | `engine/src/sync/xero-source.ts` | No |
| Odoo | `engine/src/sync/odoo-source.ts` | No |
| Microsoft Dynamics | `engine/src/sync/dynamics-source.ts` | No |
| ERPNext | `engine/src/sync/erpnext-source.ts` | No |

So this directory holding exactly one vendor is not a statement about which
integrations exist — it is a statement about which ones need code deployed on
the far side. Today that is NetSuite alone.

## Why NetSuite is different

NetSuite's public APIs cannot move a full historical migration at usable
throughput. `netsuite-bridge/` is an SDF project containing a RESTlet and a
Map/Reduce script that the customer deploys into their own NetSuite account;
`netsuite-source.ts` then talks to those instead of paging generic endpoints.

The bridge is published because a customer migrating off NetSuite has to be able
to install it, read it, and satisfy themselves about what it does before running
it in their own account. It contains no credentials, no account identifiers and
no tenant data — the account it runs in is whatever NetSuite reports at
execution time.

## Adding a connector

Start in `engine/src/sync/` and add a `*-source.ts` module. Only come back here
if the source system genuinely cannot serve the data from outside, and say in
this table why.
