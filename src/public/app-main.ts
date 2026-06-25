/**
 * Main App - Ties everything together
 */

import { WebSocketClient } from './websocket-client.js';
import { StateManager } from './state.js';
import { MessageRenderer } from './message-renderer.js';
import { ToolCardRenderer, type ToolExecution, type ToolResult } from './tool-card.js';
import { DialogHandler, type DialogRequest } from './dialogs.js';
import { SessionSidebar, type SidebarProject, type SidebarSession } from './session-sidebar.js';
import { themes, applyTheme, getCurrentTheme } from './themes.js';
import { FileBrowser, getFileIcon } from './file-browser.js';
import { setupLauncherPanel } from './launcher-panel.js';
import { setupModelPicker } from './model-picker.js';
import { setupVoiceInput } from './voice-input.js';
import { setupCommandPalette } from './command-palette.js';

import type { AppEvent, AppMessage, ExtensionUIRequest, LiveInstance, LiveSession, MessageContentBlock, ModelRecord, PendingFilePath, PendingImage, QueuedCommand, RpcCommand, UsageRecord } from './app-types.js';

type SessionHistoryEntry = { type?: string; message?: AppMessage };

type LiveSessionSnapshotData = {
  sessionId?: string;
  sessionFile?: string | null;
  session?: { sessionFile?: string | null };
  isStreaming?: boolean;
  model?: ModelRecord | null;
  thinkingLevel?: string;
  entries?: SessionHistoryEntry[];
};

type RpcEventDetail = { sessionId?: string; event?: AppEvent };
type DirectoryBrowseItem = { name: string; path: string };
type DirectoryBrowseData = { path: string; parent?: string | null; roots?: DirectoryBrowseItem[]; items?: DirectoryBrowseItem[] };
type SlashCommand = { name: string; description?: string; source?: string; location?: string };
type ParsedSlashInput = { name: string; args: string; raw: string };

// Initialize components
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const wsClient = new WebSocketClient(wsUrl);
const state = new StateManager();
// All element lookups below query the app's static index.html shell, which is
// present before this module runs (the script is a deferred module at the end
// of <body>). A missing element means the page is structurally broken, so we
// assert non-null at the query site rather than guarding every usage.
const messageRenderer = new MessageRenderer(document.getElementById('messages')!);
const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages')!);
const dialogHandler = new DialogHandler(document.getElementById('dialog-container')!, wsClient, () => activeLiveSessionId);

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById('session-list')!,
  handleSessionSelect
);

// UI elements
const messageInput = document.getElementById('message-input')!;
const chatForm = document.getElementById('chat-form')!;
const sendBtn = document.getElementById('send-btn')!;
const abortBtn = document.getElementById('abort-btn')!;
const statusIndicator = document.getElementById('status-indicator')!;
const statusText = document.getElementById('status-text')!;
// Tracks the pending timer that restores statusText after a transient
// status message (rpcCommand success/error). Any new status message must
// clear this so a stale restore cannot overwrite a later, longer-lived
// message (e.g. the red-dot error flash).
let statusRestoreTimer: ReturnType<typeof setTimeout> | null = null;
// Tracks the pending timer that restores the status indicator (dot) and
// text after a red-dot error flash. Kept SEPARATE from statusRestoreTimer
// so a normal setStatusMessage call cannot cancel the only callback that
// would clear the `error` class — otherwise an unrelated status update
// during the 3s flash would strand the dot red with no timer to reset it.
let statusFlashTimer: ReturnType<typeof setTimeout> | null = null;
// Restore the status indicator dot to its real connection/streaming state.
// Only touches the indicator class (not statusText), so callers can set the
// accompanying text themselves.
function restoreStatusIndicator() {
  const open = wsClient.ws?.readyState === WebSocket.OPEN;
  statusIndicator.className = `status-indicator ${
    open && state.isStreaming ? 'streaming' : (open ? 'connected' : 'disconnected')
  }`;
}
// Set a transient statusText message and schedule its restore. Cancels any
// previously scheduled restore so overlapping messages cannot race. A new
// status message also supersedes any active error flash: it cancels the
// flash's restore and returns the dot to its real state so the `error`
// class cannot linger with no timer to clear it.
function setStatusMessage(text: string, restoreText: string | null = null, restoreMs = 3000) {
  if (statusFlashTimer !== null) {
    clearTimeout(statusFlashTimer);
    statusFlashTimer = null;
    restoreStatusIndicator();
  }
  clearTimeout(statusRestoreTimer ?? undefined);
  statusText.textContent = text;
  if (restoreText !== null) {
    statusRestoreTimer = setTimeout(() => {
      statusRestoreTimer = null;
      statusText.textContent = restoreText;
    }, restoreMs);
  }
}
// Turn the status indicator red and show an error message; after `ms`,
// restore the indicator to the real connection state and reset the text.
function flashStatusError(msg: string, ms = 3000) {
  // Reset the class atomically so no stale connected/disconnected/streaming
  // class lingers alongside `error` (matches updateConnectionStatus' style).
  statusIndicator.className = 'status-indicator error';
  // Cancel any pending status-text restore (e.g. rpcCommand's 'Done' ->
  // 'Connected' timer from an earlier successful step in the same flow) so it
  // cannot overwrite this error message while the red dot persists.
  clearTimeout(statusRestoreTimer ?? undefined);
  // Cancel any prior flash restore so overlapping flashes (a second
  // model-save failure within 3s) cannot leak a stray restore that
  // would reset the dot before this flash's own restore fires.
  clearTimeout(statusFlashTimer ?? undefined);
  statusText.textContent = msg;
  // Schedule the dot+text restore on the dedicated statusFlashTimer so a
  // later setStatusMessage (e.g. the user clicking the thinking-level cycle
  // button right after a thinking-level failure) cannot cancel the only
  // callback that clears the `error` class. If a new status message does
  // arrive, setStatusMessage itself retires the flash via restoreStatusIndicator.
  statusFlashTimer = setTimeout(() => {
    statusFlashTimer = null;
    restoreStatusIndicator();
    const open = wsClient.ws?.readyState === WebSocket.OPEN;
    // Preserve an in-progress stream: restore the streaming text too.
    statusText.textContent = (open && state.isStreaming) ? 'Working...'
      : (open ? 'Connected' : 'Disconnected');
  }, ms);
}

const sidebarEl = document.getElementById('sidebar')!;
const sidebarToggle = document.getElementById('sidebar-toggle')!;
const sidebarOverlay = document.getElementById('sidebar-overlay')!;

const refreshSessionsBtn = document.getElementById('refresh-sessions-btn')!;
const sessionSearchInput = document.getElementById('session-search-input')!;
const typingIndicator = document.getElementById('typing-indicator')!;

const sessionCostEl = document.getElementById('session-cost')!;
const tokenUsageEl = document.getElementById('token-usage')!;
const scrollBottomBtn = document.getElementById('scroll-bottom-btn')!;
const scrollBottomBadge = document.getElementById('scroll-bottom-badge')!;
const messagesContainer = document.getElementById('messages')!;
const launcherPanel = setupLauncherPanel({
  launcherEl: document.getElementById('launcher')!,
  messagesContainer,
  async createSession(projectPath) {
    try {
      const res = await fetch('/api/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: projectPath, model: '' }),
      });
      const data = await res.json();
      if (data.session) {
        upsertLiveSession(data.session);
        await selectLiveSession(data.session.id);
      }
    } catch (e) {
      console.error('[Launcher] Failed to create Tau tab:', e);
    }
  },
});

// State tracking
let currentStreamingElement: HTMLElement | null = null;
let currentStreamingText = '';
let sessionTotalCost = 0;
let lastInputTokens = 0;
let contextWindowSize = 0;  // fetched from model info
let originalTitle = document.title;
let hasFocus = true;
let unreadCount = 0;
let isScrolledUp = false;
let hasNewWhileScrolled = false;
let lastSentMessage: string | null = null; // Track to avoid duplicate rendering from backend echo events
let lastUsage: UsageRecord | null = null; // Full usage object for context visualiser
let activeLiveSessionFile: string | null = null; // The active live session file path
let viewingActiveSession = false; // Whether we're viewing a live backend Tau tab or historical read-only session
let hasReceivedInitialServerState = false;
let liveInstances: LiveInstance[] = []; // Sidebar live indicators derived from backend live sessions
let liveSessions: LiveSession[] = [];
let activeLiveSessionId = localStorage.getItem('tau-active-live-session-id') || null;
let hasRestoredInitialLiveSession = false;
let pendingExtensionUIRequests: ExtensionUIRequest[] = []; // background session UI requests waiting for that Tau tab to be selected
dialogHandler.onIdle = () => processQueuedExtensionUIRequest();

// File browser
const fileSidebar = document.getElementById('file-sidebar')!;
const fileSidebarToggle = document.getElementById('file-sidebar-toggle')!;
const fileSidebarClose = document.getElementById('file-sidebar-close')!;
const fileSidebarUp = document.getElementById('file-sidebar-up')!;
const fileList = document.getElementById('file-list')!;
const fileSidebarPath = document.getElementById('file-sidebar-path')!;
const fileBrowser = new FileBrowser(fileList, fileSidebarPath, messageInput, (filePath) => {
  const name = filePath.split(/[/\\]/).pop() || filePath;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  pendingFilePaths.push({ path: filePath, name, ext, sessionId: activeLiveSessionId });
  renderAttachmentPreviews();
}, () => (viewingActiveSession && liveSessions.some(s => s.id === activeLiveSessionId) ? activeLiveSessionId : null));

fileSidebarToggle.addEventListener('click', () => {
  const isCollapsed = fileSidebar.classList.toggle('collapsed');
  if (!isCollapsed && !fileBrowser.currentPath) {
    fileBrowser.load(); // Load session cwd
  }
  localStorage.setItem('tau-file-sidebar', isCollapsed ? 'closed' : 'open');
});

fileSidebarClose.addEventListener('click', () => {
  fileSidebar.classList.add('collapsed');
  localStorage.setItem('tau-file-sidebar', 'closed');
});

fileSidebarUp.addEventListener('click', () => {
  const parent = fileBrowser.getParentPath();
  if (parent) fileBrowser.load(parent);
});

fetch('/api/health').then(r => r.json()).then(data => {
  const names: Record<string, string> = { win32: 'Explorer', darwin: 'Finder', linux: 'file manager' };
  const name = names[data.platform] || 'file manager';
  document.getElementById('file-sidebar-finder')!.title = `Open in ${name}`;
}).catch(() => {});

document.getElementById('file-sidebar-finder')!.addEventListener('click', () => {
  const sessionId = viewingActiveSession && activeLiveSessionId ? activeLiveSessionId : null;
  if (fileBrowser.currentPath && sessionId) {
    fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: fileBrowser.currentPath, sessionId }),
    });
  }
});

// Restore file sidebar state
if (localStorage.getItem('tau-file-sidebar') === 'open') {
  fileSidebar.classList.remove('collapsed');
  fileBrowser.load();
}


// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener('focus', () => {
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});





window.addEventListener('blur', () => {
  hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wsClient.ws?.readyState !== WebSocket.OPEN) {
    console.log('[App] Returning to app, reconnecting...');
    wsClient.forceReconnect();
  }
});

// ═══════════════════════════════════════
// Scroll-to-bottom button + new message indicator
// ═══════════════════════════════════════

messagesContainer.addEventListener('scroll', () => {
  const threshold = 150;
  const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  isScrolledUp = !atBottom;
  
  if (atBottom) {
    scrollBottomBtn.classList.add('hidden');
    scrollBottomBadge.classList.add('hidden');
    hasNewWhileScrolled = false;
  } else {
    scrollBottomBtn.classList.remove('hidden');
  }
});

scrollBottomBtn.addEventListener('click', () => {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
  scrollBottomBtn.classList.add('hidden');
  scrollBottomBadge.classList.add('hidden');
  hasNewWhileScrolled = false;
});

function scrollToBottom() {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
}

