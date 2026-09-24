# ADR-0018: lci-mcp stays local-first — network, auth, and provisioning move to the consumer

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** @sinke237
- **Supersedes:** ADR-0014 (HTTP MCP transport). Trims the provisioning half of ADR-0016.

## Context and Problem Statement

`lci-mcp`'s stated identity (README) is a strictly local-first tool: *"there is no network
listener, no server to deploy, and no daemon left running after the host exits,"* and *"the only
outbound network call the tool ever makes is to an optional embeddings endpoint."* A set of
server/multi-tenant features had grown into the server package that directly contradict that
identity — an authenticated HTTP MCP listener, per-principal authorization/allowlists, and
repository provisioning that clones from remote Git hosts at boot (a second outbound network
surface). The company chatbot that consumes `lci-mcp` already *is* the authenticated, networked,
multi-user layer (its own API, sessions, auth, and orchestrator). Where should the network, auth,
and remote-provisioning responsibilities live?

## Decision Drivers

- `lci-mcp` must match its documented contract: a local subprocess over stdio, no network listener,
  no daemon, and exactly one optional outbound call (embeddings)
- Multi-tenant authorization and a shared bearer token are a poor fit for a single-user local tool;
  the consumer already authenticates users and authorizes repository scope
- Cloning from remote Git hosts at boot is a networked, credential-bearing concern that belongs to
  whoever operates the deployment, not to a local index tool
- The consumer (chatbot) already launches `lci-mcp` over stdio, so no capability is actually lost

## Considered Options

- Keep the HTTP transport, authorization, and provisioning in `lci-mcp` and treat local-first as
  one mode among several
- Remove them from `lci-mcp` and let the consumer own network exposure, authentication, and any
  repository provisioning, connecting to `lci-mcp` over stdio only

## Decision Outcome

Chosen option: **remove them from `lci-mcp`**. The following were deleted from
`packages/server`:

1. **HTTP transport** — `src/http/server.ts` and the `--http` CLI path (bearer token, sessions,
   `X-LCI-Principal`, idle/capacity policy, `closeAllConnections`, bind-error exit). The CLI now
   serves over `--stdio` only.
2. **Per-principal authorization** — `src/catalog/authorization.ts`, the `allowedPrincipals` field
   on manifest and catalog records, the `principal` plumbed through `AppContext`, the worker
   registry, and `lci_repositories`. A single trusted local user needs no allowlist.
3. **Repository provisioning** — `src/catalog/provisioning.ts` (`RepositoryProvisioner`,
   `GitCliCheckoutAdapter`), the `provisioning` config block, the `provisioning` lifecycle state,
   and boot-time checkout cloning/recovery. Manifests supply local `checkoutPath`s; there is no
   remote clone. The lone remaining outbound call is the optional embeddings endpoint.

What stays: the multi-repository catalog and worker registry (a developer may index several local
checkouts), the semantic tool surface (ADR-0009), generation-based indexing (ADR-0004), and the
optional embedding endpoint with its external auth helper (ADR-0003, ADR-0006).

On the consumer side, the chatbot connects to `lci-mcp` over stdio only; its own authenticated API
remains the network and authorization boundary (see the chatbot's `integration-contract.md`).

### Consequences

- Good, because `lci-mcp` once again matches its README: no listener, no daemon, one optional
  outbound call
- Good, because authorization and network exposure live in one place — the consumer — instead of
  being split across two trust models
- Good, because the attack surface shrinks (no inbound listener, no boot-time git clone)
- Bad, because a deployment that wanted `lci-mcp` reachable directly over the network must now front
  it with its own authenticated service — which is exactly the chatbot's role
- Neutral, because the catalog record schema drops `allowedPrincipals` and the `provisioning`
  lifecycle; non-strict record parsing simply ignores those keys in any pre-existing catalog file

## Pros and Cons of the Options

### Keep HTTP/auth/provisioning as optional modes

- Good, because a networked deployment needs no external fronting service
- Bad, because it permanently contradicts the tool's stated local-first identity and doubles its
  trust surface (inbound auth, remote git credentials) inside a tool meant to be a local subprocess

### Remove them; consumer owns network/auth/provisioning

- Good, because each concern lives where it is already implemented and tested (the chatbot)
- Good, because `lci-mcp` stays small, auditable, and true to its contract
- Bad, because it is a breaking change for anyone who adopted the short-lived HTTP transport

## More Information

- Supersedes ADR-0014; trims the provisioning-recovery decision from ADR-0016 (the worker-resolution
  and shutdown-race parts of 0016 still stand).
- Related: ADR-0009 (semantic tool surface), ADR-0003 (embedding HTTP stays in TypeScript),
  ADR-0006 (external auth helper), and the chatbot `docs/integration-contract.md`.
