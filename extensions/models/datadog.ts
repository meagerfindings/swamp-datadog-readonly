/**
 * @module @mgreten/datadog-readonly
 *
 * Read-only Datadog incident-context surface — monitors, logs, error events,
 * deploy correlation. No write methods by design.
 *
 * A read-only incident-context layer over the Datadog API and GitHub.
 *
 * Given a firing Datadog monitor or an incident window, agents need queryable
 * incident context: the monitor definition plus its recent state transitions, a
 * scoped log search, an error-event stream for a service, a cheap authenticated
 * ping, and a deploy/PR correlation that ranks change suspects by proximity to
 * the incident start. Every method persists its result as a swamp resource
 * (writeResource) with a zod schema so downstream CEL / data.latest() consumers
 * can read fields.
 *
 * ## Auth
 *
 * The Datadog API needs two headers: DD-API-KEY and DD-APPLICATION-KEY. Supply
 * them via the sensitive `ddApiKey` / `ddAppKey` globalArguments — the intended
 * pattern is to wire them from a swamp VAULT using a CEL
 * `${{ vault.get(<vault>, <key>) }}` reference on the model instance. This
 * model does NOT read the vault itself: swamp resolves the CEL at instance-YAML
 * load time and hands the resolved strings in via globalArgs. When the secrets
 * are missing/unresolved the args arrive empty-string; `requireAuth()` catches
 * that up front and throws a clear, actionable error rather than letting the
 * call reach Datadog and come back as a cryptic 403.
 *
 * The Datadog credentials required are an **org API Key** plus a **scoped
 * Application Key** with only these READ scopes: `monitors_read`,
 * `events_read`, `logs_read_data`, `logs_read_index_data`. The scopes are
 * deliberately read-only, so both the key AND the model are incapable of
 * writes. The `ddSite` argument
 * (default `datadoghq.com`) selects the org's site so a US5 / EU / etc. org
 * just overrides it; the API base URL is `https://api.<ddSite>`.
 *
 * ## GitHub half
 *
 * `correlateDeploys` uses the `gh` CLI (Deno.Command) and needs NO Datadog
 * auth — it is a read-only pull of GitHub Deployments + merged PRs. It requires
 * the `gh` CLI to be installed and authenticated on the host, and the
 * `githubRepo` (owner/repo) + `deployEnvironment` globalArguments to be set on
 * the instance; unconfigured, it throws a clear error naming both.
 *
 * `errorEvents` proxies an error-tracking view through the v2 logs-search
 * endpoint (`status:error` scoped to the service), rather than a dedicated
 * error-tracking API.
 */

import { z } from "npm:zod@4";

/**
 * Global arguments for the datadog model. `ddApiKey` / `ddAppKey` are sensitive
 * (wire from a vault); `ddSite` selects the Datadog site; `githubRepo` /
 * `deployEnvironment` configure `correlateDeploys` and have no default (they
 * must be set for that method to run).
 */
const GlobalArgsSchema: z.ZodObject<{
  ddApiKey: z.ZodDefault<z.ZodString>;
  ddAppKey: z.ZodDefault<z.ZodString>;
  ddSite: z.ZodDefault<z.ZodString>;
  githubRepo: z.ZodDefault<z.ZodString>;
  deployEnvironment: z.ZodDefault<z.ZodString>;
}> = z.object({
  ddApiKey: z
    .string()
    .default("")
    .describe(
      "Datadog API key (DD-API-KEY header). Wire from a vault, e.g. " +
        "${{ vault.get(datadog, datadog-api-key) }}. Requires an org API Key.",
    )
    .meta({ sensitive: true }),
  ddAppKey: z
    .string()
    .default("")
    .describe(
      "Datadog application key (DD-APPLICATION-KEY header). Wire from a vault, " +
        "e.g. ${{ vault.get(datadog, datadog-app-key) }}. Requires a scoped " +
        "Application Key with monitors_read, events_read, logs_read_data, " +
        "logs_read_index_data.",
    )
    .meta({ sensitive: true }),
  ddSite: z
    .string()
    .default("datadoghq.com")
    .describe(
      "Datadog site host, e.g. datadoghq.com, us5.datadoghq.com, datadoghq.eu. " +
        "The API base URL is https://api.<ddSite>.",
    ),
  githubRepo: z
    .string()
    .default("")
    .describe(
      "owner/repo slug used by correlateDeploys, e.g. owner/repo. Required for " +
        "correlateDeploys; no default.",
    ),
  deployEnvironment: z
    .string()
    .default("")
    .describe(
      "GitHub Deployments environment filter used by correlateDeploys, e.g. " +
        "production. Required for correlateDeploys; no default.",
    ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Method execution context (mirrors the shape swamp injects into `execute`). */
type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
    options?: { tags?: Record<string, string> },
  ) => Promise<Record<string, unknown>>;
  modelType: string;
  modelId: string;
};

/** Minimal fetch signature the HTTP methods depend on (injectable in tests). */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/** The real `fetch`, adapted to the injectable {@link FetchLike} shape. */
const realFetch: FetchLike = (url, init) =>
  fetch(url, init) as unknown as ReturnType<FetchLike>;

/** Runs `gh <args>` and returns stdout. Injectable in tests. */
export type GhRunner = (
  args: string[],
) => Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;

/** The real `gh` CLI runner (shells out via Deno.Command). */
export const realGh: GhRunner = async (args) => {
  const cmd = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const errText = new TextDecoder().decode(stderr).trim();
    return { ok: false, error: errText || `gh exited ${code}` };
  }
  return { ok: true, stdout: new TextDecoder().decode(stdout) };
};