function showNewMessageBadge() {
  if (isScrolledUp) {
    hasNewWhileScrolled = true;
    scrollBottomBadge.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

wsClient.addEventListener('connected', () => {
  updateConnectionStatus('connected');
  // Fetch model context window size for token % display
  setTimeout(fetchContextWindow, 1000);

});

wsClient.addEventListener('disconnected', () => {
  updateConnectionStatus('disconnected');
});

wsClient.addEventListener('reconnectFailed', () => {
  updateConnectionStatus('disconnected');
  messageRenderer.renderError('Connection lost. Please refresh the page.');
});

wsClient.addEventListener('rpcEvent', (e: Event) => {
  const detail = (e as CustomEvent<RpcEventDetail>).detail || {};
  const event = (detail.event || detail) as AppEvent;
  const sessionId = detail.sessionId;
  if (sessionId) {
    const session = liveSessions.find(s => s.id === sessionId);
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      if (event.type === 'agent_start' || event.type === 'turn_start') session.isStreaming = true;
      if (event.type === 'agent_end' || event.type === 'turn_end') session.isStreaming = false;
      if (event.type === 'session_name' && event.name) session.sessionName = event.name;
      if ((event.message as AppMessage)?.usage) session.contextUsage = { ...(session.contextUsage || {}), usage: (event.message as AppMessage).usage };
      renderLiveTabs();
    }
    if (sessionId !== activeLiveSessionId || !viewingActiveSession) {
      if (event.type === 'extension_ui_request') queueExtensionUIRequest(event, sessionId);
      return;
    }
  }
  handleRPCEvent(event, sessionId);
});

wsClient.addEventListener('serverError', (e: Event) => {
  messageRenderer.renderError((e as CustomEvent<{ message: string }>).detail.message);
});

wsClient.addEventListener('stateUpdate', (e: Event) => {
  const detail = (e as CustomEvent<{ liveSessions?: LiveSession[] }>).detail;
  const wasViewingLive = viewingActiveSession;
  const launcherVisible = launcherPanel.isVisible();
  hasReceivedInitialServerState = true;
  setLiveSessions(detail.liveSessions || []);
  if (!hasRestoredInitialLiveSession || (wasViewingLive && !launcherVisible)) {
    hasRestoredInitialLiveSession = true;
    restoreActiveLiveSession();
  } else {
    if (activeLiveSessionId && !liveSessions.some(s => s.id === activeLiveSessionId)) {
      activeLiveSessionId = null;
      localStorage.removeItem('tau-active-live-session-id');
      renderQueuedMessages();
      renderLiveTabs();
    }
    updateLiveSessionInputState();
    updateLiveSessionIndicators();
  }
});

wsClient.addEventListener('liveSessionCreated', (e: Event) => {
  upsertLiveSession((e as CustomEvent<LiveSession>).detail);
});

wsClient.addEventListener('liveSessionUpdated', (e: Event) => {
  const detail = (e as CustomEvent<LiveSession>).detail;
  upsertLiveSession(detail);
  if (detail?.id === activeLiveSessionId) applyActiveSessionMetadata(detail);
});

wsClient.addEventListener('liveSessionClosed', (e: Event) => {
  handleLiveSessionClosed((e as CustomEvent<{ sessionId: string }>).detail.sessionId);
});

// Receive a full live-session state snapshot.
wsClient.addEventListener('liveSessionSnapshot', (e: Event) => {
  applyLiveSessionSnapshot((e as CustomEvent<LiveSessionSnapshotData>).detail);
});

// ═══════════════════════════════════════
// Live-session tabs
// ═══════════════════════════════════════

const liveTabsList = document.getElementById('live-tabs-list');
const liveTabAddBtn = document.getElementById('live-tab-add');
const newLiveSessionOverlay = document.getElementById('new-live-session-overlay');
const newLiveSessionModal = document.getElementById('new-live-session-modal');
const newLiveSessionForm = document.getElementById('new-live-session-form');
const newLiveSessionCwd = document.getElementById('new-live-session-cwd')!;
const newLiveSessionModel = document.getElementById('new-live-session-model')!;
const newLiveSessionProjects = document.getElementById('new-live-session-projects');
const newLiveSessionSubmit = document.getElementById('new-live-session-submit')!;
const newLiveSessionBrowse = document.getElementById('new-live-session-browse')!;
const directoryPicker = document.getElementById('new-live-session-directory-picker')!;
const directoryPickerPath = document.getElementById('directory-picker-path')!;
const directoryPickerRoots = document.getElementById('directory-picker-roots')!;
const directoryPickerList = document.getElementById('directory-picker-list')!;
const directoryPickerUp = document.getElementById('directory-picker-up')!;
const directoryPickerUse = document.getElementById('directory-picker-use')!;
let currentDirectoryPickerPath = '';

function setLiveSessions(sessions: LiveSession[]) {
  liveSessions = sessions || [];
  liveInstances = liveSessions.map(s => ({ sessionFile: s.sessionFile, cwd: s.cwd, port: location.port }));
  renderLiveTabs();
  updateLiveSessionIndicators();
}

function handleLiveSessionClosed(closedId: string) {
  if (!closedId) return;
  liveSessions = liveSessions.filter(s => s.id !== closedId);
  messageQueue = messageQueue.filter(cmd => cmd.sessionId !== closedId);
  pendingExtensionUIRequests = pendingExtensionUIRequests.filter(req => req.sessionId !== closedId);
  if (dialogHandler.currentRequest?.sessionId === closedId) {
    dialogHandler.clearCurrentDialog();
    processQueuedExtensionUIRequest();
  }
  renderQueuedMessages();
  if (activeLiveSessionId === closedId) {
    const wasViewingActive = viewingActiveSession;
    activeLiveSessionId = null;
    localStorage.removeItem('tau-active-live-session-id');
    activeLiveSessionFile = null;
    currentStreamingElement = null;
    currentStreamingThinking = '';
    currentStreamingText = '';
    state.reset();
    showTypingIndicator(false);
    if (wasViewingActive) {
      messageRenderer.clear();
      toolCardRenderer.clear();
      const next = getMostRecentLiveSession();
      if (next) selectLiveSession(next.id);
      else {
        viewingActiveSession = false;
        messageRenderer.renderWelcome();
        updateLiveSessionInputState();
        updateUI();
      }
    } else {
      updateLiveSessionInputState();
      updateUI();
    }
  }
  liveInstances = liveSessions.map(s => ({ sessionFile: s.sessionFile, cwd: s.cwd, port: location.port }));
  renderLiveTabs();
  updateLiveSessionIndicators();
}

function upsertLiveSession(session: LiveSession) {
  if (!session) return;
  const idx = liveSessions.findIndex(s => s.id === session.id);
  let shouldRenderTabs = false;
  if (idx >= 0) {
    const before = liveTabSignature(liveSessions[idx]);
    liveSessions[idx] = { ...liveSessions[idx], ...session };
    shouldRenderTabs = before !== liveTabSignature(liveSessions[idx]);
  } else {
    liveSessions.push(session);
    shouldRenderTabs = true;
  }
  liveInstances = liveSessions.map(s => ({ sessionFile: s.sessionFile, cwd: s.cwd, port: location.port }));
  if (shouldRenderTabs) renderLiveTabs();
  updateLiveSessionIndicators();
}

function getMostRecentLiveSession() {
  return [...liveSessions].sort((a, b) =>
    new Date(b.lastActiveAt || b.createdAt || 0).getTime() - new Date(a.lastActiveAt || a.createdAt || 0).getTime()
  )[0] || null;
}

function basename(p: string) {
  return (p || '').split(/[/\\]/).filter(Boolean).pop() || p || 'session';
}

function compactModelLabel(session: LiveSession) {
  const raw = session.modelLabel || session.modelSpec || (session.model as ModelRecord)?.id || (session.model as ModelRecord)?.name || 'default';
  return String(raw).replace(/^.*\//, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function liveTabSignature(session: LiveSession) {
  return [
    session.sessionName || basename(session.cwd || ''),
    compactModelLabel(session),
    session.cwd || '',
    session.modelSpec || '',
    session.isStreaming ? 'streaming' : 'idle',
    hasPendingExtensionUIRequest(session.id) ? 'ui' : '',
  ].join('\u001f');
}

function renderLiveTabs() {
  if (!liveTabsList) return;
  const existing = new Map<string, HTMLButtonElement>();
  liveTabsList.querySelectorAll<HTMLButtonElement>('.live-tab').forEach((tab) => {
    if (tab.dataset.sessionId) existing.set(tab.dataset.sessionId, tab);
  });
  const seen = new Set<string>();
  liveSessions.forEach((session, index) => {
    let tab = existing.get(session.id);
    if (!tab) {
      tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'live-tab';
      tab.dataset.sessionId = session.id;
      tab.addEventListener('click', () => selectLiveSession(session.id));
    }
    seen.add(session.id);
    tab.classList.toggle('active', session.id === activeLiveSessionId);
    tab.title = `${session.cwd || ''}${session.modelSpec ? ` • ${session.modelSpec}` : ''}`;
    const signature = liveTabSignature(session);
    if (tab.dataset.signature !== signature) {
      tab.dataset.signature = signature;
      tab.innerHTML = `
        ${session.isStreaming ? '<span class="live-tab-streaming-dot"></span>' : ''}
        ${hasPendingExtensionUIRequest(session.id) ? '<span class="live-tab-ui-dot" title="Waiting for response">?</span>' : ''}
        <span class="live-tab-title">${escapeHtml(session.sessionName || basename(session.cwd || ''))}</span>
        <span class="live-tab-model">${escapeHtml(compactModelLabel(session))}</span>
        <span class="live-tab-close" title="Close Tau tab">×</span>
      `;
      tab.querySelector('.live-tab-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeLiveSession(session.id);
      });
    }
    const currentAtIndex = liveTabsList.children[index];
    if (currentAtIndex !== tab) liveTabsList.insertBefore(tab, currentAtIndex || null);
  });
  for (const [id, tab] of existing) {
    if (!seen.has(id)) tab.remove();
  }
}

function restoreActiveLiveSession() {
  const saved = activeLiveSessionId && liveSessions.find(s => s.id === activeLiveSessionId);
  const next = saved || getMostRecentLiveSession();
  if (next) {
    selectLiveSession(next.id);
  } else {
    activeLiveSessionId = null;
    viewingActiveSession = false;
    activeLiveSessionFile = null;
    localStorage.removeItem('tau-active-live-session-id');
    state.reset();
    renderQueuedMessages();
    renderLiveTabs();
    updateLiveSessionInputState();
  }
}

async function selectLiveSession(id: string) {
  const session = liveSessions.find(s => s.id === id);
  if (!session) return;
  suspendCurrentDialogForTabSwitch(id);
  launcherPanel.hide();
  activeLiveSessionId = id;
  localStorage.setItem('tau-active-live-session-id', id);
  viewingActiveSession = true;
  activeLiveSessionFile = session.sessionFile || null;
  renderLiveTabs();
  renderQueuedMessages();
  applyActiveSessionMetadata(session);
  currentStreamingElement = null;
  currentStreamingThinking = '';
  currentStreamingText = '';
  state.reset();
  state.setStreaming(!!session.isStreaming);
  messageRenderer.clear();
  toolCardRenderer.clear();
  try {
    const res = await fetch(`/api/live-sessions/${encodeURIComponent(id)}/snapshot`);
    const data = await res.json();
    if (!res.ok || data.error) {
      handleLiveSessionClosed(id);
      throw new Error(data.error || 'Live session not found');
    }
    applyLiveSessionSnapshot({ ...data, sessionId: id });
  } catch (e) {
    messageRenderer.renderError((e instanceof Error ? e.message : '') || 'Failed to load live session snapshot');
    return;
  }
  if (!fileSidebar.classList.contains('collapsed')) fileBrowser.load();
  updateLiveSessionInputState();
  processQueuedExtensionUIRequest(id);
  flushQueue();
}

function applyActiveSessionMetadata(session: LiveSession) {
  if (!session) return;
  // Server is canonical: session.model is always null or a full {provider,id}
  // object, so assign directly. No modelLabel/modelSpec string fallbacks.
  modelPickerController.setModelState(session.model || '', session.thinkingLevel || 'off');
}

async function closeLiveSession(id: string) {
  const session = liveSessions.find(s => s.id === id);
  if (!session) return;
  const hasQueuedMessages = messageQueue.some(cmd => cmd.sessionId === id);
  if (session.isStreaming || hasQueuedMessages) {
    const reason = session.isStreaming && hasQueuedMessages
      ? 'This Tau tab is streaming and has queued unsent messages. Close it, terminate the Pi session, and discard the queue?'
      : session.isStreaming
        ? 'This Tau tab is streaming. Close it and terminate the Pi session?'
        : 'This Tau tab has queued unsent messages. Close it and discard them?';
    if (!confirm(reason)) return;
  }
  try {
    await fetch(`/api/live-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (e) {
    messageRenderer.renderError('Failed to close Tau tab');
  }
}

async function loadProjectChips() {
  if (!newLiveSessionProjects) return;
  newLiveSessionProjects.innerHTML = '';
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    for (const project of data.projects || []) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'project-chip';
      chip.textContent = project.name;
      chip.title = project.path;
      chip.addEventListener('click', () => { newLiveSessionCwd.value = project.path; });
      newLiveSessionProjects.appendChild(chip);
    }
  } catch {}
}

function renderDirectoryPicker(data: DirectoryBrowseData) {
  currentDirectoryPickerPath = data.path || '';
  directoryPickerPath.textContent = currentDirectoryPickerPath;
  directoryPickerPath.title = currentDirectoryPickerPath;
  directoryPickerUp.toggleAttribute('disabled', !data.parent);
  directoryPickerUp.onclick = () => { if (data.parent) loadDirectoryPicker(data.parent); };

  directoryPickerRoots.innerHTML = '';
  for (const root of data.roots || []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'directory-root';
    btn.textContent = root.name;
    btn.title = root.path;
    btn.addEventListener('click', () => loadDirectoryPicker(root.path));
    directoryPickerRoots.appendChild(btn);
  }

  directoryPickerList.innerHTML = '';
  if (!data.items?.length) {
    const empty = document.createElement('div');
    empty.className = 'directory-picker-empty';
    empty.textContent = 'No folders';
    directoryPickerList.appendChild(empty);
    return;
  }
  for (const item of data.items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'directory-item';
    btn.title = item.path;
    btn.innerHTML = `<span class="directory-item-icon">/</span><span class="directory-item-name">${escapeHtml(item.name)}</span>`;
    btn.addEventListener('click', () => loadDirectoryPicker(item.path));
    directoryPickerList.appendChild(btn);
  }
}

async function loadDirectoryPicker(dirPath = '') {
  const params = new URLSearchParams();
  if (dirPath) params.set('path', dirPath);
  directoryPicker.classList.remove('hidden');
  directoryPickerList.innerHTML = '<div class="directory-picker-empty">Loading...</div>';
  try {
    const res = await fetch(`/api/browse-dirs${params.toString() ? `?${params.toString()}` : ''}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Failed to browse folders');
    renderDirectoryPicker(data);
  } catch (e) {
    directoryPickerList.innerHTML = `<div class="directory-picker-empty">${escapeHtml((e instanceof Error ? e.message : '') || 'Failed')}</div>`;
  }
}

function openNewLiveSessionModal() {
  newLiveSessionOverlay?.classList.remove('hidden');
  newLiveSessionModal?.classList.remove('hidden');
  newLiveSessionSubmit.disabled = false;
  if (!newLiveSessionCwd.value) newLiveSessionCwd.value = liveSessions.find(s => s.id === activeLiveSessionId)?.cwd || '';
  loadProjectChips();
  requestAnimationFrame(() => newLiveSessionCwd?.focus());
}

function closeNewLiveSessionModal() {
  newLiveSessionOverlay?.classList.add('hidden');
  newLiveSessionModal?.classList.add('hidden');
  directoryPicker.classList.add('hidden');
}

liveTabAddBtn?.addEventListener('click', openNewLiveSessionModal);
document.getElementById('new-live-session-close')?.addEventListener('click', closeNewLiveSessionModal);
document.getElementById('new-live-session-cancel')?.addEventListener('click', closeNewLiveSessionModal);
newLiveSessionOverlay?.addEventListener('click', closeNewLiveSessionModal);
newLiveSessionBrowse.addEventListener('click', () => loadDirectoryPicker(newLiveSessionCwd.value.trim()));
directoryPickerUse.addEventListener('click', () => {
  if (!currentDirectoryPickerPath) return;
  newLiveSessionCwd.value = currentDirectoryPickerPath;
  directoryPicker.classList.add('hidden');
  newLiveSessionCwd.focus();
});
newLiveSessionForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cwd = newLiveSessionCwd.value.trim();
  if (!cwd) return;
  newLiveSessionSubmit.disabled = true;
  newLiveSessionSubmit.textContent = 'Starting…';
  try {
    const res = await fetch('/api/live-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, model: newLiveSessionModel.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Failed to create Tau tab');
    upsertLiveSession(data.session);
    closeNewLiveSessionModal();
    newLiveSessionModel.value = '';
    await selectLiveSession(data.session.id);
  } catch (err) {
    messageRenderer.renderError((err instanceof Error ? err.message : '') || 'Failed to create Tau tab');
  } finally {
    newLiveSessionSubmit.disabled = false;
    newLiveSessionSubmit.textContent = 'Create tab';
  }
});

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

