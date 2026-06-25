const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Isolate settings + sessions in a temp tree, and configure auth credentials
// so set_auth can succeed. Env must be set before requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-rpc-'));
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');
process.env.TAU_USER = 'admin';
process.env.TAU_PASS = 's3cret';

const {
  handleRpcCommand,
  liveManager,
  appendSessionName,
  parsePiListModels,
  _setAuthForTest,
  _setExecFileForTest,
  SESSIONS_DIR,
} = require('../bin/tau.js');

interface RpcTestSession {
  id: string;
  cwd: string;
  model: string;
  modelSpec: string;
  thinkingLevel: string;
  isStreaming: boolean;
  sessionFile: string;
  sessionName: string | null;
  titleSet: boolean;
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  steeringMode: string;
  followUpMode: string;
  entries: Array<Record<string, unknown>>;
  contextUsage: { tokens?: number; usage?: { input_tokens: number; output_tokens: number } } | null;
  setSessionName: (name: unknown) => boolean;
  metadata: () => Record<string, unknown>;
  snapshot: () => Record<string, unknown>;
  send: (cmd: { id?: string; type?: string; [k: string]: unknown }) =>
    Promise<{ type: string; id?: string; success: boolean; data: Record<string, unknown>; error?: string }>;
}

const PROJ = path.join(SESSIONS_DIR, '--tmp--proj');
const SESSION_FILE = path.join(PROJ, 's.jsonl');

before(() => {
  fs.mkdirSync(PROJ, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ type: 'session', id: 's' }) + '\n');
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  liveManager.sessions.clear();
  _setAuthForTest(true);
  _setExecFileForTest(null);
});

function injectSession(overrides: Partial<RpcTestSession> = {}): RpcTestSession {
  const session: RpcTestSession = {
    id: 'tau_test',
    cwd: '/tmp/proj',
    model: 'openai/gpt-5.5',
    modelSpec: '',
    thinkingLevel: 'off',
    isStreaming: false,
    sessionFile: SESSION_FILE,
    sessionName: null,
    titleSet: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    entries: [{ type: 'message', message: { role: 'user', content: 'hi' } }],
    contextUsage: null,
    setSessionName: (name) => {
      const value = String(name || '').trim();
      session.sessionName = value || null;
      return !!value;
    },
    metadata: () => ({
      id: session.id, cwd: session.cwd, model: session.model, modelSpec: session.modelSpec,
      modelLabel: session.model, thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming,
      sessionFile: session.sessionFile, sessionName: session.sessionName, contextUsage: session.contextUsage,
      autoCompactionEnabled: session.autoCompactionEnabled, autoRetryEnabled: session.autoRetryEnabled,
      steeringMode: session.steeringMode, followUpMode: session.followUpMode,
    }),
    snapshot: () => ({
      session: { id: session.id },
      entries: session.entries,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      contextUsage: null,
    }),
    send: async (cmd) => ({ type: 'response', id: cmd.id, success: true, data: {} }),
    ...overrides,
  };
  liveManager.sessions.set(session.id, session);
  return session;
}

test('get_auth reports configured + enabled state', async () => {
  _setAuthForTest(false);
  let resp = await handleRpcCommand({ type: 'get_auth' });
  assert.equal(resp.success, true);
  assert.equal(resp.data.configured, true);
  assert.equal(resp.data.enabled, false);
  _setAuthForTest(true);
  resp = await handleRpcCommand({ type: 'get_auth' });
  assert.equal(resp.data.enabled, true);
});

test('set_auth toggles the enabled flag when credentials are configured', async () => {
  const resp = await handleRpcCommand({ type: 'set_auth', enabled: false });
  assert.equal(resp.success, true);
  assert.equal(resp.data.enabled, false);
  // toggling back on
  const resp2 = await handleRpcCommand({ type: 'set_auth', enabled: true });
  assert.equal(resp2.data.enabled, true);
});

test('parsePiListModels preserves slashful model ids from pi table output', () => {
  const out = parsePiListModels(`provider      model                                               context  max-out  thinking  images
anthropic     claude-opus-4-5                                     200K     64K      yes       yes
fireworks     accounts/fireworks/models/deepseek-v4-flash         1M       384K     yes       no
`);
  assert.deepEqual(out, [
    { provider: 'anthropic', id: 'claude-opus-4-5', context: '200K', maxOutput: '64K', thinking: true, images: true },
    { provider: 'fireworks', id: 'accounts/fireworks/models/deepseek-v4-flash', context: '1M', maxOutput: '384K', thinking: true, images: false },
  ]);
});

test('get_available_models returns parsed pi model list', async () => {
  _setExecFileForTest((file: string, args: string[], opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    assert.equal(file, 'pi');
    assert.deepEqual(args, ['--list-models']);
    cb(null, `provider      model                                               context  max-out  thinking  images
openrouter    z-ai/glm-5.2                                        128K     16K      yes       no
`, '');
  });
  const resp = await handleRpcCommand({ type: 'get_available_models' });
  assert.equal(resp.success, true);
  assert.deepEqual(resp.data.models, [
    { provider: 'openrouter', id: 'z-ai/glm-5.2', context: '128K', maxOutput: '16K', thinking: true, images: false },
  ]);
});