/**
 * Validate that both Datadog keys are present. Throws a clear, actionable
 * error (naming the vault commands) when either is missing/blank so a
 * misconfigured instance fails fast instead of returning a 403 from Datadog.
 */
export function requireAuth(g: Pick<GlobalArgs, "ddApiKey" | "ddAppKey">): {
  ddApiKey: string;
  ddAppKey: string;
} {
  const missing: string[] = [];
  if (!g.ddApiKey || g.ddApiKey.trim() === "") missing.push("datadog-api-key");
  if (!g.ddAppKey || g.ddAppKey.trim() === "") missing.push("datadog-app-key");
  if (missing.length > 0) {
    throw new Error(
      `@mgreten/datadog-readonly: missing Datadog credential(s): ${
        missing.join(", ")
      }. ` +
        `Add them to a vault and wire them into the instance globalArguments:\n` +
        `  swamp vault put-secret datadog datadog-api-key\n` +
        `  swamp vault put-secret datadog datadog-app-key\n` +
        `then set ddApiKey: '\${{ vault.get(datadog, datadog-api-key) }}' and ` +
        `ddAppKey: '\${{ vault.get(datadog, datadog-app-key) }}' on the instance. ` +
        `The app key must be scoped monitors_read, events_read, logs_read_data, ` +
        `logs_read_index_data.`,
    );
  }
  return { ddApiKey: g.ddApiKey, ddAppKey: g.ddAppKey };
}

/**
 * Validate that `githubRepo` and `deployEnvironment` are configured. Throws a
 * clear error naming both when either is blank, so correlateDeploys fails fast
 * on an unconfigured instance instead of shelling out to gh with a bad slug.
 */
export function requireCorrelateConfig(
  g: Pick<GlobalArgs, "githubRepo" | "deployEnvironment">,
): { githubRepo: string; deployEnvironment: string } {
  const missing: string[] = [];
  if (!g.githubRepo || g.githubRepo.trim() === "") missing.push("githubRepo");
  if (!g.deployEnvironment || g.deployEnvironment.trim() === "") {
    missing.push("deployEnvironment");
  }
  if (missing.length > 0) {
    throw new Error(
      `@mgreten/datadog-readonly: correlateDeploys is unconfigured — set ${
        missing.join(" and ")
      } on the instance globalArguments (e.g. githubRepo: owner/repo, ` +
        `deployEnvironment: production).`,
    );
  }
  return { githubRepo: g.githubRepo, deployEnvironment: g.deployEnvironment };
}

/** The Datadog API base URL for a given site. */
export function apiBase(ddSite: string): string {
  return `https://api.${ddSite}`;
}

/** The two Datadog auth headers plus content-type. */
export function ddHeaders(
  g: Pick<GlobalArgs, "ddApiKey" | "ddAppKey">,
): Record<string, string> {
  const { ddApiKey, ddAppKey } = requireAuth(g);
  return {
    "DD-API-KEY": ddApiKey,
    "DD-APPLICATION-KEY": ddAppKey,
    "Content-Type": "application/json",
  };
}