function handleRPCEvent(event: AppEvent, sessionId: string | null = null) {
  switch (event.type) {
    case 'agent_start':
    case 'turn_start':
      handleAgentStart();
      break;
    case 'agent_end':
    case 'turn_end':
      handleAgentEnd();
      break;
    case 'message_start':
      handleMessageStart(event.message as AppMessage);
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event.message as AppMessage);
      break;
    case 'tool_execution_start':
      handleToolExecutionStart(event);
      break;
    case 'tool_execution_update':
      handleToolExecutionUpdate(event);
      break;
    case 'tool_execution_end':
      handleToolExecutionEnd(event);
      break;
    case 'auto_compaction_start':
    case 'compaction_start':
      handleCompactionStart();
      break;
    case 'auto_compaction_end':
    case 'compaction_end':
      handleCompactionEnd(event);
      break;
    case 'queue_update':
      handleQueueUpdate(event, sessionId);
      break;
    case 'auto_retry_start':
      setStatusMessage(`Retrying ${event.attempt || ''}`.trim(), 'Connected', Number(event.delayMs || 3000));
      break;
    case 'auto_retry_end':
      setStatusMessage(event.success === false ? 'Retry failed' : 'Retry done', 'Connected', 2500);
      break;
    case 'extension_ui_request':
      handleExtensionUIRequest(event, sessionId);
      break;
    case 'extension_error':
      messageRenderer.renderError(`Extension error: ${event.error}`);
      break;
    case 'session_name':
      // Auto-title: update sidebar with new session name
      if (event.name) {
        const activeItem = document.querySelector('.session-item.active .session-title');
        if (activeItem) activeItem.textContent = event.name;
      }
      break;
  }
}

function handleCompactionStart() {
  const el = document.createElement('div');
  el.className = 'system-message compaction-message';
  el.id = 'compaction-indicator';
  el.innerHTML = '<span class="compaction-spinner">⟳</span> Compacting context…';
  messagesContainer.appendChild(el);
  scrollToBottom();
}

function handleCompactionEnd(event: AppEvent) {
  const indicator = document.getElementById('compaction-indicator');
  if (indicator) {
    const result = event.result as { summary?: string } | undefined;
    const summaryText = event.summary || result?.summary;
    const summary = summaryText ? ` — ${summaryText}` : '';
    indicator.innerHTML = `✓ Context compacted${summary}`;
    indicator.classList.add('compaction-done');
  }
  // Reset token tracking — next message will update
  lastInputTokens = 0;
  updateTokenUsage();
  hideCompactButton();
}

function handleAgentStart() {
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
}

function handleAgentEnd() {
  const wasStreaming = state.isStreaming;
  state.setStreaming(false);
  showTypingIndicator(false);
  currentStreamingElement = null;
  currentStreamingText = '';
  updateUI();

  // Notify via tab title if unfocused. Guard with wasStreaming so paired
  // turn_end/agent_end events do not double-count the same completed turn.
  if (wasStreaming && !hasFocus) {
    unreadCount++;
    document.title = `(${unreadCount}) ● ${originalTitle}`;

  }
}

let currentStreamingThinking = '';

function handleMessageStart(message: AppMessage) {
  if (message.role === 'assistant') {
    currentStreamingText = '';
    currentStreamingThinking = '';
    currentStreamingElement = messageRenderer.renderAssistantMessage(
      { content: '' },
      true
    );
  } else if (message.role === 'user') {
    // User messages can echo back via backend events; only render if we did
    // not just send this message ourselves.
    if (!lastSentMessage || getMessageText(message) !== lastSentMessage) {
      const content = getMessageText(message);
      if (content) {
        messageRenderer.renderUserMessage({ content });
      }
    }
    lastSentMessage = null;
  }
}

function getMessageText(message: AppMessage) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

function getMessageThinking(message: AppMessage) {
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter(b => b.type === 'thinking')
    .map(b => b.thinking || b.text || '')
    .filter(Boolean)
    .join('\n');
}

function handleMessageUpdate(event: AppEvent) {
  const { assistantMessageEvent } = event;
  if (!assistantMessageEvent) return;

  if (assistantMessageEvent.type === 'thinking_delta') {
    if (!currentStreamingElement) {
      currentStreamingElement = messageRenderer.renderAssistantMessage({ content: '' }, true);
    }
    currentStreamingThinking += assistantMessageEvent.delta;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
    }
  } else if (assistantMessageEvent.type === 'text_delta') {
    if (!currentStreamingElement) {
      currentStreamingElement = messageRenderer.renderAssistantMessage({ content: '' }, true);
    }
    currentStreamingText += assistantMessageEvent.delta;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingMessage(
        currentStreamingElement,
        currentStreamingText
      );
    }
  }
}

function handleMessageEnd(message: AppMessage) {
  if (!currentStreamingElement && message?.role === 'assistant') {
    messageRenderer.renderAssistantMessage(message, false, true);
  }
  if (currentStreamingElement) {
    // If this client attached mid-stream, local deltas may be incomplete. The
    // message_end payload is authoritative, so refresh the streaming DOM from it
    // before finalizing.
    if (message?.role === 'assistant') {
      const finalText = getMessageText(message);
      const finalThinking = getMessageThinking(message);
      if (finalText && finalText.length >= currentStreamingText.length) {
        currentStreamingText = finalText;
        messageRenderer.updateStreamingMessage(currentStreamingElement, currentStreamingText);
      }
      if (finalThinking && finalThinking.length >= currentStreamingThinking.length) {
        currentStreamingThinking = finalThinking;
        messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
      }
    }

    // Pass usage info for cost display
    const usage = message?.usage || null;
    // Pass thinking content so finalize can render the thinking block
    messageRenderer.finalizeStreamingMessage(currentStreamingElement, usage, currentStreamingThinking);
    currentStreamingElement = null;
    currentStreamingThinking = '';
    currentStreamingText = '';

    // Track session cost and tokens
    if (usage?.cost?.total) {
      sessionTotalCost += usage.cost.total;
    }
    if (usage?.input) {
      lastInputTokens = usage.input + (usage.cacheRead || 0);
      lastUsage = usage;
    }
    updateCostDisplay();
    updateTokenUsage();
    showNewMessageBadge();
  }
}

function handleToolExecutionStart(event: AppEvent) {
  const { toolCallId, toolName, args } = event;
  if (!toolCallId) return;

  state.addToolExecution(toolCallId, {
    toolName,
    args,
    status: 'pending',
  });

  const exec = state.getToolExecution(toolCallId);
  if (exec) toolCardRenderer.createToolCard(exec as ToolExecution);
}

function handleToolExecutionUpdate(event: AppEvent) {
  const { toolCallId, partialResult } = event;
  if (!toolCallId) return;
  const output = formatToolOutput(partialResult);

  state.updateToolExecution(toolCallId, {
    status: 'streaming',
    output,
  });

  const exec = state.getToolExecution(toolCallId);
  if (exec) toolCardRenderer.updateToolCard(exec as ToolExecution);
}

function handleToolExecutionEnd(event: AppEvent) {
  const { toolCallId, result, isError } = event;
  if (!toolCallId) return;
  const output = formatToolOutput(result);

  state.updateToolExecution(toolCallId, {
    status: isError ? 'error' : 'complete',
    output,
    isError,
  });

  toolCardRenderer.finalizeToolCard(toolCallId, result as ToolResult, isError ?? false);
}

function hasPendingExtensionUIRequest(sessionId: string) {
  return pendingExtensionUIRequests.some(req => req.sessionId === sessionId);
}

function queueExtensionUIRequest(event: AppEvent, sessionId: string) {
  if (!sessionId) {
    handleExtensionUIRequest(event, sessionId);
    return;
  }
  if (!pendingExtensionUIRequests.some(req => req.sessionId === sessionId && req.event?.id === event.id)) {
    pendingExtensionUIRequests.push({ sessionId, event });
  }
  renderLiveTabs();
}

