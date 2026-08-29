# ADR-0009: Expose a small semantic tool surface, not raw query access

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** leghadjeu-christian

## Context and Problem Statement

The MCP layer needs to expose retrieval capability to a coding agent. Should it expose the
underlying storage engine's query capability directly (arbitrary SQL, or a graph-query language), or
a small set of purpose-built tools?

## Decision Drivers

- The storage engine (SQLite + a vector extension) is an implementation detail that should be free
  to change without breaking every MCP host integration
- Arbitrary query access is a meaningfully larger attack surface and a much harder contract to keep
  stable
- A model calling tools benefits from a small, well-described surface more than from generality
- Every traversal must be boundedly sized regardless of what a client requests

## Considered Options

- Expose raw SQL (or a subset of it) as a tool
- Expose a graph-query language (e.g. a Cypher-like subset) as a tool
- Expose a small, fixed set of purpose-built tools: index, index status, semantic search, find
  symbol, get callers, get callees, explore symbol

## Decision Outcome

Chosen option: **a small, purpose-built tool surface**. Every tool has a typed input schema and a
typed, bounded result shape; none of them accept a query string in any query language. Traversal
depth and result counts are clamped server-side regardless of what a client requests.

### Consequences

- Good, because the storage engine can change (a different vector extension, a schema migration)
  without changing the tool contract a host integration depends on
- Good, because every tool's input/output shape is small enough for a model to use correctly without
  extensive prompting
- Bad, because a genuinely novel query shape a user wants is not expressible without adding a new
  tool
- Neutral, because this mirrors the same posture a hosted, multi-tenant version of this kind of
  system would need for safety reasons, even though a local single-user tool has a smaller blast
  radius on its own

## Pros and Cons of the Options

### Raw SQL

- Good, because it is maximally flexible
- Bad, because it exposes the storage schema as a permanent public contract, and needs careful
  sandboxing to stay safe against pathological queries

### Graph-query language

- Good, because it is more expressive than a fixed tool set for genuinely graph-shaped questions
- Bad, because it still exposes internal schema/relation names as a public contract, and a full
  query language is a much larger thing to specify, implement, and keep safe than a handful of typed
  tools

### Small, purpose-built tool set

- Good, because the contract is small, typed, and stable independent of storage internals
- Bad, because it cannot answer a query shape nobody anticipated without a code change

## More Information

None.
