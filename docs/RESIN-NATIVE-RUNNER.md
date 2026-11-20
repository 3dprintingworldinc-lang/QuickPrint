# Bounded Windows native runner

`src/slicing/windows-native-job.js` exports `runWindowsNative(executable, args,
options)` for an absolute local `.exe` and an existing managed `cwd`. Optional
`processCommitLimitBytes` and `jobCommitLimitBytes` may lower the 1 GiB ceiling;
the job limit must be at least the process limit. `timeoutMs`, `maxOutputBytes`
and `signal` bound elapsed time, captured output and cancellation. The runner
forces `DOTNET_PROCESSOR_COUNT=1`. Only its small managed environment allowlist
can be supplied through `env`.

The helper creates the native process suspended with atomic Windows job-list
assignment, verifies membership and reads back process/job memory limits and
`KILL_ON_JOB_CLOSE` before resuming it. Only the intended standard-I/O handles
are inherited. Closing the job terminates its descendants on completion,
cancellation, deadline, output overflow, helper failure or lost control input.
It never falls back to unguarded execution when these capabilities are absent.

The Windows limit measures **committed virtual memory, not RSS**. It applies to
the native process and aggregate owned process tree; the Node caller and helper
are outside that accounting. Job high-water counters can include rejected
allocation attempts and do not independently prove successful peak usage.
Memory notifications are informative and not guaranteed; kernel-enforced
allocation limits supply the bound. A native program can handle a denied
allocation and return an ordinary code, so callers must still validate outputs.

The JS, PowerShell and C# resources are pinned at module initialization and
checked before and after each call. The helper resources are copied into a
fresh direct child of the work directory, verified, and cleaned by exact owned
paths. The system PowerShell is invoked without profile or execution-policy
bypass. Unsupported policy, path or Windows capabilities fail closed. Restart
after source changes; these selected hashes assume one unchanged installation
and do not attest the whole runtime or the provider's algorithm.

Ordinary native exit codes return `{ code, stdout, stderr, resourceReceipt }`.
Resource or control failures reject; where available the error includes
`resourceReceipt`, `nativeCode`, `stdout` and `stderr`. The receipt records job
limits, assignment, source hashes and observed commit information. It contains
no caller environment dump.

Owned tests exercise quoting, descendants, aggregate commit denial, timeout,
output overflow, cancellation, helper loss, startup interruption and cached
source changes. Actual UVtools 7.1.2 checks on the owned 8-layer 16K artifact
return all six issue counts zero under 1 GiB process/tree commit limits, with
the artifact digest unchanged. This is bounded software validation. The
ordinary production slicer runner is not switched to this helper by this
change; a controlled hollowing orchestrator must adopt and validate it before
issuing production evidence or printer permits.