function processQueuedExtensionUIRequest(sessionId = activeLiveSessionId) {
  if (!sessionId || !viewingActiveSession || sessionId !== activeLiveSessionId || dialogHandler.currentRequest) return;
  const idx = pendingExtensionUIRequests.findIndex(req => req.sessionId === sessionId);
  if (idx === -1) return;
  const [{ event }] = pendingExtensionUIRequests.splice(idx, 1);
  renderLiveTabs();
  handleExtensionUIRequest(event, sessionId);
}

function suspendCurrentDialogForTabSwitch(nextSessionId: string) {
  const current = dialogHandler.currentRequest;
  if (!current?.sessionId || current.sessionId === nextSessionId) return;
  const event = current.request;
  if (event && !pendingExtensionUIRequests.some(req => req.sessionId === current.sessionId && req.event?.id === event.id)) {
    pendingExtensionUIRequests.unshift({ sessionId: current.sessionId, event });
  }
  dialogHandler.clearCurrentDialog();
  renderLiveTabs();
}

function handleExtensionUIRequest(event: AppEvent, sessionId: string | null = null) {
  const request = (sessionId ? { ...event, sessionId } : event) as DialogRequest;
  switch (event.method) {
    case 'select':
      dialogHandler.showSelect(request);
      break;
    case 'confirm':
      dialogHandler.showConfirm(request);
      break;
    case 'input':
      dialogHandler.showInput(request);
      break;
    case 'editor':
      dialogHandler.showEditor(request);
      break;
    case 'notify':
      dialogHandler.showNotification(request);
      break;
    case 'setStatus':
    case 'set_status':
      setStatusMessage(String(event.message || event.text || event.status || ''), 'Connected', Number(event.duration || 3000));
      break;
    case 'setWidget':
    case 'set_widget':
      if (event.message || event.text) messageRenderer.renderSystemMessage(String(event.message || event.text));
      break;
    case 'setTitle':
    case 'set_title':
      if (event.title) {
        originalTitle = String(event.title);
        if (hasFocus) document.title = originalTitle;
      }
      break;
    case 'setEditorText':
    case 'set_editor_text':
      messageInput.value = String(event.text || event.value || '');
      messageInput.dispatchEvent(new Event('input'));
      messageInput.focus();
      break;
    case 'pasteToEditor':
    case 'paste_to_editor':
      insertTextAtCursor(String(event.text || event.value || ''));
      break;
    default:
      console.warn('[App] Unknown extension UI method:', event.method);
  }
}

function insertTextAtCursor(text: string) {
  const start = messageInput.selectionStart ?? messageInput.value.length;
  const end = messageInput.selectionEnd ?? start;
  messageInput.value = messageInput.value.slice(0, start) + text + messageInput.value.slice(end);
  messageInput.selectionStart = messageInput.selectionEnd = start + text.length;
  messageInput.dispatchEvent(new Event('input'));
  messageInput.focus();
}

function formatToolOutput(result: unknown) {
  if (!result) return '';

  const r = result as { content?: MessageContentBlock[] };
  if (r.content && Array.isArray(r.content)) {
    return r.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener('keydown', (e) => {
  // Enter sends, Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(e.altKey ? 'follow_up' : 'steer');
  } else if (e.key === 'Tab' && fileReferenceSuggestions.length > 0) {
    e.preventDefault();
    acceptFileReference(fileReferenceSuggestions[0]);
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
  updateSlashCommandSuggestions();
  updateFileReferenceSuggestions();
});

// ═══════════════════════════════════════
// Attachments (images + file browser paths)
// ═══════════════════════════════════════

const attachBtn = document.getElementById('attach-btn')!;
const imageInput = document.getElementById('image-input')!;
const imagePreviews = document.getElementById('image-previews')!;
const slashCommandSuggestions = document.getElementById('slash-command-suggestions')!;

let pendingImages: PendingImage[] = [];     // { data: base64, mimeType }
let pendingFilePaths: PendingFilePath[] = [];  // { path, name, ext } - file browser or uploads
let slashCommandCacheSessionId: string | null = null;
let slashCommandCache: SlashCommand[] = [];
let slashCommandRequestId = 0;
let fileReferenceSuggestions: Array<{ name: string; path: string; relativePath: string }> = [];
let fileReferenceRequestId = 0;

const TUI_BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'settings', description: 'Open settings menu', source: 'builtin', location: 'Web' },
  { name: 'model', description: 'Select model, or set model with /model provider/model[:thinking]', source: 'builtin', location: 'Web' },
  { name: 'scoped-models', description: 'Show or set model cycling scope', source: 'builtin', location: 'Web' },
  { name: 'export', description: 'Export session as HTML or JSONL', source: 'builtin', location: 'Web' },
  { name: 'import', description: 'Import and resume a session JSONL file', source: 'builtin', location: 'Web' },
  { name: 'share', description: 'Share session as a secret GitHub gist', source: 'builtin', location: 'Not available in Web' },
  { name: 'copy', description: 'Copy last agent message to clipboard', source: 'builtin', location: 'Web' },
  { name: 'name', description: 'Set session display name', source: 'builtin', location: 'Web' },
  { name: 'session', description: 'Show session info and stats', source: 'builtin', location: 'Web' },
  { name: 'changelog', description: 'Show changelog entries', source: 'builtin', location: 'TUI only' },
  { name: 'hotkeys', description: 'Show keyboard shortcuts', source: 'builtin', location: 'Web' },
  { name: 'fork', description: 'Create a new fork from a previous user message', source: 'builtin', location: 'Web' },
  { name: 'clone', description: 'Duplicate the current session at the current position', source: 'builtin', location: 'Web' },
  { name: 'tree', description: 'Show forkable session messages', source: 'builtin', location: 'Web' },
  { name: 'trust', description: 'Save project trust decision for future sessions', source: 'builtin', location: 'Web' },
  { name: 'login', description: 'Configure provider authentication', source: 'builtin', location: 'Not available in Web' },
  { name: 'logout', description: 'Remove provider authentication', source: 'builtin', location: 'Not available in Web' },
  { name: 'new', description: 'Start a new session in this Tau tab', source: 'builtin', location: 'Web' },
  { name: 'compact', description: 'Manually compact the session context', source: 'builtin', location: 'Web' },
  { name: 'resume', description: 'Resume a session path or focus the session sidebar', source: 'builtin', location: 'Web' },
  { name: 'reload', description: 'Reload Web command cache and sidebar', source: 'builtin', location: 'Web' },
  { name: 'quit', description: 'Close the current Tau tab', source: 'builtin', location: 'Web' },
];

const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

function getFileChipIcon(name: string) {
  return getFileIcon(name || 'file', false);
}

function processImageFile(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const mimeType = VALID_MIME_TYPES.includes(file.type) ? file.type : 'image/png';

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);

        const outputMime = (mimeType === 'image/jpeg') ? 'image/jpeg' : 'image/png';
        const quality = (outputMime === 'image/jpeg') ? 0.85 : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];
        if (!base64) { reject(new Error('Failed to encode image')); return; }
        resolve({ data: base64, mimeType: outputMime });
      };
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

function fileExt(name: string) {
  return name.split('.').pop()?.toLowerCase() || '';
}

async function uploadAttachment(file: File) {
  if (!activeLiveSessionId) throw new Error('Select a live Tau tab first.');
  const params = new URLSearchParams({ sessionId: activeLiveSessionId, name: file.name || 'upload.bin' });
  const res = await fetch(`/api/upload?${params.toString()}`, {
    method: 'POST',
    headers: file.type ? { 'Content-Type': file.type } : undefined,
    body: file,
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Upload failed');
  const name = data.name || file.name || 'upload.bin';
  pendingFilePaths.push({ path: data.path, name, ext: fileExt(name), sessionId: activeLiveSessionId, uploaded: true });
}

async function addAttachments(files: FileList | File[]) {
  const list = Array.from(files);
  if (!list.length) return;
  let uploaded = 0;
  for (const file of list) {
    try {
      if (file.type.startsWith('image/')) {
        pendingImages.push(await processImageFile(file));
      } else {
        await uploadAttachment(file);
        uploaded += 1;
      }
    } catch (e) {
      const msg = (e instanceof Error ? e.message : '') || 'Attachment failed';
      flashStatusError(msg);
      console.error('[Tau] Attachment failed:', e);
    }
  }
  if (uploaded > 0) setStatusMessage(`Attached ${uploaded} file${uploaded === 1 ? '' : 's'}`, 'Connected', 1600);
  renderAttachmentPreviews();
}

attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  addAttachments(imageInput.files ?? []);
  imageInput.value = '';
});

document.addEventListener('click', (e) => {
  const target = e.target as Node | null;
  if (!target) return;
  if (target === messageInput || slashCommandSuggestions.contains(target)) return;
  hideSlashSuggestions();
});

// Drag & drop on input
messageInput.addEventListener('dragover', (e) => { e.preventDefault(); });
messageInput.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length > 0) addAttachments(e.dataTransfer.files);
});

// Paste images
messageInput.addEventListener('paste', (e) => {
  if (!e.clipboardData) return;
  const files: File[] = [];
  for (const item of e.clipboardData.items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length) addAttachments(files);
});

function makeRemoveBtn(onClick: () => void) {
  const btn = document.createElement('button');
  btn.className = 'image-preview-remove';
  btn.setAttribute('aria-label', 'Remove');
  btn.textContent = '✕';
  btn.addEventListener('click', onClick);
  return btn;
}

function renderAttachmentPreviews() {
  imagePreviews.innerHTML = '';
  const hasAny = pendingImages.length > 0 || pendingFilePaths.length > 0;
  if (!hasAny) { imagePreviews.classList.add('hidden'); return; }
  imagePreviews.classList.remove('hidden');

  // Binary image chips
  pendingImages.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'image-preview';
    const thumb = document.createElement('img');
    thumb.src = `data:${img.mimeType};base64,${img.data}`;
    el.appendChild(thumb);
    el.appendChild(makeRemoveBtn(() => { pendingImages.splice(i, 1); renderAttachmentPreviews(); }));
    imagePreviews.appendChild(el);
  });

  // File browser path chips
  pendingFilePaths.forEach((fp, i) => {
    const el = document.createElement('div');
    const removeBtn = makeRemoveBtn(() => {
      if (!fp.uploaded) {
        const withSpace = fp.path + ' ';
        messageInput.value = messageInput.value.includes(withSpace)
          ? messageInput.value.replace(withSpace, '')
          : messageInput.value.replace(fp.path, '');
        messageInput.dispatchEvent(new Event('input'));
      }
      pendingFilePaths.splice(i, 1);
      renderAttachmentPreviews();
    });

    if (IMAGE_EXTS.has(fp.ext)) {
      el.className = 'image-preview';
      el.title = fp.path;
      const thumb = document.createElement('img');
      thumb.style.cssText = 'width:100%;height:100%;object-fit:cover';
      const previewParams = new URLSearchParams({ path: fp.path });
      if (fp.sessionId) previewParams.set('sessionId', fp.sessionId);
      thumb.src = `/api/file/preview?${previewParams.toString()}`;
      thumb.onerror = () => {
        el.classList.add('file-chip');
        thumb.remove();
        const icon = document.createElement('span');
        icon.className = 'file-chip-icon';
        icon.textContent = getFileChipIcon(fp.name);
        const label = document.createElement('span');
        label.className = 'file-chip-name';
        label.textContent = fp.name;
        el.insertBefore(label, removeBtn);
        el.insertBefore(icon, label);
      };
      el.appendChild(thumb);
    } else {
      el.className = 'image-preview file-chip';
      el.title = fp.path;
      const icon = document.createElement('span');
      icon.className = 'file-chip-icon';
      icon.textContent = getFileChipIcon(fp.name);
      const label = document.createElement('span');
      label.className = 'file-chip-name';
      label.textContent = fp.name;
      el.appendChild(icon);
      el.appendChild(label);
    }

    el.appendChild(removeBtn);
    imagePreviews.appendChild(el);
  });
}

