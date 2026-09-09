# ADR-0013: Publish via npm's OIDC trusted publishing, not a long-lived token

- **Status:** Proposed
- **Date:** 2026-09-09
- **Deciders:** @leghadjeu-christian
- **Supersedes:** ADR-0011's "Neutral" note that publishing needs an `NPM_TOKEN` secret

## Context and Problem Statement

The release workflow published every package with `pnpm publish -r`, authenticated by an `NPM_TOKEN`
secret — a long-lived credential that, if ever leaked, grants publish rights indefinitely. npm's
OIDC-based "trusted publishing" removes that credential entirely: GitHub Actions issues a short-lived
identity token scoped to one specific workflow file, and npm exchanges it for a one-time publish
credential, provided the package's registry settings name that exact workflow as trusted. How does
this repository adopt that without a long-lived secret, given its release workflow runs on a
self-hosted runner?

## Decision Drivers

- No long-lived npm credential should exist in the repository or its secrets once this lands
- npm's own documentation is explicit that OIDC trusted publishing does not support self-hosted
  runners as of this writing — confirmed directly against `docs.npmjs.com/trusted-publishers`, not
  assumed
- `pnpm publish` does not implement the OIDC exchange itself — only the `npm` CLI (11.5.1+) does;
  `workspace:*` still needs resolving to a real version before publishing, which plain `npm publish`
  cannot do on its own

## Considered Options

- Keep `NPM_TOKEN`, do nothing
- Run the entire release (build + publish) on a GitHub-hosted runner, abandoning the self-hosted one
- Split the release into two jobs: the existing self-hosted job builds every target and packs each
  package into a tarball; a new, minimal GitHub-hosted job downloads those tarballs and publishes them
  via OIDC

## Decision Outcome

Chosen option: **split the release into a self-hosted build job and a GitHub-hosted publish job**.
The self-hosted `build` job is unchanged except for its last step: instead of publishing, it packs
every package — `pnpm pack` for the two workspace packages (`packages/server`,
`packages/engine`, since only `pnpm pack` resolves their `workspace:*` dependency to a real version)
and plain `npm pack` for the five per-platform stub packages under `packages/engine/npm/*/` (they
carry no internal dependencies, so no resolution step is needed) — and uploads the resulting
tarballs as a build artifact. A new `publish` job, `runs-on: ubuntu-latest`, downloads that artifact
and runs `npm publish <tarball> --access public` for each one, in dependency order (platform
packages, then the native package that optionally depends on them, then the server package that
depends on that). Its only permission beyond the default is `id-token: write` — no `NPM_TOKEN`
anywhere in this job, or in the workflow at all once this lands. `napi pre-publish` also gains
`--skip-optional-publish`, since it otherwise tries to publish the platform packages itself using
whatever npm auth is present in the (self-hosted) job it runs in — publishing now happens
exclusively in the `publish` job.

This whole pipeline was verified locally end to end before being trusted: `napi pre-publish
--skip-optional-publish` confirmed to make no network call while still wiring `optionalDependencies`
correctly, and the pack step confirmed to produce a `workspace:*`-resolved `package.json` inside
both the native and server tarballs. The one thing that cannot be verified outside a real tag push is
the OIDC token exchange itself — GitHub only issues that token to an actual Actions run.

### Consequences

- Good, because no long-lived npm credential exists anywhere in this repository once this lands
- Good, because the expensive part (cross-compiling five native targets) still runs on the
  self-hosted runner — the GitHub-hosted job only downloads pre-built tarballs and calls `npm
  publish`, minimizing GitHub-hosted usage to what OIDC strictly requires
- Bad, because this reintroduces GitHub-hosted runner usage for a project that otherwise avoids it
  entirely — a deliberate, narrow exception made for this one job, not a reversal of that constraint
  elsewhere
- Neutral, because each of the seven published packages (the two workspace packages plus five
  platform variants) needs its own Trusted Publisher configuration entered manually on npmjs.com —
  org `ADORSYS-GIS`, repo `lci-mcp`, workflow filename `publish.yml` (exactly, no path prefix) — this
  is npmjs.com's own required format, not something this repository controls

## Pros and Cons of the Options

### Keep `NPM_TOKEN`

- Good, because it needs no workflow changes and works today
- Bad, because a long-lived, unscoped publish credential sits in repository secrets indefinitely

### Move the whole release to a GitHub-hosted runner

- Good, because it's the simplest possible OIDC setup — one job, no artifact hand-off
- Bad, because GitHub-hosted minutes are billing-blocked for this org; the expensive cross-compile
  steps cannot move there

### Split build (self-hosted) and publish (GitHub-hosted)

- Good, because it satisfies OIDC's runner requirement while keeping the expensive work self-hosted
- Bad, because it adds an artifact hand-off and a second job to reason about

## More Information

See ADR-0011 for the multi-platform build pipeline this extends, and
[docs.npmjs.com/trusted-publishers](https://docs.npmjs.com/trusted-publishers) for npm's own
requirements this decision is constrained by.
