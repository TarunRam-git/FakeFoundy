# Provider rate limits and native retries

Start the dedicated runtime with `HOST=127.0.0.1 npm run trueforge`.
The launcher sets TrueForge's supported `MODEL_HTTP_MAX_RETRIES` to **7** unless
explicitly supplied. Set it to an integer **0–8** to override, for example:

```sh
HOST=127.0.0.1 MODEL_HTTP_MAX_RETRIES=4 npm run trueforge
```

Restart the runtime to change this setting. A separately launched runtime does
not inherit this project's default. This changes neither API credentials nor
provider billing, network-policy settings, or the chosen model.

## Semantics

Pinned TrueForge 0.185.1 retries individual failed provider HTTP requests inside
the existing agent turn, not the whole prompt/session or already completed MCP
tools. This preserves conversation progress and staged proposals. Its native
backoff uses approximately 1, 2, 4, 8, 16, 32, and 64 seconds, with ±10% jitter
(about 127 seconds total for seven retries without accepted Retry-After values).
The runtime also retries its other documented transient statuses, not only 429.
Authentication failures such as 401 are not retried by this mechanism.

The pinned runtime accepts Retry-After hints only up to five seconds; larger
hints fall back to exponential backoff. This launcher does not patch dependencies,
replace the guarded transport, bypass provider quotas, or call providers directly.
It cannot fix exhausted daily quota or a model unavailable to the account.

The extension's overall `fakefoundy.runTimeoutSeconds` (default 300) still applies
across setup, model execution, and fallback. Cancel stops the TrueForge session
and its native backoff. If retries exhaust, the existing failed-attempt rollback
and optional configured-model fallback apply. Do not increase the timeout merely
to hide a persistent daily-quota or billing error.

## Verification

`npm test` covers the launcher bounds, an actual pinned TrueForge transport 429 →
200 loopback response with byte-identical POST replay, a non-retried 401, and
cancellation during a four-second backoff with no subsequent request. Tests make
no provider calls and use no paid quota. They verify retry transport semantics,
not successful completion of a real-model benchmark.
