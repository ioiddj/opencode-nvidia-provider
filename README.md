# opencode-nvidia-provider

[![CI](https://github.com/ioiddj/opencode-nvidia-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/ioiddj/opencode-nvidia-provider/actions/workflows/ci.yml)

An OpenCode V2 plugin that gives NVIDIA NIM requests a configurable retry policy. It handles rate limits (`429`), request timeouts (`408`), and temporary server failures (`5xx`) through OpenCode's provider retry hook, with bounded exponential backoff and optional respect for a provider-supplied retry delay.

This plugin does **not** register a provider, store credentials, choose models, or move prompts. It only adjusts retry decisions for the provider IDs you configure.

## Requirements

- OpenCode V2. This plugin is developed and runtime-verified against OpenCode **2.1.4**.
- Node.js 22 or newer for running the test suite.
- An existing NVIDIA provider connection in OpenCode. Use `/connect` to connect the provider and `/models` to select a model.

The published plugin has **no runtime dependencies**. `@opencode/plugin` **2.1.4** is used
for its types only (a type-only import, erased at runtime), and it is pinned exactly as a
development dependency.

## Install

Install directly from GitHub:

```sh
opencode plugin add github:ioiddj/opencode-nvidia-provider
```

Or configure the package yourself in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:ioiddj/opencode-nvidia-provider",
      "options": {
        "providers": ["nvidia", "nvidia-nim"],
        "rateLimit": {
          "maxAttempts": 5,
          "baseDelayMs": 1000,
          "maxDelayMs": 30000
        },
        "serverError": {
          "maxAttempts": 3,
          "baseDelayMs": 1000,
          "maxDelayMs": 15000
        },
        "respectRetryAfter": true,
        "maxRetryAfterMs": 300000
      }
    }
  ]
}
```

A local checkout can also be used as a directory plugin. OpenCode loads its `index.ts` entrypoint:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-nvidia-provider"
    }
  ]
}
```

## Behavior

- `429` failures use the `rateLimit` budget.
- `408` and `5xx` failures use the `serverError` budget.
- `maxAttempts` includes the initial request. For example, `maxAttempts: 5` permits at most five total attempts for that failure category.
- The two budgets are tracked independently until a successful response.
- Only a successful **primary** request restores the budget. OpenCode's own housekeeping
  requests — the session title, a compaction, a generated summary — run with the same
  session, agent and model, so a housekeeping success must not hand an exhausted
  request a fresh budget.
- Computed delays grow exponentially and use 50–100% jitter. `baseDelayMs` is the initial delay and `maxDelayMs` caps it.
- When `respectRetryAfter` is enabled, a provider-supplied `retryAfterMs` takes precedence over computed backoff, up to `maxRetryAfterMs`.
- OpenCode's own maximum-attempt limit remains a hard limit, even when this plugin requests another retry.
- Authentication failures, invalid requests, and other deterministic `4xx` responses are not retried by this plugin.

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `providers` | `string[]` | `["nvidia", "nvidia-nim"]` | Provider IDs whose retry decisions are managed. At most **64** ids, each at most **128** characters. |
| `rateLimit.maxAttempts` | integer | `5` | Total attempts allowed for `429` failures. |
| `rateLimit.baseDelayMs` | integer | `1000` | Initial computed backoff for `429` failures. |
| `rateLimit.maxDelayMs` | integer | `30000` | Maximum computed backoff for `429` failures. |
| `serverError.maxAttempts` | integer | `3` | Total attempts allowed for `408` and `5xx` failures. |
| `serverError.baseDelayMs` | integer | `1000` | Initial computed backoff for `408` and `5xx` failures. |
| `serverError.maxDelayMs` | integer | `15000` | Maximum computed backoff for `408` and `5xx` failures. |
| `respectRetryAfter` | boolean | `true` | Prefer the provider's requested delay when available. |
| `maxRetryAfterMs` | integer | `300000` | Upper bound for a provider-requested delay. |

Invalid values are ignored in favor of the next valid source, then the documented default.
If `maxDelayMs` is configured below `baseDelayMs`, the effective maximum is raised to the
base delay, so a computed delay never exceeds its own cap.

