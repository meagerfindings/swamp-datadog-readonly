import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  apiBase,
  buildLogQuery,
  buildLogsBody,
  ddHeaders,
  type FetchLike,
  type GhRunner,
  parseDeployments,
  parseErrorLogsResponse,
  parseEventsResponse,
  parseLogsResponse,
  parseMergedPrs,
  rankSuspects,
  requireAuth,
  requireCorrelateConfig,
  resolveWindow,
  runCorrelateDeploys,
  runErrorEvents,
  runMonitorContext,
  runSearchLogs,
  runValidateAuth,
} from "./datadog.ts";

const KEYS = { ddApiKey: "api-123", ddAppKey: "app-456" };

// A recording fetch stub: captures the request and returns a canned response.
function stubFetch(status: number, bodyText: string): {
  fetch: FetchLike;
  calls: Array<
    {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  >;
} {
  const calls: Array<
    {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  > = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(bodyText),
    });
  };
  return { fetch, calls };
}

const g = (over: Record<string, unknown> = {}) =>
  ({
    ddApiKey: KEYS.ddApiKey,
    ddAppKey: KEYS.ddAppKey,
    ddSite: "datadoghq.com",
    githubRepo: "owner/repo",
    deployEnvironment: "production",
    ...over,
    // deno-lint-ignore no-explicit-any
  }) as any;

// ── auth ────────────────────────────────────────────────────────────

Deno.test("requireAuth: returns keys when both present", () => {
  assertEquals(requireAuth(KEYS), KEYS);
});

Deno.test("requireAuth: throws actionable error naming both missing secrets", () => {
  const err = assertThrows(() => requireAuth({ ddApiKey: "", ddAppKey: "" }));
  const msg = String(err);
  assert(msg.includes("datadog-api-key"), "names the api key secret");
  assert(msg.includes("datadog-app-key"), "names the app key secret");
  assert(msg.includes("swamp vault put-secret"), "names the fix command");
});

Deno.test("requireAuth: whitespace-only key counts as missing", () => {
  const err = assertThrows(() =>
    requireAuth({ ddApiKey: "   ", ddAppKey: "app-present" })
  );
  // The "missing credential(s): ..." line lists only the blank key. (The
  // remediation block below it always names both put-secret commands.)
  const missingLine = String(err)
    .split("\n")
    .find((l) => l.includes("missing Datadog credential")) ?? "";
  assert(missingLine.includes("datadog-api-key"), "reports the blank key");
  assert(
    !missingLine.includes("datadog-app-key"),
    "does not report the present key",
  );
});

Deno.test("requireCorrelateConfig: returns config when both present", () => {
  assertEquals(
    requireCorrelateConfig({
      githubRepo: "owner/repo",
      deployEnvironment: "production",
    }),
    { githubRepo: "owner/repo", deployEnvironment: "production" },
  );
});

Deno.test("requireCorrelateConfig: throws naming both when unconfigured", () => {
  const err = assertThrows(() =>
    requireCorrelateConfig({ githubRepo: "", deployEnvironment: "" })
  );
  const msg = String(err);
  assert(msg.includes("githubRepo"), "names githubRepo");
  assert(msg.includes("deployEnvironment"), "names deployEnvironment");
});

Deno.test("requireCorrelateConfig: reports only the missing one in the 'set ...' clause", () => {
  const err = assertThrows(() =>
    requireCorrelateConfig({ githubRepo: "owner/repo", deployEnvironment: "" })
  );
  // The "set <X> on the instance" clause lists only the blank arg. (The
  // trailing "e.g. ..." example always names both for clarity.)
  const setClause = String(err).split(" (e.g.")[0];
  assert(setClause.includes("deployEnvironment"), "reports the blank one");
  assert(
    !setClause.includes("githubRepo"),
    "does not report the present one in the set clause",
  );
});

Deno.test("ddHeaders: sets both Datadog auth headers", () => {
  const h = ddHeaders(KEYS);
  assertEquals(h["DD-API-KEY"], "api-123");
  assertEquals(h["DD-APPLICATION-KEY"], "app-456");
  assertEquals(h["Content-Type"], "application/json");
});