test('set_session_name with filePath appends a session_info record', async () => {
  const resp = await handleRpcCommand({ type: 'set_session_name', filePath: SESSION_FILE, name: 'Plan' });
  assert.equal(resp.success, true);
  assert.equal(resp.data.name, 'Plan');
  const lines = fs.readFileSync(SESSION_FILE, 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[lines.length - 1]).name, 'Plan');
});

test('set_session_name rejects empty names and invalid file paths', async () => {
  const empty = await handleRpcCommand({ type: 'set_session_name', filePath: SESSION_FILE, name: '   ' });
  assert.equal(empty.success, false);
  assert.match(empty.error, /Name cannot be empty/);
  const bad = await handleRpcCommand({ type: 'set_session_name', filePath: '/etc/hosts', name: 'x' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /Invalid session file/);
});

test('set_session_name with sessionId updates the matching live session', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'set_session_name', sessionId: session.id, name: 'Live title' });
  assert.equal(resp.success, true);
  assert.equal(session.sessionName, 'Live title');
  assert.equal(session.titleSet, true);
});

test('set_session_name with a filePath matching a live session updates that session without a sessionId', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'set_session_name', filePath: session.sessionFile, name: 'From file' });
  assert.equal(resp.success, true);
  // the matchingLive branch finds the live session by sessionFile and updates it
  assert.equal(session.sessionName, 'From file');
  assert.equal(session.titleSet, true);
});

test('set_session_name rejects when neither sessionId nor filePath is provided', async () => {
  const resp = await handleRpcCommand({ type: 'set_session_name', name: 'Orphan' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /sessionId or filePath required/);
});

test('get_state returns cached backend state for the session', async () => {
  const session = injectSession({ model: 'anthropic/claude', thinkingLevel: 'high', isStreaming: true });
  const resp = await handleRpcCommand({ type: 'get_state', sessionId: session.id });
  assert.equal(resp.success, true);
  assert.equal(resp.data.model, 'anthropic/claude');
  assert.equal(resp.data.thinkingLevel, 'high');
  assert.equal(resp.data.isStreaming, true);
  assert.equal(resp.data.sessionFile, SESSION_FILE);
});

test('get_messages returns cached entries', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'get_messages', sessionId: session.id });
  assert.equal(resp.success, true);
  assert.equal(resp.data.entries.length, 1);
});

test('live_session_snapshot_request returns a live_session_snapshot payload', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'live_session_snapshot_request', sessionId: session.id });
  assert.equal(resp.type, 'live_session_snapshot');
  assert.equal(resp.sessionId, session.id);
  assert.deepEqual(resp.entries, session.entries);
});

test('set_auto_compaction is proxied and updates cached state', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'set_auto_compaction', sessionId: session.id, enabled: false });
  assert.equal(resp.success, true);
  assert.equal(session.autoCompactionEnabled, false);
  const state = await handleRpcCommand({ type: 'get_state', sessionId: session.id });
  assert.equal(state.data.autoCompactionEnabled, false);
});

test('native commands require an active live session', async () => {
  const resp = await handleRpcCommand({ type: 'prompt', message: 'hi' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /No active Tau session/);
});

test('unknown command is rejected', async () => {
  const session = injectSession();
  const resp = await handleRpcCommand({ type: 'bogus', sessionId: session.id });
  assert.equal(resp.success, false);
  assert.match(resp.error, /Unknown command: bogus/);
});

test('native commands are proxied to the child and success is preserved', async () => {
  const session = injectSession({
    send: async (cmd) => ({ type: 'response', id: cmd.id, success: true, data: { ok: 1 } }),
  });
  const resp = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: 'hi' });
  assert.equal(resp.success, true);
  assert.equal(resp.data.ok, 1);
});

test('new RPC parity commands are proxied to the child', async () => {
  const seen: string[] = [];
  const session = injectSession({
    send: async (cmd) => {
      seen.push(cmd.type || '');
      return { type: 'response', id: cmd.id, success: true, data: { output: 'ok' } };
    },
  });
  for (const type of ['set_auto_retry', 'abort_retry', 'bash', 'abort_bash', 'set_steering_mode', 'set_follow_up_mode']) {
    const resp = await handleRpcCommand({ type, sessionId: session.id, command: 'echo ok', enabled: false, mode: 'all' });
    assert.equal(resp.success, true, type);
  }
  assert.deepEqual(seen, ['set_auto_retry', 'abort_retry', 'bash', 'abort_bash', 'set_steering_mode', 'set_follow_up_mode']);
  assert.equal(session.autoRetryEnabled, false);
  assert.equal(session.steeringMode, 'all');
  assert.equal(session.followUpMode, 'all');
});

test('get_commands is proxied to the child for slash command discovery', async () => {
  let seenType = '';
  const session = injectSession({
    send: async (cmd) => {
      seenType = cmd.type || '';
      return { type: 'response', id: cmd.id, success: true, data: { commands: [{ name: 'compact' }] } };
    },
  });
  const resp = await handleRpcCommand({ type: 'get_commands', sessionId: session.id });
  assert.equal(resp.success, true);
  assert.equal(seenType, 'get_commands');
  assert.deepEqual(resp.data.commands, [{ name: 'compact' }]);
});

