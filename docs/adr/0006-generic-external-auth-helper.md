# ADR-0006: Generic external auth helper for embedding credentials

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** project maintainers

## Context and Problem Statement

Organizations authenticate to their embedding provider in many different, often internal ways: a
static API key, a short-lived token from an internal broker, a cloud CLI's own credential chain, or
a bespoke OAuth flow. Implementing every one of these inside the tool is neither realistic nor
desirable. How should the tool support enterprise authentication without becoming an identity
client for every possible provider?

## Decision Drivers

- Cannot realistically implement every enterprise identity system directly
- Must not require a shell to be invoked implicitly, for security reasons
- Credentials (and the process that produces them) must never be logged
- Refresh behavior needs to be boundedly retryable, not an infinite loop on persistent failure

## Considered Options

- Implement a fixed set of built-in auth methods (e.g. OAuth2 client-credentials, a specific cloud
  provider's token exchange)
- Support a single static API key only
- Support an external helper: a configured command, executed without shell expansion, expected to
  print a small JSON document of HTTP headers to stdout

## Decision Outcome

Chosen option: **external auth helper**. The tool executes a configured command (argv array, no
implicit shell), captures and bounds its stdout, and parses either a bare header map or an extended
`{headers, expiresAt}` shape. This is a generic escape hatch: it covers a static key, a cloud CLI, an
internal broker, or a custom script, without the tool needing to understand any of their specifics.
A 401/403 from the provider invalidates the cached headers and triggers exactly one bounded refresh
retry.

### Consequences

- Good, because organizations can plug in whatever credential-acquisition mechanism they already
  have, without waiting on a feature request
- Good, because the tool's own attack surface for authentication stays small — it parses JSON and
  runs one configured command, nothing more
- Bad, because a broken or slow helper script is now part of every embedding request's critical
  path, bounded by a timeout that must be tuned per environment
- Neutral, because a static API key is still supported directly for the common case where a helper
  is unnecessary overhead

## Pros and Cons of the Options

### Fixed set of built-in auth methods

- Good, because zero external process is needed for supported methods
- Bad, because it can never cover every organization's actual credential system, and each new one
  requires a code change and release

### Static API key only

- Good, because it is the simplest possible option
- Bad, because it cannot express short-lived, rotating, or dynamically-issued credentials at all

### External auth helper

- Good, because it covers arbitrary credential-acquisition mechanisms through one interface
- Good, because it keeps credential logic out of the tool's own codebase and update cycle
- Bad, because helper execution failure modes (timeout, malformed output, non-zero exit) all need to
  be handled as first-class, actionable errors

## More Information

None.
