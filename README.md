# MCPilot

A development environment for Model Context Protocol servers, inside VS Code —
and a CLI that runs the same engine in CI.

Build MCP servers, connect to existing ones, explore tools and resources,
execute and test them, debug protocol traffic, diagnose problems, generate tests,
manage environments, and expose trusted MCP capabilities to AI agents.

---

## The one architectural rule

**`src/core/` never imports `vscode`.**

```
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │  src/vscode/ │   │   src/cli/   │   │ src/webview/ │
        │  extension   │   │  CI runner   │   │    panel     │
        └───────┬──────┘   └───────┬──────┘   └───────┬──────┘
                └──────────────────┼──────────────────┘
                        ┌──────────▼──────────┐
                        │      src/core/      │
                        │  no vscode, no DOM  │
                        └──────────┬──────────┘
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
    Transports                 McpClient                ConnectionManager
  stdio · streamable HTTP   handshake · pagination      status · catalog
```

That rule is not aspirational. `tests/cli.test.ts` spawns the compiled CLI as a
real process and drives three MCP servers with no editor present — it would fail
the moment core grew an editor dependency.

MCPilot speaks **both halves** of the protocol: it is a client to the servers
you configure, and a server to the AI clients you connect.

```
  Claude Code / Copilot ──MCP──▶ MCPilot ──MCP──▶ CMS · Deployment · AWS
                                       │
                                  one gate: classify,
                                  check environment,
                                  ask a human
```

---

## What it does

### Explore and execute

- A form built from each tool's JSON Schema — nothing is hardcoded. Objects,
  arrays, enums, formats, nullable via `anyOf`, nested structures.
- Form ⇄ raw JSON, carrying the value across.
- Validation before the request leaves MCPilot; per-field error marking.
- Results rendered by shape: uniform arrays become tables, text, markdown,
  images, audio, embedded resources, prompt messages, errors.
- Every invocation recorded and replayable byte-for-byte.

### Test

- Tests are plain JSON (`**/*.mcp-test.json`) — reviewable, diffable, and
  runnable in CI without MCPilot installed.
- Assertions use JSONPath-lite: `$.structuredContent.sum`, `$.content[0].text`.
- `expectError`, `expectToolError`, latency budgets, `skip`.
- Suites appear in VS Code's own Test Explorer with expected/actual diffs.
- **Generation is deterministic first**: the schema already states what is
  required, what the enums are and where the bounds lie, so those cases are
  derived exactly and offline. A language model only adds what a schema cannot
  express.

### Diagnose

- **Doctor** — 14 checks across connectivity, protocol, capabilities, error
  handling, schema quality, security and coverage. Probes are read-only by
  construction: a ping, and a deliberately unknown tool name.
- **Linter** — `MCP001`–`MCP012`, published as editor diagnostics.
- **Security scan** — config, catalog, logs and history, looking for leaked
  credentials, PII, unannotated destructive tools and unencrypted transports.
  Every finding names its evidence, because MCPilot cannot read server source
  and does not pretend to.
- **Protocol trace** — every JSON-RPC frame in both directions, with round-trip
  times. **Logs** — MCPilot events, server stderr and MCP logging
  notifications, with credentials masked on the way in.

### Compose

- **Workflows** — steps that read earlier outputs through
  `{{steps.<id>.output.<path>}}`, with branches and per-step error handling.
- **Record & replay** — arm the recorder, work normally, then save the sequence
  as a workflow (values auto-wired between steps) or as a regression suite.
- **Compare** — contract diff between two servers, classifying each change as
  breaking or not: removed tools, narrowed enums, optional becoming required,
  dropped destructive hints.

### Operate

- **Environments** — DEV/QC/PROD with per-environment targets. Switching
  disconnects everything, because the connections now point elsewhere.
- **One risk gate.** Tools are classified `read` / `write` / `destructive` by
  annotation first, name second. Production writes are confirmed even when a
  tool carries no annotations. Workflows, tests and AI clients all pass through
  it.
- **Auth** — bearer, custom header, basic, OAuth client-credentials. Only the
  credential *shape* lives in config; the secret is in `SecretStorage`.
- **Catalog & search** — every server with owner, version and health derived
  from real usage, plus ranked search across all of them.
- **Analytics** — call counts, failure rates, p50/p95, by target.

### Build

- **Scaffold** a new server in TypeScript, Python or C#, each shipping an
  `mcp.config.json` so the CLI can reach it immediately.
- **REST → MCP**: convert an OpenAPI document into tool definitions plus
  TypeScript handlers. It warns rather than guesses.

---

## The CLI

```bash
mcpilot test   --config mcp.config.json --junit report.xml
mcpilot lint   --config mcp.config.json --max-warnings 5
mcpilot doctor --config mcp.config.json
mcpilot docs   --config mcp.config.json --out SERVER.md
```

Exit codes: `0` ok, `1` failures found, `2` could not run. `--json` for
machine-readable output. A sample pipeline lives in `.github/workflows/mcp.yml`.

---

## Try it

```bash
npm install
npm run build
```

