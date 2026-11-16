import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findCollisions } from '../bin/mcp-route-collision.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin/mcp-route-collision.mjs');
const config = path.join(root, 'examples/in/servers.json');
const run = (args, cwd = root) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });

test('scan --json emits parseable JSON', () => {
  const r = run(['scan', '--config', config, '--json']);
  const d = JSON.parse(r.stdout);
  assert.equal(d.mode, 'scan');
  assert.equal(d.total_tools, 27);
  assert.deepEqual(d.servers, ['fs', 'text', 'git']);
});
test('scan exits 1 when collisions exist', () => {
  assert.equal(run(['scan', '--config', config]).status, 1);
});
test('exact collision search spans three servers', () => {
  const d = JSON.parse(run(['scan', '--config', config, '--json']).stdout);
  const g = d.collisions.find((c) => c.name === 'search');
  assert.equal(g.kind, 'exact');
  assert.deepEqual(g.members.map((m) => m.server), ['fs', 'text', 'git']);
});
test('read_file is flagged schema-incompatible with a witness', () => {
  const d = JSON.parse(run(['scan', '--config', config, '--json']).stdout);
  const g = d.collisions.find((c) => c.name === 'read_file');
  assert.equal(g.schema_incompatible, true);
  assert.deepEqual(g.witness.required_a, ['path']);
  assert.deepEqual(g.witness.required_b, ['path', 'rev']);
});
test('near miss stat/status is reported', () => {
  const d = JSON.parse(run(['scan', '--config', config, '--json']).stdout);
  assert.ok(d.near_misses.some((n) => n.members.map((m) => m.tool).sort().join(',') === 'stat,status'));
});
test('normalization catches snake/camel/kebab variants', () => {
  const { collisions } = findCollisions([
    { server: 'a', name: 'read_file', inputSchema: { type: 'object', required: ['path'] } },
    { server: 'b', name: 'readFile', inputSchema: { type: 'object', required: ['path'] } },
    { server: 'c', name: 'read-file', inputSchema: { type: 'object', required: ['path', 'rev'] } },
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].kind, 'normalized');
  assert.equal(collisions[0].schema_incompatible, true);
});
test('naive last-wins shadow count equals extra members', () => {
  const d = JSON.parse(run(['scan', '--config', config, '--json']).stdout);
  assert.equal(d.summary.naive_last_wins_shadowed, 5);
});
test('100 bare-name calls are rejected, never guessed', () => {
  const r = run(['route', '--config', config, '--calls', path.join(root, 'examples/in/calls-bare-200.jsonl'), '--json']);
  const d = JSON.parse(r.stdout);
  assert.equal(r.status, 1);
  assert.equal(d.total, 200);
  assert.equal(d.rejected, 100);
  assert.equal(d.errors, 0);
  assert.ok(d.rejections.every((x) => x.code === 'ambiguous-tool-name'));
});
test('200 qualified calls route with zero misroutes and exit 0', () => {
  const r = run(['route', '--config', config, '--calls', path.join(root, 'examples/in/calls-200.jsonl'), '--json']);
  const d = JSON.parse(r.stdout);
  assert.equal(r.status, 0);
  assert.equal(d.routed, 200);
  assert.equal(d.misroutes, 0);
  assert.equal(d.errors, 0);
});
test('single qualified tools/call works', () => {
  const r = run(['call', '--config', config, '--tool', 'text::wordcount', '--args', '{"path":"a.txt"}', '--json']);
  const d = JSON.parse(r.stdout);
  assert.equal(r.status, 0);
  assert.equal(d.ok, true);
  assert.match(d.content[0].text, /"words":3/);
});
test('bad config exits 2', () => {
  const r = run(['scan', '--config', path.join(root, 'examples/in/missing.json')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read config/);
});
test('missing --config exits 2', () => {
  assert.equal(run(['scan']).status, 2);
});
test('two scans produce the same determinism hash', () => {
  const a = JSON.parse(run(['scan', '--config', config, '--json']).stdout).determinism.sha256;
  const b = JSON.parse(run(['scan', '--config', config, '--json']).stdout).determinism.sha256;
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
});
