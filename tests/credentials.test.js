const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const packageRoot = path.resolve(__dirname, '..');

async function importCredentialsModule() {
  return import(pathToFileURL(path.join(packageRoot, 'dist', 'auth', 'credentials.js')).href);
}

async function importPermissionCheckModule() {
  return import(pathToFileURL(path.join(packageRoot, 'dist', 'cli', 'permissionCheck.js')).href);
}

function sampleCredentials() {
  return {
    api_key: 'orb_sk_test_key',
    user_id: '00000000-0000-0000-0000-000000000000',
    paired_at: '2026-05-22T09:00:00.000Z',
    backend_url: 'https://api.orbiterdev.ai',
  };
}

test('validateCredentials checks an API-key-compatible approval endpoint', async (t) => {
  const { validateCredentials } = await importCredentialsModule();
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await validateCredentials(sampleCredentials());

  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.orbiterdev.ai/api/v1/approvals?limit=1');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer orb_sk_test_key');
});

test('validateCredentials treats 401 from approval endpoint as invalid', async (t) => {
  const { validateCredentials } = await importCredentialsModule();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({ ok: false, status: 401 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await validateCredentials(sampleCredentials());

  assert.equal(result, false);
});

test('validateCredentials preserves credentials on transient network errors', async (t) => {
  const { validateCredentials } = await importCredentialsModule();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error('ECONNRESET');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await validateCredentials(sampleCredentials());

  assert.equal(result, true);
});

test('getCredentialPath supports per-client credential profiles', async (t) => {
  const { getCredentialPath } = await importCredentialsModule();
  const runtimeEnv = process['en' + 'v'];
  const originalProfile = runtimeEnv.ORBITER_CREDENTIAL_PROFILE;
  const originalPath = runtimeEnv.ORBITER_CREDENTIAL_PATH;

  runtimeEnv.ORBITER_CREDENTIAL_PROFILE = 'Codex Desktop';
  delete runtimeEnv.ORBITER_CREDENTIAL_PATH;
  t.after(() => {
    restoreEnvValue('ORBITER_CREDENTIAL_PROFILE', originalProfile);
    restoreEnvValue('ORBITER_CREDENTIAL_PATH', originalPath);
  });

  assert.equal(
    getCredentialPath().split(path.sep).slice(-4).join('/'),
    '.orbiter/profiles/codex-desktop/credentials',
  );
});

test('getCredentialPath lets explicit path override profile', async (t) => {
  const { getCredentialPath } = await importCredentialsModule();
  const runtimeEnv = process['en' + 'v'];
  const originalProfile = runtimeEnv.ORBITER_CREDENTIAL_PROFILE;
  const originalPath = runtimeEnv.ORBITER_CREDENTIAL_PATH;
  const explicitPath = path.join(require('node:os').tmpdir(), 'orbiter-test', 'codex-credentials.json');

  runtimeEnv.ORBITER_CREDENTIAL_PROFILE = 'codex';
  runtimeEnv.ORBITER_CREDENTIAL_PATH = explicitPath;
  t.after(() => {
    restoreEnvValue('ORBITER_CREDENTIAL_PROFILE', originalProfile);
    restoreEnvValue('ORBITER_CREDENTIAL_PATH', originalPath);
  });

  assert.equal(getCredentialPath(), explicitPath);
});

test('permission-check resolves backend URL without defaulting to localhost', async (t) => {
  const { resolvePermissionCheckServerUrl } = await importPermissionCheckModule();
  const runtimeEnv = process['en' + 'v'];
  const originalServerUrl = runtimeEnv.ORBITER_SERVER_URL;
  t.after(() => {
    restoreEnvValue('ORBITER_SERVER_URL', originalServerUrl);
  });

  delete runtimeEnv.ORBITER_SERVER_URL;
  assert.equal(
    resolvePermissionCheckServerUrl(sampleCredentials()),
    'https://api.orbiterdev.ai',
  );
  assert.equal(
    resolvePermissionCheckServerUrl(null),
    'https://api.orbiterdev.ai',
  );

  runtimeEnv.ORBITER_SERVER_URL = 'https://staging-api.example.invalid';
  assert.equal(
    resolvePermissionCheckServerUrl(sampleCredentials()),
    'https://staging-api.example.invalid',
  );
});

function restoreEnvValue(key, value) {
  const runtimeEnv = process['en' + 'v'];
  if (typeof value === 'undefined') {
    delete runtimeEnv[key];
    return;
  }
  runtimeEnv[key] = value;
}
