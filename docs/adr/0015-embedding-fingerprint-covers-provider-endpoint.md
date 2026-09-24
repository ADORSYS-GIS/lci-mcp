# ADR-0015: Embedding staleness fingerprint covers the provider endpoint

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** @sinke237

## Context and Problem Statement

`lci_index` stores an embedding "fingerprint" with each generation and `lci_index_status` compares
the live fingerprint against the stored one to decide whether an index is stale — the whole point is
to catch a change in how vectors were produced, so that `lci_search` never silently compares query
vectors from one embedding source against stored vectors from another. The fingerprint was
`${model}:${dimensions}`. But an operator repointing `embedding.baseUrl` to a different
OpenAI-compatible provider — while leaving `model`/`dimensions` unchanged, which is common since many
gateways accept an arbitrary caller-supplied `model` string — produced a byte-identical fingerprint.
The staleness check had a blind spot on the most common way the embedding source actually changes.
What must the fingerprint cover to make "the embedding source changed" reliably detectable?

## Decision Drivers

- The fingerprint must change whenever any input that affects the produced vectors changes —
  including the provider endpoint, not just the model name and dimensions
- It is only ever compared for equality; it is never parsed back into fields
- It should not embed a raw endpoint URL (or any accidental userinfo) as a plainly readable stored
  value, and it must not be ambiguous if a value contains the previous `:` delimiter
- The existing behaviors must be preserved: structural-only workers have no fingerprint, and an old
  generation with no stored fingerprint is stale the moment embeddings are configured

## Considered Options

- Append `baseUrl` to the existing colon-delimited string: `${model}:${dimensions}:${baseUrl}`
- Hash a structured tuple of all embedding-affecting fields into a single opaque token
- Leave `baseUrl` out and document the limitation

## Decision Outcome

Chosen option: **hash a structured tuple**. `embeddingFingerprintFor`
(`packages/server/src/mcp/context.ts`) now returns
`sha256(JSON.stringify({ baseUrl, model, dimensions }))` as hex when the worker has an embedding
client, and `undefined` when it does not. Hashing a JSON tuple avoids the delimiter-collision risk
of concatenation (a URL contains its own `:` and `//`), keeps the stored value bounded, and does not
persist a readable endpoint URL. The `undefined`-for-structural-only and `None ≠ Some` migration
behaviors are unchanged, so a structural-only generation is still correctly flagged stale once
embeddings are turned on. The function stays the single shared source for both the value stored at
`beginIndex` and the value compared at status time, so the two cannot drift.

### Consequences

- Good, because a provider swap with an unchanged model/dimensions is now detected as stale, closing
  the blind spot the check exists to cover
- Good, because equality comparison is unaffected by delimiters inside any field, and no raw URL is
  written into the stored fingerprint
- Bad, because the fingerprint format changed, so every generation committed before this change
  compares unequal once and is flagged stale, prompting a one-time reindex — the expected, correct
  outcome of any fingerprint-format change
- Neutral, because adding a future embedding-affecting field means extending the hashed tuple, not
  reworking any comparison logic

## Pros and Cons of the Options

### Append `baseUrl` to the delimited string

- Good, because it is the smallest change and stays human-readable
- Bad, because a URL's own `:`/`//` can, in principle, align with the field delimiter, and the raw
  endpoint is stored verbatim

### Hash a structured tuple

- Good, because it is delimiter-safe, bounded, and opaque
- Bad, because the fingerprint is no longer human-readable for debugging (mitigated: raw config is
  still logged elsewhere)

### Leave `baseUrl` out

- Good, because no reindex is triggered
- Bad, because it leaves the exact blind spot — a changed provider read as "not stale" — that makes
  `lci_search` compare mismatched vector spaces with no signal

## More Information

- Related code: `packages/server/src/mcp/context.ts`, `packages/server/src/mcp/tools/indexTool.ts`,
  `packages/server/src/mcp/tools/indexStatus.ts`; the Rust-side `fingerprint_stale_reasons` in
  `index_coordinator.rs`.
- Builds on ADR-0004 (generation-based indexing) and ADR-0003 (embedding HTTP stays in TypeScript).