/**
 * Perform a Datadog request and parse JSON, turning transport + HTTP errors
 * into thrown Errors with the status and (truncated) body so callers see a
 * real message rather than a silent green success.
 */
export async function ddRequest(
  fetchImpl: FetchLike,
  g: Pick<GlobalArgs, "ddApiKey" | "ddAppKey" | "ddSite">,
  path: string,
  opts?: { method?: string; body?: unknown },
): Promise<unknown> {
  const url = `${apiBase(g.ddSite)}${path}`;
  const init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  } = {
    method: opts?.method ?? "GET",
    headers: ddHeaders(g),
  };
  if (opts?.body !== undefined) init.body = JSON.stringify(opts.body);

  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 403
      ? " (403 — check the API/APP key pair and that the app key is authorized for this org/site)"
      : "";
    throw new Error(
      `@mgreten/datadog-readonly: ${init.method} ${path} failed with ${res.status}${hint}: ${
        text.slice(0, 500)
      }`,
    );
  }
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `@mgreten/datadog-readonly: ${init.method} ${path} returned non-JSON: ${
        text.slice(0, 200)
      }`,
    );
  }
}

/** A resolved time window in epoch milliseconds. */
export type Window = { fromMs: number; toMs: number };

/**
 * Resolve a time window. Precedence:
 *   1. explicit from/to (ISO strings) if both given
 *   2. `lookbackMinutes` before `to` (or before now)
 *   3. default 60m before now
 * `now` is injectable for deterministic tests.
 */
export function resolveWindow(
  args: { from?: string; to?: string; lookbackMinutes?: number },
  now: number = Date.now(),
): Window {
  const toMs = args.to ? Date.parse(args.to) : now;
  if (Number.isNaN(toMs)) {
    throw new Error(
      `@mgreten/datadog-readonly: invalid 'to' timestamp: ${args.to}`,
    );
  }
  if (args.from) {
    const fromMs = Date.parse(args.from);
    if (Number.isNaN(fromMs)) {
      throw new Error(
        `@mgreten/datadog-readonly: invalid 'from' timestamp: ${args.from}`,
      );
    }
    return { fromMs, toMs };
  }
  const lookback = args.lookbackMinutes ?? 60;
  return { fromMs: toMs - lookback * 60_000, toMs };
}

/** A GitHub Deployment row (subset used for correlation). */
export type DeployRow = {
  sha: string;
  createdAt: string;
  ref: string;
};

/** A merged GitHub PR row (subset used for correlation). */
export type PrRow = {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  mergeSha: string;
};

/** A ranked deploy/PR change suspect for an incident. */
export type Suspect = {
  sha: string;
  deployedAt: string | null;
  prNumber: number | null;
  prTitle: string | null;
  prAuthor: string | null;
  mergedAt: string | null;
  minutesBeforeIncident: number | null;
  score: number;
  reasons: string[];
};

/**
 * Rank deploy/PR suspects for an incident that started at `incidentStartMs`.
 *
 * Model: a deploy is a suspect when it landed AT or BEFORE the incident start
 * (a change already live can cause the incident; the boundary instant counts)
 * but not so long before that it is implausible (bounded by `windowMinutes`,
 * default 180 — a deploy exactly at the window edge is kept, at proximity 0;
 * anything past it is dropped). We join deploys to PRs on the deploy SHA == PR
 * merge commit SHA (the merge commit becomes the deployed ref). Score is higher
 * the closer the deploy landed to the incident start — a simple, deterministic
 * linear decay over the window. Deploys after the incident start are dropped
 * (they cannot have caused it). Ties break by SHA for stable ordering.
 */
