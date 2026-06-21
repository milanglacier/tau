const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Load the module with NO credentials configured: no TAU_USER / TAU_PASS env
// vars and no settings.json in the agent dir. AUTH_CONFIGURED is a load-time
// const computed from those, so it must be false here — exercising the
// `set_auth` "No credentials configured" rejection branch (bin/tau.js:541)
// that every other test file leaves unhit (they all configure credentials).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-auth-uncfg-'));
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');
delete process.env.TAU_USER;
delete process.env.TAU_PASS;

const { handleRpcCommand } = require('../bin/tau.js');

test('get_auth reports configured: false when no credentials are set', async () => {
  const resp = await handleRpcCommand({ type: 'get_auth' });
  assert.equal(resp.success, true);
  assert.equal(resp.data.configured, false);
});

test('set_auth rejects with "No credentials configured" when AUTH_CONFIGURED is false', async () => {
  const resp = await handleRpcCommand({ type: 'set_auth', enabled: true });
  assert.equal(resp.success, false);
  assert.match(resp.error, /No credentials configured/);
});
