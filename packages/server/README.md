# @vymalo/lightbridge-code-intelligence-mcp

A local-first [Model Context Protocol](https://modelcontextprotocol.io) server that gives coding
agents repository-aware semantic and structural code retrieval. Index a checkout once, then ask it
to find a symbol, walk callers and callees, explore a symbol's neighborhood, or search code by
meaning.

Everything runs in one local process launched over stdio by the MCP host. There is no server to
deploy, no daemon left running, and no database to install — the index is a single SQLite file in
your user data directory. The only outbound network call the tool ever makes is to an optional
embeddings endpoint, and only when semantic search needs one.

## Install

```bash
npm install -g @vymalo/lightbridge-code-intelligence-mcp
```

Requires Node.js 24 or newer. The Rust engine ships as a prebuilt native addon in
[`@vymalo/lightbridge-code-intelligence-native`](https://www.npmjs.com/package/@vymalo/lightbridge-code-intelligence-native),
installed automatically. Prebuilt binaries currently cover **Linux x64 (glibc)** and
**Linux arm64 (glibc)**.

## Connect it to an MCP host

Point your host at the binary with `--stdio` and the repository to index:

```json
{
  "mcpServers": {
    "lci": {
      "command": "lightbridge-code-intelligence-mcp",
      "args": ["--stdio", "--root", "/path/to/your/repo"]
    }
  }
}
```

Then call `lci_index` once. Structural queries work as soon as it returns.

## Tools

| Tool | What it does |
| --- | --- |
| `lci_index` | Indexes or reindexes the repository. Returns once structural extraction completes; embeddings, if configured, keep building in the background. Never destroys the previously active index on failure. |
| `lci_index_status` | Index lifecycle, freshness and statistics — state, whether it is usable, indexed vs current HEAD, and file/chunk/node/edge counts. |
| `lci_find_symbol` | Finds structural symbols by name, label or path substring, case-insensitively. |
| `lci_get_callers` | Direct callers of a node id — reverse call-graph edges. |
| `lci_get_callees` | Direct callees of a node id — forward call-graph edges. |
| `lci_explore_symbol` | A symbol's immediate neighborhood: nearby nodes and the call edges among them, out to a given caller/callee depth. |
| `lci_search` | Semantic search over the index. Returns ranked chunks with source locations and node ids for follow-up structural exploration. Requires an embeddings endpoint. |

`lci_find_symbol` is the usual entry point: it returns node ids that the three graph tools take.

## Configuration

Semantic search needs an OpenAI-compatible embeddings endpoint. Without one the other six tools work
normally and `lci_search` reports that it is unavailable.

```bash
lightbridge-code-intelligence-mcp --stdio \
  --root /path/to/repo \
  --embedding-base-url https://your-endpoint/v1 \
  --embedding-model text-embedding-3-small
```

Or in `~/.config/lci/config.json`:

```json
{
  "embedding": {
    "baseUrl": "https://your-endpoint/v1",
    "model": "text-embedding-3-small",
    "dimensions": 1536,
    "auth": { "apiKey": "..." }
  }
}
```

Rather than storing a key, `embedding.auth.helper` can name a command that prints headers on stdout,
which is re-run when the endpoint rejects the cached credentials.

Sources are merged lowest to highest precedence:

```
built-in defaults → ~/.config/lci/config.json → --config → LCI_CONFIG_CONTENT → --config-json → CLI flags
```

`lightbridge-code-intelligence-mcp config show` prints the resolved configuration with credentials
redacted, along with the repository identity and the database path it will use.

### Options

| Flag | Meaning |
| --- | --- |
| `--stdio` | Start the MCP server on stdio (required to actually serve) |
| `--root <path>` | Repository root to index (default: current directory) |
| `--config <path>` | Load a JSON config file |
| `--config-json <json>` | Inline JSON config, merged over `--config` |
| `--log-level <level>` | `error`, `warn`, `info`, `debug`, `trace` (default: `info`) |
| `--embedding-base-url <url>` | OpenAI-compatible embeddings endpoint; unset disables embeddings |
| `--embedding-model <name>` | Embedding model name |
| `--embedding-dimensions <n>` | Expected embedding vector size |
| `--database <path>` | Override the SQLite database path |

## Where the index lives

By default `{{dataDir}}/lci-mcp/{{repoKey}}/index.sqlite` — your platform data directory, keyed by a
hash of the repository, so several checkouts never collide. `--database` overrides it.

The server refuses to index a root that resolves to a home directory or a filesystem root; pass
`--root` at a specific repository instead.

## Links

- [Repository](https://github.com/ADORSYS-GIS/lci-mcp)
- [Architecture](https://github.com/ADORSYS-GIS/lci-mcp/blob/main/docs/ARC42.md) and
  [decision records](https://github.com/ADORSYS-GIS/lci-mcp/tree/main/docs/adr)
- [Issues](https://github.com/ADORSYS-GIS/lci-mcp/issues)
