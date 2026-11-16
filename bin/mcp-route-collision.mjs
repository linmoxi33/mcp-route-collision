#!/usr/bin/env node
// mcp-route-collision: find tool-name collisions across real stdio MCP servers,
// then route real tools/call requests without guessing.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const USAGE = `usage:
  mcp-route-collision scan  --config <servers.json> [--json] [--emit-policy <file>]
  mcp-route-collision route --config <servers.json> --calls <calls.jsonl> [--json]
  mcp-route-collision call  --config <servers.json> --tool <server::tool> --args '<json>' [--json]`;

function fail(msg, code = 2) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'json') out.json = true;
      else if (i + 1 < argv.length) out[key] = argv[++i];
      else fail(`missing value for --${key}`);
    } else out._.push(a);
  }
  return out;
}
export function normalize(name) { return String(name).toLowerCase().replace(/[^a-z0-9]/g, ''); }

class McpClient {
  constructor(server) { this.server = server; this.pending = new Map(); this.nextId = 1; this.stderr = ''; }
  async start() {
    const [cmd, ...baseArgs] = this.server.command;
    const args = [...baseArgs, ...(this.server.args || [])];
    this.proc = spawn(cmd, args, {
      cwd: this.server.cwd,
      env: { ...process.env, ...(this.server.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stderr.on('data', (d) => { this.stderr += d.toString(); });
    this.proc.on('error', (e) => this.rejectAll(e));
    this.proc.on('exit', (code) => this.rejectAll(new Error(`server "${this.server.name}" exited rc=${code} ${this.stderr.slice(-300)}`)));
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || String(msg.error.code)));
      else p.resolve(msg.result);
    });
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-route-collision', version: '1.0.0' } });
    this.notify('notifications/initialized');
    return this;
  }
  notify(method, params = {}) { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout waiting for ${method} from ${this.server.name}`)); }, 8000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  rejectAll(err) { for (const [, p] of this.pending) p.reject(err); this.pending.clear(); }
  close() { try { this.proc.stdin.end(); } catch {} try { this.proc.kill('SIGTERM'); } catch {} }
}

function loadConfig(file) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { fail(`cannot read config ${file}: ${e.message}`); }
  if (!raw || !Array.isArray(raw.servers) || raw.servers.length === 0) fail('config must contain a non-empty "servers" array');
  const dir = path.dirname(path.resolve(file));
  const names = new Set();
  const servers = raw.servers.map((s, i) => {
    if (!s || typeof s.name !== 'string' || !s.name) fail(`servers[${i}] needs a name`);
    if (names.has(s.name)) fail(`duplicate server name: ${s.name}`);
    names.add(s.name);
    if (!Array.isArray(s.command) || s.command.length === 0) fail(`server "${s.name}" needs command: [exe, ...args]`);
    return { ...s, name: s.name, command: s.command, cwd: s.cwd ? path.resolve(dir, s.cwd) : dir };
  });
  return { servers };
}

async function connectAll(servers) {
  const clients = [];
  try {
    for (const s of servers) {
      const c = new McpClient(s);
      try { await c.start(); } catch (e) { fail(`cannot start server "${s.name}": ${e.message}`); }
      clients.push(c);
    }
  } catch (e) {
    clients.forEach((c) => c.close());
    throw e;
  }
  return clients;
}

function schemaInfo(tool) {
  const sc = tool.inputSchema || {};
  return {
    required: [...(sc.required || [])].sort(),
    properties: Object.keys(sc.properties || {}).sort(),
    types: Object.fromEntries(Object.entries(sc.properties || {}).map(([k, v]) => [k, v.type || 'any'])),
  };
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

export function findCollisions(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = normalize(e.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const collisions = [];
  for (const [key, members] of groups) {
    const servers = new Set(members.map((m) => m.server));
    if (servers.size < 2) continue;
    const exact = new Set(members.map((m) => m.name));
    const kind = exact.size === 1 ? 'exact' : 'normalized';
    const sig = members.map((m) => JSON.stringify(schemaInfo(m)));
    const incompatible = new Set(sig).size > 1;
    const witness = incompatible ? describeSchemaDiff(members) : null;
    collisions.push({ kind, key, name: [...exact].join(' | '), members: members.map(slim), schema_incompatible: incompatible, witness });
  }
  const near = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      if (a.server === b.server || normalize(a.name) === normalize(b.name)) continue;
      const d = levenshtein(normalize(a.name), normalize(b.name));
      if (d <= 2 && Math.min(normalize(a.name).length, normalize(b.name).length) >= 4) {
        near.push({ kind: 'near', distance: d, members: [slim(a), slim(b)], schema_incompatible: JSON.stringify(schemaInfo(a)) !== JSON.stringify(schemaInfo(b)) });
      }
    }
  }
  near.sort((x, y) => x.distance - y.distance);
  return { collisions, near };
}
function slim(e) { return { server: e.server, tool: e.name, ...schemaInfo(e) }; }
function describeSchemaDiff(members) {
  const [a, b] = members;
  const sa = schemaInfo(a), sb = schemaInfo(b);
  return {
    pair: [a.server + '::' + a.name, b.server + '::' + b.name],
    required_a: sa.required, required_b: sb.required,
    props_a: sa.properties, props_b: sb.properties,
    differs_in_required: JSON.stringify(sa.required) !== JSON.stringify(sb.required),
    differs_in_properties: JSON.stringify(sa.properties) !== JSON.stringify(sb.properties),
    differs_in_types: JSON.stringify(sa.types) !== JSON.stringify(sb.types),
  };
}