function collectSlashCommands(value: unknown, out: SlashCommand[] = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectSlashCommands(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') out.push({ name: value });
    return out;
  }
  const obj = value as Record<string, unknown>;
  const rawName = obj.name || obj.command || obj.id;
  if (typeof rawName === 'string') {
    out.push({
      name: rawName.replace(/^\//, ''),
      description: typeof obj.description === 'string' ? obj.description : undefined,
      source: typeof obj.source === 'string' ? obj.source : undefined,
      location: typeof obj.location === 'string' ? obj.location : undefined,
    });
  }
  for (const key of ['commands', 'extensionCommands', 'extension_commands', 'promptCommands', 'prompt_commands', 'skillCommands', 'skill_commands']) {
    if (key in obj) collectSlashCommands(obj[key], out);
  }
  return out;
}

function uniqueSlashCommands(commands: SlashCommand[]) {
  const seen = new Set<string>();
  return commands
    .map((cmd) => ({ ...cmd, name: String(cmd.name || '').replace(/^\//, '').trim() }))
    .filter((cmd) => {
      if (!cmd.name || seen.has(cmd.name)) return false;
      seen.add(cmd.name);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchSlashCommands() {
  if (!activeLiveSessionId) return [];
  if (slashCommandCacheSessionId === activeLiveSessionId) return slashCommandCache;
  slashCommandCacheSessionId = activeLiveSessionId;
  let rpcCommands: SlashCommand[] = [];
  try {
    const res = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_commands', sessionId: activeLiveSessionId }),
    });
    const data = await res.json();
    if (!res.ok || data.success === false) throw new Error(data.error || 'Failed to load commands');
    rpcCommands = collectSlashCommands(data.data || data);
  } catch (e) {
    console.warn('[Tau] Failed to load Pi slash commands:', e);
  }
  slashCommandCache = uniqueSlashCommands([...TUI_BUILTIN_SLASH_COMMANDS, ...rpcCommands]);
  return slashCommandCache;
}

function hideSlashSuggestions() {
  slashCommandSuggestions.classList.add('hidden');
  slashCommandSuggestions.innerHTML = '';
}

function renderSlashSuggestions(commands: SlashCommand[]) {
  slashCommandSuggestions.innerHTML = '';
  if (!commands.length) { hideSlashSuggestions(); return; }
  slashCommandSuggestions.classList.remove('hidden');
  for (const cmd of commands.slice(0, 8)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slash-command-item';
    const tags = [cmd.source === 'builtin' ? '' : cmd.source, cmd.location].filter(Boolean).join(' / ');
    const meta = [cmd.description, tags].filter(Boolean).join(' - ');
    btn.innerHTML = `
      <span class="slash-command-name">/${escapeHtml(cmd.name)}</span>
      ${meta ? `<span class="slash-command-desc">${escapeHtml(meta)}</span>` : ''}
    `;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rest = messageInput.value.replace(/^\/\S*/, '').trimStart();
      messageInput.value = `/${cmd.name}${rest ? ` ${rest}` : ' '}`;
      messageInput.dispatchEvent(new Event('input'));
      hideSlashSuggestions();
      messageInput.focus();
    });
    slashCommandSuggestions.appendChild(btn);
  }
}

async function updateSlashCommandSuggestions() {
  const match = messageInput.value.match(/^\/(\S*)$/);
  if (!match) { hideSlashSuggestions(); return; }
  const query = match[1].toLowerCase();
  const requestId = ++slashCommandRequestId;
  try {
    const commands = await fetchSlashCommands();
    if (requestId !== slashCommandRequestId) return;
    renderSlashSuggestions(commands.filter((cmd) => cmd.name.toLowerCase().includes(query)));
  } catch {
    hideSlashSuggestions();
  }
}

function currentFileReferenceQuery() {
  const caret = messageInput.selectionStart ?? messageInput.value.length;
  const before = messageInput.value.slice(0, caret);
  const match = before.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;
  return { query: match[2] || '', start: before.length - (match[2] || '').length - 1, end: caret };
}

function renderFileReferenceSuggestions(results: Array<{ name: string; path: string; relativePath: string }>) {
  slashCommandSuggestions.innerHTML = '';
  fileReferenceSuggestions = results.slice(0, 8);
  if (!fileReferenceSuggestions.length) { hideSlashSuggestions(); return; }
  slashCommandSuggestions.classList.remove('hidden');
  for (const file of fileReferenceSuggestions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slash-command-item';
    btn.innerHTML = `
      <span class="slash-command-name">@${escapeHtml(file.relativePath)}</span>
      <span class="slash-command-desc">${escapeHtml(file.path)}</span>
    `;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      acceptFileReference(file);
    });
    slashCommandSuggestions.appendChild(btn);
  }
}

async function updateFileReferenceSuggestions() {
  const ref = currentFileReferenceQuery();
  if (!ref || !activeLiveSessionId) {
    fileReferenceSuggestions = [];
    if (!messageInput.value.startsWith('/')) hideSlashSuggestions();
    return;
  }
  const requestId = ++fileReferenceRequestId;
  try {
    const params = new URLSearchParams({ sessionId: activeLiveSessionId, q: ref.query });
    const res = await fetch(`/api/file-search?${params.toString()}`);
    const data = await res.json();
    if (requestId !== fileReferenceRequestId) return;
    if (!res.ok || data.error) throw new Error(data.error || 'File search failed');
    renderFileReferenceSuggestions(data.results || []);
  } catch {
    fileReferenceSuggestions = [];
    hideSlashSuggestions();
  }
}

function acceptFileReference(file: { name: string; path: string; relativePath: string }) {
  const ref = currentFileReferenceQuery();
  if (!ref) return;
  const label = `@${file.relativePath}`;
  messageInput.value = messageInput.value.slice(0, ref.start) + label + ' ' + messageInput.value.slice(ref.end);
  const nextCaret = ref.start + label.length + 1;
  messageInput.selectionStart = messageInput.selectionEnd = nextCaret;
  if (!pendingFilePaths.some((fp) => fp.path === file.path)) {
    pendingFilePaths.push({ path: file.path, name: file.name, ext: fileExt(file.name), sessionId: activeLiveSessionId });
  }
  renderAttachmentPreviews();
  messageInput.dispatchEvent(new Event('input'));
  hideSlashSuggestions();
  messageInput.focus();
}

function messageWithFileRefs(message: string, files: PendingFilePath[]) {
  const unique = Array.from(new Map(files.map((fp) => [fp.path, fp])).values());
  const missing = unique.filter((fp) => !message.includes(fp.path));
  if (!missing.length) return message;
  const refs = missing.map((fp) => `- ${fp.path}`).join('\n');
  if (!message) return `Please read the attached file(s):\n${refs}`;
  return `${message}\n\nAttached files:\n${refs}`;
}

function parseSlashInput(message: string): ParsedSlashInput | null {
  const match = message.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name: match[1].trim().toLowerCase(),
    args: (match[2] || '').trim(),
    raw: message,
  };
}

function clearComposer() {
  messageInput.value = '';
  messageInput.style.height = 'auto';
  pendingImages = [];
  pendingFilePaths = [];
  renderAttachmentPreviews();
  hideSlashSuggestions();
}

function firstCommandArg(args: string) {
  const trimmed = args.trim();
  if (!trimmed) return '';
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  return trimmed.split(/\s+/)[0] || '';
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

async function refreshActiveLiveSessionSnapshot() {
  if (!activeLiveSessionId) return;
  const res = await fetch(`/api/live-sessions/${encodeURIComponent(activeLiveSessionId)}/snapshot`);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Failed to refresh session');
  applyLiveSessionSnapshot({ ...data, sessionId: activeLiveSessionId });
  const active = liveSessions.find(s => s.id === activeLiveSessionId);
  if (active) {
    const snapshotSession = data.session || {};
    upsertLiveSession({ ...active, ...snapshotSession, sessionFile: data.sessionFile || snapshotSession.sessionFile || active.sessionFile });
  }
}

function showWebHotkeys() {
  messageRenderer.renderSystemMessage([
    'Keyboard Shortcuts',
    '/ focus input',
    'Enter send',
    'Shift+Enter newline',
    'Esc close popup or abort streaming',
    'Attach button upload files',
  ].join('\n'));
}

async function copyLastAssistantMessage() {
  const data = await rpcCommand({ type: 'get_last_assistant_text' }, 'Copying...');
  const text = data?.data?.text;
  if (!data?.success || !text) {
    messageRenderer.renderError(data?.error || 'No agent messages to copy yet.');
    return;
  }
  await copyTextToClipboard(String(text));
  setStatusMessage('Copied', 'Connected', 1600);
}

let lastForkMessages: Array<Record<string, unknown>> = [];

function messagePreview(value: unknown) {
  const text = typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text').map((b) => String((b as { text?: unknown }).text || '')).join('\n')
      : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 100);
}

async function showSessionTree() {
  const data = await rpcCommand({ type: 'get_fork_messages' }, 'Loading tree...');
  const raw = data?.data?.messages || data?.data?.forkMessages || data?.data || [];
  lastForkMessages = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
  if (!lastForkMessages.length) {
    messageRenderer.renderSystemMessage('No forkable messages found.');
    return;
  }
  const lines = ['Session Tree'];
  lastForkMessages.slice(0, 30).forEach((entry, i) => {
    const msg = (entry.message || entry) as { content?: unknown; id?: unknown };
    const id = String(entry.entryId || entry.id || msg.id || entry.messageId || i + 1);
    lines.push(`${i + 1}. ${id}  ${messagePreview(entry.text || msg.content || entry.content)}`);
  });
  lines.push('Use /fork <number-or-id> to fork.');
  messageRenderer.renderSystemMessage(lines.join('\n'));
}

function forkTargetFromArg(arg: string) {
  const value = firstCommandArg(arg);
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0 && numeric <= lastForkMessages.length) {
    const entry = lastForkMessages[numeric - 1];
    const msg = (entry.message || entry) as { id?: unknown };
    return entry.entryId || entry.id || msg.id || entry.messageId || value;
  }
  return value;
}

async function forkSession(arg: string) {
  const target = forkTargetFromArg(arg);
  if (!target) {
    await showSessionTree();
    return;
  }
  const data = await rpcCommand({ type: 'fork', entryId: target }, 'Forking...');
  if (data?.success) await refreshActiveLiveSessionSnapshot();
}

async function resumeSessionFromSlash(arg: string) {
  const filePath = firstCommandArg(arg);
  if (!filePath) {
    sidebarEl.classList.remove('collapsed');
    sessionSearchInput.focus();
    messageRenderer.renderSystemMessage('Select a session from the sidebar, or use /resume /path/to/session.jsonl.');
    return;
  }
  const res = await fetch('/api/live-sessions/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Failed to resume session');
  upsertLiveSession(data.session);
  await selectLiveSession(data.session.id);
}

async function importSessionFromSlash(arg: string, files: PendingFilePath[]) {
  const fromArg = firstCommandArg(arg);
  const filePath = fromArg || files.find((fp) => fp.ext === 'jsonl')?.path || files[0]?.path || '';
  if (!filePath) throw new Error('Use /import /path/to/session.jsonl');
  const data = await rpcCommand({ type: 'import_session', filePath }, 'Importing...');
  if (data?.success && data.data?.session) {
    upsertLiveSession(data.data.session);
    await selectLiveSession(data.data.session.id);
    messageRenderer.renderSystemMessage(`Imported: ${data.data.filePath}`);
  }
}

async function showOrSetScopedModels(arg: string) {
  const value = arg.trim();
  if (value) {
    await rpcCommand({ type: 'set_pi_setting', key: 'enabledModels', value: value.split(',').map(s => s.trim()).filter(Boolean) }, 'Saving...');
    messageRenderer.renderSystemMessage('Model cycling scope saved. New Pi sessions will use it.');
    return;
  }
  const data = await rpcCommand({ type: 'get_pi_settings' }, 'Loading...');
  const models = data?.data?.settings?.enabledModels || data?.data?.settings?.models || [];
  messageRenderer.renderSystemMessage(`Scoped models: ${Array.isArray(models) && models.length ? models.join(', ') : '(default)'}`);
}

async function trustProject(arg: string) {
  const value = firstCommandArg(arg).toLowerCase();
  const trusted = !(value === 'false' || value === 'no' || value === 'untrusted' || value === 'off');
  const data = await rpcCommand({ type: 'trust_project', trusted }, 'Saving trust...');
  if (data?.success) {
    const state = trusted ? 'trusted' : 'untrusted';
    messageRenderer.renderSystemMessage(`Project marked ${state}: ${data.data?.path}\nRestart or create a new Tau tab for Pi to reload trust.`);
  }
}

