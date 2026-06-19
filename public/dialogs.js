/**
 * Dialogs - Handles extension UI dialogs
 */

export class DialogHandler {
  constructor(container, wsClient, getSessionId = null) {
    this.container = container;
    this.wsClient = wsClient;
    this.getSessionId = getSessionId;
    this.currentDialog = null;
    this.currentRequest = null;
    this.timeoutId = null;
    this.onIdle = null;
  }

  showSelect(request) {
    this.cancelCurrentDialog(true);

    const { id, title, options, timeout, sessionId } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Select an option')}</div>
      <div class="dialog-options" id="dialog-options"></div>
      <div class="dialog-actions">
        <button id="dialog-cancel">Cancel</button>
      </div>
    `;

    const optionsContainer = dialog.querySelector('#dialog-options');
    
    (options || []).forEach(option => {
      const optionDiv = document.createElement('div');
      optionDiv.className = 'dialog-option';
      optionDiv.textContent = option;
      optionDiv.onclick = () => {
        this.respond(id, { value: option }, sessionId);
      };
      optionsContainer.appendChild(optionDiv);
    });

    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true }, sessionId);
    };

    this.showDialog(dialog, timeout, id, sessionId, request);
  }

  showConfirm(request) {
    this.cancelCurrentDialog(true);

    const { id, title, message, timeout, sessionId } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Confirm')}</div>
      ${message ? `<div class="dialog-message">${this.escapeHtml(message)}</div>` : ''}
      <div class="dialog-actions">
        <button id="dialog-no">No</button>
        <button id="dialog-yes">Yes</button>
      </div>
    `;

    dialog.querySelector('#dialog-yes').onclick = () => {
      this.respond(id, { confirmed: true }, sessionId);
    };

    dialog.querySelector('#dialog-no').onclick = () => {
      this.respond(id, { confirmed: false }, sessionId);
    };

    this.showDialog(dialog, timeout, id, sessionId, request);
  }

  showInput(request) {
    this.cancelCurrentDialog(true);

    const { id, title, placeholder, timeout, sessionId } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Input')}</div>
      <input type="text" class="dialog-input" id="dialog-input" placeholder="${this.escapeHtml(placeholder || '')}" />
      <div class="dialog-actions">
        <button id="dialog-cancel">Cancel</button>
        <button id="dialog-submit">Submit</button>
      </div>
    `;

    const input = dialog.querySelector('#dialog-input');
    
    const submit = () => {
      const value = input.value.trim();
      this.respond(id, value ? { value } : { cancelled: true }, sessionId);
    };

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submit();
    });

    dialog.querySelector('#dialog-submit').onclick = submit;
    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true }, sessionId);
    };

    this.showDialog(dialog, timeout, id, sessionId, request);
    
    // Focus input after a short delay
    setTimeout(() => input.focus(), 100);
  }

  showEditor(request) {
    this.cancelCurrentDialog(true);

    const { id, title, prefill, timeout, sessionId } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Editor')}</div>
      <textarea class="dialog-textarea" id="dialog-textarea">${this.escapeHtml(prefill || '')}</textarea>
      <div class="dialog-actions">
        <button id="dialog-cancel">Cancel</button>
        <button id="dialog-save">Save</button>
      </div>
    `;

    const textarea = dialog.querySelector('#dialog-textarea');

    dialog.querySelector('#dialog-save').onclick = () => {
      const value = textarea.value;
      this.respond(id, value ? { value } : { cancelled: true }, sessionId);
    };

    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true }, sessionId);
    };

    this.showDialog(dialog, timeout, id, sessionId, request);
    
    // Focus textarea after a short delay
    setTimeout(() => textarea.focus(), 100);
  }

  showNotification(request) {
    const { message, notifyType } = request;
    
    // Create a temporary notification element
    const notification = document.createElement('div');
    notification.className = 'error-message';
    notification.textContent = `${notifyType === 'error' ? '⚠️' : notifyType === 'warning' ? '⚠️' : 'ℹ️'} ${message}`;
    
    // Add to messages container temporarily
    const messagesContainer = document.getElementById('messages');
    if (messagesContainer) {
      messagesContainer.appendChild(notification);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      
      // Remove after 5 seconds
      setTimeout(() => {
        notification.remove();
      }, 5000);
    }
  }

  showDialog(dialogElement, timeout, requestId, sessionId = null, request = null) {
    this.currentDialog = dialogElement;
    this.currentRequest = { id: requestId, sessionId, request };
    this.container.innerHTML = '';
    this.container.appendChild(dialogElement);
    this.container.classList.remove('hidden');

    // Set up timeout if specified
    if (timeout) {
      this.timeoutId = setTimeout(() => {
        this.respond(requestId, { cancelled: true }, sessionId);
      }, timeout);
    }
  }

  cancelCurrentDialog(suppressIdle = false) {
    if (!this.currentRequest?.id) {
      this.clearCurrentDialog();
      return;
    }
    const { id, sessionId } = this.currentRequest;
    this.clearCurrentDialog();
    this.wsClient.send({
      type: 'extension_ui_response',
      id,
      sessionId: sessionId || this.getSessionId?.(),
      cancelled: true,
    });
    if (!suppressIdle) this.onIdle?.();
  }

  clearCurrentDialog() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    
    this.container.innerHTML = '';
    this.container.classList.add('hidden');
    this.currentDialog = null;
    this.currentRequest = null;
  }

  respond(id, response, sessionId = null) {
    this.clearCurrentDialog();
    this.wsClient.send({
      type: 'extension_ui_response',
      id,
      sessionId: sessionId || this.getSessionId?.(),
      ...response
    });
    this.onIdle?.();
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
