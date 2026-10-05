# MCP Lab

A development environment for Model Context Protocol servers, inside VS Code —
and a CLI that runs the same engine in CI.

Build MCP servers, connect to existing ones, explore tools and resources,
execute and test them, debug protocol traffic, diagnose problems, generate tests,
manage environments, and expose trusted MCP capabilities to AI agents.

Developed by **Sarath Kumar**. MIT licensed.

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

MCP Lab speaks **both halves** of the protocol: it is a client to the servers
you configure, and a server to the AI clients you connect.

```
  Claude Code / Copilot ──MCP──▶ MCP Lab ──MCP──▶ CMS · Deployment · AWS
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
- Validation before the request leaves MCP Lab; per-field error marking.
- Results rendered by shape: uniform arrays become tables, text, markdown,
  images, audio, embedded resources, prompt messages, errors.
- Every invocation recorded and replayable byte-for-byte.

### Test

- Tests are plain JSON (`**/*.mcp-test.json`) — reviewable, diffable, and
  runnable in CI without MCP Lab installed.
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
  Every finding names its evidence, because MCP Lab cannot read server source
  and does not pretend to.
- **Protocol trace** — every JSON-RPC frame in both directions, with round-trip
  times. **Logs** — MCP Lab events, server stderr and MCP logging
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

- **Environments** — DEV/QC/UAT/PROD with per-environment targets: each server
  can point at a different URL, headers and credential per tier. Switching
  disconnects everything, because the connections now point elsewhere.
- **One risk gate.** MCP has no HTTP verb, so tools are classified
  `read` / `write` / `destructive` by annotation first, name second — and that
  verdict is the badge you see on every tool, marked `write?` when the server
  annotated nothing and the name was all there was to go on. PROD confirms
  everything but reads, UAT confirms writes, DEV and QC only stop for
  destructive calls. Workflows, tests and AI clients all pass through it.
- **Auth** — bearer, custom header, basic, OAuth client-credentials, and
  **interactive OAuth 2.1** (authorization code + PKCE) for the servers an
  organisation actually runs — see [MCP projects with OAuth](#mcp-projects-with-oauth).
  Only the credential *shape* lives in config; tokens live in `SecretStorage`,
  which is the OS keychain — so a sign-in survives closing VS Code and
  rebooting, and the access token is refreshed silently from the stored
  refresh token without asking again.
- **Catalog & search** — every server with owner, version and health derived
  from real usage, plus ranked search across all of them.
- **Analytics** — call counts, failure rates, p50/p95, by target.

### Build

- **Scaffold** a new server in TypeScript, Python or C#, each shipping an
  `mcp.config.json` so the CLI can reach it immediately.
- **REST → MCP**: convert an OpenAPI document into tool definitions plus
  TypeScript handlers. It warns rather than guesses.

---

## MCP projects with OAuth

An *MCP project* is an MCP endpoint plus the OAuth configuration needed to
reach it. Select one and **MCP: Connect** does the rest: discovers the
authorization server, opens your browser, receives the callback, exchanges
the code with PKCE, stores the tokens in the OS keychain, connects, and lists
every tool with its parameters. Nothing is pasted by hand.

### Configure

One project, from environment variables (read from the extension host's
environment — the remote machine, in Remote SSH / WSL / containers):

```bash
MCP_URL=https://<mcp-host>/<project-path>/mcp
MCP_OAUTH_CLIENT_ID=<oauth-client-id>
MCP_OAUTH_SCOPES="offline_access <api-scope>"
MCP_OAUTH_AUTHORITY=https://<identity-provider-host>/<tenant>/v2.0
# optional
MCP_OAUTH_RESOURCE=https://<mcp-host>/<project-path>/mcp        # defaults to MCP_URL
MCP_OAUTH_DISCOVERY_URL=https://<identity-provider-host>/.well-known/openid-configuration
MCP_OAUTH_PROTECTED_RESOURCE_METADATA_URL=https://<mcp-host>/.well-known/oauth-protected-resource
MCP_OAUTH_REDIRECT_URI=                                          # leave empty; see below
MCP_OAUTH_CLIENT_SECRET=                                         # confidential clients only
```

The same values work as settings — `mcplab.serverUrl`, `mcplab.oauth.clientId`,
`mcplab.oauth.scopes` and so on — and a setting overrides its environment
variable. Several projects, each fully self-contained, go in `mcplab.projects`:

```jsonc
"mcplab.projects": [
  {
    "id": "project-a",
    "displayName": "Project A",
    "mcpUrl": "${env:MCP_PROJECT_A_URL}",
    "oauth": {
      "clientId": "${env:MCP_PROJECT_A_OAUTH_CLIENT_ID}",
      "scopes": ["offline_access", "<project-api-scope>"],
      "authority": "${env:MCP_PROJECT_A_OAUTH_AUTHORITY}"
    }
  }
]
```

Values resolve in this order: the project's own configuration, then
extension settings and secure storage, then environment variables, then
discovery, then safe defaults. Projects never inherit from each other — two
projects may use different identity providers, clients, scopes and
resources. **MCP: Show Authentication Diagnostics** shows where every value
came from, and names exactly which variable or setting is missing.

### Register the redirect URI

Register this redirect URI with the identity provider (as a *mobile and
desktop* / *native* platform redirect):

```
vscode://sarathkumar.mcplab/auth/callback
```

The scheme follows the editor: `vscode-insiders://` for Insiders, and the
fork's own scheme in VSCodium, Cursor and the like. The exact value for your
editor is written to the **MCP Lab: Auth** output channel at startup, after
it has passed through `asExternalUri` — which is also what makes the callback
reach the extension host in Remote SSH, WSL, dev containers and Codespaces.

If your identity provider insists on a loopback redirect, set
`"oauth.callbackMode": "loopback"` and register `http://127.0.0.1/auth/callback`.
MCP Lab then listens on 127.0.0.1 only, on a port the OS chooses (RFC 8252
requires providers to accept any port for loopback), for one callback.

### What the identity provider must allow

- Authorization code flow with **PKCE (S256)**, as a **public client** — no
  client secret. A desktop extension cannot keep one, and PKCE is what
  protects the exchange.
- **Refresh tokens**, usually by requesting `offline_access`; without them
  you sign in again whenever the access token expires.
- The API scopes the MCP server checks, consented for your users.
- If it rejects the RFC 8707 `resource` parameter (some providers identify
  the API through scopes instead), set `"oauth.resourceParameter": "never"`.

### What is checked, and refused

- **Discovery is validated hop by hop**: the 401's `WWW-Authenticate`
  challenge, protected-resource metadata that must describe *this* resource,
  an authorization server that must be the configured `authority` (or one you
  approve when asked), metadata whose `issuer` must match, endpoints that must
  be HTTPS on the issuer's host. A `.well-known` URL is never used as the MCP
  endpoint.
- **Every sign-in** uses fresh `state`, PKCE verifier and nonce. State is
  compared in constant time and consumed once; a forged, replayed or late
  callback is rejected before any code is exchanged. The `iss` response
  parameter (RFC 9207) is checked when the server sends it.
- **Tokens stay with their project.** They are stored per project and
  account, bound to the endpoint, resource and client they were issued for,
  and only ever attached to requests for their own project's origin. An
  authenticated request never follows a redirect.
- **A 401 triggers one refresh and one retry**, never a loop. Concurrent
  requests share a single refresh. A refused refresh clears the session and
  asks you to sign in again.
- **Workspace settings cannot silently redirect credentials.** If a
  workspace sets a project's endpoint, client, authority or redirect, you are
  shown the values and asked before anything is sent — and asked again if
  they change. The extension does not run in untrusted workspaces at all.
- **Nothing secret is logged**: no tokens, codes, verifiers, state values,
  nonces, client secrets or full authorization URLs, at any log level.

### Commands

| Command | |
| --- | --- |
| MCP: Select Project | Choose the project other commands act on; disconnects the previous one |
| MCP: Connect | Signs in if needed, connects, lists the tools |
| MCP: Refresh Tools | Re-runs `tools/list` (following every page) |
| MCP: Reauthenticate | Signs out and back in, e.g. to switch account |
| MCP: Sign Out | Disconnects and deletes the project's tokens |
| MCP: Copy Tool Definition | Copies a tool's full definition as JSON |
| MCP: Show Authentication Diagnostics | Configuration sources, discovery steps, redirect URI, session — no secrets |

Signed-in projects also appear in VS Code's **Accounts** menu.

---

## The CLI

```bash
mcplab test   --config mcp.config.json --junit report.xml
mcplab lint   --config mcp.config.json --max-warnings 5
mcplab doctor --config mcp.config.json
mcplab docs   --config mcp.config.json --out SERVER.md
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
| `src/core/serverRole.ts` | The **server** half: MCP Lab as an MCP server |
| `src/core/schema.ts` | JSON Schema → form model, validation, pruning |
| `src/core/execution.ts` | The one path every invocation takes |
| `src/core/testing.ts` · `testgen.ts` | Test model, runner, schema-derived generation |
| `src/core/doctor.ts` · `linter.ts` · `security.ts` | Analysis |
| `src/core/workflows.ts` · `recording.ts` | Composition |
| `src/core/compare.ts` · `catalog.ts` · `docs.ts` | Contract diff, catalog, docs |
| `src/core/scaffold.ts` · `openapi.ts` | Project templates, REST → MCP |
| `src/core/oauth.ts` | OAuth protocol: PKCE, discovery and its validation, exchange, refresh, token checks |
| `src/core/oauthSession.ts` | OAuth orchestration: sign-in, storage isolation, refresh, 401 handling |
| `src/core/oauthCallback.ts` | Pending sign-ins, state validation, the loopback listener |
| `src/core/projects.ts` | MCP project configuration: env/settings resolution, validation, overrides |
| `src/vscode/` | Extension host: tree, panel, commands, secrets, bridge, auth provider |
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

## Disclaimer

MCP Lab is provided as-is, without warranty. The author is not responsible for
any data loss, system crash or other issue caused by using it; it can invoke
tools that change or delete data on the servers you connect to. **Use it at your
own risk.** See [LICENSE](LICENSE) for the full terms.

---

## Status

Phases 0–32 of the project plan are implemented, with these documented limits:

- **OAuth has not been verified against a production identity provider.**
  The whole flow runs under test against real HTTP servers — a mock
  authorization server that verifies PKCE and rotates refresh tokens, and an
  OAuth-protected MCP server that enforces audiences — including discovery,
  both callback modes, refresh, 401 retry and project isolation. What has not
  been exercised is a real provider's consent screen and its quirks.
- **ID tokens are validated by claims, not signature.** OIDC allows this for
  a token received directly from the token endpoint over TLS. Access tokens
  are the resource server's to verify; MCP Lab checks their lifetime, and
  their audience and issuer when the project pins them.
- **VS Code for the Web is not supported.** The extension needs a Node
  extension host (it spawns stdio servers). Codespaces works, because its
  extension host is a full Node environment.
- **The VS Code UI layer is not covered by automated tests.** The core is, and
  the CLI is tested end to end as a real process. Testing the extension host
  itself needs `@vscode/test-electron`, which downloads a VS Code build.