export function rankSuspects(
  deploys: DeployRow[],
  prs: PrRow[],
  incidentStartMs: number,
  windowMinutes = 180,
): Suspect[] {
  const prBySha = new Map<string, PrRow>();
  for (const pr of prs) {
    if (pr.mergeSha) prBySha.set(pr.mergeSha, pr);
  }

  const windowMs = windowMinutes * 60_000;
  const suspects: Suspect[] = [];

  for (const d of deploys) {
    const deployedMs = Date.parse(d.createdAt);
    if (Number.isNaN(deployedMs)) continue;
    // Only deploys at or before the incident start can be causes: a deploy
    // landing at the exact same instant is kept (and scores maximum
    // proximity); anything after is dropped.
    if (deployedMs > incidentStartMs) continue;
    const beforeMs = incidentStartMs - deployedMs;
    if (beforeMs > windowMs) continue;

    const minutesBefore = beforeMs / 60_000;
    // Linear decay: 1.0 at the incident start, 0.0 at the window edge.
    const proximity = 1 - beforeMs / windowMs;
    const pr = prBySha.get(d.sha) ?? null;

    const reasons: string[] = [];
    reasons.push(
      `deployed ${
        minutesBefore.toFixed(1)
      }m before incident start (within ${windowMinutes}m window)`,
    );
    let score = proximity;
    if (pr) {
      reasons.push(
        `matched PR #${pr.number} "${pr.title}" by ${pr.author} (merge SHA == deploy SHA)`,
      );
      // A SHA-matched PR is a stronger, more actionable suspect than a bare
      // deploy: nudge it above an unmatched deploy at the same proximity.
      score += 0.5;
    } else {
      reasons.push("no merged PR matched this deploy SHA");
    }

    suspects.push({
      sha: d.sha,
      deployedAt: d.createdAt,
      prNumber: pr?.number ?? null,
      prTitle: pr?.title ?? null,
      prAuthor: pr?.author ?? null,
      mergedAt: pr?.mergedAt ?? null,
      minutesBeforeIncident: Number(minutesBefore.toFixed(2)),
      score: Number(score.toFixed(4)),
      reasons,
    });
  }

  suspects.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0;
  });
  return suspects;
}

/** Parse `gh api .../deployments` JSON into {@link DeployRow}s. */
export function parseDeployments(stdout: string): DeployRow[] {
  const raw = JSON.parse(stdout) as Array<
    { sha?: string; created_at?: string; ref?: string }
  >;
  return raw
    .filter((d) => typeof d.sha === "string")
    .map((d) => ({
      sha: d.sha as string,
      createdAt: d.created_at ?? "",
      ref: d.ref ?? "",
    }));
}

/** Parse `gh pr list --json ...` JSON into {@link PrRow}s. */
export function parseMergedPrs(stdout: string): PrRow[] {
  const raw = JSON.parse(stdout) as Array<{
    number?: number;
    title?: string;
    author?: { login?: string } | null;
    mergedAt?: string;
    mergeCommit?: { oid?: string } | null;
  }>;
  return raw
    .filter((p) => typeof p.number === "number")
    .map((p) => ({
      number: p.number as number,
      title: p.title ?? "",
      author: p.author?.login ?? "",
      mergedAt: p.mergedAt ?? "",
      mergeSha: p.mergeCommit?.oid ?? "",
    }));
}

/** Result schema for `monitorContext`. */
const MonitorContextResultSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  monitorId: z.number().int(),
  name: z.string(),
  overallState: z.string(),
  type: z.string(),
  query: z.string(),
  message: z.string(),
  tags: z.array(z.string()),
  window: z.object({ from: z.string(), to: z.string() }),
  events: z.array(z.object({
    id: z.union([z.number(), z.string()]).nullable(),
    title: z.string(),
    text: z.string(),
    alertType: z.string(),
    dateHappened: z.string(),
  })),
  eventCount: z.number().int(),
}).passthrough();

/** Result schema for `searchLogs`. */
const SearchLogsResultSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  query: z.string(),
  service: z.string().nullable(),
  env: z.string().nullable(),
  window: z.object({ from: z.string(), to: z.string() }),
  limit: z.number().int(),
  resultCount: z.number().int(),
  logs: z.array(z.object({
    id: z.string(),
    timestamp: z.string(),
    service: z.string(),
    status: z.string(),
    message: z.string(),
    host: z.string(),
  })),
}).passthrough();

/** Result schema for `errorEvents`. */
const ErrorEventsResultSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  service: z.string(),
  env: z.string().nullable(),
  window: z.object({ from: z.string(), to: z.string() }),
  limit: z.number().int(),
  resultCount: z.number().int(),
  errors: z.array(z.object({
    id: z.string(),
    timestamp: z.string(),
    status: z.string(),
    message: z.string(),
    errorKind: z.string(),
  })),
}).passthrough();

