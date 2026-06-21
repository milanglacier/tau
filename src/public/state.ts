/**
 * State Manager - Manages chat state
 */

export class StateManager {
  messages: Record<string, unknown>[];
  toolExecutions: Map<string, Record<string, unknown>>;
  isStreaming: boolean;
  currentStreamingMessage: Record<string, unknown> | null;
  listeners: Set<() => void>;

  constructor() {
    this.messages = [];
    this.toolExecutions = new Map(); // toolCallId -> tool execution data
    this.isStreaming = false;
    this.currentStreamingMessage = null;
    this.listeners = new Set();
  }

  addListener(callback: () => void) {
    this.listeners.add(callback);
  }

  removeListener(callback: () => void) {
    this.listeners.delete(callback);
  }

  notifyListeners() {
    this.listeners.forEach(callback => callback());
  }

  addMessage(message: Record<string, unknown>) {
    this.messages.push(message);
    this.notifyListeners();
  }

  updateLastMessage(updates: Record<string, unknown>) {
    if (this.messages.length > 0) {
      const lastMessage = this.messages[this.messages.length - 1];
      Object.assign(lastMessage, updates);
      this.notifyListeners();
    }
  }

  setStreamingMessage(message: Record<string, unknown>) {
    this.currentStreamingMessage = message;
    this.notifyListeners();
  }

  clearStreamingMessage() {
    this.currentStreamingMessage = null;
    this.notifyListeners();
  }

  setStreaming(isStreaming: boolean) {
    this.isStreaming = isStreaming;
    this.notifyListeners();
  }

  addToolExecution(toolCallId: string, data: Record<string, unknown>) {
    this.toolExecutions.set(toolCallId, {
      toolCallId,
      toolName: data.toolName,
      args: data.args,
      status: 'pending',
      output: '',
      isError: false,
      ...data
    });
    this.notifyListeners();
  }

  updateToolExecution(toolCallId: string, updates: Record<string, unknown>) {
    const tool = this.toolExecutions.get(toolCallId);
    if (tool) {
      Object.assign(tool, updates);
      this.notifyListeners();
    }
  }

  getToolExecution(toolCallId: string) {
    return this.toolExecutions.get(toolCallId);
  }

  getAllToolExecutions() {
    return Array.from(this.toolExecutions.values());
  }

  reset() {
    this.messages = [];
    this.toolExecutions.clear();
    this.isStreaming = false;
    this.currentStreamingMessage = null;
    this.notifyListeners();
  }
}