function buildPolicy(entries, collisions) {
  const ambiguous = {};
  for (const c of collisions) {
    const names = new Set(c.members.map((m) => m.tool));
    for (const n of names) {
      if (!ambiguous[n]) ambiguous[n] = [];
      for (const m of c.members) if (m.tool === n && !ambiguous[n].includes(m.server)) ambiguous[n].push(m.server);
    }
  }
  const tools = {};
  for (const e of entries) tools[`${e.server}::${e.name}`] = { server: e.server, tool: e.name };
  return { version: 1, generated_by: 'mcp-route-collision', tools, ambiguous: Object.fromEntries(Object.entries(ambiguous).filter(([, v]) => v.length > 1)) };
}

async function scan(cfg, opts) {
  const clients = await connectAll(cfg.servers);
  const entries = [];
  try {
    for (const c of clients) {
      const res = await c.request('tools/list', {});
      for (const t of res.tools || []) entries.push({ server: c.server.name, name: t.name, description: t.description || '', inputSchema: t.inputSchema || {} });
    }
  } finally {
    clients.forEach((c) => c.close());
  }
  const { collisions, near } = findCollisions(entries);
  const policy = buildPolicy(entries, collisions);
  const perServer = Object.fromEntries(cfg.servers.map((s) => [s.name, entries.filter((e) => e.server === s.name).length]));
  const report = {
    tool: 'mcp-route-collision', version: '1.0.0', mode: 'scan',
    servers: cfg.servers.map((s) => s.name), tools_per_server: perServer, total_tools: entries.length,
    collisions, near_misses: near,
    summary: {
      groups: collisions.length,
      exact_groups: collisions.filter((c) => c.kind === 'exact').length,
      normalized_groups: collisions.filter((c) => c.kind === 'normalized').length,
      schema_incompatible_groups: collisions.filter((c) => c.schema_incompatible).length,
      near_misses: near.length,
      naive_last_wins_shadowed: collisions.reduce((n, c) => n + c.members.length - 1, 0),
    },
    policy,
  };
  report.determinism = { sha256: sha256(JSON.stringify({ entries, collisions, near })) };
  if (opts['emit-policy']) { writeFileSync(opts['emit-policy'], JSON.stringify(policy, null, 2) + '\n'); }
  return report;
}
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

async function loadTools(clients) {
  const entries = [];
  for (const c of clients) {
    const res = await c.request('tools/list', {});
    for (const t of res.tools || []) entries.push({ server: c.server.name, name: t.name, description: t.description || '', inputSchema: t.inputSchema || {} });
  }
  return entries;
}

async function route(cfg, opts) {
  if (!opts.calls) fail('route requires --calls <calls.jsonl>');
  let lines;
  try { lines = readFileSync(opts.calls, 'utf8').split('\n').filter((l) => l.trim()); } catch (e) { fail(`cannot read calls: ${e.message}`); }
  const calls = [];
  for (const [i, l] of lines.entries()) {
    try { calls.push({ index: i, ...JSON.parse(l) }); } catch (e) { fail(`bad JSON on calls line ${i + 1}: ${e.message}`); }
  }
  const clients = await connectAll(cfg.servers);
  const byName = new Map(clients.map((c) => [c.server.name, c]));
  let report;
  try {
    const entries = await loadTools(clients);
    const { collisions, near } = findCollisions(entries);
    const policy = buildPolicy(entries, collisions);
    const results = [];
    for (const call of calls) {
      const raw = String(call.tool || '');
      let server = null, tool = null, rejected = null;
      if (raw.includes('::')) {
        const [s, t] = raw.split('::');
        const c = byName.get(s);
        if (!c) rejected = { code: 'unknown-server', server: s };
        else if (!entries.some((e) => e.server === s && e.name === t)) rejected = { code: 'unknown-tool', server: s, tool: t };
        else { server = s; tool = t; }
      } else if (policy.ambiguous[raw]) {
        rejected = { code: 'ambiguous-tool-name', tool: raw, candidates: policy.ambiguous[raw] };
      } else {
        const hit = entries.filter((e) => e.name === raw);
        if (hit.length === 1) { server = hit[0].server; tool = raw; }
        else rejected = { code: hit.length ? 'ambiguous-tool-name' : 'unknown-tool', tool: raw, candidates: hit.map((h) => h.server) };
      }
      if (rejected) { results.push({ ...call, rejected }); continue; }
      try {
        const res = await byName.get(server).request('tools/call', { name: tool, arguments: call.args || {} });
        results.push({ ...call, routed_server: server, routed_tool: tool, ok: !res.isError, sample: (res.content?.[0]?.text || '').slice(0, 160) });
      } catch (e) {
        results.push({ ...call, routed_server: server, routed_tool: tool, ok: false, error: e.message });
      }
    }
    const rejected = results.filter((r) => r.rejected);
    const errors = results.filter((r) => r.ok === false);
    const misroutes = results.filter((r) => r.expect && r.routed_server && r.expect !== r.routed_server);
    report = {
      tool: 'mcp-route-collision', version: '1.0.0', mode: 'route',
      total: calls.length,
      routed: results.filter((r) => r.routed_server).length,
      rejected: rejected.length,
      errors: errors.length,
      misroutes: misroutes.length,
      rejections: rejected.map((r) => ({ tool: r.tool, ...r.rejected })),
      error_details: errors.slice(0, 5).map((r) => ({ tool: r.tool, server: r.routed_server, error: r.error || r.sample })),
      results,
      collision_summary: { groups: collisions.length, near_misses: near.length },
    };
  } finally { clients.forEach((c) => c.close()); }
  return report;
}