Deno.test("apiBase: composes the site into the api host", () => {
  assertEquals(apiBase("datadoghq.com"), "https://api.datadoghq.com");
  assertEquals(apiBase("us5.datadoghq.com"), "https://api.us5.datadoghq.com");
});

// ── window resolution ────────────────────────────────────────────────

Deno.test("resolveWindow: default 60m lookback before now", () => {
  const now = Date.parse("2026-07-14T12:00:00Z");
  const w = resolveWindow({}, now);
  assertEquals(w.toMs, now);
  assertEquals(w.fromMs, now - 60 * 60_000);
});

Deno.test("resolveWindow: explicit lookbackMinutes", () => {
  const now = Date.parse("2026-07-14T12:00:00Z");
  const w = resolveWindow({ lookbackMinutes: 15 }, now);
  assertEquals(w.fromMs, now - 15 * 60_000);
});

Deno.test("resolveWindow: explicit from+to overrides lookback", () => {
  const w = resolveWindow({
    from: "2026-07-14T10:00:00Z",
    to: "2026-07-14T11:00:00Z",
    lookbackMinutes: 999,
  });
  assertEquals(w.fromMs, Date.parse("2026-07-14T10:00:00Z"));
  assertEquals(w.toMs, Date.parse("2026-07-14T11:00:00Z"));
});

Deno.test("resolveWindow: invalid timestamp throws", () => {
  assertThrows(() => resolveWindow({ to: "not-a-date" }));
  assertThrows(() =>
    resolveWindow({ from: "nope", to: "2026-07-14T11:00:00Z" })
  );
});

// ── query builders ────────────────────────────────────────────────────

Deno.test("buildLogQuery: appends service/env facets", () => {
  assertEquals(buildLogQuery("error"), "error");
  assertEquals(buildLogQuery("error", "api"), "error service:api");
  assertEquals(
    buildLogQuery("error", "api", "prod"),
    "error service:api env:prod",
  );
  assertEquals(buildLogQuery("  ", "api"), "service:api");
});

Deno.test("buildLogsBody: correct filter/sort/page shape", () => {
  const body = buildLogsBody("status:error service:api", {
    fromMs: Date.parse("2026-07-14T10:00:00Z"),
    toMs: Date.parse("2026-07-14T11:00:00Z"),
  }, 25) as {
    filter: { query: string; from: string; to: string };
    sort: string;
    page: { limit: number };
  };
  assertEquals(body.filter.query, "status:error service:api");
  assertEquals(body.filter.from, "2026-07-14T10:00:00.000Z");
  assertEquals(body.filter.to, "2026-07-14T11:00:00.000Z");
  assertEquals(body.sort, "-timestamp");
  assertEquals(body.page.limit, 25);
});

// ── response parsers ──────────────────────────────────────────────────

Deno.test("parseLogsResponse: flattens v2 log rows", () => {
  const logs = parseLogsResponse({
    data: [
      {
        id: "AAA",
        attributes: {
          timestamp: "2026-07-14T10:30:00Z",
          service: "api",
          status: "error",
          message: "boom",
          host: "web-1",
        },
      },
      { id: "BBB", attributes: {} },
    ],
  });
  assertEquals(logs.length, 2);
  assertEquals(logs[0], {
    id: "AAA",
    timestamp: "2026-07-14T10:30:00Z",
    service: "api",
    status: "error",
    message: "boom",
    host: "web-1",
  });
  assertEquals(logs[1].id, "BBB");
  assertEquals(logs[1].service, "");
});

Deno.test("parseLogsResponse: empty/missing data → []", () => {
  assertEquals(parseLogsResponse({}), []);
  assertEquals(parseLogsResponse({ data: [] }), []);
});

Deno.test("parseErrorLogsResponse: extracts nested error.kind", () => {
  const errs = parseErrorLogsResponse({
    data: [{
      id: "E1",
      attributes: {
        timestamp: "2026-07-14T10:00:00Z",
        status: "error",
        message: "NoMethodError",
        attributes: { error: { kind: "NoMethodError" } },
      },
    }],
  });
  assertEquals(errs.length, 1);
  assertEquals(errs[0].errorKind, "NoMethodError");
  assertEquals(errs[0].message, "NoMethodError");
});

