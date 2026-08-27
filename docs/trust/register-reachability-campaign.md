# Register reachability campaign tooling

`check:register-reachability` is campaign tooling for auditing orchestration
state. It answers whether findings recorded fixed or resolved have a closing
commit that is reachable from the local integration `main` ref. The checker
never defaults to the potentially stale `origin/main` remote-tracking ref. For
an explicit release candidate, set `OPENBOOKS_REGISTER_CHECK_REF` to a ref that
resolves to a commit; a missing override fails closed. It is intentionally not
a permanent product-property gate and is not part of `npm test`; run it
deliberately when a campaign register needs to be checked:

```sh
OPENBOOKS_REGISTER_DB=/path/to/ultragoal/data.db \
OPENBOOKS_REGISTER_THREAD_ID=thr_... \
npm run check:register-reachability
```

`OPENBOOKS_REGISTER_CHECK_REF` is optional. When omitted, the checker audits
local `main`; when supplied, it must resolve to a commit in the checkout. There
is no implicit fallback to `origin/main` or `HEAD`.

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

When multiple worker fixes are coalesced into one integration commit, the
checked-in snapshot records that reachable integration SHA for each affected
finding. This keeps attribution aligned with the tree that ships; it is not a
baseline waiver. Any other unsupported row remains a new drift violation until
its own closing commit is recorded and reachable.

## 2026-08-27 unreachable-row reconciliation

The 18 rows that were unreachable at the campaign snapshot were reviewed
individually. Each row below is re-attributed to the exact integration commit
that carries its fix and is an ancestor of local `main`; no row was moved into
a waiver. The historical worker ref remains visible here as evidence of the
correction.

| Finding | Historical reported ref | Reachable integration commit | Evidence |
| --- | --- | --- | --- |
| `fnd_24dfd85d_ff16d2` | `09e0e9944dd6bef1343038b86a18e31951f4e01d` | `e4ed339d4bedb6b74030ecf42c9707d47d5b3bdc` | `fix: persist order drafts before requesting approval` |
| `fnd_421d5f16_2b6657` | `44ecb4d818873f88ceb5606d43624f7c579a6151` | `8fbe02704b95be2c519e0811e3e13037d1a29700` | `fix: make document void requests atomic and concurrency-safe` |
| `fnd_56e2f1d3_73d494` | `45c705a3e885e521dcd2f60465c597f89f032dd4` | `7f177519148060ea2774cdbba9ade65db339e22a` | `feat: add paginated lot recall reporting` |
| `fnd_6a5d52fa_a5a3a0` | `45c705a3e885e521dcd2f60465c597f89f032dd4` | `7f177519148060ea2774cdbba9ade65db339e22a` | `feat: add paginated lot recall reporting` |
| `fnd_815b6d7d_de3a32` | `d54f7bea729de9e441276300d6b6b26a187bf7ac` | `fe1e16ec95a0c859b13757d32774e28a1589e092` | `fix: verify PDF encryption against forged markers` |
| `fnd_82904c62_85f4ed` | `44ecb4d818873f88ceb5606d43624f7c579a6151` | `8fbe02704b95be2c519e0811e3e13037d1a29700` | `fix: make document void requests atomic and concurrency-safe` |
| `fnd_84a1dbbb_832e7c` | `c85153fd2db14796edf7264418f52ba937f21abf` | `aa516625af3c1873512c976a10c7af35ac323692` | `fix: guard payment artifact generation and delivery against stale reads` |
| `fnd_8ae2ccb8_9a2063` | `ca176905f51436f524415fb52a7d3e0c79eafebe` | `6a6c1245fe343739fc1fdcc4285a30dc8cd9c4b3` | `test(schema): register landed migrations in canonical inventory` |
| `fnd_8af82a06_e94d88` | `45c705a3e885e521dcd2f60465c597f89f032dd4` | `7f177519148060ea2774cdbba9ade65db339e22a` | `feat: add paginated lot recall reporting` |
| `fnd_d3eb5d98_28c85a` | `45c705a3e885e521dcd2f60465c597f89f032dd4` | `7f177519148060ea2774cdbba9ade65db339e22a` | `feat: add paginated lot recall reporting` |
| `fnd_d46f1bdf_6db94a` | `45c705a3e885e521dcd2f60465c597f89f032dd4` | `7f177519148060ea2774cdbba9ade65db339e22a` | `feat: add paginated lot recall reporting` |
| `fnd_ddae2dd2_92aed7` | `43ee270b456961a704bf7c6955383dd890a7d160` | `c0fca24448c291909b567edddc694a319e0f736c` | `fix: enforce nested private-folder access boundaries` |
| `fnd_f3336505_de4203` | `09e0e9944dd6bef1343038b86a18e31951f4e01d` | `e4ed339d4bedb6b74030ecf42c9707d47d5b3bdc` | `fix: persist order drafts before requesting approval` |
| `fnd_f40ce24a_881fae` | `255b7674d103b4c5490f032df199e2abb71f63e1` | `8fbe02704b95be2c519e0811e3e13037d1a29700` | `fix: make document void requests atomic and concurrency-safe` |
| `fnd_mt7nyxa_ns307` | `2645d3e50faf98e66d1575653ac5745a7764e041` | `68a73600e7f7d521f0ff1ccd26ef61029ccfbd12` | `fix(engine): refuse redirects on NetSuite SuiteQL, RESTlet, and SuiteTalk calls` |
| `fnd_mt7nyxa_tax307` | `2645d3e50faf98e66d1575653ac5745a7764e041` | `1ab18121762c7e47700f4049399ad92e68a95565` | `fix: prevent tax provider credential leaks across redirects` |
| `fnd_mt9844pt_0bwnsn` | `0575704025ef5290927830c31db7ff5b771eb496` | `e85307c7d07a570af8d5e03dda37773290355d38` | `fix(tax): gate filing prepare/mark-filed behind compliance.file` |
| `fnd_mtbnparb_fnvdqh` | `13760657c69081f142bfefa55d0f76599e93839e` | `26606bdd729f22273207c1218e7ea4682121fafe` | `fix(tax): require an org-wide closed lock for the mark-filed period fence` |

The checker now reports the reconciled population as `unreachable (0)` while
preserving the unsupported historical classes: `unresolvable (10)` and
`unattributed (239)`. The expected fail-closed result is:

```text
FAIL: 249 baselined register gap(s) remain; the baseline records history, it does not waive reachability:
  unresolvable (10):
  unattributed (239):
```

The command exits with status 1 because those 249 unsupported rows remain; the
reachability class itself is zero.

The permanent shipping checks remain in the canonical suite: credential-fetch
redirects, explicit-`any`, product neutrality, container security, CI
integrity, and the conformance corpus. Those checks assert properties of the
shipping software. Register reachability asserts the state of a temporary
remediation campaign and therefore remains a standalone instrument.