/** Result schema for `correlateDeploys`. */
const CorrelateDeploysResultSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  githubRepo: z.string(),
  deployEnvironment: z.string(),
  incidentStart: z.string(),
  windowMinutes: z.number().int(),
  deployCount: z.number().int(),
  prCount: z.number().int(),
  suspects: z.array(z.object({
    sha: z.string(),
    deployedAt: z.string().nullable(),
    prNumber: z.number().int().nullable(),
    prTitle: z.string().nullable(),
    prAuthor: z.string().nullable(),
    mergedAt: z.string().nullable(),
    minutesBeforeIncident: z.number().nullable(),
    score: z.number(),
    reasons: z.array(z.string()),
  })),
}).passthrough();

/** Result schema for `validateAuth`. */
const ValidateAuthResultSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  ddSite: z.string(),
  valid: z.boolean(),
}).passthrough();

/** Shared window argument fields for the log/monitor methods. */
const WindowArgs = {
  from: z.string().optional().describe(
    "Window start (ISO 8601). If set with 'to', overrides lookbackMinutes.",
  ),
  to: z.string().optional().describe("Window end (ISO 8601). Defaults to now."),
  lookbackMinutes: z.number().int().positive().optional().describe(
    "Minutes before 'to' (or now). Default 60.",
  ),
};

/** Argument schema for `monitorContext`. */
const MonitorContextArgs = z.object({
  monitorId: z.number().int().describe("Datadog monitor numeric ID."),
  ...WindowArgs,
});

/** Argument schema for `searchLogs`. */
const SearchLogsArgs = z.object({
  query: z.string().describe("Datadog log search query string."),
  service: z.string().optional().describe(
    "Optional service facet (added to the query as service:<v>).",
  ),
  env: z.string().optional().describe(
    "Optional env facet (added to the query as env:<v>).",
  ),
  limit: z.number().int().positive().max(1000).default(50).describe(
    "Max log rows (bounded, default 50, max 1000).",
  ),
  ...WindowArgs,
});

/** Argument schema for `errorEvents`. */
const ErrorEventsArgs = z.object({
  service: z.string().describe("Service to pull error events for."),
  env: z.string().optional().describe("Optional env facet."),
  limit: z.number().int().positive().max(1000).default(50).describe(
    "Max error rows (bounded, default 50, max 1000).",
  ),
  ...WindowArgs,
});

/** Argument schema for `correlateDeploys`. */
const CorrelateDeploysArgs = z.object({
  incidentStart: z.string().describe(
    "Incident start time (ISO 8601). Suspects are deploys before this.",
  ),
  windowMinutes: z.number().int().positive().default(180).describe(
    "How far before incidentStart to consider a deploy a suspect. Default 180.",
  ),
  maxDeploys: z.number().int().positive().max(200).default(50).describe(
    "How many recent deployments to pull from GitHub. Default 50.",
  ),
  maxPrs: z.number().int().positive().max(200).default(50).describe(
    "How many recent merged PRs to pull from GitHub. Default 50.",
  ),
});

/** Compose the effective log query from the base query + optional facets. */
export function buildLogQuery(
  query: string,
  service?: string,
  env?: string,
): string {
  const parts = [query.trim()].filter((p) => p.length > 0);
  if (service) parts.push(`service:${service}`);
  if (env) parts.push(`env:${env}`);
  return parts.join(" ");
}

/** Build the v2 logs search request body. */
export function buildLogsBody(
  effectiveQuery: string,
  window: Window,
  limit: number,
): Record<string, unknown> {
  return {
    filter: {
      query: effectiveQuery,
      from: new Date(window.fromMs).toISOString(),
      to: new Date(window.toMs).toISOString(),
    },
    sort: "-timestamp",
    page: { limit },
  };
}

/** A raw v2 log row as returned by the Datadog logs-search endpoint. */
type DdLog = {
  id?: string;
  attributes?: {
    timestamp?: string;
    service?: string;
    status?: string;
    message?: string;
    host?: string;
    attributes?: Record<string, unknown>;
  };
};

/** Flatten a v2 logs search response into our log row schema. */
export function parseLogsResponse(body: unknown): Array<{
  id: string;
  timestamp: string;
  service: string;
  status: string;
  message: string;
  host: string;
}> {
  const data = (body as { data?: DdLog[] })?.data ?? [];
  return data.map((d) => ({
    id: d.id ?? "",
    timestamp: d.attributes?.timestamp ?? "",
    service: d.attributes?.service ?? "",
    status: d.attributes?.status ?? "",
    message: d.attributes?.message ?? "",
    host: d.attributes?.host ?? "",
  }));
}

