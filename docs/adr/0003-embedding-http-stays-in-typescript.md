# ADR-0003: Embedding HTTP and authentication stay in TypeScript

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** project maintainers

## Context and Problem Statement

Turning an extracted chunk into a stored vector requires an outbound HTTP call to an
OpenAI-compatible embeddings endpoint, plus whatever authentication an organization's provider
requires (a static key, or a helper process producing headers). Should that network call live in
the native extraction engine, or in the TypeScript layer that also owns configuration and process
lifecycle?

## Decision Drivers

- Enterprise authentication needs (helper processes, header injection, retry-after-refresh) belong
  close to configuration and process management, not inside a storage/extraction engine
- A native addon making outbound HTTP calls means every platform binary carries a TLS stack and
  needs its own security review surface
- Retry, backoff, and provider-compatibility quirks change faster than extraction logic and
  shouldn't force a native rebuild

## Considered Options

- Perform embedding HTTP calls from native code, passing resolved credentials in
- Perform embedding HTTP calls from TypeScript; native code only prepares batches of `(id, text)`
  and accepts `(id, vector)` results back

## Decision Outcome

Chosen option: **embedding HTTP stays in TypeScript**. Native code's job ends at handing out
`{id, text}` batches for chunks that still need a vector, and accepting `{id, vector}` results back
into storage. The TypeScript layer owns the actual request: batching, retries, backoff, response
reordering by the provider's own index, and credential resolution (static key or an external helper
process).

### Consequences

- Good, because enterprise authentication (an external helper process returning headers) is a
  TypeScript-side concern with no native rebuild required to support a new provider
- Good, because native binaries carry no HTTP/TLS dependency for this path
- Bad, because it means the engine's own extraction step does not enrich embedding input with
  additional cross-file context before handing batches out — that enrichment, if added later, has
  to happen without making the extraction step itself perform network I/O
- Neutral, because this places a firm interface (batch out, vectors in) between two otherwise
  loosely coupled halves of the system, which is a constraint future contributors need to keep in
  mind rather than reach around

## Pros and Cons of the Options

### Embedding HTTP in native code

- Good, because it could reuse extraction-time context directly, in-process
- Bad, because it pulls a full HTTP/TLS/retry stack, and eventually an auth-helper subprocess
  launcher, into every platform binary
- Bad, because supporting a new provider quirk or auth scheme would require a native rebuild and a
  new release across every platform target

### Embedding HTTP in TypeScript

- Good, because the request/retry/auth logic lives next to configuration, where it can change
  without touching native code
- Good, because it keeps native binaries free of a TLS dependency for this path
- Bad, because it introduces a real seam (batch handoff) that both sides must keep in sync

## More Information

None.
