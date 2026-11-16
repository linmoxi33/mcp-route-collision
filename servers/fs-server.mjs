import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { serve } from './_stdio.mjs';
const ROOT = path.resolve(process.env.MCP_FS_ROOT || process.cwd());
function p(rel) { const abs = path.resolve(ROOT, rel || '.'); if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error('path escapes root: ' + rel); return abs; }
const tools = [
  { name: 'read_file', description: 'Read a UTF-8 file under the sandbox root', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write a UTF-8 file under the sandbox root', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'list_dir', description: 'List directory entries under the sandbox root', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'stat', description: 'Stat a path under the sandbox root', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'delete', description: 'Delete a file under the sandbox root', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'copy', description: 'Copy a file inside the sandbox root', inputSchema: { type: 'object', properties: { src: { type: 'string' }, dst: { type: 'string' } }, required: ['src', 'dst'] } },
  { name: 'move', description: 'Move a file inside the sandbox root', inputSchema: { type: 'object', properties: { src: { type: 'string' }, dst: { type: 'string' } }, required: ['src', 'dst'] } },
  { name: 'mkdir', description: 'Create a directory under the sandbox root', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'search', description: 'Find file names matching a glob-ish pattern', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
];
function walk(dir, acc) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f, acc); else acc.push(f); } return acc; }
const call = (name, a) => {
  switch (name) {
    case 'read_file': return { path: a.path, content: fs.readFileSync(p(a.path), 'utf8') };
    case 'write_file': fs.writeFileSync(p(a.path), a.content); return { path: a.path, bytes: Buffer.byteLength(a.content) };
    case 'list_dir': return { path: a.path, entries: fs.readdirSync(p(a.path)) };
    case 'stat': { const s = fs.statSync(p(a.path)); return { path: a.path, size: s.size, mtimeMs: Math.round(s.mtimeMs) }; }
    case 'delete': fs.unlinkSync(p(a.path)); return { deleted: a.path };
    case 'copy': fs.copyFileSync(p(a.src), p(a.dst)); return { copied: [a.src, a.dst] };
    case 'move': fs.renameSync(p(a.src), p(a.dst)); return { moved: [a.src, a.dst] };
    case 'mkdir': fs.mkdirSync(p(a.path), { recursive: true }); return { created: a.path };
    case 'search': { const re = new RegExp('^' + String(a.pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'); return { pattern: a.pattern, matches: walk(ROOT, []).map((f) => path.relative(ROOT, f)).filter((f) => re.test(path.basename(f)) || re.test(f)) }; }
    default: throw new Error('unknown tool: ' + name);
  }
};
serve(tools, call);
