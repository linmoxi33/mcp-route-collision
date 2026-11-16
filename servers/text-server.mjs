import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { serve } from './_stdio.mjs';
const ROOT = path.resolve(process.env.MCP_FS_ROOT || process.cwd());
function p(rel) { const abs = path.resolve(ROOT, rel || '.'); if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error('path escapes root: ' + rel); return abs; }
const tools = [
  { name: 'read_lines', description: 'Read a line range from a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } }, required: ['path'] } },
  { name: 'search', description: 'Regex search file contents', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern', 'path'] } },
  { name: 'wordcount', description: 'Count words/lines/bytes in a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'replace', description: 'Literal replace in a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['path', 'from', 'to'] } },
  { name: 'sort_lines', description: 'Sort lines of a file in place', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'uniq', description: 'Drop adjacent duplicate lines', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'hash', description: 'Hash a string', inputSchema: { type: 'object', properties: { text: { type: 'string' }, algo: { type: 'string' } }, required: ['text'] } },
  { name: 'encode', description: 'Encode text as base64 or hex', inputSchema: { type: 'object', properties: { text: { type: 'string' }, format: { type: 'string' } }, required: ['text', 'format'] } },
  { name: 'diff', description: 'Line diff between two files', inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] } },
  { name: 'json_query', description: 'Read a dotted JSON path from a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string' } }, required: ['path', 'query'] } },
];
const call = (name, a) => {
  const read = (f) => fs.readFileSync(p(f), 'utf8');
  switch (name) {
    case 'read_lines': { const ls = read(a.path).split('\n'); return { lines: ls.slice(a.start ?? 0, a.end ?? ls.length) }; }
    case 'search': { const re = new RegExp(a.pattern); return { matches: read(a.path).split('\n').map((l, i) => ({ line: i + 1, text: l })).filter((x) => re.test(x.text)) }; }
    case 'wordcount': { const t = read(a.path); return { words: t.split(/\s+/).filter(Boolean).length, lines: t.split('\n').length, bytes: Buffer.byteLength(t) }; }
    case 'replace': { const t = read(a.path); const n = t.split(a.from).length - 1; fs.writeFileSync(p(a.path), t.split(a.from).join(a.to)); return { replacements: n }; }
    case 'sort_lines': { const ls = read(a.path).split('\n').sort(); fs.writeFileSync(p(a.path), ls.join('\n')); return { lines: ls.length }; }
    case 'uniq': { const ls = read(a.path).split('\n').filter((l, i, arr) => i === 0 || l !== arr[i - 1]); fs.writeFileSync(p(a.path), ls.join('\n')); return { lines: ls.length }; }
    case 'hash': return { algo: a.algo || 'sha256', hex: crypto.createHash(a.algo || 'sha256').update(a.text).digest('hex') };
    case 'encode': return { format: a.format, value: a.format === 'base64' ? Buffer.from(a.text).toString('base64') : Buffer.from(a.text).toString('hex') };
    case 'diff': { const A = read(a.a).split('\n'), B = read(a.b).split('\n'); const out = []; for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) out.push({ line: i + 1, a: A[i] ?? null, b: B[i] ?? null }); return { changed: out.length, hunks: out }; }
    case 'json_query': { let v = JSON.parse(read(a.path)); for (const k of a.query.split('.')) v = v?.[k]; return { value: v }; }
    default: throw new Error('unknown tool: ' + name);
  }
};
serve(tools, call);
