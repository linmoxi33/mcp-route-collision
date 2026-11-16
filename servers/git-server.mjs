import { execFileSync } from 'node:child_process'; import path from 'node:path';
import { serve } from './_stdio.mjs';
const ROOT = path.resolve(process.env.MCP_GIT_ROOT || process.cwd());
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const tools = [
  { name: 'status', description: 'git status --porcelain', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'log', description: 'git log oneline', inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, required: [] } },
  { name: 'diff', description: 'git diff (worktree)', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: [] } },
  { name: 'show', description: 'git show a revision', inputSchema: { type: 'object', properties: { rev: { type: 'string' } }, required: ['rev'] } },
  { name: 'branch_list', description: 'List branches', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'search', description: 'git grep in tracked files', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'read_file', description: 'Read a file at a revision', inputSchema: { type: 'object', properties: { path: { type: 'string' }, rev: { type: 'string' } }, required: ['path', 'rev'] } },
  { name: 'list_dir', description: 'List a tree at a revision', inputSchema: { type: 'object', properties: { path: { type: 'string' }, rev: { type: 'string' } }, required: ['path', 'rev'] } },
];
const call = (name, a) => {
  switch (name) {
    case 'status': return { porcelain: git(['status', '--porcelain']) };
    case 'log': return { log: git(['log', '--oneline', '-n', String(a.limit ?? 10)]).trim().split('\n').filter(Boolean) };
    case 'diff': return { diff: git(a.path ? ['diff', '--', a.path] : ['diff']) };
    case 'show': return { show: git(['show', '--stat', '--oneline', a.rev]) };
    case 'branch_list': return { branches: git(['branch', '--format=%(refname:short)']).trim().split('\n').filter(Boolean) };
    case 'search': return { matches: git(['grep', '-n', a.pattern]).trim().split('\n').filter(Boolean) };
    case 'read_file': return { content: git(['show', a.rev + ':' + a.path]) };
    case 'list_dir': return { entries: git(['ls-tree', '--name-only', a.rev, a.path]).trim().split('\n').filter(Boolean) };
    default: throw new Error('unknown tool: ' + name);
  }
};
serve(tools, call);