async function singleCall(cfg, opts) {
  if (!opts.tool) fail('call requires --tool <server::tool>');
  const [server, tool] = String(opts.tool).split('::');
  if (!server || !tool) fail('--tool must be <server>::<tool>');
  let args = {};
  if (opts.args) { try { args = JSON.parse(opts.args); } catch (e) { fail(`--args is not JSON: ${e.message}`); } }
  const clients = await connectAll(cfg.servers);
  try {
    const c = clients.find((x) => x.server.name === server);
    if (!c) fail(`unknown server: ${server}`);
    const res = await c.request('tools/call', { name: tool, arguments: args });
    return { tool: 'mcp-route-collision', mode: 'call', server, tool_name: tool, ok: !res.isError, content: res.content || [] };
  } finally { clients.forEach((c) => c.close()); }
}

function renderScan(r) {
  const out = [];
  out.push(`servers: ${r.servers.join(', ')}`);
  out.push(`tools: ${r.total_tools} (${Object.entries(r.tools_per_server).map(([k, v]) => `${k}=${v}`).join(', ')})`);
  out.push(`collision groups: ${r.summary.groups} (exact=${r.summary.exact_groups}, normalized=${r.summary.normalized_groups}, schema-incompatible=${r.summary.schema_incompatible_groups})`);
  out.push(`near misses: ${r.summary.near_misses} | naive last-wins would shadow ${r.summary.naive_last_wins_shadowed} tool name(s)`);
  for (const c of r.collisions) {
    out.push(`  [${c.kind}${c.schema_incompatible ? '+schema' : ''}] ${c.name} -> ${c.members.map((m) => m.server + '::' + m.tool).join(', ')}`);
    if (c.witness) out.push(`      witness: required ${JSON.stringify(c.witness.required_a)} vs ${JSON.stringify(c.witness.required_b)}`);
  }
  for (const n of r.near_misses) out.push(`  [near d=${n.distance}] ${n.members.map((m) => m.server + '::' + m.tool).join(' vs ')}`);
  out.push(`policy: ${Object.keys(r.policy.tools).length} qualified routes, ${Object.keys(r.policy.ambiguous).length} ambiguous bare name(s)`);
  out.push(`determinism sha256: ${r.determinism.sha256}`);
  return out.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  if (!cmd || cmd === 'help' || cmd === '--help') { process.stdout.write(USAGE + '\n'); process.exit(cmd ? 0 : 2); }
  if (!['scan', 'route', 'call'].includes(cmd)) fail(`unknown command: ${cmd}`);
  if (!opts.config) fail('--config <servers.json> is required');
  const cfg = loadConfig(opts.config);
  let report;
  if (cmd === 'scan') {
    report = await scan(cfg, opts);
    process.stdout.write((opts.json ? JSON.stringify(report, null, 2) : renderScan(report)) + '\n');
    process.exit(report.summary.groups > 0 ? 1 : 0);
  }
  if (cmd === 'route') {
    report = await route(cfg, opts);
    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(`total=${report.total} routed=${report.routed} rejected=${report.rejected} errors=${report.errors} misroutes=${report.misroutes}\n` + report.rejections.slice(0, 10).map((x) => `  rejected: ${x.tool} (${x.code}${x.candidates ? '; ' + x.candidates.join('|') : ''})`).join('\n') + (report.rejections.length ? '\n' : ''));
    process.exit(report.rejected || report.errors || report.misroutes ? 1 : 0);
  }
  report = await singleCall(cfg, opts);
  process.stdout.write((opts.json ? JSON.stringify(report, null, 2) : JSON.stringify(report.content)) + '\n');
  process.exit(report.ok ? 0 : 1);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write(`fatal: ${e.stack || e.message}\n`); process.exit(2); });
}
