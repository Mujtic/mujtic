// ===============================================
// SUPPORT CHAT
// ===============================================
let chatPollTimer     = null;
let chatBadgeTimer    = null;
let chatFilterStatus  = 'open';
let chatDateFrom      = '';
let chatDateTo        = '';
let chatSelectedIds   = new Set();

// visitors type arbitrary content — escape everything we render
function _chatEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function _fmtChatTime(d) {
  const t = new Date(d); if (isNaN(t)) return '';
  const now = new Date();
  if (t.toDateString() === now.toDateString()) {
    return t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Inject the bulk-action bar + "select all" checkbox once, idempotently.
// Keeps the sidebar HTML untouched — everything is added at runtime.
function _ensureChatBulkUI() {
  const header = document.querySelector('.chat-sidebar-header');
  if (header && !document.getElementById('chat-select-all')) {
    const label = document.createElement('label');
    label.className = 'chat-select-all';
    label.title = 'Select all visible';
    label.innerHTML = `<input type="checkbox" id="chat-select-all"
                              aria-label="Select all conversations"
                              onchange="toggleChatSelectAll(this.checked)">`;
    header.insertBefore(label, header.firstChild);
  }

  const list = document.getElementById('chat-conversation-list');
  if (list && !document.getElementById('chat-bulk-bar')) {
    const bar = document.createElement('div');
    bar.id = 'chat-bulk-bar';
    bar.className = 'chat-bulk-bar';
    bar.style.display = 'none';
    bar.innerHTML = `
      <span id="chat-bulk-count" class="chat-bulk-count">0 selected</span>
      <div class="chat-bulk-actions">
        <button type="button" class="btn chat-bulk-delete" onclick="bulkDeleteChatConversations()">
          <i class="fa-solid fa-trash"></i> Delete
        </button>
        <button type="button" class="btn chat-bulk-clear" onclick="clearChatSelection()"
                aria-label="Clear selection">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>`;
    list.parentNode.insertBefore(bar, list);
  }
}

function _updateChatBulkBar() {
  const bar = document.getElementById('chat-bulk-bar');
  const count = document.getElementById('chat-bulk-count');
  if (!bar) return;

  // Only count selected conversations that are still visible in the current
  // filtered list — keeps the counter honest if a filter change hid some.
  const visible = new Set(conversations.map(c => c.id));
  const active  = [...chatSelectedIds].filter(id => visible.has(id));

  if (active.length === 0) {
    bar.style.display = 'none';
  } else {
    bar.style.display = 'flex';
    if (count) count.textContent = `${active.length} selected`;
    // Delete button only for admins
    const delBtn = bar.querySelector('.chat-bulk-delete');
    if (delBtn) delBtn.style.display = (currentAdmin?.role === 'admin') ? 'inline-flex' : 'none';
  }

  _syncChatSelectAll(visible);
}

function _syncChatSelectAll(visibleIds) {
  const cb = document.getElementById('chat-select-all');
  if (!cb) return;
  const total = visibleIds.size;
  const selected = [...chatSelectedIds].filter(id => visibleIds.has(id)).length;
  cb.checked = total > 0 && selected === total;
  cb.indeterminate = selected > 0 && selected < total;
  cb.disabled = total === 0;
}

function toggleChatSelect(id, checked) {
  if (checked) chatSelectedIds.add(id);
  else chatSelectedIds.delete(id);
  renderChatList();
  _updateChatBulkBar();
}

function toggleChatSelectAll(checked) {
  if (checked) {
    conversations.forEach(c => chatSelectedIds.add(c.id));
  } else {
    // Only unselect visible ones, keep any stale ones (harmless, they
    // get pruned at delete time)
    const visible = new Set(conversations.map(c => c.id));
    chatSelectedIds = new Set([...chatSelectedIds].filter(id => !visible.has(id)));
  }
  renderChatList();
  _updateChatBulkBar();
}

function clearChatSelection() {
  chatSelectedIds.clear();
  renderChatList();
  _updateChatBulkBar();
}

async function loadChat() {
  try {
    const params = new URLSearchParams({ status: chatFilterStatus });
    if (chatDateFrom) params.append('from', chatDateFrom);
    if (chatDateTo)   params.append('to',   chatDateTo);

    const res = await apiRequest(`/admin/chat/conversations?${params.toString()}`);
    conversations = (res.conversations || []).map(c => ({
      ...c,
      id: c._id?.toString() || c.id,
    }));

    // Prune selection of anything the server no longer returns
    const existing = new Set(conversations.map(c => c.id));
    chatSelectedIds = new Set([...chatSelectedIds].filter(id => existing.has(id)));
  } catch (err) {
    console.error('Failed to load chat conversations', err);
    conversations = [];
    chatSelectedIds.clear();
  }
  renderChatList();
  updateChatUnreadBadge();
  _updateChatBulkBar();
}

async function loadChatUnread() {
  try {
    const res = await apiRequest('/admin/chat/unread-count');
    const count = Number(res.count) || 0;
    const badge = document.getElementById('chat-tab-badge');
    if (badge) {
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.classList.toggle('show', count > 0);
    }
  } catch {}
}

function updateChatUnreadBadge() {
  const unread = conversations.reduce((s, c) => s + (Number(c.unreadForOwner) || 0), 0);
  const badge = document.getElementById('chat-tab-badge');
  if (badge) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.toggle('show', unread > 0);
  }
}

function renderChatList() {
  _ensureChatBulkUI();

  const list = document.getElementById('chat-conversation-list');
  const count = document.getElementById('chat-conv-count');
  if (!list) return;
  if (count) count.textContent = conversations.length;

  if (!conversations.length) {
    const hasDateFilter = chatDateFrom || chatDateTo;
    const statusWord = chatFilterStatus === 'all' ? '' : chatFilterStatus;
    const msg = hasDateFilter
      ? `No ${statusWord ? statusWord + ' ' : ''}conversations in this date range`
      : `No ${statusWord ? statusWord + ' ' : ''}conversations`;
    list.innerHTML = `
      <div class="chat-empty-list">
        <i class="fa-solid fa-inbox"></i>
        ${msg}
      </div>`;
    _updateChatBulkBar();
    return;
  }

  list.innerHTML = conversations.map(c => {
    const isActive = activeConversation?.id === c.id;
    const isSelected = chatSelectedIds.has(c.id);
    const unread = Number(c.unreadForOwner) || 0;
    const name = c.visitorName || c.visitorEmail || 'Visitor';
    const initial = name.charAt(0).toUpperCase();
    const snippet = (c.lastMessageText || '').slice(0, 64);
    const time = c.lastMessageAt ? _fmtChatTime(c.lastMessageAt) : '';
    const isOwnerLast = c.lastMessageFrom === 'owner';

    return `
      <div class="chat-conv-item ${isActive ? 'active' : ''} ${unread > 0 ? 'unread' : ''} ${isSelected ? 'selected' : ''}"
           onclick="openConversation('${c.id}')">
        <label class="chat-conv-check" onclick="event.stopPropagation()">
          <input type="checkbox"
                 ${isSelected ? 'checked' : ''}
                 aria-label="Select conversation with ${_chatEsc(name)}"
                 onchange="toggleChatSelect('${c.id}', this.checked)">
        </label>
        <div class="chat-conv-avatar">${_chatEsc(initial)}</div>
        <div class="chat-conv-body">
          <div class="chat-conv-header">
            <span class="chat-conv-name">${_chatEsc(name)}</span>
            <span class="chat-conv-time">${_chatEsc(time)}</span>
          </div>
          <div class="chat-conv-snippet">
            ${isOwnerLast ? '<span class="chat-you">You: </span>' : ''}${_chatEsc(snippet)}
          </div>
        </div>
        ${unread > 0 ? `<span class="chat-conv-badge">${unread}</span>` : ''}
      </div>`;
  }).join('');

  _updateChatBulkBar();
}

async function openConversation(id) {
  try {
    const res = await apiRequest(`/admin/chat/conversations/${id}`);
    activeConversation = {
      ...res.conversation,
      id: res.conversation._id?.toString() || res.conversation.id,
      messages: res.messages || [],
    };
    renderChatList();
    renderChatThread();
    startThreadPolling();
    setTimeout(() => loadChat().catch(() => {}), 400);
  } catch (err) {
    toast.error('Could not open conversation', err.message);
  }
}

function renderChatThread() {
  const body = document.getElementById('chat-thread-body');
  if (!body) return;

  if (!activeConversation) {
    body.innerHTML = `
      <div class="chat-empty-thread">
        <i class="fa-regular fa-comments"></i>
        Select a conversation to start replying
      </div>`;
    return;
  }

  const conv = activeConversation;
  const name = conv.visitorName || conv.visitorEmail || 'Visitor';
  const meta = [conv.visitorEmail, conv.status].filter(Boolean).join(' · ');
  const msgs = conv.messages || [];
  const isOpen = conv.status === 'open';
  const isAdmin = currentAdmin?.role === 'admin';

  body.innerHTML = `
    <div class="chat-thread-header">
      <div>
        <div class="chat-thread-name">${_chatEsc(name)}</div>
        <div class="chat-thread-meta">${_chatEsc(meta)}</div>
      </div>
      <div class="chat-thread-actions">
        ${isOpen
    ? `<button class="btn chat-close-btn" onclick="closeConversation()">
               <i class="fa-solid fa-check"></i> Close
             </button>`
    : `<span class="badge badge-cancelled chat-closed-badge">Closed</span>`}
        ${isAdmin
    ? `<button class="btn chat-delete-btn" onclick="deleteChatConversation()"
                     title="Delete conversation permanently (admin only)"
                     aria-label="Delete conversation permanently">
               <i class="fa-solid fa-trash"></i>
             </button>`
    : ''}
      </div>
    </div>
    <div class="chat-thread-messages" id="chat-thread-messages">
      ${msgs.length
    ? msgs.map(m => _renderChatMessage(m)).join('')
    : '<div class="chat-thread-empty">No messages yet</div>'}
    </div>
    ${isOpen ? `
      <form class="chat-reply-form" onsubmit="event.preventDefault(); sendChatReply();">
        <input type="text" id="chat-reply-input" class="input"
               placeholder="Type your reply…" maxlength="2000" autocomplete="off">
        <button type="submit" class="btn btn-primary" style="padding:0 1.1rem;">
          <i class="fa-solid fa-paper-plane"></i>
        </button>
      </form>` : ''}
  `;

  const msgsEl = document.getElementById('chat-thread-messages');
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  const inp = document.getElementById('chat-reply-input');
  if (inp) inp.focus();
}

function _renderChatMessage(m) {
  const isOwner = m.from === 'owner';
  const time = new Date(m.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `
    <div class="chat-msg ${isOwner ? 'chat-msg-owner' : 'chat-msg-visitor'}">
      <div class="chat-msg-text">${_chatEsc(m.text)}</div>
      <div class="chat-msg-time">${_chatEsc(time)}</div>
    </div>`;
}

async function sendChatReply() {
  if (!activeConversation) return;
  const inp = document.getElementById('chat-reply-input');
  const text = (inp?.value || '').trim();
  if (!text) return;
  inp.value = '';
  try {
    const res = await apiRequest(`/admin/chat/conversations/${activeConversation.id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    activeConversation.messages.push(res.message);
    renderChatThread();

    const found = conversations.find(c => c.id === activeConversation.id);
    if (found) {
      found.lastMessageText = text.slice(0, 120);
      found.lastMessageAt = res.message.createdAt;
      found.lastMessageFrom = 'owner';
      found.unreadForOwner = 0;
    }
    renderChatList();

    addLog('event', `Chat reply sent (conversation ${activeConversation.id})`, {
      adminName: currentAdmin.name, adminRole: currentAdmin.role,
      conversationId: activeConversation.id,
    });
  } catch (err) {
    toast.error('Could not send', err.message);
    if (inp) inp.value = text;
  }
}

async function closeConversation() {
  if (!activeConversation) return;
  const ok = await customConfirm(
    'Close this conversation? The visitor will see it as ended and their next message starts a new thread.',
    'Close Conversation', 'Close', '#f59e0b'
  );
  if (!ok) return;
  try {
    await apiRequest(`/admin/chat/conversations/${activeConversation.id}/close`, { method: 'POST' });
    activeConversation.status = 'closed';
    renderChatThread();
    await loadChat();
    await loadChatUnread();
    toast.success('Conversation closed');
  } catch (err) {
    toast.error('Failed to close', err.message);
  }
}

async function deleteChatConversation() {
  if (!activeConversation) return;

  if (currentAdmin?.role !== 'admin') {
    toast.error('Admins only', 'Only admins can delete conversations.');
    return;
  }

  const conv = activeConversation;
  const msgCount = (conv.messages || []).length;
  const who = conv.visitorName || conv.visitorEmail || 'this visitor';

  const ok = await customConfirm(
    `Permanently delete the conversation with ${who}? ` +
    `${msgCount} message${msgCount === 1 ? '' : 's'} will be destroyed. ` +
    `This cannot be undone — if you just want to end it, use Close instead.`,
    'Delete Conversation',
    'Delete Permanently',
    '#ef4444'
  );
  if (!ok) return;

  try {
    await apiRequest(`/admin/chat/conversations/${conv.id}`, { method: 'DELETE' });

    addLog('danger', `Chat conversation deleted (${conv.id})`, {
      adminName: currentAdmin.name,
      adminRole: currentAdmin.role,
      conversationId: conv.id,
      visitorEmail: conv.visitorEmail,
      messageCount: msgCount,
    });

    activeConversation = null;
    chatSelectedIds.delete(conv.id);
    stopThreadPolling();
    renderChatThread();

    conversations = conversations.filter(c => c.id !== conv.id);
    renderChatList();
    updateChatUnreadBadge();
    _updateChatBulkBar();

    toast.success('Conversation deleted', `${msgCount} message${msgCount === 1 ? '' : 's'} removed.`);

    loadChat().catch(() => {});
    loadChatUnread().catch(() => {});
  } catch (err) {
    toast.error('Could not delete', err.message);
  }
}

async function bulkDeleteChatConversations() {
  if (currentAdmin?.role !== 'admin') {
    toast.error('Admins only', 'Only admins can delete conversations.');
    return;
  }

  // Only act on IDs still visible in the current filtered list
  const visible = new Set(conversations.map(c => c.id));
  const ids = [...chatSelectedIds].filter(id => visible.has(id));
  if (!ids.length) {
    toast.error('Nothing selected', 'Select at least one conversation.');
    return;
  }

  const ok = await customConfirm(
    `Permanently delete ${ids.length} conversation${ids.length === 1 ? '' : 's'}? ` +
    `All messages in them will be destroyed. This cannot be undone.`,
    'Delete Conversations',
    `Delete ${ids.length}`,
    '#ef4444'
  );
  if (!ok) return;

  try {
    const res = await apiRequest('/admin/chat/conversations/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });

    addLog('danger', `Bulk deleted ${res.deleted} chat conversation(s)`, {
      adminName: currentAdmin.name,
      adminRole: currentAdmin.role,
      count: res.deleted,
      messageTotal: res.messageTotal,
      conversationIds: ids,
    });

    // If the currently-open thread was deleted, reset
    if (activeConversation && ids.includes(activeConversation.id)) {
      activeConversation = null;
      stopThreadPolling();
      renderChatThread();
    }

    ids.forEach(id => chatSelectedIds.delete(id));
    await loadChat();
    await loadChatUnread();

    toast.success(
      `${res.deleted} conversation${res.deleted === 1 ? '' : 's'} deleted`,
      res.messageTotal ? `${res.messageTotal} message${res.messageTotal === 1 ? '' : 's'} removed.` : ''
    );
  } catch (err) {
    toast.error('Could not delete', err.message);
  }
}

function filterChatList() {
  chatFilterStatus = document.getElementById('chat-status-filter')?.value || 'open';
  chatDateFrom     = document.getElementById('chat-date-from')?.value || '';
  chatDateTo       = document.getElementById('chat-date-to')?.value   || '';

  // Changing filters invalidates the selection — start clean
  chatSelectedIds.clear();
  activeConversation = null;
  renderChatThread();

  loadChat().catch(() => {});
}

function clearChatDateFilters() {
  const fromEl = document.getElementById('chat-date-from');
  const toEl   = document.getElementById('chat-date-to');
  if (fromEl) fromEl.value = '';
  if (toEl)   toEl.value = '';
  chatDateFrom = '';
  chatDateTo = '';
  chatSelectedIds.clear();
  loadChat().catch(() => {});
}

function startThreadPolling() {
  stopThreadPolling();
  chatPollTimer = setInterval(async () => {
    if (!activeConversation) return;
    const chatSection = document.getElementById('chat');
    if (!chatSection || !chatSection.classList.contains('active')) return;
    if (document.hidden) return;

    try {
      const lastMsg = activeConversation.messages[activeConversation.messages.length - 1];
      const since = lastMsg?.createdAt;
      const url = `/admin/chat/conversations/${activeConversation.id}` + (since ? `?since=${encodeURIComponent(since)}` : '');
      const res = await apiRequest(url);
      if (res.messages?.length) {
        activeConversation.messages.push(...res.messages);
        renderChatThread();
      }
    } catch (err) {
      if (/not found|404/i.test(err?.message || '')) {
        stopThreadPolling();
        activeConversation = null;
        renderChatThread();
        loadChat().catch(() => {});
        toast.error('Conversation removed', 'Another admin deleted it.');
      }
    }
  }, 4000);
}

function stopThreadPolling() {
  if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
}

function startChatBadgePolling() {
  if (chatBadgeTimer) return;
  chatBadgeTimer = setInterval(() => {
    if (!authToken) return;
    loadChatUnread().catch(() => {});
  }, 30000);
}

document.addEventListener('DOMContentLoaded', () => {
  const chatTab = document.getElementById('tab-chat');
  if (chatTab) {
    chatTab.addEventListener('click', () => {
      setTimeout(() => {
        if (typeof loadChat === 'function') loadChat().catch(() => {});
      }, 100);
    });
  }
  startChatBadgePolling();
});
