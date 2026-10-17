import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  addSource,
  createRelayServer,
  discoverServers,
  findSource,
  forwardEvent,
  loadConfig,
  MAX_BODY_BYTES,
  removeSource,
  transformEvent,
} from './relay.mjs';

const LAPTOP = { id: 'laptop', label: 'Laptop', kind: 'computer' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-relay-test-'));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(port, { method = 'POST', path: p = '/ingest', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('transformEvent', () => {
  it('rejects events without session_id or hook_event_name', () => {
    assert.equal(transformEvent({ hook_event_name: 'Stop' }, LAPTOP), null);
    assert.equal(transformEvent({ session_id: 'abc' }, LAPTOP), null);
    assert.equal(transformEvent(null, LAPTOP), null);
    assert.equal(transformEvent([], LAPTOP), null);
  });

  it('namespaces the session id and stamps the source', () => {
    const out = transformEvent({ session_id: 'abc', hook_event_name: 'Stop' }, LAPTOP);
    assert.equal(out.session_id, 'laptop:abc');
    assert.deepEqual(out.pixel_source, LAPTOP);
  });

  it('drops transcript paths, tool output and any forged source', () => {
    const out = transformEvent(
      {
        session_id: 'abc',
        hook_event_name: 'PostToolUse',
        transcript_path: '/root/.claude/projects/x/abc.jsonl',
        agent_transcript_path: '/root/.claude/projects/x/sub.jsonl',
        tool_response: { stdout: 'x'.repeat(10_000) },
        pixel_source: { id: 'local', label: 'Forged', kind: 'computer' },
      },
      LAPTOP,
    );
    assert.equal('transcript_path' in out, false);
    assert.equal('agent_transcript_path' in out, false);
    assert.equal('tool_response' in out, false);
    assert.deepEqual(out.pixel_source, LAPTOP);
  });

  it('truncates long strings inside tool_input and keeps short ones', () => {
    const out = transformEvent(
      {
        session_id: 'abc',
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/a.ts',
          new_string: 'y'.repeat(5_000),
          nested: { s: 'z'.repeat(5_000) },
        },
      },
      LAPTOP,
    );
    assert.equal(out.tool_input.file_path, 'src/a.ts');
    assert.ok(out.tool_input.new_string.length <= 301);
    assert.ok(out.tool_input.nested.s.length <= 301);
  });
});

