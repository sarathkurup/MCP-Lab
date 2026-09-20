# Demo environment

Three MCP servers standing in for an enterprise, with problems planted on
purpose so every MCP Lab feature has something real to find.

No install step: they are dependency-free Node scripts.

## The servers

| Server | Team | What it is |
| --- | --- | --- |
| **CMS MCP** | Platform | Events and content. Mostly sound, with two planted flaws. |
| **Deployment MCP** | DevOps | Pipelines, logs, health, rollback. The well-behaved one. |
| **Employee MCP** | People Systems | Directory and entitlements. The one with data problems. |

## What is deliberately wrong

| Where | Problem | Found by |
| --- | --- | --- |
| `CMS.deleteEvent` | Destructive, but no `destructiveHint` | Doctor, `MCP004`, `SEC012` |
| `CMS.getCmsConfig` | Returns an `apiKey` in its output | Security scan `SEC011` |
| `CMS.updateEvent` | Undocumented `revision` parameter | `MCP008` |
| `CMS.getEvents` | ~900ms, over the test's latency budget | Test run, Analytics p95 |
| `Employee.getEmployee` | Returns an SSN and a personal email | `SEC011`, `MCP005` |
| `Employee.authenticateUser` | Takes a password as a tool argument | `SEC010`, `MCP005` |
| `Employee.purgeEmployee` | Destructive, unannotated, no required parameters | `SEC012`, `SEC013`, `MCP003` |
| `Employee.*` | No tests at all | `MCP007` |
| `Deployment.getHealth` | Fails every third call | Analytics failure rate |

## Try it from the command line

```bash
cd demo
node ../dist/cli.js doctor  --config mcp.config.json --server "CMS MCP"
node ../dist/cli.js lint    --config mcp.config.json --server "Employee MCP"
node ../dist/cli.js test    --config mcp.config.json
node ../dist/cli.js docs    --config mcp.config.json --server "Deployment MCP"
```

`test` exits 1, because the CMS latency budget is deliberately missed.

## Try it in the editor

1. Open this folder in VS Code with the extension running (<kbd>F5</kbd> from the repo root).
2. The three servers appear in the **MCP Lab** view — they are declared in
   `mcp.config.json`, so add them via **MCP: Add Server** or copy them into
   `mcplab.servers` in settings.
3. Worth doing, in order:
   - **Explorer** → `updateEvent` → note the form built from the schema, then
     switch to JSON and back.
   - **Tests** → *Run all* → one failure, with expected vs actual.
   - **Doctor** → *Run diagnostics* on CMS MCP → the apiKey leak and the missing
     annotation.
   - **Security** → *Run security scan* on Employee MCP → SSN, password
     parameter, unannotated purge.
   - **Workflows** → *QC Deployment Verification* → watch the branch pick an arm
     based on the pipeline result.
   - **Analytics** → after a few calls, `getHealth` shows a real failure rate.
   - **Compare** → CMS MCP against itself in another environment to see the
     contract diff (edit one server's schema first to make it interesting).

## Recreating the drift demo

To see the comparison view do real work, copy `servers/cms-server.js` to
`servers/cms-server-qc.js`, remove a tool or make an optional parameter
required, and register it as a second server. **Compare** will report exactly
which changes break existing callers.