async function reloadWebState() {
  slashCommandCacheSessionId = null;
  slashCommandCache = [];
  await sidebar.loadSessions();
  updateLiveSessionIndicators();
  messageRenderer.renderSystemMessage('Reloaded Web command cache and sessions.');
}

async function handleBuiltinSlashCommand(parsed: ParsedSlashInput, files: PendingFilePath[]) {
  const builtin = TUI_BUILTIN_SLASH_COMMANDS.find((cmd) => cmd.name === parsed.name);
  if (!builtin) return false;

  if (parsed.name !== 'import' && (pendingImages.length > 0 || files.length > 0)) {
    flashStatusError('Slash commands do not accept attachments');
    return true;
  }

  clearComposer();

  try {
    switch (parsed.name) {
      case 'settings':
        await openSettings();
        return true;
      case 'model':
        if (parsed.args) await modelPickerController.applyModelSpec(parsed.args);
        else modelPickerController.open();
        return true;
      case 'scoped-models':
        await showOrSetScopedModels(parsed.args);
        return true;
      case 'compact':
        await rpcCommand({ type: 'compact', customInstructions: parsed.args || undefined }, 'Compacting...');
        return true;
      case 'export':
        await rpcExportHtml(firstCommandArg(parsed.args));
        return true;
      case 'import':
        await importSessionFromSlash(parsed.args, files);
        return true;
      case 'copy':
        await copyLastAssistantMessage();
        return true;
      case 'name':
        if (parsed.args) {
          const data = await rpcCommand({ type: 'set_session_name', name: parsed.args }, 'Renaming...');
          if (data?.success) messageRenderer.renderSystemMessage(`Session name set: ${parsed.args}`);
        } else {
          const data = await rpcCommand({ type: 'get_state' }, 'Loading name...');
          const name = data?.data?.sessionName || '(unnamed)';
          messageRenderer.renderSystemMessage(`Session name: ${name}`);
        }
        return true;
      case 'session':
        await showSessionStats();
        return true;
      case 'hotkeys':
        showWebHotkeys();
        return true;
      case 'tree':
        await showSessionTree();
        return true;
      case 'fork':
        await forkSession(parsed.args);
        return true;
      case 'trust':
        await trustProject(parsed.args);
        return true;
      case 'resume':
        await resumeSessionFromSlash(parsed.args);
        return true;
      case 'reload':
        await reloadWebState();
        return true;
      case 'quit':
        if (activeLiveSessionId) await closeLiveSession(activeLiveSessionId);
        return true;
      case 'new': {
        const data = await rpcCommand({ type: 'new_session' }, 'Starting new session...');
        if (data?.success) await refreshActiveLiveSessionSnapshot();
        return true;
      }
      case 'clone': {
        const data = await rpcCommand({ type: 'clone' }, 'Cloning session...');
        if (data?.success) await refreshActiveLiveSessionSnapshot();
        return true;
      }
      default:
        messageRenderer.renderSystemMessage(`/${parsed.name} is not available in Tau Web.`);
        return true;
    }
  } catch (e) {
    messageRenderer.renderError((e instanceof Error ? e.message : '') || `/${parsed.name} failed`);
    return true;
  }
}

// ═══════════════════════════════════════
// Send message (with images)
// ═══════════════════════════════════════

let messageQueue: QueuedCommand[] = [];

function parseShellInput(message: string) {
  const match = message.match(/^(!{1,2})(?:\s*)([\s\S]+)$/);
  if (!match) return null;
  return { hidden: match[1] === '!!', command: match[2].trim() };
}

async function handleShellInput(shell: { hidden: boolean; command: string }) {
  clearComposer();
  if (!shell.command) return;
  const type = shell.hidden ? 'local_bash' : 'bash';
  const data = await rpcCommand({ type, command: shell.command }, shell.hidden ? 'Running hidden shell...' : 'Running shell...');
  if (data?.success) {
    const out = data.data?.output || '';
    const exitCode = data.data?.exitCode ?? 0;
    const label = shell.hidden ? 'Hidden shell' : 'Shell';
    messageRenderer.renderSystemMessage(`${label}: ${shell.command}\nExit: ${exitCode}\n${out ? `\n${out}` : ''}`);
    if (!shell.hidden) messageRenderer.renderSystemMessage('Shell output was added to Pi context for the next prompt.');
  } else if (data?.error) {
    messageRenderer.renderError(data.error);
  }
}

function sendMessage(streamingMode: 'steer' | 'follow_up' = 'steer') {
  const message = messageInput.value.trim();
  const files = [...pendingFilePaths];
  const images = [...pendingImages];
  if (!message && images.length === 0 && files.length === 0) return;

  if (!activeLiveSessionId) {
    messageRenderer.renderError('Create or select a Tau tab first.');
    updateLiveSessionInputState();
    return;
  }

  const shellInput = parseShellInput(message);
  if (shellInput) {
    if (images.length > 0 || files.length > 0) {
      flashStatusError('Shell commands do not accept attachments');
      return;
    }
    handleShellInput(shellInput).catch((e) => messageRenderer.renderError((e instanceof Error ? e.message : '') || 'Shell command failed'));
    return;
  }

  const slashInput = parseSlashInput(message);
  if (slashInput) {
    handleBuiltinSlashCommand(slashInput, files).then((handled) => {
      if (!handled) sendPromptMessage(message, files, images, streamingMode, true);
    });
    return;
  }

  sendPromptMessage(message, files, images, streamingMode);
}