Every provider id costs two hook registrations at setup time, so the provider list is
bounded: at most 64 ids are used, and an id longer than 128 characters is dropped. Extra
ids are dropped rather than rejected, so an over-long list still configures the providers
you listed first.

## Environment variables

Environment variables override plugin options, which makes them convenient for a service deployment.

| Variable | Equivalent option |
| --- | --- |
| `NVIDIA_PROVIDERS` | comma-separated `providers` |
| `NVIDIA_MAX_429_ATTEMPTS` | `rateLimit.maxAttempts` |
| `NVIDIA_429_BASE_MS` | `rateLimit.baseDelayMs` |
| `NVIDIA_429_CAP_MS` | `rateLimit.maxDelayMs` |
| `NVIDIA_MAX_5XX_ATTEMPTS` | `serverError.maxAttempts` |
| `NVIDIA_5XX_BASE_MS` | `serverError.baseDelayMs` |
| `NVIDIA_5XX_CAP_MS` | `serverError.maxDelayMs` |
| `NVIDIA_RESPECT_RETRY_AFTER` | `respectRetryAfter` |
| `NVIDIA_MAX_RETRY_AFTER_MS` | `maxRetryAfterMs` |

Boolean environment values accept `true`, `false`, `1`, `0`, `yes`, and `no`.

## Privacy and security

- The plugin does not read or persist request bodies, prompts, responses, credentials, or API keys.
- Retry counters live in memory only and are discarded after a successful response or plugin reload.
- The plugin has no telemetry and makes no network requests of its own.
- HTTP response bodies are never consumed by the plugin.
- The only event fields the plugin reads are `event.response.status`, `event.error.status`,
  `event.error.retryAfterMs`, `event.decision`, and `event.kind`. The request kind is
  used solely to decide whether a successful response may restore the retry budget
  (`src/request-kind.ts`).
- At most 1,000 request tuples are tracked in memory. The least recently used tuple is
  evicted first, so a request that is still failing keeps its budget.
- A source-level contract test (`test/privacy.test.ts`) pins that the shipped plugin code
  never references response bodies, prompts, messages, headers, authorization, API keys,
  plugin storage, browser storage, file writes, logging, or outbound HTTP — and that it
  still reads the failure metadata (`status`, `retryAfterMs`) it claims to read. The scan
  ignores comments and string literals, so a comment describing a request is not
  mistaken for a request.

## Limitations

- Automatic model failover is not implemented. The plugin retries the selected model and then lets OpenCode report the failure.
- Retry decisions cannot exceed OpenCode's built-in hard attempt limit.
- The plugin applies to failures that reach OpenCode's provider retry hook. It cannot recover from failures that occur before a provider request is created.
- The retry budget is shared per `(session, agent, provider, model)`. Two concurrent requests in the same tuple share one budget, so `maxAttempts` is not a per-request hard bound under concurrency.
- The runtime check verifies that OpenCode loads the plugin and completes `setup()`. It does not exercise a live NVIDIA endpoint, so provider-specific retry timing is not verified end to end.

## Development

```sh
npm ci
npm run check
```

`npm run check` runs the TypeScript typechecker and the Node test suite.

### Mutation check

A gate that cannot fail is not a gate. `npm run test:mutations` removes or weakens one
specific protection at a time and requires the named test suite to fail as a result:

```sh
npm run test:mutations
```

The harness covers repository containment of the state directory, fixture containment,
loopback-only authentication, global and base64 password redaction, bounded output
capture, unconditional process-group teardown, least-recently-used eviction of the retry
budget, primary-only budget restore, the provider-list cap, and the privacy contract.
A mutation that survives is a failure, and the run exits non-zero.

### Runtime verification

The unit tests exercise the retry policy in memory. The runtime check boots a real
OpenCode V2 server against an isolated, repo-local configuration and proves that
OpenCode loads the plugin and that the production `setup()` completes:

```sh
OPENCODE_BIN=/path/to/opencode npm run test:runtime
```

`OPENCODE_BIN` is required and must point at an OpenCode V2 executable. The check
starts its own server on an ephemeral port, stops only the process group it
started (and verifies it is gone), and writes its scratch state to `.runtime-state/`
(ignored by Git).

