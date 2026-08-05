# Replay-validation datasets

Synthetic full-company datasets for delete-and-rebuild validation — the
public form of the methodology described in
[docs/trust/replay-validation.md](../../docs/trust/replay-validation.md).

The harness can generate a local `<name>/` directory containing:

- `dataset.json` — every GL-affecting event of a simulated company in a
  neutral schema: commercial documents with lines, payments with settlement
  applications, and origin-tagged engine journals, plus the
  account/party/project dictionaries. Deterministically regenerable from the
  recorded `(profile, seed)`.
- `golden.json` — the golden snapshot the rebuild must reproduce exactly:
  trial balance, per-party open balances, and per-project
  cost/billed/margin.

Run a rebuild (provisions a disposable sim-tagged org):

```sh
OPENBOOKS_SIM=1 npm -w engine run harness:replay -- rebuild corpus/replay/<name>
```

No dataset is currently published in this directory. A future checked-in corpus
must be generated only on a dedicated sim/test database, reviewed as synthetic,
and wired into CI before it is cited as repository evidence.

The comparison is penny-exact with no tolerance. GL fallbacks (events that
could not re-post through their native document pipeline) are counted, listed,
and make the run fail even if the aggregate diff is clean. The golden snapshot
comes from the same OpenBooks simulator, so this is regression and rebuild
integrity evidence—not an independent accounting oracle.
