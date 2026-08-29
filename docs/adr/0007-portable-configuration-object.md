# ADR-0007: One portable configuration object, multiple sources

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** leghadjeu-christian

## Context and Problem Statement

The tool is launched in several different contexts: directly from a terminal, from an MCP host's own
configuration (which typically injects environment variables rather than writing files), and
potentially from an organization-provided well-known configuration. Should each context have its own
configuration semantics, or should there be a single configuration model usable from all of them?

## Decision Drivers

- Configuration delivered through an MCP host's environment must behave identically to the same
  configuration loaded from a file — a host integrator should not need to think about which path
  they're on
- Precedence between sources needs to be well-defined and testable, not implicit
- Secret-bearing values should have a path that avoids landing directly in shell history or process
  listings where avoidable

## Considered Options

- Separate configuration formats/parsers per source (CLI flags, a config file format, an environment
  variable convention)
- One configuration schema, fed from an ordered list of sources that deep-merge into a single result

## Decision Outcome

Chosen option: **one schema, ordered sources**. A single schema is the source of truth; built-in
defaults, a discovered global config file, an explicit `--config` file, an `LCI_CONFIG_CONTENT`
environment variable, an inline `--config-json` flag, and individual CLI flags are merged in that
order, later sources overriding earlier ones. Objects deep-merge; arrays replace wholesale rather
than concatenating, since silent array-merge ambiguity is a common source of configuration surprises.

### Consequences

- Good, because a host's environment-variable-based configuration and a human's file-based
  configuration are provably equivalent, not just conventionally similar
- Good, because the precedence chain is a plain ordered list, straightforward to unit test in
  isolation from where each layer's raw value came from
- Bad, because a configuration typo in a nested key currently only surfaces at schema-validation
  time, not sooner
- Neutral, because array-replace-not-merge means a user who wants to *add* to a default array (say,
  an ignore-glob list) must repeat the defaults themselves — an explicit trade-off, not an oversight

## Pros and Cons of the Options

### Separate formats per source

- Good, because each source could be optimized for its own ergonomics
- Bad, because "does this behave the same from an environment variable as from a file" becomes a
  question instead of a guarantee

### One schema, ordered sources

- Good, because there is exactly one configuration semantics to document, test, and reason about
- Bad, because every source must still be coerced into the same shape before merging, which is
  slightly more upfront design work than accepting each source's native shape

## More Information

See ADR-0008 for how storage paths within this configuration are templated.