test('session replacement commands are proxied and refresh cached state', async () => {
  const nextFile = path.join(PROJ, 'next.jsonl');
  const seen: string[] = [];
  const session = injectSession({
    send: async (cmd) => {
      seen.push(cmd.type || '');
      if (cmd.type === 'new_session') return { type: 'response', id: cmd.id, success: true, data: { cancelled: false } };
      if (cmd.type === 'get_state') {
        return {
          type: 'response',
          id: cmd.id,
          success: true,
          data: {
            sessionFile: nextFile,
            sessionName: 'Fresh',
            model: { provider: 'openrouter', id: 'z-ai/glm' },
            thinkingLevel: 'high',
            isStreaming: false,
          },
        };
      }
      if (cmd.type === 'get_messages') {
        return { type: 'response', id: cmd.id, success: true, data: { messages: [{ role: 'user', content: 'fresh prompt' }] } };
      }
      return { type: 'response', id: cmd.id, success: true, data: {} };
    },
  });
  const resp = await handleRpcCommand({ type: 'new_session', sessionId: session.id });
  assert.equal(resp.success, true);
  assert.deepEqual(seen, ['new_session', 'get_state', 'get_messages']);
  assert.equal(session.sessionFile, nextFile);
  assert.equal(session.sessionName, 'Fresh');
  assert.deepEqual(session.model, { provider: 'openrouter', id: 'z-ai/glm' });
  assert.equal(session.thinkingLevel, 'high');
  assert.deepEqual(session.entries, [{ type: 'message', message: { role: 'user', content: 'fresh prompt' } }]);
});

test('ack timeouts for prompt/abort/extension_ui_response are converted to success', async () => {
  const session = injectSession({
    send: async () => { const e = new Error('RPC command timed out: prompt'); throw e; },
  });
  for (const type of ['prompt', 'abort', 'extension_ui_response']) {
    const resp = await handleRpcCommand({ type, sessionId: session.id });
    assert.equal(resp.success, true, `${type} timeout should be treated as success`);
  }
});

test('immediate send failures are reported as errors, not swallowed', async () => {
  const session = injectSession({
    send: async () => { throw new Error('Pi RPC session is not running'); },
  });
  const resp = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: 'hi' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /not running/);
});

test('export_html rejects an invalid session file path', async () => {
  const resp = await handleRpcCommand({ type: 'export_html', filePath: '/etc/hosts' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /Invalid session file/);
});

test('export_html rejects a sessionId that does not resolve to a live session', async () => {
  const resp = await handleRpcCommand({ type: 'export_html', sessionId: 'tau_missing' });
  assert.equal(resp.success, false);
  assert.match(resp.error, /Live session not found/);
});

test('export_html rejects an outputPath outside the session directory before invoking pi', async () => {
  const resp = await handleRpcCommand({
    type: 'export_html',
    filePath: SESSION_FILE,
    outputPath: '/tmp/escaped.html',
  });
  assert.equal(resp.success, false);
  assert.match(resp.error, /session directory/);
});

test('export_html supports JSONL copy inside the session directory', async () => {
  const out = path.join(PROJ, 'copy.jsonl');
  const resp = await handleRpcCommand({
    type: 'export_html',
    filePath: SESSION_FILE,
    outputPath: out,
  });
  assert.equal(resp.success, true);
  assert.equal(resp.data.path, out);
  assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(SESSION_FILE, 'utf8'));
});

test('trust_project writes trust.json for the live session cwd', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-trust-'));
  const session = injectSession({ cwd });
  const resp = await handleRpcCommand({ type: 'trust_project', sessionId: session.id, trusted: true });
  assert.equal(resp.success, true);
  assert.equal(resp.data.trusted, true);
  const trustPath = path.join(process.env.PI_CODING_AGENT_DIR, 'trust.json');
  const trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  assert.equal(trust[fs.realpathSync(cwd)], true);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('local_bash runs in the live session cwd without child Pi', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-bash-'));
  fs.writeFileSync(path.join(cwd, 'marker.txt'), 'ok');
  const session = injectSession({ cwd });
  const resp = await handleRpcCommand({ type: 'local_bash', sessionId: session.id, command: process.platform === 'win32' ? 'dir marker.txt' : 'ls marker.txt' });
  assert.equal(resp.success, true);
  assert.match(String(resp.data.output), /marker\.txt/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('import_session can resume an existing session-dir JSONL', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-import-'));
  const session = injectSession({ cwd, sessionFile: SESSION_FILE });
  const resp = await handleRpcCommand({ type: 'import_session', sessionId: session.id, filePath: SESSION_FILE });
  assert.equal(resp.success, true);
  assert.equal(resp.data.filePath, SESSION_FILE);
  assert.equal(resp.data.session.id, session.id);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('set_auth persists the enabled flag to settings.json', async () => {
  await handleRpcCommand({ type: 'set_auth', enabled: true });
  const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(parsed.tau.authEnabled, true);
});