Deno.test("parseEventsResponse: converts epoch seconds to ISO", () => {
  const events = parseEventsResponse({
    events: [{
      id: 42,
      title: "Triggered",
      text: "monitor fired",
      alert_type: "error",
      date_happened: 1_768_392_000, // 2026-01-14T12:00:00Z
    }],
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].id, 42);
  assertEquals(events[0].alertType, "error");
  assertEquals(
    events[0].dateHappened,
    new Date(1_768_392_000 * 1000).toISOString(),
  );
});

Deno.test("parseDeployments: filters rows without sha", () => {
  const rows = parseDeployments(JSON.stringify([
    { sha: "abc", created_at: "2026-07-14T20:00:00Z", ref: "abc" },
    { created_at: "2026-07-14T19:00:00Z" },
  ]));
  assertEquals(rows.length, 1);
  assertEquals(rows[0].sha, "abc");
});

Deno.test("parseMergedPrs: flattens author + mergeCommit", () => {
  const rows = parseMergedPrs(JSON.stringify([{
    number: 25027,
    title: "Pin client",
    author: { login: "octocat" },
    mergedAt: "2026-07-14T20:09:45Z",
    mergeCommit: { oid: "8bbdc1dd520f8c084deb4d6ee13c66d598530d56" },
  }]));
  assertEquals(rows[0], {
    number: 25027,
    title: "Pin client",
    author: "octocat",
    mergedAt: "2026-07-14T20:09:45Z",
    mergeSha: "8bbdc1dd520f8c084deb4d6ee13c66d598530d56",
  });
});

// ── correlateDeploys ranking (the deterministic core) ─────────────────

const INCIDENT = Date.parse("2026-07-14T21:00:00Z");

Deno.test("rankSuspects: drops deploys after incident start", () => {
  const deploys = [
    { sha: "after", createdAt: "2026-07-14T21:05:00Z", ref: "after" },
    { sha: "before", createdAt: "2026-07-14T20:55:00Z", ref: "before" },
  ];
  const suspects = rankSuspects(deploys, [], INCIDENT);
  assertEquals(suspects.length, 1);
  assertEquals(suspects[0].sha, "before");
});

Deno.test("rankSuspects: drops deploys older than the window", () => {
  const deploys = [
    { sha: "old", createdAt: "2026-07-14T17:00:00Z", ref: "old" }, // 240m before, window 180
    { sha: "recent", createdAt: "2026-07-14T20:00:00Z", ref: "recent" },
  ];
  const suspects = rankSuspects(deploys, [], INCIDENT, 180);
  assertEquals(suspects.map((s) => s.sha), ["recent"]);
});

Deno.test("rankSuspects: closer deploy scores higher", () => {
  const deploys = [
    { sha: "far", createdAt: "2026-07-14T19:30:00Z", ref: "far" }, // 90m before
    { sha: "near", createdAt: "2026-07-14T20:50:00Z", ref: "near" }, // 10m before
  ];
  const suspects = rankSuspects(deploys, [], INCIDENT, 180);
  assertEquals(suspects[0].sha, "near");
  assert(suspects[0].score > suspects[1].score);
  assertEquals(suspects[0].minutesBeforeIncident, 10);
});

Deno.test("rankSuspects: SHA-matched PR outranks a closer unmatched deploy", () => {
  const deploys = [
    { sha: "unmatched", createdAt: "2026-07-14T20:55:00Z", ref: "unmatched" }, // 5m, no PR
    { sha: "matched", createdAt: "2026-07-14T20:30:00Z", ref: "matched" }, // 30m, has PR (+0.5)
  ];
  const prs = [{
    number: 100,
    title: "Suspicious change",
    author: "alice",
    mergedAt: "2026-07-14T20:29:00Z",
    mergeSha: "matched",
  }];
  const suspects = rankSuspects(deploys, prs, INCIDENT, 180);
  assertEquals(suspects[0].sha, "matched");
  assertEquals(suspects[0].prNumber, 100);
  assertEquals(suspects[0].prAuthor, "alice");
  assert(suspects[0].reasons.some((r) => r.includes("#100")));
  assertEquals(suspects[1].prNumber, null);
});

