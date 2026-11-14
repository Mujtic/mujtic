// ===============================================
// SUPPORT CHAT
// ===============================================
let chatPollTimer     = null;
let chatBadgeTimer    = null;
let chatFilterStatus  = 'open';

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

async function loadChat() {
  try {
    const res = await apiRequest(`/admin/chat/conversations?status=${chatFilterStatus}`);
    conversations = (res.conversations || []).map(c => ({
      ...c,
      id: c._id?.toString() || c.id,
    }));
  } catch (err) {
    console.error('Failed to load chat conversations', err);
    conversations = [];
  }
  renderChatList();
  updateChatUnreadBadge();
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
  const list = document.getElementById('chat-conversation-list');
  const count = document.getElementById('chat-conv-count');
  if (!list) return;
  if (count) count.textContent = conversations.length;

  if (!conversations.length) {
    list.innerHTML = `
      <div class="chat-empty-list">
        <i class="fa-solid fa-inbox"></i>
        No ${chatFilterStatus === 'all' ? '' : chatFilterStatus + ' '}conversations
      </div>`;
    return;
  }

  list.innerHTML = conversations.map(c => {
    const isActive = activeConversation?.id === c.id;
    const unread = Number(c.unreadForOwner) || 0;
    const name = c.visitorName || c.visitorEmail || 'Visitor';
    const initial = name.charAt(0).toUpperCase();
    const snippet = (c.lastMessageText || '').slice(0, 64);
    const time = c.lastMessageAt ? _fmtChatTime(c.lastMessageAt) : '';
    const isOwnerLast = c.lastMessageFrom === 'owner';

    return `
      <div class="chat-conv-item ${isActive ? 'active' : ''} ${unread > 0 ? 'unread' : ''}"
           onclick="openConversation('${c.id}')">
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
    // server marks unreadForOwner=0 on read; refresh the list after a beat
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

    // Update the sidebar snippet without a full reload
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

  // Belt-and-braces: server enforces this too, but failing fast here keeps
  // the moderator from ever seeing the modal.
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
    stopThreadPolling();
    renderChatThread();

    // Drop the deleted conversation from the sidebar instantly, then re-sync
    // with the server (picks up any conversations the deletion may have
    // hidden from the current filter).
    conversations = conversations.filter(c => c.id !== conv.id);
    renderChatList();
    updateChatUnreadBadge();

    toast.success('Conversation deleted', `${msgCount} message${msgCount === 1 ? '' : 's'} removed.`);

    loadChat().catch(() => {});
    loadChatUnread().catch(() => {});
  } catch (err) {
    toast.error('Could not delete', err.message);
  }
}

function filterChatList() {
  chatFilterStatus = document.getElementById('chat-status-filter')?.value || 'open';
  activeConversation = null;
  renderChatThread();
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
      // Another admin deleted this conversation while we were viewing it.
      // The 404 from the backend means the doc is gone — reset UI cleanly.
      if (/not found|404/i.test(err?.message || '')) {
        stopThreadPolling();
        activeConversation = null;
        renderChatThread();
        conversations = conversations.filter(c => c.id !== activeConversation?.id);
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
