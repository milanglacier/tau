/**
 * Tool Card - Renders and updates tool execution cards (collapsible)
 */

export type ToolArgs = Record<string, unknown>;

export type ToolExecution = {
  toolCallId?: string;
  toolName?: string;
  args?: ToolArgs;
  status?: string;
  output?: string;
  isError?: boolean;
};

type ToolResultBlock = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export type ToolResult = {
  content?: ToolResultBlock[];
  [key: string]: unknown;
};

export class ToolCardRenderer {
  container: HTMLElement;
  toolCards: Map<string, HTMLElement>;

  constructor(container: HTMLElement) {
    this.container = container;
    this.toolCards = new Map(); // toolCallId -> element
  }

  createToolCard(toolExecution: ToolExecution) {
    const { toolCallId, toolName, args, status } = toolExecution;

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolCallId = String(toolCallId || '');

    const argsPreview = this.getArgsPreview(String(toolName || ''), args);
    const argsJson = this.formatJson(args);
    const isExpanded = (status === 'streaming' || status === 'pending');

    const isEdit = (toolName === 'edit' || toolName === 'Edit') && args && (args.oldText || args.old_text) && (args.newText || args.new_text);

    card.innerHTML = `
      <div class="tool-card-header" onclick="this.parentElement.querySelector('.tool-card-body').classList.toggle('expanded'); this.querySelector('.tool-card-chevron').classList.toggle('expanded')">
        <div class="tool-header-left">
          <span class="tool-card-chevron${isExpanded ? ' expanded' : ''}"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="tool-name">${this.escapeHtml(toolName || '')}</span>
          ${argsPreview ? `<span class="tool-args-preview">${this.escapeHtml(argsPreview)}</span>` : ''}
        </div>
        <div class="tool-header-right">
          <button class="tool-action-btn copy-output-btn" title="Copy output" onclick="event.stopPropagation(); var t=this.closest('.tool-card').querySelector('.tool-output'); if(!t||!t.textContent.trim())return; var s=t.textContent,b=this; (navigator.clipboard?navigator.clipboard.writeText(s):new Promise(function(r){var a=document.createElement('textarea');a.value=s;a.style.cssText='position:fixed;left:-9999px';document.body.appendChild(a);a.select();document.execCommand('copy');document.body.removeChild(a);r()})).then(function(){b.classList.add('copied');setTimeout(function(){b.classList.remove('copied')},1500)})"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
          <div class="tool-status ${status}">${status}</div>
        </div>
      </div>
      <div class="tool-card-body${isExpanded ? ' expanded' : ''}">
        ${!isEdit && argsJson ? `<div class="tool-args">${this.escapeHtml(argsJson)}</div>` : ''}
        <div class="tool-output-wrapper">
          <div class="tool-output"></div>
        </div>
      </div>
    `;

    // Insert diff view for Edit tools
    if (isEdit) {
      const diffEl = this.renderDiff(String(args.oldText || args.old_text || ''), String(args.newText || args.new_text || ''));
      const body = card.querySelector('.tool-card-body');
      if (body) body.insertBefore(diffEl, body.firstChild);
    }

    this.container.appendChild(card);
    this.toolCards.set(String(toolCallId || ''), card);
    this.scrollToBottom();

    return card;
  }

  updateToolCard(toolExecution: ToolExecution) {
    let card = this.toolCards.get(String(toolExecution.toolCallId || ''));

    if (!card) {
      card = this.createToolCard(toolExecution);
    }

    // Update status
    const statusElement = card.querySelector('.tool-status');
    if (statusElement) {
      statusElement.className = `tool-status ${toolExecution.status}`;
      statusElement.textContent = toolExecution.status ?? null;
    }

    // Auto-expand when streaming
    if (toolExecution.status === 'streaming') {
      const body = card.querySelector('.tool-card-body');
      const chevron = card.querySelector('.tool-card-chevron');
      if (body) body.classList.add('expanded');
      if (chevron) chevron.classList.add('expanded');
    }

    // Update output
    const outputElement = card.querySelector('.tool-output');
    if (outputElement && toolExecution.output) {
      outputElement.textContent = toolExecution.output;
      this.scrollToBottom();
    }
  }

  finalizeToolCard(toolCallId: string, result: ToolResult, isError: boolean) {
    const card = this.toolCards.get(toolCallId);
    if (!card) return;

    // Update status
    const statusElement = card.querySelector('.tool-status');
    if (statusElement) {
      const status = isError ? 'error' : 'complete';
      statusElement.className = `tool-status ${status}`;
      statusElement.textContent = status;
    }

    // Update output with final result
    const outputElement = card.querySelector('.tool-output');
    if (outputElement && result) {
      const output = this.formatResult(result);
      outputElement.textContent = output;
    }

    // Collapse completed cards (less noise)
    if (!isError) {
      const body = card.querySelector('.tool-card-body');
      const chevron = card.querySelector('.tool-card-chevron');
      if (body) body.classList.remove('expanded');
      if (chevron) chevron.classList.remove('expanded');
    }
  }

