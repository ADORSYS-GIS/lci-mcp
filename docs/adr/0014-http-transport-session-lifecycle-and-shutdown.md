# ADR-0014: HTTP MCP transport session lifecycle and graceful shutdown

- **Status:** Superseded by ADR-0018
- **Date:** 2026-09-24
- **Deciders:** @sinke237

> **Superseded:** the HTTP MCP transport this ADR hardened was removed to keep `lci-mcp` local-first
> (stdio-only). Network exposure, authentication, and session management now live in the consumer
> (the chatbot). This ADR is retained only as a record of the hardening that was considered while
> the transport existed. See [ADR-0018](./0018-local-first-no-http-auth-provisioning.md).

## Context and Problem Statement

ADR-0009's semantic tool surface is now reachable over an authenticated HTTP transport
(`packages/server/src/http/server.ts`), which introduces per-client `StreamableHTTPServerTransport`
sessions the stdio transport never had. A long-lived network server has failure modes a
process-per-client stdio server does not: a client can POST without ever completing the MCP
`initialize` handshake, sessions accumulate for the life of the process, a rejected request handler
becomes an unhandled rejection, a bind failure is emitted asynchronously after `listen()` returns,
and open SSE streams keep the process alive at shutdown. How should the HTTP transport bound and
tear down session state so a single misbehaving client cannot exhaust memory or crash the process?

## Decision Drivers

- One bad or abusive client must not be able to grow server state without bound or crash the process
- Every `McpServer` + transport pair that gets created must eventually be closed — no leaks on the
  non-`initialize` path or during teardown
- Startup and bind failures must surface through the normal exit path (non-zero exit code), not a
  raw stack trace
- Shutdown must actually terminate, even with long-lived SSE GET streams still open
- The CLI surface must not silently do something other than what the flags say

## Considered Options

- Leave session management to the SDK transport defaults and rely on the OS to reclaim everything at
  process exit
- Add explicit lifecycle bounds: create a session only for a completed handshake, cap the table,
  expire idle sessions, and drive shutdown/bind errors through the CLI

## Decision Outcome

Chosen option: **explicit lifecycle bounds**, implemented as several composing guards:

1. **Session created, then confirmed or closed.** A POST without a known `mcp-session-id` gets a
   fresh transport + `McpServer`, but it is only retained if `onsessioninitialized` fires. If the
   request was not a valid `initialize`, the pair is closed in a `finally` rather than left
   connected and unreferenced (`registered` flag in `handleRequest`).
2. **A hard cap on concurrent sessions.** Once the table reaches `maxSessions` (default 256), new
   session-creating POSTs get a `503` with `retry-after`, so an un-initializing client cannot grow
   it without limit.
3. **Idle expiry.** An `unref()`'d sweeper closes sessions whose `lastActivity` is older than
   `idleTimeoutMs` (default 30 min); every request bumps its session's `lastActivity`. The timer is
   `unref()`'d so it never keeps the event loop alive on its own.
4. **Handler rejections are contained.** The `createHttpServer` callback is synchronous and routes
   `handleRequest(...).catch(...)` to a `500` (or `response.end()`), so a malformed body or an
   aborted-client write error can never become a process-terminating unhandled rejection.
5. **Bind failures exit cleanly.** `httpServer.on("error", …)` forwards to an `onError` option;
   `cli.ts` logs it and exits non-zero. `EADDRINUSE`/`EACCES` (emitted asynchronously, outside
   `main()`'s promise chain) no longer crash with a raw stack trace.
6. **Shutdown forces streams closed.** On `SIGINT`/`SIGTERM` the CLI drains the worker registry and
   background index job, then calls `httpServer.close()` **and** `httpServer.closeAllConnections()`;
   the server's own `close` handler clears the sweeper and closes every live transport/server. Open
   SSE GET streams can no longer pin the process open.

Two CLI-surface decisions landed alongside these, because they gate the same transport:

- **One transport only.** `--stdio` and `--http` together is rejected rather than silently choosing
  HTTP.
- **`--http-port` is validated at parse time** (`parsePort`), so `Number("abc") → NaN` fails loudly
  instead of reaching `listen()` with a bad port.
- **Empty-allowlist warning.** Because the HTTP bearer token is shared, `--http` logs a warning for
  every repository whose `allowedPrincipals` is empty (that repository is queryable by any
  authenticated client) — see ADR-0009's per-repository authorization.

### Consequences

- Good, because none of these bounds require new configuration — every deployment gets them with
  sane defaults, and `maxSessions`/`idleTimeoutMs` remain overridable
- Good, because each guard is independent: the cap, the idle sweep, and the close-on-failed-init
  path each close a different leak/growth vector
- Good, because bind failures and handler rejections now share the process's normal reporting/exit
  path instead of terminating it abruptly
- Bad, because a legitimate but genuinely idle session is closed after the timeout and must
  re-initialize — acceptable, since MCP clients re-handshake transparently
- Neutral, because the cap and idle timeout are process-local; a multi-instance HTTP deployment
  would size them per instance

## Pros and Cons of the Options

### Leave it to SDK defaults and the OS

- Good, because it is no additional code
- Bad, because non-`initialize` POSTs and never-expired sessions leak for the life of the process
- Bad, because an async bind error or a rejected handler crashes the whole server
- Bad, because long-lived SSE streams can block a clean shutdown indefinitely

### Explicit lifecycle bounds

- Good, because every create path has a matching close path and every unbounded set has a cap
- Good, because failures surface through the CLI's normal exit handling
- Bad, because it is more moving parts (a sweeper, a `registered` flag, an `onError` hop) to
  maintain and test

## More Information

- Builds on ADR-0009 (semantic MCP tool surface) and its per-repository authorization model.
- Related code: `packages/server/src/http/server.ts`, `packages/server/src/cli.ts`.
