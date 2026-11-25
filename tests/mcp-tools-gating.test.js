const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const cliPath = path.join(packageRoot, 'dist', 'index.js');

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

  const listResp = responses.get(2);
  assert.ok(listResp && listResp.result && Array.isArray(listResp.result.tools));
  const names = listResp.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, EXPECTED_CORE_TOOLS);

  for (const legacyName of EXPECTED_LEGACY_TOOLS) {
    assert.ok(!names.includes(legacyName), `legacy tool ${legacyName} must not be exposed by default`);
  }

  const approveTool = listResp.result.tools.find((tool) => tool.name === 'request_approval');
  assert.ok(approveTool);
  assert.doesNotMatch(approveTool.description, /CATASTROPHIC|CRITICAL REQUIREMENT|FAILURE TO USE/i);
  assert.equal(approveTool.annotations.readOnlyHint, false);
  assert.equal(approveTool.annotations.destructiveHint, false);

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