function sendPromptMessage(message: string, files: PendingFilePath[], images: PendingImage[], streamingMode: 'steer' | 'follow_up' = 'steer', forcePromptWhileStreaming = false) {
  clearComposer();

  const finalMessage = messageWithFileRefs(message, files);
  const cmd: QueuedCommand = { type: 'prompt', message: finalMessage || '(see attached image)' };

  if (images.length > 0) {
    cmd.images = images.map(img => {
      console.log(`[Tau] Sending image: mimeType=${img.mimeType}, dataLen=${img.data?.length}`);
      return { type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' };
    });
  }

  cmd.sessionId = activeLiveSessionId || undefined;

  if (state.isStreaming) {
    if (forcePromptWhileStreaming) {
      wsClient.send(cmd);
      return;
    }
    cmd.type = streamingMode === 'follow_up' ? 'follow_up' : 'steer';
    cmd.label = streamingMode === 'follow_up' ? 'Follow-up' : 'Steer';
    cmd.remote = true;
    messageQueue.push(cmd);
    lastSentMessage = cmd.message ?? null;
    renderQueuedMessages();
    wsClient.send(cmd);
    return;
  }

  lastSentMessage = cmd.message ?? null;
  messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
  wsClient.send(cmd);
}

const queuedMessagesEl = document.getElementById('queued-messages')!;

function renderQueuedMessages() {
  queuedMessagesEl.innerHTML = '';
  if (messageQueue.length === 0) {
    queuedMessagesEl.classList.add('hidden');
    return;
  }
  queuedMessagesEl.classList.remove('hidden');
  messageQueue.forEach((cmd, i) => {
    if (cmd.sessionId !== activeLiveSessionId) return;
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `
      <span class="queued-msg-label">${escapeHtml(cmd.label || 'Queued')}</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message || '')}</span>
      <button class="queued-msg-cancel" title="Cancel">×</button>
    `;
    el.querySelector('.queued-msg-cancel')?.addEventListener('click', () => {
      messageQueue.splice(i, 1);
      renderQueuedMessages();
      if (cmd.remote) wsClient.send({ type: 'abort', sessionId: activeLiveSessionId });
    });
    queuedMessagesEl.appendChild(el);
  });
  queuedMessagesEl.classList.toggle('hidden', queuedMessagesEl.children.length === 0);
}

function handleQueueUpdate(event: AppEvent, sessionId: string | null = null) {
  const targetSessionId = sessionId || activeLiveSessionId || undefined;
  if (!targetSessionId) return;
  const steering = Array.isArray(event.steering) ? event.steering : [];
  const followUp = Array.isArray(event.followUp) ? event.followUp : [];
  messageQueue = messageQueue.filter((cmd) => cmd.sessionId !== targetSessionId || !cmd.remote);
  for (const msg of steering) {
    messageQueue.push({ type: 'steer', label: 'Steer', message: String(msg), sessionId: targetSessionId, remote: true });
  }
  for (const msg of followUp) {
    messageQueue.push({ type: 'follow_up', label: 'Follow-up', message: String(msg), sessionId: targetSessionId, remote: true });
  }
  renderQueuedMessages();
}

function escapeHtml(text: string) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function flushQueue() {
  if (!activeLiveSessionId || state.isStreaming) return;
  const idx = messageQueue.findIndex(cmd => cmd.sessionId === activeLiveSessionId && !cmd.remote);
  if (idx >= 0) {
    const [cmd] = messageQueue.splice(idx, 1);
    lastSentMessage = cmd.message ?? null;
    messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
    renderQueuedMessages();
    wsClient.send(cmd);
  }
}

abortBtn.addEventListener('click', () => {
  if (!viewingActiveSession || !activeLiveSessionId) return;
  wsClient.send({ type: 'abort', sessionId: activeLiveSessionId });
  messageRenderer.renderError('Aborted by user');
  showTypingIndicator(false);
});

// Command Palette
const commandPaletteController = setupCommandPalette([
  { icon: '🗜️', label: 'Compact', desc: 'Compact context to save tokens', action: () => rpcCommand({ type: 'compact' }, 'Compacting...') },
  { icon: '📋', label: 'Export HTML', desc: 'Export session as HTML file', action: () => rpcExportHtml() },
  { icon: '📊', label: 'Session Stats', desc: 'Show session statistics', action: () => showSessionStats() },
  { icon: '⬇️', label: 'Expand All Tools', desc: 'Expand all tool cards', action: () => toolCardRenderer.expandAll() },
  { icon: '⬆️', label: 'Collapse All Tools', desc: 'Collapse all tool cards', action: () => toolCardRenderer.collapseAll() },
]);

async function rpcCommand(cmd: RpcCommand, statusMsg = '') {
  try {
    const backendLocalCommands = new Set(['get_auth', 'set_auth', 'get_available_models', 'get_pi_settings', 'set_pi_setting', 'import_session']);
    const needsLiveSession = !cmd.sessionId && !cmd.filePath && !backendLocalCommands.has(cmd.type);
    if (needsLiveSession && (!viewingActiveSession || !activeLiveSessionId)) {
      const error = 'Select a live Tau tab first.';
      setStatusMessage(error, wsClient.ws?.readyState === WebSocket.OPEN ? 'Connected' : 'Disconnected', 3000);
      return { type: 'response', command: cmd.type, success: false, error };
    }
    if (!cmd.sessionId && viewingActiveSession && activeLiveSessionId) cmd = { ...cmd, sessionId: activeLiveSessionId };
    if (statusMsg) setStatusMessage(statusMsg);
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const data = await resp.json();
    if (data.success) {
      setStatusMessage('Done', 'Connected', 2000);
    } else {
      setStatusMessage(data.error || 'Failed', 'Connected', 3000);
    }
    return data;
  } catch (e) {
    setStatusMessage('Error', 'Connected', 3000);
  }
}

async function rpcExportHtml(outputPath = '') {
  const cmd: RpcCommand = outputPath ? { type: 'export_html', outputPath } : { type: 'export_html' };
  const data = await rpcCommand(cmd, 'Exporting...');
  if (data?.success && data.data?.path) {
    setStatusMessage(`Exported: ${data.data.path}`, 'Connected', 4000);
    messageRenderer.renderSystemMessage(`Exported: ${data.data.path}`);
  }
}

async function showSessionStats() {
  const data = await rpcCommand({ type: 'get_session_stats' }, 'Loading stats...');
  if (data?.success && data.data) {
    const s = data.data;
    const lines = [
      `📊 Session Stats`,
      s.sessionName ? `Name: ${s.sessionName}` : '',
      s.sessionFile ? `File: ${s.sessionFile}` : '',
      s.sessionId ? `ID: ${s.sessionId}` : '',
      `Messages: ${s.totalMessages} (${s.userMessages} user, ${s.assistantMessages} assistant)`,
      `Tool calls: ${s.toolCalls}`,
    ].filter(Boolean);
    if (s.tokens) {
      lines.push(`Context: ~${(s.tokens.input / 1000).toFixed(1)}k tokens`);
    }
    messageRenderer.renderSystemMessage(lines.join('\n'));
  }
}

// Model Picker
const modelPickerController = setupModelPicker({
  getActiveLiveSessionId: () => activeLiveSessionId,
  isViewingActiveSession: () => viewingActiveSession,
  rpcCommand,
  flashStatusError,
  escapeHtml,
  setContextWindowSize(value) { contextWindowSize = value; },
  updateTokenUsage,
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === 'Escape') {
    // Close palettes/panels first
    if (!slashCommandSuggestions.classList.contains('hidden')) {
      hideSlashSuggestions();
      return;
    }
    if (modelPickerController.closeIfOpen()) return;
    if (!settingsPanel.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (commandPaletteController.closeIfOpen()) return;

    if (state.isStreaming && viewingActiveSession && activeLiveSessionId) {
      wsClient.send({ type: 'abort', sessionId: activeLiveSessionId });
      messageRenderer.renderError('Aborted by user');
      showTypingIndicator(false);
    } else if (!sidebarEl.classList.contains('collapsed') && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Focus message input (when not already in an input)
  if (e.key === '/' && !isInInput()) {
    e.preventDefault();
    messageInput.focus();
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 768;
}

function updateSidebarToggleIcon() {
  sidebarToggle.textContent = '☰';
}

function toggleSidebar() {
  sidebarEl.classList.toggle('collapsed');
  sidebarOverlay.classList.toggle('visible', !sidebarEl.classList.contains('collapsed') && isMobile());
  updateSidebarToggleIcon();
}

sidebarToggle.addEventListener('click', toggleSidebar);

sidebarOverlay.addEventListener('click', () => {
  sidebarEl.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
  updateSidebarToggleIcon();
});



const newSessionBtn = document.getElementById('new-session-btn')!;
newSessionBtn.addEventListener('click', openNewLiveSessionModal);

refreshSessionsBtn.addEventListener('click', () => {
  if (isMobile()) {
    location.reload();
    return;
  }
  refreshSessionsBtn.classList.add('spinning');
  sidebar.loadSessions().then(() => {
    setTimeout(() => refreshSessionsBtn.classList.remove('spinning'), 600);
    updateLiveSessionIndicators();
  });
});

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    // Only track swipes starting within 20px of left edge
    if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains('collapsed')) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      tracking = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    // If vertical movement dominates, cancel
    if (dy > dx) {
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    if (dx > 60) {
      sidebarEl.classList.remove('collapsed');
      sidebarOverlay.classList.add('visible');
    }
  }, { passive: true });
})();

// Session search
sessionSearchInput.addEventListener('input', () => {
  sidebar.setSearchQuery(sessionSearchInput.value);
});

async function newSession() {
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();
  await switchSession(null);
  sidebar.clearActive();
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
  if (!isMobile()) messageInput.focus();
}

async function handleSessionSelect(session: SidebarSession | null, project: SidebarProject | null) {
  if (session) sidebar.setActive(session.filePath);
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();
  if (session) await switchSession(session.filePath, session, project);

  // Close sidebar on mobile after selecting
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
}

async function switchSession(sessionFile: string | null | undefined, session: SidebarSession | null = null, project: SidebarProject | null = null) {
  try {
    // Clear any streaming state from previous session to prevent bleed
    currentStreamingElement = null;
    currentStreamingThinking = '';
    currentStreamingText = '';
    viewingActiveSession = false;
    
    state.reset();
    showTypingIndicator(false);
    updateUI();
    messageRenderer.clear();
    toolCardRenderer.clear();

    // Clicking a historical session resumes it as a live backend Tau tab.
    // selectLiveSession() will load the resumed tab snapshot with the same
    // historical entries after the backend has attached to the session file.
    if (sessionFile) {
      const live = liveSessions.find(s => s.sessionFile === sessionFile);
      if (live) {
        await selectLiveSession(live.id);
        return;
      }
      // No live tab yet — ask the server to resume this session.
      messageRenderer.renderSystemMessage('Resuming session…');
      try {
        const resumeBody: Record<string, unknown> = { filePath: sessionFile };
        if (project?.path) resumeBody.cwd = project.path;
        const res = await fetch('/api/live-sessions/resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(resumeBody),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          messageRenderer.clear();
          messageRenderer.renderError(data.error || 'Failed to resume session');
          viewingActiveSession = false;
          updateLiveSessionInputState();
          updateUI();
          return;
        }
        // If the server found an existing live tab (reused), just focus it.
        if (data.reused && data.session) {
          upsertLiveSession(data.session);
          await selectLiveSession(data.session.id);
          return;
        }
        upsertLiveSession(data.session);
        await selectLiveSession(data.session.id);
      } catch (e) {
        messageRenderer.clear();
        messageRenderer.renderError('Failed to resume session');
        viewingActiveSession = false;
        updateLiveSessionInputState();
        updateUI();
      }
      return;
    }

    messageRenderer.renderWelcome();
  } catch (error) {
    console.error('[App] Failed to switch session:', error);
    messageRenderer.renderError('Failed to switch session');
  }
}

// ═══════════════════════════════════════
// Live-session snapshot sync
// ═══════════════════════════════════════

function applyLiveSessionSnapshot(data: LiveSessionSnapshotData) {
  console.log('[LiveSession] Received state snapshot:', data.entries?.length, 'entries');
  if (data.sessionId && data.sessionId !== activeLiveSessionId) return;
  hasReceivedInitialServerState = true;

  // Track the active session
  activeLiveSessionFile = data.sessionFile || data.session?.sessionFile || null;
  viewingActiveSession = !!activeLiveSessionId;
  state.setStreaming(!!data.isStreaming);
  showTypingIndicator(!!data.isStreaming);
  updateLiveSessionInputState();
  updateUI();
  updateLiveSessionIndicators();

  // Update model display — server is canonical, assign directly.
  if (data.model !== undefined) {
    if (data.model?.contextWindow) {
      contextWindowSize = Number(data.model.contextWindow) || 0;
    }
    modelPickerController.setModelState(data.model || '', data.thinkingLevel || 'off');
  } else if (data.thinkingLevel) {
    modelPickerController.setThinkingLevel(data.thinkingLevel || 'off');
  }

  // Clear and render message history. Reset streaming handles after the
  // snapshot arrives because live deltas may have created a streaming element
  // while the snapshot request was in flight; that element is about to be
  // removed from the DOM.
  currentStreamingElement = null;
  currentStreamingThinking = '';
  currentStreamingText = '';
  messageRenderer.clear();
  sessionTotalCost = 0;
  lastInputTokens = 0;

  if (data.entries && data.entries.length > 0) {
    renderSessionHistory(data.entries);
  } else {
    messageRenderer.renderWelcome();
  }

  updateCostDisplay();
  updateTokenUsage();
}

// Mark all live sessions in the sidebar with a green dot
function updateLiveSessionIndicators() {
  const liveFiles = new Set(liveInstances.map(i => i.sessionFile));
  // Also include the current active live session
  if (activeLiveSessionFile) liveFiles.add(activeLiveSessionFile);

  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('has-live-session', liveFiles.has(el.dataset.filePath));
  });
}

// Refresh live-session list for sidebar indicators if WS missed an update
async function pollInstances() {
  try {
    const res = await fetch('/api/live-sessions');
    if (res.ok) {
      const data = await res.json();
      const wasActive = activeLiveSessionId;
      setLiveSessions(data.sessions || []);
      const activeSession = wasActive ? liveSessions.find(s => s.id === wasActive) : null;
      if (wasActive && !activeSession) {
        handleLiveSessionClosed(wasActive);
      } else if (activeSession && viewingActiveSession) {
        state.setStreaming(!!activeSession.isStreaming);
        showTypingIndicator(!!activeSession.isStreaming);
        applyActiveSessionMetadata(activeSession);
        updateLiveSessionInputState();
        updateUI();
      }
    }
  } catch {}
}

// Poll every 10 seconds
setInterval(pollInstances, 10000);

// Enable/disable input based on whether we're viewing a live backend Tau tab
function updateLiveSessionInputState() {
  const inputArea = document.querySelector('.input-area');
  const hasLiveSession = viewingActiveSession && !!activeLiveSessionId;
  if (hasLiveSession) {
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.placeholder = 'Message...';
    inputArea?.classList.remove('no-active-live-session');
  } else {
    messageInput.disabled = true;
    sendBtn.disabled = true;
    messageInput.placeholder = hasReceivedInitialServerState ? 'Create or select a Tau tab to chat' : 'Connecting...';
    inputArea?.classList.add('no-active-live-session');
  }
  document.getElementById('command-btn')!.disabled = !hasLiveSession;
  modelPickerController.setEnabled(hasLiveSession);
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

function renderSessionHistory(entries: SessionHistoryEntry[]) {
  console.log(`[History] Rendering ${entries.length} entries`);
  let userCount = 0, assistantCount = 0, toolCardCount = 0, toolResultCount = 0;

  for (const entry of entries) {
    if (entry.type !== 'message') continue;

    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content || [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      // Extract images from content blocks
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === 'image')
            .map((b) => ({ data: b.source?.data || b.data || '', mimeType: b.source?.media_type || b.media_type || 'image/png' }))
        : [];
      if (content || images.length > 0) {
        userCount++;
        messageRenderer.renderUserMessage({ content: content || '', images: images.length > 0 ? images : undefined }, true);
      }
    } else if (msg.role === 'assistant') {
      const textBlocks = ((msg.content as MessageContentBlock[]) || []).filter((b) => b.type === 'text');
      const thinkingBlocks = ((msg.content as MessageContentBlock[]) || []).filter((b) => b.type === 'thinking');
      const toolCalls = ((msg.content as MessageContentBlock[]) || []).filter((b) => b.type === 'toolCall');

      // Build content blocks for rendering
      const contentBlocks = [];
      for (const block of (msg.content as MessageContentBlock[]) || []) {
        if (block.type === 'text' || block.type === 'thinking') {
          contentBlocks.push(block);
        }
      }

      const text = textBlocks.map((b) => b.text).join('\n');

      if (text || thinkingBlocks.length > 0) {
        assistantCount++;
        messageRenderer.renderAssistantMessage(
          {
            content: contentBlocks.length > 0 ? contentBlocks : text,
            usage: msg.usage,
          },
          false,
          true
        );

        // Track cost and tokens from history
        if (msg.usage?.cost?.total) {
          sessionTotalCost += msg.usage.cost.total;
        }
        if (msg.usage?.input) {
          lastInputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          lastUsage = msg.usage;
        }
      }

      // Show tool calls as compact history cards
      for (const tc of toolCalls) {
        toolCardCount++;
        const card = toolCardRenderer.createHistoryCard({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments || {},
        });
        console.log(`[History] Tool card created: ${tc.name}`, card?.offsetHeight, card?.innerHTML?.substring(0, 100));
      }
    } else if (msg.role === 'toolResult') {
      toolResultCount++;
      toolCardRenderer.addHistoryResult(
        msg.toolCallId ?? '',
        { content: (msg.content as MessageContentBlock[]) || [] },
        msg.isError ?? false
      );
    } else if (msg.role === 'bashExecution') {
      const command = String((msg as AppMessage & { command?: unknown }).command || '');
      const output = String((msg as AppMessage & { output?: unknown }).output || '');
      const exitCode = (msg as AppMessage & { exitCode?: unknown }).exitCode ?? 0;
      messageRenderer.renderSystemMessage(`Shell: ${command}\nExit: ${exitCode}\n${output}`);
    }
  }

  console.log(`[History] Done: ${userCount} users, ${assistantCount} assistants, ${toolCardCount} tools, ${toolResultCount} results`);
  console.log(`[History] DOM tool-card count:`, document.querySelectorAll('.tool-card').length);
  console.log(`[History] DOM thinking-block count:`, document.querySelectorAll('.thinking-block').length);

  updateCostDisplay();
  updateTokenUsage();
  fetchContextWindow();

  // Jump to bottom instantly (no smooth scroll animation)
  messagesContainer.style.scrollBehavior = 'auto';
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    // Restore smooth scrolling after a frame
    requestAnimationFrame(() => {
      messagesContainer.style.scrollBehavior = '';
    });
  });
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

function showTypingIndicator(show: boolean) {
  typingIndicator.classList.toggle('hidden', !show);
}

