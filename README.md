# mcp-route-collision

Find tool-name collisions across real stdio MCP servers, then route calls with an explicit policy instead of guessing. Names matter now: MCP tool names are flat and un-namespaced, so mounting two servers that both expose `search` or `read_file` silently sends work to the wrong place.

Upstream: https://github.com/ChromeDevTools/chrome-devtools-mcp

## 上游是什么、它缺什么

`chrome-devtools-mcp` (GitHub Trending 2026-11-16, 717 stars in the period) gives coding agents a large set of browser tools with **flat, un-namespaced names** (`click`, `fill`, `take_snapshot`, ...). That is fine alone; it breaks when a client mounts it next to another MCP server. Nothing in the server, and nothing in the MCP spec, tells the client how to disambiguate two servers exposing the same name.

This is not hypothetical. Real, currently open reports:

- <https://github.com/kira-autonoma/mcp-context-proxy/issues/1> — "Duplicate tool names across servers: calls route to the last server (jira create_issue went to sentry)". A concrete cross-server misroute.
- <https://github.com/IBM/mcp-context-forge/issues/6189> — "Duplicate tool names still possible outside the update_tool path fixed in #6129", i.e. the collision class survives a fix in a production gateway.

The upstream repo has no command that answers "which of my mounted servers collide, and with what argument schema?" That is the gap this tool fills.

## 这个工具做什么 / 不做什么

It speaks JSON-RPC over stdio to every server in a config file, calls `tools/list`, and reports:

- **exact** name collisions across servers;
- **normalized** collisions (`read_file` / `readFile` / `read-file`);
- **schema incompatibility** inside a collision group, with a witness (required fields, property sets, types);
- **near misses** (edit distance ≤ 2, e.g. `stat` vs `status`);
- a **route policy**: every tool gets a `server::tool` key, and every truly ambiguous bare name is listed as ambiguous rather than silently assigned.

`route` then replays a JSONL call file. Qualified names are routed directly; bare ambiguous names are **rejected** with exit 1 — it never guesses. `call` executes one qualified call.

It does **not** proxy, rewrite, or wrap your servers; it does not vendor any MCP SDK; it does not claim to fix upstream naming.

## 安装 / 用法

Requires Node.js ≥ 18. Zero dependencies, nothing to install:

```bash
git clone <this repo> && cd mcp-route-collision
node bin/mcp-route-collision.mjs scan --config examples/in/servers.json
```

Real measured output on the three bundled reference servers (`fs`, `text`, `git`; 27 tools):

```text
servers: fs, text, git
tools: 27 (fs=9, text=10, git=8)
collision groups: 4 (exact=4, normalized=0, schema-incompatible=4)
near misses: 1 | naive last-wins would shadow 5 tool name(s)
  [exact+schema] read_file -> fs::read_file, git::read_file
      witness: required ["path"] vs ["path","rev"]
  [exact+schema] search -> fs::search, text::search, git::search
  [near d=2] fs::stat vs git::status
policy: 27 qualified routes, 4 ambiguous bare name(s)
determinism sha256: 59b9c87d48543258fa5b7c574fa9196a88d8c2b8852beb4927f488cc35907fca
```

```bash
# machine-readable + write the policy
node bin/mcp-route-collision.mjs scan --config examples/in/servers.json --json --emit-policy examples/out/policy.json

# 200 qualified real tools/call requests: 200 routed, 0 errors, 0 misroutes
node bin/mcp-route-collision.mjs route --config examples/in/servers.json --calls examples/in/calls-200.jsonl --json

# the same 200 calls with bare names: 100 are rejected as ambiguous, 0 guessed
node bin/mcp-route-collision.mjs route --config examples/in/servers.json --calls examples/in/calls-bare-200.jsonl --json

# one real call
node bin/mcp-route-collision.mjs call --config examples/in/servers.json --tool text::wordcount --args '{"path":"a.txt"}'
```

`--json` output is directly parseable: `python3 -c "import json,sys;json.load(sys.stdin)"`.

### 退出码

| code | meaning |
| --- | --- |
| 0 | scan found no collision / route sent every call without error |
| 1 | scan found ≥1 collision group, or route rejected/errored/misrouted a call |
| 2 | usage error, unreadable config/calls file, or a server that would not start |

### Config format

```json
{ "servers": [ { "name": "fs", "command": ["node", "servers/fs-server.mjs"],
                 "cwd": "../..", "env": { "MCP_FS_ROOT": "examples/in/workspace" } } ] }
```

Point it at your own servers (`npx chrome-devtools-mcp`, `uvx mcp-server-git`, ...). The bundled `servers/` are real implementations (node:fs, child_process git, text ops), not stubs — they exist so the example is offline and deterministic.

## 本轮创新

First tool that measures **cross-server MCP tool-name collisions on a live `tools/list` surface and turns them into an executable routing policy with a reject-don't-guess rule**; the ledger's 9 previous C entries are single-repo offline auditors with no multi-server runtime session, and no prior entry distinguishes exact / normalized / schema-incompatible collisions by witness. On the 200-call replay, the qualified policy routes 200/200 with 0 misroutes, while the bare-name surface rejects 100/200 as ambiguous instead of reproducing the last-writer-wins misroute reported in mcp-context-proxy#1.

## 局限

- Collision detection uses name normalization + JSON Schema shape; it does not do semantic equivalence of descriptions.
- Near misses are edit distance ≤ 2 only, so they are hints, not verdicts.
- `route` executes real calls — mutating tools (write_file, replace, delete) change the workspace. Run against a scratch root.
- The bundled servers cover fs/text/git; protocol coverage is `tools/*` only (no prompts, resources, sampling).
- No HTTP/SSE transport yet.

## License

MIT. Reference servers and tool code are original.