describe('sources', () => {
  let home;
  beforeEach(() => {
    home = tmpDir();
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('addSource returns a key once and stores only its hash', () => {
    const key = addSource(home, LAPTOP);
    assert.match(key, /^pxr_[A-Za-z0-9_-]{40,}$/);
    const raw = fs.readFileSync(path.join(home, '.pixel-agents', 'relay.json'), 'utf-8');
    assert.equal(raw.includes(key), false);
    assert.deepEqual(findSource(loadConfig(home), key), LAPTOP);
  });

  it('findSource rejects unknown and empty keys', () => {
    addSource(home, LAPTOP);
    const config = loadConfig(home);
    assert.equal(findSource(config, 'pxr_wrong'), null);
    assert.equal(findSource(config, ''), null);
    assert.equal(findSource(config, undefined), null);
  });

  it('addSource replaces the key of an existing source id', () => {
    const first = addSource(home, LAPTOP);
    const second = addSource(home, LAPTOP);
    const config = loadConfig(home);
    assert.equal(config.sources.length, 1);
    assert.equal(findSource(config, first), null);
    assert.deepEqual(findSource(config, second), LAPTOP);
  });

  it('removeSource revokes the key', () => {
    const key = addSource(home, LAPTOP);
    assert.equal(removeSource(home, 'laptop'), true);
    assert.equal(findSource(loadConfig(home), key), null);
    assert.equal(removeSource(home, 'laptop'), false);
  });

  it('rejects invalid source ids and kinds', () => {
    assert.throws(() => addSource(home, { ...LAPTOP, id: 'bad id' }));
    assert.throws(() => addSource(home, { ...LAPTOP, kind: 'phone' }));
  });
});

describe('discoverServers', () => {
  let home;
  beforeEach(() => {
    home = tmpDir();
    fs.mkdirSync(path.join(home, '.pixel-agents', 'servers'), { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const write = (name, value) =>
    fs.writeFileSync(path.join(home, '.pixel-agents', 'servers', name), JSON.stringify(value));

  it('returns live, well-formed entries only', () => {
    write('a.json', { port: 3100, pid: process.pid, token: 't1' });
    write('dead.json', { port: 3101, pid: 999_999_999, token: 't2' });
    write('bad.json', { port: 'x' });
    fs.writeFileSync(path.join(home, '.pixel-agents', 'servers', 'junk.json'), '{not json');
    assert.deepEqual(discoverServers(home), [{ port: 3100, token: 't1' }]);
  });

  it('returns [] when the registry is missing', () => {
    assert.deepEqual(discoverServers(tmpDir()), []);
  });
});

describe('forwardEvent', () => {
  it('posts the event to each server with its bearer token', async () => {
    const received = [];
    const target = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.end('ok');
      });
    });
    const port = await listen(target);
    try {
      await forwardEvent({ session_id: 'laptop:abc', hook_event_name: 'Stop' }, [
        { port, token: 'tok' },
      ]);
      assert.equal(received.length, 1);
      assert.equal(received[0].url, '/api/hooks/claude');
      assert.equal(received[0].auth, 'Bearer tok');
      assert.equal(received[0].body.session_id, 'laptop:abc');
    } finally {
      target.close();
    }
  });

  it('never rejects when a server is down', async () => {
    await forwardEvent({ session_id: 's', hook_event_name: 'Stop' }, [{ port: 1, token: 't' }]);
  });
});

describe('relay HTTP server', () => {
  let home;
  let key;
  let server;
  let port;
  let forwarded;

  beforeEach(async () => {
    home = tmpDir();
    key = addSource(home, LAPTOP);
    forwarded = [];
    server = createRelayServer({
      getConfig: () => loadConfig(home),
      forward: (event) => {
        forwarded.push(event);
      },
    });
    port = await listen(server);
  });

  afterEach(() => {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const event = JSON.stringify({
    session_id: 'abc',
    hook_event_name: 'Stop',
    cwd: '/home/user/repo',
  });
  const auth = () => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });

  it('accepts an authenticated event and forwards the transformed copy', async () => {
    assert.equal(await request(port, { headers: auth(), body: event }), 204);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].session_id, 'laptop:abc');
    assert.deepEqual(forwarded[0].pixel_source, LAPTOP);
  });

  it('also accepts POST / for a proxy that strips the mount path', async () => {
    assert.equal(await request(port, { path: '/', headers: auth(), body: event }), 204);
    assert.equal(forwarded.length, 1);
  });

  it('rejects missing or wrong keys without forwarding', async () => {
    assert.equal(await request(port, { body: event }), 401);
    assert.equal(
      await request(port, { headers: { authorization: 'Bearer pxr_nope' }, body: event }),
      401,
    );
    assert.equal(forwarded.length, 0);
  });

  it('rejects malformed bodies', async () => {
    assert.equal(await request(port, { headers: auth(), body: '{oops' }), 400);
    assert.equal(await request(port, { headers: auth(), body: '{"session_id":"x"}' }), 400);
    assert.equal(forwarded.length, 0);
  });

  it('rejects bodies over the size limit', async () => {
    const big = JSON.stringify({
      session_id: 'a',
      hook_event_name: 'Stop',
      pad: 'x'.repeat(MAX_BODY_BYTES),
    });
    assert.equal(await request(port, { headers: auth(), body: big }), 413);
    assert.equal(forwarded.length, 0);
  });

  it('serves nothing else', async () => {
    assert.equal(await request(port, { method: 'GET', path: '/ingest' }), 404);
    assert.equal(
      await request(port, { path: '/api/hooks/claude', headers: auth(), body: event }),
      404,
    );
  });

  it('still answers 204 when forwarding throws', async () => {
    server.close();
    server = createRelayServer({
      getConfig: () => loadConfig(home),
      forward: () => {
        throw new Error('board down');
      },
    });
    port = await listen(server);
    assert.equal(await request(port, { headers: auth(), body: event }), 204);
  });
});