function updateCostDisplay() {
  if (sessionTotalCost > 0) {
    sessionCostEl.textContent = `$${sessionTotalCost.toFixed(4)} (sub)`;
    sessionCostEl.classList.add('visible');
  } else {
    sessionCostEl.classList.remove('visible');
  }
}

function updateTokenUsage() {
  if (lastInputTokens > 0 && contextWindowSize > 0) {
    const pct = Math.round((lastInputTokens / contextWindowSize) * 100);
    tokenUsageEl.textContent = pct === 0 ? '<1%' : `${pct}%`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
    if (pct >= 80) {
      tokenUsageEl.classList.add('critical');
    } else if (pct >= 60) {
      tokenUsageEl.classList.add('warning');
    }
    tokenUsageEl.title = `Context: ${(lastInputTokens / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k tokens`;
    if (pct >= 80) {
      showCompactButton();
    } else {
      hideCompactButton();
    }
  } else if (lastInputTokens > 0) {
    // No context window info yet, just show raw tokens
    tokenUsageEl.textContent = `${(lastInputTokens / 1000).toFixed(1)}k`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
  }
}

function showCompactButton() {
  if (document.getElementById('compact-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'compact-btn';
  btn.className = 'compact-btn';
  btn.textContent = 'Compact';
  btn.title = 'Context is over 80% — compact to save tokens';
  btn.addEventListener('click', () => {
    rpcCommand({ type: 'compact' }, 'Compacting...');
    hideCompactButton();
  });
  // Insert next to token usage in header
  const tokenParent = tokenUsageEl.parentElement;
  if (tokenParent) tokenParent.insertBefore(btn, tokenUsageEl.nextSibling);
}

function hideCompactButton() {
  const btn = document.getElementById('compact-btn');
  if (btn) btn.remove();
}

async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await modelPickerController.fetchModelInfo();
}

let tailscaleUrl = '';

function updateConnectionStatus(status: string) {
  statusIndicator.className = `status-indicator ${status}`;

  if (status === 'connected') {
    statusText.textContent = tailscaleUrl ? 'Connected • TS' : 'Connected';
    statusText.title = tailscaleUrl || '';
    // Fetch tailscale info on first connect
    if (!tailscaleUrl) {
      fetch('/api/health').then(r => r.json()).then(data => {
        if (data.tailscaleUrl) {
          tailscaleUrl = data.tailscaleUrl;
          statusText.textContent = 'Connected • TS';
          statusText.title = tailscaleUrl;
        }
      }).catch(() => {});
    }
  } else if (status === 'disconnected') {
    statusText.textContent = 'Disconnected';
  }
}

function updateUI() {
  const hasLiveSession = !!activeLiveSessionId && viewingActiveSession;
  const isStreaming = state.isStreaming && hasLiveSession;

  // Don't clobber an active red-dot error flash: it owns both the indicator
  // class and statusText for its full 3 s. The flash's restore callback
  // re-derives the current connection/streaming state, so skipping here is
  // safe. Other UI updates below (input enabling, abort button, etc.) still
  // run normally.
  if (statusFlashTimer === null) {
    if (isStreaming) {
      statusIndicator.classList.add('streaming');
      statusIndicator.classList.remove('connected');
      statusText.textContent = 'Working...';
    } else {
      statusIndicator.classList.remove('streaming');
      statusIndicator.classList.add('connected');
      statusText.textContent = 'Connected';
    }
  }

  messageInput.disabled = !hasLiveSession;
  sendBtn.disabled = !hasLiveSession;

  if (isStreaming) {
    abortBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
  } else {
    abortBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
    if (hasLiveSession) flushQueue();
  }
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener('sessionSwitch', () => {
  console.log('[App] Session switched');
});

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════



const settingsBtn = document.getElementById('settings-btn')!;
const settingsPanel = document.getElementById('settings-panel')!;
const settingsOverlay = document.getElementById('settings-overlay')!;
const settingsClose = document.getElementById('settings-close')!;
const themeGrid = document.getElementById('theme-grid')!;


const toggleAutoCompact = document.getElementById('toggle-auto-compact')!;
const toggleAutoRetry = document.getElementById('toggle-auto-retry')!;
const selectSteeringMode = document.getElementById('select-steering-mode')!;
const selectFollowUpMode = document.getElementById('select-follow-up-mode')!;
const btnThinkingLevel = document.getElementById('btn-thinking-level')!;
const toggleShowThinking = document.getElementById('toggle-show-thinking')!;


function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement('button');
    btn.className = `theme-swatch${current === id ? ' active' : ''}`;
    const dots = (theme.colors || []).map(c => 
      `<span class="swatch-dot" style="background:${c}"></span>`
    ).join('');
    btn.innerHTML = `<span class="swatch-colors">${dots}</span>`;
    btn.addEventListener('click', () => {
      applyTheme(id);
      themeGrid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
    });
    themeGrid.appendChild(btn);
  }
}

async function openSettings() {
  buildThemeGrid();
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');

  // Fetch current state for toggles
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state', sessionId: activeLiveSessionId }),
    });
    const data = await resp.json();
    if (data.success && data.data) {
      const s = data.data;
      // Auto-compaction toggle
      toggleAutoCompact.className = `settings-toggle${s.autoCompactionEnabled ? ' on' : ''}`;
      toggleAutoRetry.className = `settings-toggle${s.autoRetryEnabled !== false ? ' on' : ''}`;
      selectSteeringMode.value = s.steeringMode || 'one-at-a-time';
      selectFollowUpMode.value = s.followUpMode || 'one-at-a-time';
      // Thinking level
      btnThinkingLevel.textContent = s.thinkingLevel || 'off';
      modelPickerController.setThinkingLevel(s.thinkingLevel || 'off');
      // Session name is managed by Pi session history; no editable field in Tau settings.
    }
  } catch (e) {
    // Silent
  }

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: 'get_auth' });
    if (authData?.success && authData.data?.configured) {
      authSection.style.display = '';
      toggleAuth.className = `settings-toggle${authData.data.enabled ? ' on' : ''}`;
    } else {
      authSection.style.display = 'none';
    }
  } catch {
    authSection.style.display = 'none';
  }
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

// Auto-compaction toggle
toggleAutoCompact.addEventListener('click', async () => {
  const isOn = toggleAutoCompact.classList.contains('on');
  toggleAutoCompact.className = `settings-toggle${isOn ? '' : ' on'}`;
  await rpcCommand({ type: 'set_auto_compaction', enabled: !isOn });
});

toggleAutoRetry.addEventListener('click', async () => {
  const isOn = toggleAutoRetry.classList.contains('on');
  toggleAutoRetry.className = `settings-toggle${isOn ? '' : ' on'}`;
  await rpcCommand({ type: 'set_auto_retry', enabled: !isOn });
});

selectSteeringMode.addEventListener('change', async () => {
  await rpcCommand({ type: 'set_steering_mode', mode: selectSteeringMode.value });
});

selectFollowUpMode.addEventListener('change', async () => {
  await rpcCommand({ type: 'set_follow_up_mode', mode: selectFollowUpMode.value });
});

// Thinking level cycle (settings panel button)
btnThinkingLevel.addEventListener('click', async () => {
  const data = await rpcCommand({ type: 'cycle_thinking_level' });
  if (data?.success && data.data?.level) {
    btnThinkingLevel.textContent = data.data.level;
    modelPickerController.setThinkingLevel(data.data.level);
  }
});

// Show thinking toggle (local pref)
const showThinking = localStorage.getItem('tau-show-thinking') !== 'false';
toggleShowThinking.className = `settings-toggle${showThinking ? ' on' : ''}`;
if (!showThinking) document.body.classList.add('hide-thinking');

toggleShowThinking.addEventListener('click', () => {
  const isOn = toggleShowThinking.classList.contains('on');
  toggleShowThinking.className = `settings-toggle${isOn ? '' : ' on'}`;
  document.body.classList.toggle('hide-thinking', isOn);
  localStorage.setItem('tau-show-thinking', String(!isOn));
});

// Auth toggle
const toggleAuth = document.getElementById('toggle-auth')!;
const authSection = document.getElementById('settings-auth-section')!;

toggleAuth.addEventListener('click', async () => {
  const isOn = toggleAuth.classList.contains('on');
  const data = await rpcCommand({ type: 'set_auth', enabled: !isOn });
  if (data?.success) {
    toggleAuth.className = `settings-toggle${!isOn ? ' on' : ''}`;
  }
});





// Restore saved theme
const savedTheme = getCurrentTheme();
applyTheme(savedTheme);

// ═══════════════════════════════════════
// Context Window Visualiser
// ═══════════════════════════════════════

const contextViz = document.getElementById('context-viz')!;
const contextBar = document.getElementById('context-bar')!;
const contextLegend = document.getElementById('context-legend')!;
const contextVizUsed = document.getElementById('context-viz-used')!;
const contextVizTotal = document.getElementById('context-viz-total')!;


function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function updateContextViz() {
  if (!lastUsage || !contextWindowSize) return;

  const input = lastUsage.input || 0;
  const cacheRead = lastUsage.cacheRead || 0;
  const cacheWrite = lastUsage.cacheWrite || 0;
  const output = lastUsage.output || 0;
  const total = contextWindowSize;

  // Input tokens include cache — break it down
  // "input" from API = fresh (uncached) input tokens
  // "cacheRead" = tokens served from cache (system prompt, earlier messages)
  const freshInput = input;
  const totalUsed = freshInput + cacheRead;
  const free = Math.max(0, total - totalUsed);

  const segments = [
    { key: 'cache', label: 'Cached', tokens: cacheRead, color: 'cache' },
    { key: 'messages', label: 'Input', tokens: freshInput, color: 'messages' },
    { key: 'free', label: 'Available', tokens: free, color: 'free' },
  ];

  // Build bar
  contextBar.innerHTML = '';
  for (const seg of segments) {
    if (seg.tokens <= 0) continue;
    const pct = (seg.tokens / total) * 100;
    const el = document.createElement('div');
    el.className = `context-bar-segment ${seg.color}`;
    el.style.width = `${pct}%`;
    el.title = `${seg.label}: ${formatTokens(seg.tokens)}`;
    contextBar.appendChild(el);
  }

  // Build legend
  contextLegend.innerHTML = '';
  for (const seg of segments) {
    const item = document.createElement('div');
    item.className = 'context-legend-item';
    item.innerHTML = `
      <span class="context-legend-left">
        <span class="context-legend-dot ${seg.color}"></span>
        ${seg.label}
      </span>
      <span class="context-legend-value">${formatTokens(seg.tokens)}</span>
    `;
    contextLegend.appendChild(item);
  }

  // Footer
  const pct = Math.round((totalUsed / total) * 100);
  contextVizUsed.textContent = `${pct}% used`;
  contextVizTotal.textContent = `${formatTokens(totalUsed)} / ${formatTokens(total)}`;
}

// Toggle on click
tokenUsageEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = contextViz.classList.contains('hidden');
  if (isHidden) {
    updateContextViz();
    contextViz.classList.remove('hidden');
  } else {
    contextViz.classList.add('hidden');
  }
});

// Close on click outside
document.addEventListener('click', (e) => {
  if (!contextViz.contains(e.target as Node) && e.target !== tokenUsageEl) {
    contextViz.classList.add('hidden');
  }
});

// Voice Input
setupVoiceInput(document.getElementById('mic-btn')!, messageInput);

// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, move cost + token usage above input
if (isMobile()) {
  sidebarEl.classList.add('collapsed');

  const mobileBar = document.getElementById('mobile-model-bar')!;
  const sessionCost = document.getElementById('session-cost');
  const tokenUsage = document.getElementById('token-usage');
  if (mobileBar && sessionCost && tokenUsage) {
    mobileBar.appendChild(sessionCost);
    mobileBar.appendChild(tokenUsage);
  }

  // Start collapsed
  mobileBar.classList.add('collapsed');

  // Toggle via chevron
  const contextToggle = document.getElementById('mobile-context-toggle')!;
  contextToggle.addEventListener('click', () => {
    mobileBar.classList.toggle('collapsed');
    contextToggle.classList.toggle('flipped', !mobileBar.classList.contains('collapsed'));
  });
}

wsClient.connect();
messageRenderer.renderWelcome();
updateLiveSessionInputState();
sidebar.loadSessions().then(() => {
  updateLiveSessionIndicators();
});
launcherPanel.init();

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Dismiss mobile splash screen
const splash = document.getElementById('mobile-splash');
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300);
  });
}

console.log('🚀 Tau initialized');