Deno.test("rankSuspects: deterministic tie-break by SHA", () => {
  // Two deploys at the exact same time → identical proximity score.
  const deploys = [
    { sha: "zzz", createdAt: "2026-07-14T20:30:00Z", ref: "zzz" },
    { sha: "aaa", createdAt: "2026-07-14T20:30:00Z", ref: "aaa" },
  ];
  const suspects = rankSuspects(deploys, [], INCIDENT, 180);
  assertEquals(suspects.map((s) => s.sha), ["aaa", "zzz"]);
  // Running again yields the same order.
  const again = rankSuspects([...deploys].reverse(), [], INCIDENT, 180);
  assertEquals(again.map((s) => s.sha), ["aaa", "zzz"]);
});

Deno.test("rankSuspects: deploy exactly at incidentStart is kept, max proximity", () => {
  const deploys = [
    { sha: "atstart", createdAt: "2026-07-14T21:00:00Z", ref: "atstart" }, // == INCIDENT
    {
      sha: "justafter",
      createdAt: "2026-07-14T21:00:00.001Z",
      ref: "justafter",
    },
  ];
  const suspects = rankSuspects(deploys, [], INCIDENT, 180);
  assertEquals(suspects.map((s) => s.sha), ["atstart"]);
  assertEquals(suspects[0].minutesBeforeIncident, 0);
  assertEquals(suspects[0].score, 1); // full proximity, no PR bonus
});

Deno.test("rankSuspects: deploy exactly at the window edge is kept at score 0; 1ms past is dropped", () => {
  const windowMinutes = 180;
  const edgeMs = INCIDENT - windowMinutes * 60_000;
  const deploys = [
    { sha: "atedge", createdAt: new Date(edgeMs).toISOString(), ref: "atedge" },
    {
      sha: "pastedge",
      createdAt: new Date(edgeMs - 1).toISOString(),
      ref: "pastedge",
    },
  ];
  const suspects = rankSuspects(deploys, [], INCIDENT, windowMinutes);
  assertEquals(suspects.map((s) => s.sha), ["atedge"]);
  assertEquals(suspects[0].score, 0);
  assertEquals(suspects[0].minutesBeforeIncident, windowMinutes);
});

Deno.test("rankSuspects: strong proximity can beat the +0.5 PR-match bonus", () => {
  // near unmatched: 18m before / 180m window → proximity 0.9, no bonus → 0.9
  // far matched:  174.6m before / 180m window → proximity 0.03 + 0.5   → 0.53
  const deploys = [
    { sha: "farmatched", createdAt: "2026-07-14T18:05:24Z", ref: "farmatched" },
    { sha: "nearplain", createdAt: "2026-07-14T20:42:00Z", ref: "nearplain" },
  ];
  const prs = [{
    number: 200,
    title: "Old but matched",
    author: "bob",
    mergedAt: "2026-07-14T18:00:00Z",
    mergeSha: "farmatched",
  }];
  const suspects = rankSuspects(deploys, prs, INCIDENT, 180);
  assertEquals(suspects[0].sha, "nearplain");
  assertEquals(suspects[0].prNumber, null);
  assertEquals(suspects[1].sha, "farmatched");
  assertEquals(suspects[1].prNumber, 200);
  assert(suspects[0].score > suspects[1].score);
});

Deno.test("rankSuspects: skips undate-parseable deploys", () => {
  const deploys = [{ sha: "bad", createdAt: "garbage", ref: "bad" }];
  assertEquals(rankSuspects(deploys, [], INCIDENT), []);
});

// ── HTTP method wrappers (with stubbed fetch) ─────────────────────────