/** Flatten a v2 logs search response into error rows (error-tracking view). */
export function parseErrorLogsResponse(body: unknown): Array<{
  id: string;
  timestamp: string;
  status: string;
  message: string;
  errorKind: string;
}> {
  const data = (body as { data?: DdLog[] })?.data ?? [];
  return data.map((d) => {
    const attrs = d.attributes?.attributes ?? {};
    const errorKind =
      typeof (attrs as { error?: { kind?: string } }).error?.kind === "string"
        ? (attrs as { error: { kind: string } }).error.kind
        : "";
    return {
      id: d.id ?? "",
      timestamp: d.attributes?.timestamp ?? "",
      status: d.attributes?.status ?? "",
      message: d.attributes?.message ?? "",
      errorKind,
    };
  });
}

/** A raw v1 monitor definition as returned by the Datadog monitor endpoint. */
type DdMonitor = {
  id?: number;
  name?: string;
  overall_state?: string;
  type?: string;
  query?: string;
  message?: string;
  tags?: string[];
};

/** A raw v1 event as returned by the Datadog events endpoint. */
type DdEvent = {
  id?: number | string;
  title?: string;
  text?: string;
  alert_type?: string;
  date_happened?: number;
};

/** Flatten the v1 events response into our event row schema. */
export function parseEventsResponse(body: unknown): Array<{
  id: number | string | null;
  title: string;
  text: string;
  alertType: string;
  dateHappened: string;
}> {
  const events = (body as { events?: DdEvent[] })?.events ?? [];
  return events.map((e) => ({
    id: e.id ?? null,
    title: e.title ?? "",
    text: e.text ?? "",
    alertType: e.alert_type ?? "",
    dateHappened: e.date_happened
      ? new Date(e.date_happened * 1000).toISOString()
      : "",
  }));
}

/** Fetch a monitor definition plus its recent events in a window. */
export async function runMonitorContext(
  fetchImpl: FetchLike,
  g: GlobalArgs,
  args: z.infer<typeof MonitorContextArgs>,
  now: number = Date.now(),
): Promise<z.infer<typeof MonitorContextResultSchema>> {
  const win = resolveWindow(args, now);
  const monitor = (await ddRequest(
    fetchImpl,
    g,
    `/api/v1/monitor/${args.monitorId}`,
  )) as DdMonitor;

  // Pull recent monitor events (state transitions / alerts) from the v1 events
  // stream, scoped to this monitor and window.
  const fromS = Math.floor(win.fromMs / 1000);
  const toS = Math.floor(win.toMs / 1000);
  const eventsBody = await ddRequest(
    fetchImpl,
    g,
    `/api/v1/events?start=${fromS}&end=${toS}&tags=monitor:${args.monitorId}`,
  );
  const events = parseEventsResponse(eventsBody);

  return {
    ok: true,
    ts: new Date(now).toISOString(),
    monitorId: monitor.id ?? args.monitorId,
    name: monitor.name ?? "",
    overallState: monitor.overall_state ?? "",
    type: monitor.type ?? "",
    query: monitor.query ?? "",
    message: monitor.message ?? "",
    tags: monitor.tags ?? [],
    window: {
      from: new Date(win.fromMs).toISOString(),
      to: new Date(win.toMs).toISOString(),
    },
    events,
    eventCount: events.length,
  };
}

/** Run a scoped Datadog log search over a window. */
export async function runSearchLogs(
  fetchImpl: FetchLike,
  g: GlobalArgs,
  args: z.infer<typeof SearchLogsArgs>,
  now: number = Date.now(),
): Promise<z.infer<typeof SearchLogsResultSchema>> {
  const win = resolveWindow(args, now);
  const effectiveQuery = buildLogQuery(args.query, args.service, args.env);
  const body = buildLogsBody(effectiveQuery, win, args.limit);
  const resp = await ddRequest(fetchImpl, g, "/api/v2/logs/events/search", {
    method: "POST",
    body,
  });
  const logs = parseLogsResponse(resp);
  return {
    ok: true,
    ts: new Date(now).toISOString(),
    query: effectiveQuery,
    service: args.service ?? null,
    env: args.env ?? null,
    window: {
      from: new Date(win.fromMs).toISOString(),
      to: new Date(win.toMs).toISOString(),
    },
    limit: args.limit,
    resultCount: logs.length,
    logs,
  };
}

