// Minimal newline-delimited JSON-RPC stdio loop shared by the demo servers.
export function serve(tools, call) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) handle(JSON.parse(line));
    }
  });
  function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
  function handle(msg) {
    if (msg.id === undefined) return; // notification
    try {
      if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1.0.0' } } });
      if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
      if (msg.method === 'tools/call') {
        const args = msg.params?.arguments ?? {};
        const out = call(msg.params?.name, args);
        return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
      }
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } });
    } catch (e) {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } });
    }
  }
}