  /**
   * Create a pre-collapsed card for session history using DOM methods (no innerHTML)
   */
  createHistoryCard(toolExecution: ToolExecution) {
    const { toolCallId, toolName, args } = toolExecution;

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolCallId = String(toolCallId || '');

    // Header
    const header = document.createElement('div');
    header.className = 'tool-card-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'tool-header-left';

    const chevron = document.createElement('span');
    chevron.className = 'tool-card-chevron';
    chevron.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg>';
    headerLeft.appendChild(chevron);

    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = String(toolName || '');
    headerLeft.appendChild(name);

    const preview = this.getArgsPreview(String(toolName || ''), args);
    if (preview) {
      const previewEl = document.createElement('span');
      previewEl.className = 'tool-args-preview';
      previewEl.textContent = preview;
      headerLeft.appendChild(previewEl);
    }

    header.appendChild(headerLeft);

    // Right side: copy button + status
    const headerRight = document.createElement('div');
    headerRight.className = 'tool-header-right';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'tool-action-btn copy-output-btn';
    copyBtn.title = 'Copy output';
    copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const output = card.querySelector('.tool-output');
      if (!output || !output.textContent.trim()) return;
      const text = output.textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : new Promise<void>((r) => {
        const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); r();
      })).then(() => {
        copyBtn.classList.add('copied');
        setTimeout(() => copyBtn.classList.remove('copied'), 1500);
      });
    });
    headerRight.appendChild(copyBtn);

    const status = document.createElement('div');
    status.className = 'tool-status complete';
    status.textContent = 'complete';
    headerRight.appendChild(status);

    header.appendChild(headerRight);

    // Toggle expand on click
    header.addEventListener('click', () => {
      body.classList.toggle('expanded');
      chevron.classList.toggle('expanded');
    });

    card.appendChild(header);

    // Body (collapsed by default)
    const body = document.createElement('div');
    body.className = 'tool-card-body';

    const isEdit = (toolName === 'edit' || toolName === 'Edit') && args && (args.oldText || args.old_text) && (args.newText || args.new_text);

    if (isEdit) {
      body.appendChild(this.renderDiff(String(args.oldText || args.old_text || ''), String(args.newText || args.new_text || '')));
    } else {
      const argsJson = this.formatJson(args);
      if (argsJson) {
        const argsEl = document.createElement('div');
        argsEl.className = 'tool-args';
        argsEl.textContent = argsJson;
        body.appendChild(argsEl);
      }
    }

    const outputEl = document.createElement('div');
    outputEl.className = 'tool-output';
    body.appendChild(outputEl);

    card.appendChild(body);

    this.container.appendChild(card);
    this.toolCards.set(String(toolCallId || ''), card);

    return card;
  }

  /**
   * Add result to a history card (stays collapsed)
   */
  addHistoryResult(toolCallId: string, result: ToolResult, isError: boolean) {
    const card = this.toolCards.get(toolCallId);
    if (!card) return;

    if (isError) {
      const statusEl = card.querySelector('.tool-status');
      if (statusEl) {
        statusEl.className = 'tool-status error';
        statusEl.textContent = 'error';
      }
    }

    const outputElement = card.querySelector('.tool-output');
    if (outputElement && result) {
      outputElement.textContent = this.formatResult(result);
    }
  }

  /** Compact preview for the header line */
  getArgsPreview(toolName: string, args?: ToolArgs) {
    if (!args || Object.keys(args).length === 0) return '';

    // Show the most relevant arg inline
    if (args.path) return String(args.path);
    if (args.command) return String(args.command).substring(0, 80);
    if (args.query) return String(args.query).substring(0, 60);
    if (args.url) return String(args.url);

    // Fallback: first string value
    for (const val of Object.values(args)) {
      if (typeof val === 'string' && val.length > 0) {
        return val.substring(0, 60);
      }
    }
    return '';
  }

  formatJson(obj?: ToolArgs) {
    if (!obj) return '';
    try {
      if (Object.keys(obj).length === 0) return '';
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }

  /** Render a simple inline diff for Edit tool */
  renderDiff(oldText: string, newText: string) {
    const container = document.createElement('div');
    container.className = 'tool-diff';

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // Removed lines
    for (const line of oldLines) {
      const el = document.createElement('div');
      el.className = 'diff-line diff-removed';
      el.textContent = '- ' + line;
      container.appendChild(el);
    }

    // Added lines
    for (const line of newLines) {
      const el = document.createElement('div');
      el.className = 'diff-line diff-added';
      el.textContent = '+ ' + line;
      container.appendChild(el);
    }

    return container;
  }

  formatResult(result: ToolResult) {
    if (!result) return '';

    if (result.content && Array.isArray(result.content)) {
      return result.content
        .map((block) => {
          if (block.type === 'text') return block.text;
          return JSON.stringify(block);
        })
        .join('\n');
    }

    return JSON.stringify(result, null, 2);
  }

  escapeHtml(text: unknown) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
  }

  scrollToBottom() {
    if (this.container) {
      const threshold = 100;
      const isNear =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
      if (isNear) {
        requestAnimationFrame(() => {
          this.container.scrollTop = this.container.scrollHeight;
        });
      }
    }
  }

  expandAll() {
    this.toolCards.forEach(card => {
      card.querySelector('.tool-card-body')?.classList.add('expanded');
      card.querySelector('.tool-card-chevron')?.classList.add('expanded');
    });
  }

  collapseAll() {
    this.toolCards.forEach(card => {
      card.querySelector('.tool-card-body')?.classList.remove('expanded');
      card.querySelector('.tool-card-chevron')?.classList.remove('expanded');
    });
  }

  clear() {
    this.toolCards.forEach((card) => card.remove());
    this.toolCards.clear();
  }
}
