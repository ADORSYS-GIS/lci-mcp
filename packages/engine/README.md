# @vymalo/lightbridge-code-intelligence-native

The native code-intelligence engine behind
[`@vymalo/lightbridge-code-intelligence-mcp`](https://www.npmjs.com/package/@vymalo/lightbridge-code-intelligence-mcp)
— a Rust N-API addon doing tree-sitter parsing, SQLite and sqlite-vec storage, and the graph and
vector queries the MCP tools are built on.

**You probably want the MCP server instead.** Install
`@vymalo/lightbridge-code-intelligence-mcp`; it depends on this package and exposes the
functionality as MCP tools. This package is published on its own so that the compiled engine can be
versioned and fetched independently, not because it is meant to be used directly.

## Platforms

Prebuilt binaries ship inside this package, so installing it needs no Rust toolchain and no compile
step:

| Target | Binary |
| --- | --- |
| Linux x64 (glibc) | `lci-mcp-engine.linux-x64-gnu.node` |
| Linux arm64 (glibc) | `lci-mcp-engine.linux-arm64-gnu.node` |

macOS and Windows are not built yet — see
[#14](https://github.com/ADORSYS-GIS/lci-mcp/issues/14) and
[#20](https://github.com/ADORSYS-GIS/lci-mcp/pull/20). On any other platform the loader raises an
explicit "binding not found" error rather than failing obscurely.

Requires Node.js 24 or newer.

## API

```js
import { CodeIndex, repositoryIdentity } from "@vymalo/lightbridge-code-intelligence-native";

const index = await CodeIndex.open({ repository: "/path/to/repo", database: "/path/to/index.sqlite" });
const handle = await index.beginIndex({});
await index.commitIndex(handle.generationId);

console.log(await index.status());
console.log(await index.findSymbol({ term: "parse", limit: 20 }));
```

`CodeIndex` owns the SQLite connection and every read and write against it; indexing is generational,
so a failed run never destroys the index that was already active. Full type definitions are in
`index.d.ts`.

## Links

- [Repository](https://github.com/ADORSYS-GIS/lci-mcp)
- [Architecture](https://github.com/ADORSYS-GIS/lci-mcp/blob/main/docs/ARC42.md) and
  [decision records](https://github.com/ADORSYS-GIS/lci-mcp/tree/main/docs/adr)
- [Issues](https://github.com/ADORSYS-GIS/lci-mcp/issues)
- [MIT License](https://github.com/ADORSYS-GIS/lci-mcp/blob/main/LICENSE)
