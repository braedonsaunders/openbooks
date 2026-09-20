# Test process shutdown

On 2026-09-20, diagnostic CI run [35514084360](https://github.com/braedonsaunders/openbooks/actions/runs/35514084360)
reproduced an intermittent unit-shard hang on Ubuntu x64, Node 24.20.0.
Four shards passed; shard 1 exceeded the unchanged 16-minute outer deadline.

The stuck child was PID 7611, executing
`web/app/api/reports/entry/[id]/route.test.ts`. Lifecycle tracing recorded
`native-exit-enter` with code 0 at 13:42:02.893 UTC and `exit-event` with code 0
at 13:42:02.896 UTC. The output-drain wrapper had therefore called native exit;
it was not waiting for its stream callbacks.

Repeated native captures showed the main thread in:

```
uv_thread_join
node::WorkerThreadsTaskRunner::Shutdown
node::NodePlatform::Shutdown
node::DefaultProcessExitHandlerInternal
node::Environment::Exit
```

Two compiler workers were in:

```
v8::internal::CollectionBarrier::AwaitCollectionBackground
v8::internal::HeapAllocator::AllocateRawWithRetryOrFailSlowPath
v8::internal::maglev::MaglevCodeGenerator::GenerateDeoptimizationData
v8::internal::maglev::MaglevConcurrentDispatcher::JobTask::Run
```

The main thread waited for the workers to stop, while their allocations waited
for a collection on that main thread. The healthy parent waited for child exit
and stdout closure. Node's file wrapper disables its own timeout; the assertion
timeout cannot interrupt this native shutdown cycle. This matches the mechanism
in [Node issue 54918](https://github.com/nodejs/node/issues/54918), including the
[Ubuntu shutdown capture](https://github.com/nodejs/node/issues/54918#issuecomment-5211891066).
It does not establish that every historical timeout had this cause.

The canonical test runner now disables concurrent Sparkplug and optimizing
compilation on every platform. It already did so on macOS following native
stack sampling there; limiting that mitigation to the observed host left Linux
CI exposed. Output-drain test subprocesses use the same policy. Forced exit,
output draining, assertion limits, outer CI deadlines, and production runtime
flags retain their behavior. The regression test evaluates the policy for
Linux, macOS, Windows, and FreeBSD and fails with the old macOS-only condition.

Ten local unmitigated repetitions of five previously stalled files on macOS
Node 24.20.0 did not reproduce the race. This negative result is not evidence
against the captured Linux wait cycle, nor proof that macOS is unaffected.
Removing the mitigation requires evidence that the deployed Node/V8 version
has repaired the shutdown cycle, not merely a green rerun of a timing race.
