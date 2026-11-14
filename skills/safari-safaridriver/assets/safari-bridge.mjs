import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';

const DRIVER = '/usr/bin/safaridriver';
const PORT = 4737;
const HOST = '127.0.0.1';
const READY_MS = 700;
const pidFile = '/private/var/folders/7w/4lmvtkb116g3zh9cbyzm3wwm0000gn/T/opencode/safari-bridge.pid';

function die(msg) {
  process.stderr.write(`safari-bridge: ${msg}\n`);
  process.exit(1);
}

function dieWithDriver(msg) {
  process.stderr.write(`safari-bridge: ${msg}\n`);
  if (driver.exitCode === null && driver.signalCode === null) driver.kill('SIGTERM');
  process.exit(1);
}

function pidFileIsMine() {
  try {
    return readFileSync(pidFile, 'utf8').trim() === String(process.pid);
  } catch {
    return false;
  }
}

if (existsSync(pidFile) && pidFileIsMine() === false) {
  const old = readFileSync(pidFile, 'utf8').trim();
  try {
    process.kill(Number(old), 0);
    die(`PID file ${pidFile} says a bridge runs as PID ${old}. Reuse it (curl http://${HOST}:${PORT}/call), do not start a second one.`);
  } catch {
    die(`stale PID file ${pidFile} (PID ${old} not running). Delete it and retry.`);
  }
}

const driver = spawn(DRIVER, ['--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
driver.stderr.on('data', () => {});
driver.on('exit', (code, signal) => {
  process.stderr.write(`safari-bridge: safaridriver exited (${code ?? signal})\n`);
  process.exit(code ?? 1);
});

let buf = '';
driver.stdout.setEncoding('utf8');
driver.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }
});

const pending = new Map();
let nextId = 1;

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    driver.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params) {
  driver.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const server = createServer((req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method !== 'POST' || req.url !== '/call') return json(404, { error: 'POST /call only' });
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 4_000_000) req.destroy();
  });
  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch (e) {
      return json(400, { error: `bad JSON: ${e.message}` });
    }
    if (!payload.tool) return json(400, { error: 'missing "tool"' });
    try {
      const result = await send('tools/call', { name: payload.tool, arguments: payload.args ?? {} });
      const text = (result.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      if (result.isError) return json(500, { ok: false, error: text });
      json(200, { ok: true, text, structured: result.structuredContent ?? null });
    } catch (e) {
      json(500, { ok: false, error: e.message });
    }
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    let pid = 'unknown';
    try {
      pid = readFileSync(pidFile, 'utf8').trim();
    } catch {}
    dieWithDriver(`port ${PORT} already bound — a bridge is already running (PID ${pid}). Reuse it, do not start a second one.`);
  }
  dieWithDriver(`server error: ${e.message}`);
});

server.listen(PORT, HOST, async () => {
  try {
    await new Promise((r) => setTimeout(r, READY_MS));
    await send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'safari-bridge', version: '1.0.0' },
    });
    notify('notifications/initialized', {});
    try {
      writeFileSync(pidFile, String(process.pid));
    } catch {}
    process.stderr.write(`safari-bridge: ready on http://${HOST}:${PORT}/call (self PID ${process.pid}, driver PID ${driver.pid})\n`);
  } catch (e) {
    dieWithDriver(`initialize failed: ${e.message}`);
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    driver.kill(sig);
    if (pidFileIsMine()) {
      try {
        unlinkSync(pidFile);
      } catch {}
    }
    process.exit(0);
  });
}