Press <kbd>F5</kbd> for an Extension Development Host, then open the
demo environment in `demo/` (see `demo/README.md`) — three servers with planted
problems, one per feature.

```bash
cd demo
node ../dist/cli.js doctor --config mcp.config.json --server "CMS MCP"
```

### Public servers to point it at

The demo servers have planted faults, so they prove the diagnostics but not the
UI. These four are real, need no key, and serve traffic nobody staged. Run
**MCP: Add Server → HTTP** and paste a URL, or point the CLI at the config
that ships with them:

```bash
node dist/cli.js doctor --config demo/public.mcp.config.json
```

| Server | Protocol | Catalog | What it puts in front of the UI |
| --- | --- | --- | --- |
| `mcp.deepwiki.com/mcp` | 2025-06-18 | 3 tools | Long markdown answers — rendering and truncation in the explorer. Doctor finds a **real bug** here: a call to a tool that does not exist comes back as success. |
| `huggingface.co/mcp` | 2025-06-18 | 4 tools, **155 resources** | The only one of the four that fills the Resources panel. Anonymous by default; add a token with **MCP: Set Authentication Token** and the catalog grows. |
| `gitmcp.io/<owner>/<repo>` | 2025-03-26 | 4–5 tools | Version negotiation against an **older revision**, with a session id on every frame. Tool names are built from the repo, so no two entries look alike. |
| `mcp.context7.com/mcp` | 2025-06-18 | 2 tools | A two-step chain — `resolve-library-id` feeds `query-docs` — worth recording as a workflow. |

For the auth path without a token of your own, `https://api.githubcopilot.com/mcp/`
answers **401 with a missing-Authorization message**: the error surface and the
credential flow, end to end.

Doctor across all four takes about a second and is a fair sample of the drift it
exists to find — DeepWiki and Context7 advertise `resources` and `prompts` and
return neither, none of the four support logging, and GitMCP is a revision
behind. Last verified 2026-09-20; these are other people's servers and may move.

---

## Layout

| Path | What lives there |
| --- | --- |
| `src/core/protocol.ts` | JSON-RPC envelopes + the MCP schema subset |
| `src/core/transport/` | `Transport` interface, stdio, streamable HTTP |
| `src/core/McpClient.ts` | Correlation, handshake, primitives, pagination |
| `src/core/serverRole.ts` | The **server** half: MCPilot as an MCP server |
| `src/core/schema.ts` | JSON Schema → form model, validation, pruning |
| `src/core/execution.ts` | The one path every invocation takes |
| `src/core/testing.ts` · `testgen.ts` | Test model, runner, schema-derived generation |
| `src/core/doctor.ts` · `linter.ts` · `security.ts` | Analysis |
| `src/core/workflows.ts` · `recording.ts` | Composition |
| `src/core/compare.ts` · `catalog.ts` · `docs.ts` | Contract diff, catalog, docs |
| `src/core/scaffold.ts` · `openapi.ts` | Project templates, REST → MCP |
| `src/vscode/` | Extension host: tree, panel, commands, secrets, bridge |
| `src/webview/` | The panel UI — no framework, VS Code theme variables |
| `src/cli/` | The CI runner |
| `demo/` | A fake enterprise with planted problems |

### Why not the MCP SDK?

The client and transports are hand-rolled so that **every frame on the wire is
observable**. The protocol debugger, history, latency analytics and the doctor
all read from one `TraceStore` that the transports feed directly. Swapping the
SDK in later means implementing `Transport` against it; nothing above that
interface changes.

---

## Development

```bash
npm run watch      # esbuild, used by the F5 launch config
npm run typecheck  # tsc --noEmit
npm test           # compiles, then runs everything
```

163 tests. They cover both transports end to end, the schema engine, execution
and history, the test runner and generator, linter, doctor, environments and
guards, auth including OAuth refresh, security scanning, contract comparison,
workflows and chaining, recording, catalog and search, scaffolding, OpenAPI
conversion, the MCP server role, redaction, reconnection — and the CLI as a real
process against the demo servers.

### Things the tests caught

Worth recording, because they are the kind of bug that survives a read-through:

- An unset enum arrived as `""` and was being sent instead of pruned.
- A generated negative case proved the demo server was not enforcing its own
  declared schema.
- After a workflow branch took its "true" arm, fall-through carried execution
  straight into the "false" arm.
- A flapping server reset the reconnect backoff on every brief success, so it
  would have retried forever.
- On Windows, `shell: true` re-parses the command line, breaking any path with
  spaces — so path-like commands now spawn without a shell.

---

## Status

Phases 0–32 of the project plan are implemented, with two documented limits:

- **Interactive OAuth** (authorization-code + PKCE) is not implemented.
  Client-credentials is. Interactive flows need a loopback redirect and a URI
  handler; bearer, header and basic auth cover the rest.
- **The VS Code UI layer is not covered by automated tests.** The core is, and
  the CLI is tested end to end as a real process. Testing the extension host
  itself needs `@vscode/test-electron`, which downloads a VS Code build.
