const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { handleNotifyUser } = require('../dist/tools/notify.js');
const { handleKillAgent } = require('../dist/tools/kill.js');
const { handleAuth } = require('../dist/tools/auth.js');
const { handleAuthVerify } = require('../dist/tools/auth_verify.js');

const packageRoot = path.resolve(__dirname, '..');
const cliPath = path.join(packageRoot, 'dist', 'index.js');

function startMockServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const EXPECTED_CORE_TOOLS = [
  'request_approval',
  'orbiter_auth',
  'orbiter_auth_verify',
  'notify_user',
  'kill_agent',
];

const EXPECTED_LEGACY_TOOLS = [
  'agent_heartbeat',
  'checkpoint_post',
  'context_health',
  'report_tool_result',
  'session_memory',
  'report_usage',
  'get_project_instincts',
  'add_project_instinct',
];

function queryMcpStdio(args = [], extraEnv = {}, requests = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: packageRoot,
      env: {
        ...process.env,
        ORBITER_ENABLE_LEGACY_TOOLS: '',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses = new Map();
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Timed out waiting for MCP stdio responses. Received: ${JSON.stringify([...responses.keys()])}`));
    }, 10000);

    const expectedIds = requests.map((req) => req.id).filter((id) => id !== undefined);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) {
            responses.set(msg.id, msg);
          }
          if (expectedIds.every((id) => responses.has(id))) {
            settled = true;
            clearTimeout(timer);
            child.kill();
            resolve(responses);
          }
        } catch {
          // Ignore non-JSON lines if any
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    for (const req of requests) {
      child.stdin.write(`${JSON.stringify(req)}\n`);
    }
  });
}

test('ORB-35: default MCP server exposes only 5 core tools and blocks legacy tool calls', async () => {
  const responses = await queryMcpStdio([], {}, [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'orb-35-test', version: '1.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'session_memory', arguments: {} },
    },
  ]);

  const initResp = responses.get(1);
  assert.ok(initResp && initResp.result);
  assert.equal(typeof initResp.result.instructions, 'string');
  assert.ok(initResp.result.instructions.length > 100, 'initialize must publish concise server instructions');
  assert.match(initResp.result.instructions, /request_approval/);
  assert.match(initResp.result.instructions, /notify_user/);
  assert.match(initResp.result.instructions, /orbiter_auth/);
  assert.match(initResp.result.instructions, /orbiter_auth_verify/);
  assert.ok(!initResp.result.instructions.includes('\u2014'), 'server instructions must contain zero Unicode em dashes');

  const listResp = responses.get(2);
  assert.ok(listResp && listResp.result && Array.isArray(listResp.result.tools));
  const names = listResp.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, EXPECTED_CORE_TOOLS);

  for (const legacyName of EXPECTED_LEGACY_TOOLS) {
    assert.ok(!names.includes(legacyName), `legacy tool ${legacyName} must not be exposed by default`);
  }

  for (const tool of listResp.result.tools) {
    assert.ok(!tool.description.includes('\u2014'), `${tool.name} description must contain zero Unicode em dashes`);
    assert.ok(tool.annotations && typeof tool.annotations.title === 'string', `${tool.name} must define annotations.title`);
    for (const [paramName, prop] of Object.entries(tool.inputSchema.properties || {})) {
      assert.equal(typeof prop.description, 'string', `${tool.name}.${paramName} must have a description`);
      assert.ok(prop.description.length >= 25, `${tool.name}.${paramName} description should be detailed`);
      assert.ok(!prop.description.includes('\u2014'), `${tool.name}.${paramName} must contain zero Unicode em dashes`);
    }
  }

  const toolsByName = Object.fromEntries(listResp.result.tools.map((t) => [t.name, t]));

  const approveTool = toolsByName.request_approval;
  assert.ok(approveTool);
  assert.doesNotMatch(approveTool.description, /CATASTROPHIC|CRITICAL REQUIREMENT|FAILURE TO USE/i);
  assert.match(approveTool.description, /notify_user/);
  assert.match(approveTool.description, /approved/);
  assert.match(approveTool.description, /rejected|denied/);
  assert.match(approveTool.description, /expired|timeout/);
  assert.equal(approveTool.annotations.readOnlyHint, false);
  assert.equal(approveTool.annotations.destructiveHint, false);

  const notifyTool = toolsByName.notify_user;
  assert.match(notifyTool.description, /request_approval/);
  assert.match(notifyTool.description, /fire-and-forget|one-way/i);
  assert.match(notifyTool.description, /channel/);
  assert.match(notifyTool.description, /timestamp/);
  assert.match(notifyTool.description, /ORBITER_NTFY_TOPIC/);

  const killTool = toolsByName.kill_agent;
  assert.match(killTool.description, /idempotent/i);
  assert.match(killTool.description, /404|unknown/i);
  assert.equal(killTool.inputSchema.properties.session_id.format, 'uuid');

  const authToolDef = toolsByName.orbiter_auth;
  assert.match(authToolDef.description, /device_code/);
  assert.match(authToolDef.description, /pair_code/);
  assert.match(authToolDef.description, /expires_in/);

  const authVerifyToolDef = toolsByName.orbiter_auth_verify;
  assert.match(authVerifyToolDef.description, /~\/\.orbiter\/credentials/);
  assert.match(authVerifyToolDef.description, /readOnlyHint/);
  assert.match(authVerifyToolDef.description, /orbiter_auth/);

  const callResp = responses.get(3);
  assert.ok(callResp.error, 'calling a disabled legacy tool must return an error');
  assert.match(callResp.error.message, /--legacy-tools/);
});

test('ORB-35: --legacy-tools CLI flag exposes all 13 tools (5 core + 8 legacy)', async () => {
  const responses = await queryMcpStdio(['--legacy-tools'], {}, [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'orb-35-test', version: '1.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);

  const names = responses.get(2).result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [...EXPECTED_CORE_TOOLS, ...EXPECTED_LEGACY_TOOLS]);
  assert.equal(names.length, 13);
});

test('ORB-35: ORBITER_ENABLE_LEGACY_TOOLS=1 exposes all 13 tools', async () => {
  const responses = await queryMcpStdio([], { ORBITER_ENABLE_LEGACY_TOOLS: '1' }, [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'orb-35-test', version: '1.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);

  const names = responses.get(2).result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [...EXPECTED_CORE_TOOLS, ...EXPECTED_LEGACY_TOOLS]);
  assert.equal(names.length, 13);
});

test('TDQS runtime contracts: notify_user, kill_agent, orbiter_auth, and orbiter_auth_verify return documented fields', async () => {
  const savedEnv = {
    ORBITER_API_URL: process.env.ORBITER_API_URL,
    ORBITER_SERVER_URL: process.env.ORBITER_SERVER_URL,
    ORBITER_NTFY_TOPIC: process.env.ORBITER_NTFY_TOPIC,
    ORBITER_TOKEN: process.env.ORBITER_TOKEN,
    ORBITER_CREDENTIAL_PATH: process.env.ORBITER_CREDENTIAL_PATH,
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbiter-tdqs-'));
  const credFile = path.join(tmpDir, 'credentials');
  const sessionUuid = '11111111-2222-4333-8444-555555555555';
  const missingUuid = '99999999-2222-4333-8444-555555555555';
  const deviceCode = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  let failNotify = false;
  let pollMode = 'authorized';

  const mock = await startMockServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/notify') {
      if (failNotify) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'push unavailable' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }
    if (req.method === 'POST' && req.url === `/api/v1/sessions/${sessionUuid}/kill`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { session_id: sessionUuid, status: 'killed' } }));
      return;
    }
    if (req.method === 'POST' && req.url === `/api/v1/sessions/${missingUuid}/kill`) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/auth/ide/claim') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: { status: 'awaiting_confirmation', device_code: deviceCode },
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/v1/auth/device/poll')) {
      if (pollMode === 'authorized') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: { status: 'authorized', api_key: 'mock-credential-placeholder', user_id: 'user-123' },
        }));
        return;
      }
      if (pollMode === 'expired') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'expired_token' }));
        return;
      }
      if (pollMode === 'denied') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'access_denied' }));
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });

  try {
    process.env.ORBITER_API_URL = mock.url;
    delete process.env.ORBITER_SERVER_URL;
    delete process.env.ORBITER_NTFY_TOPIC;
    delete process.env.ORBITER_TOKEN;
    process.env.ORBITER_CREDENTIAL_PATH = credFile;

    // 1. notify_user success + structured non-throwing failure
    const notifyOk = JSON.parse((await handleNotifyUser({ title: 'Build done', message: 'All green', priority: 'default' })).content[0].text);
    assert.equal(notifyOk.success, true);
    assert.equal(notifyOk.channel, 'orbiter_push');
    assert.equal(notifyOk.provider, 'backend');
    assert.ok(!Number.isNaN(Date.parse(notifyOk.timestamp)));

    failNotify = true;
    const notifyErr = JSON.parse((await handleNotifyUser({ title: 'Build done', message: 'All green' })).content[0].text);
    assert.equal(notifyErr.success, false);
    assert.equal(notifyErr.channel, 'orbiter_push');
    assert.match(notifyErr.error, /503/);
    assert.ok(notifyErr.hint);

    // 2. kill_agent success + 404 structured non-throwing failure
    const killOk = JSON.parse((await handleKillAgent({ session_id: sessionUuid, reason: 'Loop detected' })).content[0].text);
    assert.equal(killOk.success, true);
    assert.equal(killOk.session_id, sessionUuid);
    assert.equal(killOk.status, 'killed');

    const killMissing = JSON.parse((await handleKillAgent({ session_id: missingUuid })).content[0].text);
    assert.equal(killMissing.success, false);
    assert.equal(killMissing.session_id, missingUuid);
    assert.match(killMissing.error, /404/);

    // 3. orbiter_auth claim returns pair_code, device_code, expires_in
    const authClaim = JSON.parse((await handleAuth({ code: 'k7n3' })).content[0].text);
    assert.equal(authClaim.success, true);
    assert.equal(authClaim.pair_code, 'ORBIT-K7N3');
    assert.equal(authClaim.device_code, deviceCode);
    assert.equal(authClaim.expires_in, 300);

    // 4. orbiter_auth_verify persists credentials and handles expired/denied recovery
    const verifyOk = JSON.parse((await handleAuthVerify({ device_code: deviceCode }, { backendUrl: mock.url, maxWaitMs: 500, intervalMs: 20 })).content[0].text);
    assert.equal(verifyOk.success, true);
    assert.equal(verifyOk.status, 'paired');
    assert.equal(verifyOk.credentials_saved, true);
    assert.ok(fs.existsSync(credFile), 'credentials must be persisted to credential path on paired');

    pollMode = 'expired';
    const verifyExp = JSON.parse((await handleAuthVerify({ device_code: deviceCode }, { backendUrl: mock.url, maxWaitMs: 500, intervalMs: 20 })).content[0].text);
    assert.equal(verifyExp.success, false);
    assert.equal(verifyExp.status, 'expired');
    assert.match(verifyExp.recovery, /orbiter_auth/);

    pollMode = 'denied';
    const verifyDen = JSON.parse((await handleAuthVerify({ device_code: deviceCode }, { backendUrl: mock.url, maxWaitMs: 500, intervalMs: 20 })).content[0].text);
    assert.equal(verifyDen.success, false);
    assert.equal(verifyDen.status, 'denied');
    assert.match(verifyDen.recovery, /orbiter_auth/);
  } finally {
    await mock.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