`OPENCODE_RUNTIME_TIMEOUT_MS` overrides the 30-second default. It is bounded at both
ends: below 1,000 ms or above 300,000 ms is refused.

### Isolation

A verification run must not be able to read your configuration or credentials, and
must not load your plugins — otherwise it proves nothing about this plugin.

- The child server receives a minimal environment: only `PATH`, `LANG`, `LC_ALL`,
  and `SHELL` are inherited. Provider credentials and the rest of your environment
  are not.
- `HOME`, `OPENCODE_TEST_HOME`, all XDG variables, and `TMPDIR` point into the
  repo-local state directory, so the server cannot reach your real home.
- OpenCode discovers `.opencode/` configuration in **every ancestor directory** of
  the activated location, so a location inside your home would load your own
  `~/.opencode/plugins`. The harness therefore activates the isolated global
  config directory itself, which makes OpenCode skip that ancestor walk.
- The gate asserts two things about the server's own debug log: **exactly one**
  plugin was loaded (the fixture under test), and the log contains **no reference**
  to your `~/.opencode` or `~/.config/opencode` directories. If that log is
  missing, the gate fails: an absent log is not evidence of a clean run.
- The server's ephemeral password is redacted from the captured output and from
  OpenCode's own log before either is written to disk. The redaction covers the
  token by value, any "password" phrasing in any case or separator, and the base64
  Basic credential the harness itself sends.
- The harness sends that password only to a **loopback** address. If the server
  reports anything else, the gate refuses before sending the credential.
- The captured server output is bounded (1 MB) and the retained log says so when
  older output was dropped.
- The state directory and the plugin fixture must both live **inside the
  repository**. The state directory is deleted before every run, so it is refused
  unless it is a strict descendant of the repository root — never the repository
  root, the filesystem root, a top-level directory, your home directory, or an
  ancestor of it.
- The server's process group is torn down unconditionally, including when the
  group leader has already exited, so a descendant that outlives it cannot survive
  the run.

`npm run test:runtime` runs two gates:

- `test:runtime:plugin` — the positive gate. The production plugin must load and
  complete `setup()`.
- `test:runtime:control` — the negative control. A fixture that never runs the
  production setup must be **rejected** by the same gate, so a green runtime check
  cannot come from a check that never fails.

The runtime check proves loading, setup, and hook registration. It does not send a
live NVIDIA request; request-level behavior is covered by the unit tests.

### Published install verification

The runtime check loads a **checkout** of this repository. The published package
is a different artifact: OpenCode installs it from GitHub, unpacks it into its
own cache, and loads the unpacked copy. That path has its own gate:

```sh
OPENCODE_BIN=/path/to/opencode npm run verify:published-install
```

It performs the documented install in an isolated home
(`opencode plugin add github:ioiddj/opencode-nvidia-provider`), then requires
that the global configuration records the specifier, that the installer
unpacked the package **without runtime dependencies**, and that a real
OpenCode V2 server loads that unpacked copy from the cache. The control
(`npm run verify:published-install:control`) requires the same gate to reject a
package that cannot be installed, so a green result cannot come from a gate that
never fails.

This check needs network access to GitHub, and it installs the **published**
repository — so it verifies what users get, not what is in this checkout. It is
not part of CI for that reason.

## Continuous integration

Every push and pull request runs the same gates as the local workflow:

- `check` — installs the pinned development dependencies, then runs the typechecker,
  the test suite, and the mutation check.
- `runtime` — installs OpenCode V2 2.1.4 and runs the runtime gate: the production
  plugin must load and complete `setup()`, and the negative control fixture must be
  rejected by the same gate.

The workflow requests read-only repository permissions, and every action is pinned
to a commit SHA rather than a tag.

## Repository maintenance

This repository is published through the GitHub REST API rather than by
pushing, and the published tree is **verified** against the local commit
rather than assumed. `npm run publish:check` reports the difference without
changing anything; `npm run publish:rebuild` republishes the branch as a
single clean commit and proves the result.

See [docs/publishing.md](docs/publishing.md) for the procedure, the token
requirements, and why the published and local commit SHAs are expected to
differ while their trees are not.

## License

MIT. See [LICENSE](LICENSE).
