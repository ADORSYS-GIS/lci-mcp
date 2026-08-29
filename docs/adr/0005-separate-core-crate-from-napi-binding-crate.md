# ADR-0005: Separate the pure-Rust core crate from the napi binding crate

- **Status:** Accepted — Implemented
- **Date:** 2026-08-28
- **Deciders:** @leghadjeu-christian
- **Supersedes:** the original single-crate layout assumed by ADR-0001

## Context and Problem Statement

The native engine was originally built as one crate: a `#[napi]`-decorated `CodeIndex` class sitting
directly on top of the repository inspection, SQLite storage, and graph/vector query modules. Adding
integration tests against real-world source, run through ordinary `cargo test`, exposed a problem:
the test binary failed to link, with dozens of undefined N-API C symbols
(`napi_create_array_with_length`, `napi_typeof`, and others). Restricting the business-logic modules
to `pub(crate)` visibility did not help. Why does a crate with a napi binding become untestable with
a plain `cargo test`, and what actually fixes it?

## Decision Drivers

- The extraction, storage, and query logic needs to be verifiable by a normal `cargo test`, without
  requiring an actual Node process to run
- Real-world integration tests (indexing genuine Rust and Java projects and asserting against a
  known-correct structural graph) are only valuable if they can run in ordinary CI, not just as a
  manual smoke test
- The napi binding boundary itself should stay as small as possible, since it is the one part of the
  crate that cannot be tested without a Node host

## Considered Options

- Keep one crate; restrict business-logic modules to `pub(crate)` so tests, in theory, only touch
  non-napi code
- Split into two crates: a plain Rust crate with all the logic, and a thin napi-wrapper crate that
  depends on it and does nothing but convert types and call through

## Decision Outcome

Chosen option: **split into two crates**. A crate with any `#[napi]`-decorated item emits an
unconditional module-registration hook at compile time that references real N-API C symbols — those
symbols only resolve when the compiled library is loaded by an actual Node process. This poisons the
*entire* compiled crate for linking purposes, regardless of which specific items a test actually
calls or how those items are scoped; module-privacy changes cannot fix it because the registration
hook is emitted once per crate, not once per item. Moving every line of actual logic into a crate
with zero napi dependency, and reducing the napi crate to type conversion plus `spawn_blocking`
plumbing, resolves this cleanly: the core crate compiles and links as an ordinary Rust library, and
the napi crate's own surface is small enough that it needs no dedicated test suite of its own beyond
what already exercises it indirectly.

### Consequences

- Good, because real-world integration tests run with a plain `cargo test`, no Node runtime involved
- Good, because the napi boundary crate is now small enough to read in full, with its only
  responsibility being DTO conversion and off-loading blocking work
- Bad, because every data type that crosses the boundary now exists twice — once as a plain type in
  the core crate, once as a `#[napi(object)]` mirror with a `From` conversion — a mechanical but real
  maintenance cost when a field is added or renamed
- Neutral, because this is the same shape other native-addon projects converge on for the same
  reason; it was discovered here rather than planned upfront

## Pros and Cons of the Options

### One crate, `pub(crate)` visibility

- Good, because it avoids the double-type-definition cost at the boundary
- Bad, because it does not actually solve the linking problem — the module-registration hook is
  crate-wide, not item-scoped, so this option was tried and confirmed not to work

### Two crates (core + napi wrapper)

- Good, because it fixes the linking problem completely, not partially
- Good, because it draws a clean, enforced line between "logic" and "N-API glue" that a reviewer can
  see just by which crate a change touches
- Bad, because every boundary-crossing type needs a mirror definition and a conversion

## More Information

See ADR-0001 for why napi-rs was chosen in the first place.