Deno.test("runMonitorContext: builds monitor + events requests, parses response", async () => {
  const now = Date.parse("2026-07-14T12:00:00Z");
  // First call → monitor, second → events. Use a stub that switches on path.
  const calls: string[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push(url);
    assertEquals(init?.headers?.["DD-API-KEY"], "api-123");
    if (url.includes("/api/v1/monitor/")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(JSON.stringify({
            id: 777,
            name: "High error rate",
            overall_state: "Alert",
            type: "metric alert",
            query: "avg(last_5m):...",
            message: "page oncall",
            tags: ["service:api", "team:core"],
          })),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify({
          events: [{
            id: 1,
            title: "Triggered",
            text: "fired",
            alert_type: "error",
            date_happened: 1_768_392_000,
          }],
        })),
    });
  };
  const rec = await runMonitorContext(fetchImpl, g(), { monitorId: 777 }, now);
  assertEquals(rec.ok, true);
  assertEquals(rec.monitorId, 777);
  assertEquals(rec.overallState, "Alert");
  assertEquals(rec.tags, ["service:api", "team:core"]);
  assertEquals(rec.eventCount, 1);
  assert(calls[0].startsWith("https://api.datadoghq.com/api/v1/monitor/777"));
  assert(calls[1].includes("tags=monitor:777"));
  assert(calls[1].includes("https://api.datadoghq.com/api/v1/events"));
});

Deno.test("runSearchLogs: POSTs to v2 search with facet-joined query", async () => {
  const now = Date.parse("2026-07-14T12:00:00Z");
  const { fetch, calls } = stubFetch(
    200,
    JSON.stringify({
      data: [{ id: "L1", attributes: { message: "x", service: "api" } }],
    }),
  );
  const rec = await runSearchLogs(fetch, g(), {
    query: "timeout",
    service: "api",
    env: "prod",
    limit: 10,
  }, now);
  assertEquals(rec.resultCount, 1);
  assertEquals(rec.query, "timeout service:api env:prod");
  assertEquals(calls[0].method, "POST");
  assert(calls[0].url.endsWith("/api/v2/logs/events/search"));
  const sentBody = JSON.parse(calls[0].body!);
  assertEquals(sentBody.filter.query, "timeout service:api env:prod");
  assertEquals(sentBody.page.limit, 10);
});

Deno.test("runErrorEvents: forces status:error and scopes to service", async () => {
  const now = Date.parse("2026-07-14T12:00:00Z");
  const { fetch, calls } = stubFetch(
    200,
    JSON.stringify({
      data: [{
        id: "E9",
        attributes: {
          status: "error",
          message: "NPE",
          attributes: { error: { kind: "NullPointer" } },
        },
      }],
    }),
  );
  const rec = await runErrorEvents(fetch, g(), {
    service: "billing",
    limit: 50,
  }, now);
  assertEquals(rec.service, "billing");
  assertEquals(rec.resultCount, 1);
  assertEquals(rec.errors[0].errorKind, "NullPointer");
  const sentBody = JSON.parse(calls[0].body!);
  assertEquals(sentBody.filter.query, "status:error service:billing");
});

Deno.test("runValidateAuth: parses valid flag", async () => {
  const now = Date.parse("2026-07-14T12:00:00Z");
  const { fetch, calls } = stubFetch(200, JSON.stringify({ valid: true }));
  const rec = await runValidateAuth(fetch, g(), now);
  assertEquals(rec.valid, true);
  assertEquals(rec.ddSite, "datadoghq.com");
  assert(calls[0].url.endsWith("/api/v1/validate"));
});

Deno.test("HTTP methods: missing secret throws BEFORE any fetch", async () => {
  let fetched = false;
  const fetchImpl: FetchLike = () => {
    fetched = true;
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{}"),
    });
  };
  await assertRejects(
    () => runValidateAuth(fetchImpl, g({ ddApiKey: "" }), Date.now()),
    Error,
    "datadog-api-key",
  );
  assert(!fetched, "must not reach Datadog when a key is missing");
});

Deno.test("ddRequest: non-2xx surfaces status + body, 403 gets a hint", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve({
      ok: false,
      status: 403,
      text: () => Promise.resolve("Forbidden"),
    });
  const err = await assertRejects(
    () => runValidateAuth(fetchImpl, g(), Date.now()),
    Error,
  );
  assert(String(err).includes("403"));
  assert(String(err).includes("Forbidden"));
  assert(String(err).includes("app key"), "403 carries the actionable hint");
});

// ── correlateDeploys (with stubbed gh) ────────────────────────────────

