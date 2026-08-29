# ADR-0001: Use napi-rs for the Node/Rust boundary

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** leghadjeu-christian

## Context and Problem Statement

The indexing engine (repository walking, structural extraction, SQLite persistence, graph and
vector queries) needs to run as native code for acceptable performance, while the MCP protocol
layer, configuration, and embedding HTTP calls are most naturally written in TypeScript. How should
the two sides talk to each other inside one distributable package?

## Decision Drivers

- Single-process developer experience — no sidecar process to manage or keep alive
- Reuse of an existing, mature Rust extraction toolchain
- Distributable through ordinary `npm install`, without requiring a Rust toolchain on the
  end user's machine
- Native work must not block the Node.js event loop

## Considered Options

- A subprocess speaking a custom protocol (e.g. line-delimited JSON over stdio) between a Node
  process and a separately-built Rust binary
- A native Node addon built with napi-rs
- A WebAssembly build of the Rust engine, loaded in-process

## Decision Outcome

Chosen option: **napi-rs native addon**, because it gives a genuinely single-process experience
with typed, async bindings, avoids designing and versioning a subprocess protocol, and its
platform-package distribution model (prebuilt binaries selected via `optionalDependencies`) means
end users never need a Rust toolchain.

### Consequences

- Good, because native extraction and storage code runs at full speed with no IPC overhead
- Good, because every async method is a real `Promise` from the Node side; no polling or manual
  framing is needed
- Bad, because the release pipeline must build and publish one binary per target platform
- Neutral, because any code that uses `#[napi]` must ship inside a `.node` file loaded by an
  actual Node process — this shaped how the crate itself is structured (see ADR-0005)

## Pros and Cons of the Options

### Subprocess + custom protocol

- Good, because the two sides are fully decoupled and independently testable
- Bad, because it means designing, versioning, and hardening a bespoke wire protocol
- Bad, because it adds process-lifecycle management (spawn, health-check, restart) that a single
  addon doesn't need

### napi-rs native addon

- Good, because it is a single process with typed bindings generated straight from Rust
- Good, because platform binaries are ordinary npm `optionalDependencies`
- Bad, because native code must be built per target platform/architecture

### WebAssembly

- Good, because one build artifact runs everywhere, no per-platform binaries
- Bad, because SQLite with a loadable vector-search extension is a poor fit for the WASI
  filesystem/threading model available at the time this decision was made
- Bad, because giving up native filesystem and git access would require reworking large parts of
  the extraction and repository-inspection logic

## More Information

See ADR-0002 (local persistence) and ADR-0005 (splitting the native code into a core crate and a
thin napi wrapper crate).