/** Pull a service's error-status log stream over a window. */
export async function runErrorEvents(
  fetchImpl: FetchLike,
  g: GlobalArgs,
  args: z.infer<typeof ErrorEventsArgs>,
  now: number = Date.now(),
): Promise<z.infer<typeof ErrorEventsResultSchema>> {
  const win = resolveWindow(args, now);
  // Error-tracking view: scope to the service, status:error, in the window.
  const query = buildLogQuery("status:error", args.service, args.env);
  const body = buildLogsBody(query, win, args.limit);
  const resp = await ddRequest(fetchImpl, g, "/api/v2/logs/events/search", {
    method: "POST",
    body,
  });
  const errors = parseErrorLogsResponse(resp);
  return {
    ok: true,
    ts: new Date(now).toISOString(),
    service: args.service,
    env: args.env ?? null,
    window: {
      from: new Date(win.fromMs).toISOString(),
      to: new Date(win.toMs).toISOString(),
    },
    limit: args.limit,
    resultCount: errors.length,
    errors,
  };
}

/** Cheap authenticated ping against GET /api/v1/validate. */
export async function runValidateAuth(
  fetchImpl: FetchLike,
  g: GlobalArgs,
  now: number = Date.now(),
): Promise<z.infer<typeof ValidateAuthResultSchema>> {
  // requireAuth (inside ddRequest→ddHeaders) throws first if keys are absent.
  const resp = (await ddRequest(fetchImpl, g, "/api/v1/validate")) as {
    valid?: boolean;
  };
  return {
    ok: true,
    ts: new Date(now).toISOString(),
    ddSite: g.ddSite,
    valid: resp.valid === true,
  };
}

/** Correlate an incident window against recent deploys + merged PRs. */
export async function runCorrelateDeploys(
  gh: GhRunner,
  g: GlobalArgs,
  args: z.infer<typeof CorrelateDeploysArgs>,
  now: number = Date.now(),
): Promise<z.infer<typeof CorrelateDeploysResultSchema>> {
  const { githubRepo, deployEnvironment } = requireCorrelateConfig(g);
  const incidentStartMs = Date.parse(args.incidentStart);
  if (Number.isNaN(incidentStartMs)) {
    throw new Error(
      `@mgreten/datadog-readonly: invalid incidentStart: ${args.incidentStart}`,
    );
  }

  const deployRes = await gh([
    "api",
    `repos/${githubRepo}/deployments?environment=${deployEnvironment}&per_page=${args.maxDeploys}`,
  ]);
  if (!deployRes.ok) {
    throw new Error(
      `@mgreten/datadog-readonly: gh deployments fetch failed: ${deployRes.error}`,
    );
  }

  const prRes = await gh([
    "pr",
    "list",
    "--repo",
    githubRepo,
    "--state",
    "merged",
    "--limit",
    String(args.maxPrs),
    "--json",
    "number,title,author,mergedAt,mergeCommit",
  ]);
  if (!prRes.ok) {
    throw new Error(
      `@mgreten/datadog-readonly: gh pr list failed: ${prRes.error}`,
    );
  }

  const deploys = parseDeployments(deployRes.stdout);
  const prs = parseMergedPrs(prRes.stdout);
  const suspects = rankSuspects(
    deploys,
    prs,
    incidentStartMs,
    args.windowMinutes,
  );

  return {
    ok: true,
    ts: new Date(now).toISOString(),
    githubRepo,
    deployEnvironment,
    incidentStart: args.incidentStart,
    windowMinutes: args.windowMinutes,
    deployCount: deploys.length,
    prCount: prs.length,
    suspects,
  };
}

/**
 * The swamp model: a read-only Datadog + GitHub incident-context layer with
 * five methods (validateAuth, searchLogs, errorEvents, monitorContext,
 * correlateDeploys), each persisting a typed resource.
 */
