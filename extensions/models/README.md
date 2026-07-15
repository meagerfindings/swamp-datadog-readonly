# @mgreten/datadog-readonly

**Read-only Datadog incident-context surface — monitors, logs, error events,
deploy correlation. No write methods by design.**

A read-only incident-context layer over the [Datadog](https://www.datadoghq.com)
API and GitHub, for [swamp](https://swamp.club). When an incident is firing,
an agent (or a workflow) needs queryable context fast: what the monitor says,
what the logs show, what errors a service is throwing, and — crucially — which
recent change is the likely cause. This model provides five read-only methods
that answer those questions and persist every answer as a typed swamp resource,
so downstream CEL / `data.latest()` consumers can read individual fields.

Nothing here mutates Datadog or GitHub. `correlateDeploys` is a deterministic
join of GitHub Deployments and merged PRs — it needs the `gh` CLI but no
Datadog auth at all.

## Installation

```sh
swamp extension pull @mgreten/datadog-readonly
```

Then create a model instance:

```sh
swamp model create datadog --type @mgreten/datadog-readonly
```

## Setup

### Datadog credentials (vault-wired)

The four Datadog-calling methods (`validateAuth`, `searchLogs`, `errorEvents`,
`monitorContext`) need two Datadog credentials:

- an **org API Key** (the `DD-API-KEY` header), and
- a **scoped Application Key** (the `DD-APPLICATION-KEY` header) with only these
  READ scopes: `monitors_read`, `events_read`, `logs_read_data`,
  `logs_read_index_data`. The scopes are deliberately read-only, so both the key
  AND the model are incapable of writes.

This model does **not** read a vault itself. The recommended pattern is to store
both secrets in a swamp vault and wire them into the instance's
`globalArguments` with a CEL `vault.get(...)` reference; swamp resolves the CEL
at instance-load time and passes the resolved strings in as globalArgs:

```sh
swamp vault create local_encryption datadog
swamp vault put-secret datadog datadog-api-key
swamp vault put-secret datadog datadog-app-key
```

```yaml
# models/<collective>/datadog/<id>.yaml
type: "@mgreten/datadog-readonly"
name: datadog
globalArguments:
  ddApiKey: "${{ vault.get(datadog, datadog-api-key) }}"
  ddAppKey: "${{ vault.get(datadog, datadog-app-key) }}"
  ddSite: datadoghq.com
  githubRepo: owner/repo
  deployEnvironment: production
```

If either key is missing/blank, the Datadog methods fail fast with a clear error
naming the exact `swamp vault put-secret` commands — never a cryptic Datadog 403.

### GitHub (for correlateDeploys)

`correlateDeploys` shells out to the `gh` CLI, which must be installed and
authenticated on the host. Set `githubRepo` (an `owner/repo` slug) and
`deployEnvironment` (the GitHub Deployments environment to filter on); both have
no default and are required for that method.

## Usage

Validate the credential pair:

```sh
swamp model method run datadog validateAuth
```

Search logs for a service over the last 60 minutes:

```sh
swamp model method run datadog searchLogs \
  --input query=timeout --input service=api --input env=prod --input limit=25
```

Pull a service's recent errors:

```sh
swamp model method run datadog errorEvents \
  --input service=api --input limit=20 --input lookbackMinutes=120
```

Fetch a monitor's definition and recent alert events:

```sh
swamp model method run datadog monitorContext --input monitorId=123456
```

Correlate an incident window against recent deploys + merged PRs:

```sh
swamp model method run datadog correlateDeploys \
  --input incidentStart=2026-07-14T21:00:00Z --input windowMinutes=180
```

## Global Arguments

| Argument            | Type   | Default          | Notes                                                                 |
| ------------------- | ------ | ---------------- | --------------------------------------------------------------------- |
| `ddApiKey`          | string | `""` (sensitive) | Datadog org API key (`DD-API-KEY`). Wire from a vault.                |
| `ddAppKey`          | string | `""` (sensitive) | Datadog scoped app key (`DD-APPLICATION-KEY`). Wire from a vault.     |
| `ddSite`            | string | `datadoghq.com`  | Datadog site host; API base is `https://api.<ddSite>`.                |
| `githubRepo`        | string | `""`             | `owner/repo` for `correlateDeploys`. Required for that method.        |
| `deployEnvironment` | string | `""`             | GitHub Deployments environment for `correlateDeploys`. Required.      |

## Method: validateAuth

No arguments. Cheap authenticated ping (`GET /api/v1/validate`) — returns
`valid: true/false`. Throws (naming the vault commands) if the keys are absent.

## Method: searchLogs

| Argument         | Type   | Default | Notes                                             |
| ---------------- | ------ | ------- | ------------------------------------------------- |
| `query`          | string | —       | Datadog log search query string (required).       |
| `service`        | string | —       | Optional; appended as `service:<v>`.              |
| `env`            | string | —       | Optional; appended as `env:<v>`.                  |
| `limit`          | int    | `50`    | Max rows, bounded to 1000.                        |
| `from` / `to`    | string | —       | ISO 8601 window; both set overrides lookback.     |
| `lookbackMinutes`| int    | `60`    | Minutes before `to` / now.                        |

## Method: errorEvents

Proxies an error-tracking view through the v2 logs-search endpoint: it forces
`status:error` scoped to the given service over the window.

| Argument         | Type   | Default | Notes                                    |
| ---------------- | ------ | ------- | ---------------------------------------- |
| `service`        | string | —       | Service to pull errors for (required).   |
| `env`            | string | —       | Optional env facet.                      |
| `limit`          | int    | `50`    | Max rows, bounded to 1000.               |
| `from` / `to`    | string | —       | ISO 8601 window.                         |
| `lookbackMinutes`| int    | `60`    | Minutes before `to` / now.               |

## Method: monitorContext

| Argument         | Type   | Default | Notes                                    |
| ---------------- | ------ | ------- | ---------------------------------------- |
| `monitorId`      | int    | —       | Datadog monitor numeric ID (required).   |
| `from` / `to`    | string | —       | ISO 8601 window for the events pull.     |
| `lookbackMinutes`| int    | `60`    | Minutes before `to` / now.               |

## Method: correlateDeploys

| Argument       | Type   | Default | Notes                                                        |
| -------------- | ------ | ------- | ------------------------------------------------------------ |
| `incidentStart`| string | —       | ISO 8601 incident start (required). Suspects deployed ≤ this. |
| `windowMinutes`| int    | `180`   | How far before the incident to consider a deploy.            |
| `maxDeploys`   | int    | `50`    | Recent deployments to pull (max 200).                        |
| `maxPrs`       | int    | `50`    | Recent merged PRs to pull (max 200).                         |

## How It Works

- **Auth** is header-based (`DD-API-KEY` + `DD-APPLICATION-KEY`). The model
  never touches a vault — you wire resolved secrets in via `globalArguments`.
  `requireAuth()` validates presence up front so a misconfigured instance fails
  with a readable error rather than a Datadog 403.
- **Logs / errors** use the v2 logs-search endpoint
  (`POST /api/v2/logs/events/search`). `errorEvents` is `searchLogs` with a
  forced `status:error` filter — an error-tracking proxy, not a distinct API.
- **Monitor context** reads `GET /api/v1/monitor/<id>` for the definition and
  `POST /api/v2/events/search` (query `source:alert @monitor.id:<id>`) for the
  monitor's recent state-transition (alert) events. The older
  `GET /api/v1/events?tags=monitor:<id>` query returned nothing —
  `monitor:<id>` is not a real event tag — so transitions were silently missed.
- **correlateDeploys** shells out to the `gh` CLI (`gh api .../deployments` and
  `gh pr list`), joins deploys to PRs on `deploy SHA == PR merge-commit SHA`,
  and ranks suspects by a deterministic linear proximity decay over the window
  (a SHA-matched PR gets a +0.5 boost; ties break by SHA). It requires `gh` on
  the host but needs no Datadog auth.

## License

MIT — see LICENSE for details.
