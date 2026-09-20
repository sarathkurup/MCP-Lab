# MCP Workbench

A development environment for Model Context Protocol servers, inside VS Code.

This repository is at **Phase 0 + Phase 1** of the roadmap: the foundation and a
working connection engine. Everything else (explorer, execution, tests, doctor,
workflows) builds on the core established here.

## Architecture

The one rule that shapes everything: **`src/core/` never imports `vscode`.**

```
            ┌──────────────────────────┐
            │  src/vscode/  (UI layer) │  tree view, commands, secrets, output
            └────────────┬─────────────┘
                         │ observes
            ┌────────────▼─────────────┐
            │  src/core/   (engine)    │  no vscode import, no UI assumptions
            └────────────┬─────────────┘
                         │
      ┌──────────────────┼──────────────────┐
      ▼                  ▼                  ▼
  Transport          McpClient        ConnectionManager
  (stdio, http)      (JSON-RPC,       (many servers,
                      handshake,       status, catalog)
                      primitives)
```

The core is exercised by tests that spawn real MCP servers — no VS Code in the
loop. That same engine can later drive a CLI, a CI runner, or Workbench-as-an-
MCP-server without being rewritten.

| Path | What lives there |
| --- | --- |
| `src/core/protocol.ts` | JSON-RPC envelopes + the MCP schema subset |
| `src/core/transport/` | `Transport` interface, stdio, streamable HTTP |
| `src/core/McpClient.ts` | Request correlation, `initialize`, primitives, pagination |
| `src/core/McpConnection.ts` | One server: status, catalog, lifecycle |
| `src/core/ConnectionManager.ts` | The set of servers |
| `src/core/trace.ts` | Every raw frame, both directions, with round-trip times |
| `src/core/logging.ts` | Workbench, stderr and server-side log lines |
| `src/vscode/` | Tree view, commands, `SecretStorage`, output channels |
| `tests/fixtures/` | A dependency-free MCP server used by the tests |

### Why not the MCP SDK?

The transports and client are hand-rolled so that **every frame on the wire is
observable**. The protocol debugger, request history and latency analytics in
later phases all read from one `TraceStore` that the transports feed directly.
Swapping in the SDK later means implementing `Transport` against it; nothing
above that interface changes.

## What works today

- Add a server through a three-step wizard (stdio or streamable HTTP)
- Servers from workspace settings (`mcpWorkbench.servers`) are merged in read-only
- Connect / disconnect / reconnect, with status reflected live in the tree
- `initialize` handshake with protocol-version negotiation and capability gating
- Discovery of tools, resources, resource templates and prompts — cursor-paginated
- Bearer tokens in `SecretStorage`, resolved per request so rotation is picked up
- `notifications/*/list_changed` triggers an automatic catalog refresh
- stderr from a stdio server becomes logs instead of corrupting the protocol
- Raw protocol trace and logs in output channels
- Copy any tool / resource / prompt definition as JSON

Tool *execution* is deliberately not wired to the UI yet — that is Phase 3, and
it lands together with the dynamic JSON-schema form.

## Running it

```bash
npm install
npm run build
```

Then press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with
Workbench loaded, and open the MCP Workbench view in the activity bar.

To point it at the bundled demo server, add a stdio server with the command:

```
node tests/fixtures/demo-server.js
```

It exposes a read-only tool, a destructive tool (so annotation handling is
visible), a resource and a prompt.

## Development

```bash
npm run watch      # esbuild in watch mode, used by the F5 launch config
npm run typecheck  # tsc --noEmit
npm test           # compiles, then runs the core suite against real servers
```

The test suite covers both transports end to end: handshake, pagination,
capability gating, error mapping, session headers, SSE and JSON response shapes,
auth headers, and connection-manager lifecycle.

## Roadmap

Phase 0 and 1 are done. Next, in order:

1. **Phase 2 — Explorer.** Webview with a dynamic renderer driven by each tool's
   JSON schema. No hardcoded fields.
2. **Phase 3 — Execution.** Form and raw-JSON modes, validation before send,
   response viewer, timing.
3. **Phase 4 — History.** Every invocation stored and replayable.
4. **Phase 5 — Resources & prompts** as first-class panels.
5. **Phase 6/7 — Protocol debugger and live logs** on top of the existing
   `TraceStore` and `LogStore`.

Later phases (tests, doctor, linter, environments, workflows, catalog, AI) are
described in the project plan.