Deno.test("runCorrelateDeploys: joins gh deployments+PRs and ranks", async () => {
  const now = Date.parse("2026-07-14T22:00:00Z");
  const gh: GhRunner = (args) => {
    if (args[0] === "api") {
      return Promise.resolve({
        ok: true,
        stdout: JSON.stringify([
          {
            sha: "8bbdc1d",
            created_at: "2026-07-14T20:12:29Z",
            ref: "8bbdc1d",
          },
          { sha: "old000", created_at: "2026-07-14T10:00:00Z", ref: "old000" },
        ]),
      });
    }
    return Promise.resolve({
      ok: true,
      stdout: JSON.stringify([{
        number: 25027,
        title: "Pin client",
        author: { login: "octocat" },
        mergedAt: "2026-07-14T20:09:45Z",
        mergeCommit: { oid: "8bbdc1d" },
      }]),
    });
  };
  const rec = await runCorrelateDeploys(gh, g(), {
    incidentStart: "2026-07-14T20:30:00Z",
    windowMinutes: 180,
    maxDeploys: 50,
    maxPrs: 50,
  }, now);
  assertEquals(rec.deployCount, 2);
  assertEquals(rec.prCount, 1);
  // old000 is >180m before → dropped; 8bbdc1d is ~17m before and PR-matched.
  assertEquals(rec.suspects.length, 1);
  assertEquals(rec.suspects[0].sha, "8bbdc1d");
  assertEquals(rec.suspects[0].prNumber, 25027);
  assertEquals(rec.suspects[0].prAuthor, "octocat");
});

Deno.test("runCorrelateDeploys: uses configured githubRepo + deployEnvironment", async () => {
  const seen: string[][] = [];
  const gh: GhRunner = (args) => {
    seen.push(args);
    if (args[0] === "api") return Promise.resolve({ ok: true, stdout: "[]" });
    return Promise.resolve({ ok: true, stdout: "[]" });
  };
  await runCorrelateDeploys(
    gh,
    g({ githubRepo: "acme/widgets", deployEnvironment: "staging" }),
    {
      incidentStart: "2026-07-14T20:30:00Z",
      windowMinutes: 180,
      maxDeploys: 50,
      maxPrs: 50,
    },
  );
  assert(
    seen[0][1].includes("repos/acme/widgets/deployments"),
    "deployments call targets the configured repo",
  );
  assert(
    seen[0][1].includes("environment=staging"),
    "deployments call uses the configured environment",
  );
  assertEquals(seen[1][2], "--repo");
  assertEquals(seen[1][3], "acme/widgets");
});

Deno.test("runCorrelateDeploys: unconfigured repo/env throws before gh", async () => {
  let called = false;
  const gh: GhRunner = () => {
    called = true;
    return Promise.resolve({ ok: true, stdout: "[]" });
  };
  await assertRejects(
    () =>
      runCorrelateDeploys(gh, g({ githubRepo: "", deployEnvironment: "" }), {
        incidentStart: "2026-07-14T20:30:00Z",
        windowMinutes: 180,
        maxDeploys: 50,
        maxPrs: 50,
      }),
    Error,
    "githubRepo",
  );
  assert(!called, "must not shell out to gh when unconfigured");
});

Deno.test("runCorrelateDeploys: gh failure throws with the gh error", async () => {
  const gh: GhRunner = () =>
    Promise.resolve({ ok: false, error: "gh: not authenticated" });
  await assertRejects(
    () =>
      runCorrelateDeploys(gh, g(), {
        incidentStart: "2026-07-14T20:30:00Z",
        windowMinutes: 180,
        maxDeploys: 50,
        maxPrs: 50,
      }),
    Error,
    "not authenticated",
  );
});

Deno.test("runCorrelateDeploys: invalid incidentStart throws", async () => {
  const gh: GhRunner = () => Promise.resolve({ ok: true, stdout: "[]" });
  await assertRejects(
    () =>
      runCorrelateDeploys(gh, g(), {
        incidentStart: "nope",
        windowMinutes: 180,
        maxDeploys: 50,
        maxPrs: 50,
      }),
    Error,
    "invalid incidentStart",
  );
});
