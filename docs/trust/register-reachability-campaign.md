# Register reachability campaign tooling

`check:register-reachability` is campaign tooling for auditing orchestration
state. It answers whether findings recorded fixed or resolved have a closing
commit that is reachable from the integration ref. It is intentionally not a
permanent product-property gate and is not part of `npm test`; run it
deliberately when a campaign register needs to be checked:

```sh
OPENBOOKS_REGISTER_DB=/path/to/ultragoal/data.db \
OPENBOOKS_REGISTER_THREAD_ID=thr_... \
npm run check:register-reachability
```

`OPENBOOKS_REGISTER_JSON` can be used instead for an exported findings
document. A SQLite probe selects fixed/resolved rows from one thread. For both
live sources, the loaded finding IDs define the authoritative campaign cohort.
The checker projects the historical baseline onto that exact cohort, so
metadata from another campaign cannot create bogus “baseline entry names no
register entry” rows. A row in the cohort that is unreachable, unresolvable,
or unattributed still fails closed; baselines describe history and never waive
a live gap. Malformed or empty input also fails closed. Failed audits emit
`IRREDUCIBLE_REGISTER_ROWS_JSON` with each unsupported row and the evidence
sources attempted, so campaign automation can consume the result without
scraping prose.

The permanent shipping checks remain in the canonical suite: credential-fetch
redirects, explicit-`any`, product neutrality, container security, CI
integrity, and the conformance corpus. Those checks assert properties of the
shipping software. Register reachability asserts the state of a temporary
remediation campaign and therefore remains a standalone instrument.