export const model = {
  type: "@mgreten/datadog-readonly",
  version: "2026.07.15.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    monitor_context: {
      description:
        "One row per monitorContext call: monitor def + recent events.",
      schema: MonitorContextResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 2000,
    },
    log_search: {
      description:
        "One row per searchLogs call: scoped log rows + the effective query.",
      schema: SearchLogsResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 2000,
    },
    error_events: {
      description:
        "One row per errorEvents call: a service's error rows in a window.",
      schema: ErrorEventsResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 2000,
    },
    deploy_correlation: {
      description:
        "One row per correlateDeploys call: ranked deploy/PR suspect list.",
      schema: CorrelateDeploysResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 2000,
    },
    auth_check: {
      description:
        "One row per validateAuth call: whether the key pair authenticated.",
      schema: ValidateAuthResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 500,
    },
  },
  methods: {
    monitorContext: {
      description:
        "Fetch a monitor's definition plus its recent state transitions / alert events in a time window. Feeds an incident with the firing monitor's query, message, tags, and what it did recently.",
      arguments: MonitorContextArgs,
      execute: async (
        args: z.infer<typeof MonitorContextArgs>,
        context: MethodContext,
      ) => {
        const record = await runMonitorContext(
          realFetch,
          context.globalArgs,
          args,
        );
        context.logger.info("monitorContext", {
          monitorId: args.monitorId,
          overallState: record.overallState,
          eventCount: record.eventCount,
        });
        const handle = await context.writeResource(
          "monitor_context",
          `monitor-${args.monitorId}-${record.ts}`,
          record,
          {
            tags: {
              monitorId: String(args.monitorId),
              state: record.overallState,
            },
          },
        );
        return { dataHandles: [handle] };
      },
    },
    searchLogs: {
      description:
        "Scoped Datadog log search: a query string + optional service/env facets over a time window, bounded result count. Returns flattened log rows.",
      arguments: SearchLogsArgs,
      execute: async (
        args: z.infer<typeof SearchLogsArgs>,
        context: MethodContext,
      ) => {
        const record = await runSearchLogs(realFetch, context.globalArgs, args);
        context.logger.info("searchLogs", {
          query: record.query,
          resultCount: record.resultCount,
        });
        const handle = await context.writeResource(
          "log_search",
          `logs-${record.ts}`,
          record,
          { tags: { resultCount: String(record.resultCount) } },
        );
        return { dataHandles: [handle] };
      },
    },
    errorEvents: {
      description:
        "Pull a service's error-status log/event stream over a time window (bounded). The error-tracking companion to searchLogs.",
      arguments: ErrorEventsArgs,
      execute: async (
        args: z.infer<typeof ErrorEventsArgs>,
        context: MethodContext,
      ) => {
        const record = await runErrorEvents(
          realFetch,
          context.globalArgs,
          args,
        );
        context.logger.info("errorEvents", {
          service: args.service,
          resultCount: record.resultCount,
        });
        const handle = await context.writeResource(
          "error_events",
          `errors-${args.service}-${record.ts}`,
          record,
          {
            tags: {
              service: args.service,
              resultCount: String(record.resultCount),
            },
          },
        );
        return { dataHandles: [handle] };
      },
    },
    correlateDeploys: {
      description:
        "Given an incident window, pull recent GitHub Deployments for the configured environment and recent merged PRs, join them on deploy-SHA == PR-merge-SHA, and rank suspects by how close before the incident each deploy landed. Deterministic; needs the gh CLI but no Datadog auth. Requires githubRepo + deployEnvironment globalArguments.",
      arguments: CorrelateDeploysArgs,
      execute: async (
        args: z.infer<typeof CorrelateDeploysArgs>,
        context: MethodContext,
      ) => {
        const record = await runCorrelateDeploys(
          realGh,
          context.globalArgs,
          args,
        );
        context.logger.info("correlateDeploys", {
          incidentStart: args.incidentStart,
          deployCount: record.deployCount,
          prCount: record.prCount,
          suspectCount: record.suspects.length,
        });
        const handle = await context.writeResource(
          "deploy_correlation",
          `deploys-${record.ts}`,
          record,
          { tags: { suspectCount: String(record.suspects.length) } },
        );
        return { dataHandles: [handle] };
      },
    },
    validateAuth: {
      description:
        "Cheap authenticated ping (GET /api/v1/validate) so the Datadog key pair can be smoke-tested the moment the vault secrets exist. Throws a clear error naming the vault commands if the keys are missing.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: MethodContext) => {
        const record = await runValidateAuth(realFetch, context.globalArgs);
        context.logger.info("validateAuth", {
          ddSite: record.ddSite,
          valid: record.valid,
        });
        const handle = await context.writeResource(
          "auth_check",
          `auth-${record.ts}`,
          record,
          { tags: { valid: String(record.valid) } },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
