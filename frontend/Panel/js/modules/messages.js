// ===============================================
// MESSAGE MANAGEMENT
// ===============================================
let newsletterSubscribedCount = 0;

const BROADCAST_TEMPLATES = {
  maintenance: {
    subject: 'Scheduled Platform Maintenance',
    body: `Dear Glycr User,\n\nWe'd like to inform you that we will be performing scheduled maintenance on our platform. During this time, some services may be temporarily unavailable.\n\nWe apologize for any inconvenience and appreciate your patience.\n\nThe Glycr Team`,
  },
  promo: {
    subject: 'Exclusive Offer Just for You 🎉',
    body: `Hi there!\n\nWe have an exciting offer exclusively for our community. Check out the latest events on Glycr and enjoy special perks when you book your tickets this week.\n\nDon't miss out!\n\nThe Glycr Team`,
  },
  update: {
    subject: 'Platform Update — What\'s New on Glycr',
    body: `Hello from Glycr!\n\nWe've been hard at work improving your experience. Here's what's new:\n\n• Improved event discovery\n• Faster ticket checkout\n• Enhanced organizer dashboard\n\nThank you for being part of our community.\n\nThe Glycr Team`,
  },
};

function applyBroadcastTemplate(key) {
  const tpl = BROADCAST_TEMPLATES[key];
  if (!tpl) return;
  const subEl  = document.getElementById('broadcast-subject');
  const bodyEl = document.getElementById('broadcast-body');
  if (subEl)  subEl.value  = tpl.subject;
  if (bodyEl) bodyEl.value = tpl.body;
}

function getBroadcastRecipientCount() {
  const aud = document.querySelector('input[name="broadcast-audience"]:checked')?.value || 'all_users';
  if (aud === 'all_users')  return users.length;
  if (aud === 'organizers') return users.filter(u => u.role === 'organizer').length;
  if (aud === 'customers')  return users.filter(u => u.role === 'customer').length;
  if (aud === 'both')       return users.filter(u => u.role === 'organizer' || u.role === 'customer').length;
  if (aud === 'newsletter') return newsletterSubscribedCount;
  return users.length;
}

function updateBroadcastAudiencePreview() {
  const count = getBroadcastRecipientCount();
  setText('broadcast-recipient-count', count);
  setText('broadcast-warn-count', count);
}

function searchMessageRecipients() {
  const q  = (document.getElementById('msg-recipient-search')?.value || '').toLowerCase().trim();
  const dd = document.getElementById('msg-recipient-dropdown');
  if (!dd) return;
  if (!q) { dd.style.display = 'none'; return; }
  const matches = users.filter(u =>
    (u.name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  ).slice(0, 8);
  if (!matches.length) {
    dd.innerHTML = '<div class="msg-recipient-option" style="color:#94a3b8;">No users found</div>';
  } else {
    dd.innerHTML = matches.map(u => `
      <div class="msg-recipient-option" onclick="selectMessageRecipient('${u.id}', '${(u.name||u.email).replace(/'/g,"\\'")}', '${u.email}')">
        <div style="font-weight:600;">${u.name || 'User'}</div>
        <div class="option-sub">${u.email} · <span style="text-transform:capitalize;">${u.role}</span></div>
      </div>`).join('');
  }
  dd.style.display = 'block';
}

function selectMessageRecipient(id, name, email) {
  document.getElementById('msg-recipient-id').value = id;
  document.getElementById('msg-recipient-label').textContent = `${name} (${email})`;
  document.getElementById('msg-selected-recipient').style.display = 'block';
  document.getElementById('msg-recipient-search').value  = '';
  document.getElementById('msg-recipient-dropdown').style.display = 'none';
}

function clearMessageRecipient() {
  document.getElementById('msg-recipient-id').value = '';
  document.getElementById('msg-selected-recipient').style.display = 'none';
  document.getElementById('msg-recipient-search').value = '';
}

document.addEventListener('click', e => {
  const wrap = document.getElementById('compose-message-modal');
  if (!wrap?.contains(e.target)) {
    const dd = document.getElementById('msg-recipient-dropdown');
    if (dd) dd.style.display = 'none';
  }
});

async function submitDirectMessage() {
  const recipientId = document.getElementById('msg-recipient-id').value;
  const channel     = document.getElementById('msg-direct-channel').value;
  const subject     = document.getElementById('msg-direct-subject').value.trim();
  const body        = document.getElementById('msg-direct-body').value.trim();
  const errEl       = document.getElementById('msg-direct-error');
  errEl.style.display = 'none';
  if (!recipientId) { errEl.style.display = 'block'; errEl.innerHTML = '<i class="fa-solid fa-circle-exclamation" style="margin-right:0.4rem;"></i>Please select a recipient.'; return; }
  if (!subject)     { errEl.style.display = 'block'; errEl.innerHTML = '<i class="fa-solid fa-circle-exclamation" style="margin-right:0.4rem;"></i>Subject is required.'; return; }
  if (!body)        { errEl.style.display = 'block'; errEl.innerHTML = '<i class="fa-solid fa-circle-exclamation" style="margin-right:0.4rem;"></i>Message body is required.'; return; }

  const recipient = users.find(u => u.id === recipientId);
  const msgRecord = {
    id: `msg_${Date.now()}`, type: 'direct', audience: 'individual',
    subject, body, channel, recipientId,
    recipientName: recipient?.name || 'User', recipientEmail: recipient?.email || '',
    sentAt: new Date().toISOString(), sentBy: currentAdmin.name, recipientCount: 1,
  };
  try { await apiRequest('/admin/messages', { method: 'POST', body: JSON.stringify(msgRecord) }); } catch {}
  messages.unshift(msgRecord);
  await addLog('system', `Direct message sent to ${recipient?.email}`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, subject, channel, recipientEmail: recipient?.email });
  document.getElementById('msg-direct-subject').value = '';
  document.getElementById('msg-direct-body').value    = '';
  clearMessageRecipient();
  closeModal('compose-message-modal');
  renderMessages();
  updateMessageStats();
  toast.success('Message sent', `Delivered to ${recipient?.name || recipient?.email} via ${channel}.`);
}

// Newsletter is email-only. Auto-switch + disable the channel picker
// when the admin selects it, so they can't accidentally choose SMS.
function _syncBroadcastChannelToAudience() {
  const aud = document.querySelector('input[name="broadcast-audience"]:checked')?.value;
  const sel = document.getElementById('broadcast-channel');
  if (!sel) return;
  if (aud === 'newsletter') {
    sel.value = 'email';
    sel.disabled = true;
    sel.title = 'Newsletter subscribers receive email only';
  } else {
    sel.disabled = false;
    sel.title = '';
  }
}

// Recompute the preview count AND sync the channel picker whenever the
// admin changes audience. Fixes a pre-existing issue where changing the
// radio didn't update the count until the messages tab reloaded.
document.querySelectorAll('input[name="broadcast-audience"]').forEach(radio => {
  radio.addEventListener('change', () => {
    updateBroadcastAudiencePreview();
    _syncBroadcastChannelToAudience();
  });
});

async function submitBroadcast() {
  const audience = document.querySelector('input[name="broadcast-audience"]:checked')?.value || 'all_users';
  const channel  = audience === 'newsletter' ? 'email' : document.getElementById('broadcast-channel').value;
  const subject  = document.getElementById('broadcast-subject').value.trim();
  const body     = document.getElementById('broadcast-body').value.trim();
  const errEl    = document.getElementById('broadcast-error');
  errEl.style.display = 'none';
  if (!subject) { errEl.style.display = 'block'; errEl.innerHTML = '<i class="fa-solid fa-circle-exclamation" style="margin-right:0.4rem;"></i>Subject is required.'; return; }
  if (!body)    { errEl.style.display = 'block'; errEl.innerHTML = '<i class="fa-solid fa-circle-exclamation" style="margin-right:0.4rem;"></i>Message body is required.'; return; }

  const count = getBroadcastRecipientCount();
  if (count === 0) {
    errEl.style.display = 'block';
    errEl.innerHTML = '<i class="fa-solid fa-circle-exclamation" style="margin-right:0.4rem;"></i>No recipients match this audience.';
    return;
  }

  const payload = { audience, subject, body, channel };

  try {
    const saved = await apiRequest('/admin/messages/broadcast', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    // Use the server's record — it has the real id, recipientCount, sentAt
    const record = {
      ...saved,
      id: saved?.id || saved?._id?.toString(),
      recipientCount: saved?.recipientCount ?? count,
    };
    messages.unshift(record);
    await addLog('system', `Broadcast sent to ${record.recipientCount} users (${audience})`, {
      adminName: currentAdmin.name, adminRole: currentAdmin.role,
      subject, channel, audience, count: record.recipientCount,
    });
    document.getElementById('broadcast-subject').value = '';
    document.getElementById('broadcast-body').value    = '';
    closeModal('broadcast-modal');
    renderMessages();
    updateMessageStats();
    toast.success('Broadcast sent', `Message delivered to ${record.recipientCount} recipient${record.recipientCount !== 1 ? 's' : ''}.`);
  } catch (err) {
    // THE FIX: surface the actual error inside the modal, don't swallow it
    errEl.style.display = 'block';
    errEl.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="margin-right:0.4rem;"></i>${err?.message || 'Failed to send broadcast.'}`;
  }
}

function viewMessage(msgId) {
  const msg = messages.find(m => m.id === msgId);
  if (!msg) return;
  const audienceMap = {
    all_users: 'All Users',
    organizers: 'Organizers Only',
    customers: 'Customers Only',
    both: 'Organizers & Customers',
    individual: msg.recipientName || 'Individual User',
    newsletter: 'Newsletter Subscribers',
  };
  const channelIcon = { email:'fa-envelope', sms:'fa-mobile-screen-button', both:'fa-satellite-dish' };
  document.getElementById('view-message-body').innerHTML = `
    <div class="detail-grid" style="margin-bottom:1rem;">
      <div class="detail-item"><div class="detail-label">Type</div><div class="detail-value">
        <span class="msg-type-badge msg-type-${msg.type}">${msg.type === 'broadcast' ? '<i class="fa-solid fa-bullhorn"></i> Broadcast' : '<i class="fa-solid fa-paper-plane"></i> Direct'}</span>
      </div></div>
      <div class="detail-item"><div class="detail-label">Channel</div><div class="detail-value">
        <span class="msg-channel-pill msg-channel-${msg.channel}"><i class="fa-solid ${channelIcon[msg.channel] || 'fa-envelope'}"></i> ${msg.channel}</span>
      </div></div>
      <div class="detail-item"><div class="detail-label">Recipients</div><div class="detail-value">${audienceMap[msg.audience] || msg.audience} <span style="color:#94a3b8;">(${msg.recipientCount})</span></div></div>
      <div class="detail-item"><div class="detail-label">Sent At</div><div class="detail-value">${new Date(msg.sentAt).toLocaleString()}</div></div>
      <div class="detail-item"><div class="detail-label">Sent By</div><div class="detail-value">${msg.sentBy}</div></div>
    </div>
    <div style="padding:1rem;background:#0f172a;border-radius:0.5rem;margin-bottom:1rem;">
      <div style="font-size:0.72rem;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.4rem;">Subject</div>
      <div style="font-weight:700;font-size:1rem;">${msg.subject}</div>
    </div>
    <div style="padding:1rem;background:#0f172a;border-radius:0.5rem;">
      <div style="font-size:0.72rem;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.4rem;">Message Body</div>
      <div style="white-space:pre-wrap;font-size:0.875rem;color:#cbd5e1;line-height:1.7;">${msg.body}</div>
    </div>`;
  openModal('view-message-modal');
}

function getFilteredMessages() {
  const search   = (document.getElementById('msg-search')?.value || '').toLowerCase();
  const type     = document.getElementById('msg-type-filter')?.value     || 'all';
  const audience = document.getElementById('msg-audience-filter')?.value || 'all';
  const channel  = document.getElementById('msg-channel-filter')?.value  || 'all';
  const dfrom    = document.getElementById('msg-date-from')?.value;
  const dto      = document.getElementById('msg-date-to')?.value;
  return messages.filter(m => {
    const mSearch = !search || m.subject.toLowerCase().includes(search) || (m.recipientName||'').toLowerCase().includes(search) || (m.recipientEmail||'').toLowerCase().includes(search);
    return mSearch && (type === 'all' || m.type === type) && (audience === 'all' || m.audience === audience) && (channel === 'all' || m.channel === channel) && applyDateRangeFilter(m.sentAt, dfrom, dto);
  });
}

function renderMessages() {
  const tb = document.getElementById('messages-table');
  if (!tb) return;
  const filtered = getFilteredMessages();
  const sorted   = applySorting(filtered, 'messages');
  const { rows, page, totalPages, total, pp } = paginate(sorted, 'messages');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fa-solid fa-paper-plane" style="font-size:1.5rem;display:block;margin-bottom:0.5rem;"></i>No messages sent yet</td></tr>';
    renderPaginationBar('messages-pagination', 'messages', 0, 1, 1, pp);
    return;
  }
  const audienceMap = {
    all_users: 'All Users',
    organizers: 'Organizers Only',
    customers: 'Customers Only',
    both: 'Org. & Customers',
    individual: '',
    newsletter: 'Newsletter',
  };
  const channelIcon = { email:'fa-envelope', sms:'fa-mobile-screen-button', both:'fa-satellite-dish' };
  tb.innerHTML = rows.map(m => {
    const dateStr = new Date(m.sentAt).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
    const timeStr = new Date(m.sentAt).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
    const recipientLabel = m.type === 'broadcast'
      ? `${audienceMap[m.audience] || m.audience} <span style="color:#475569;">(${m.recipientCount} recipients)</span>`
      : `${m.recipientName || '—'} <span style="font-size:0.72rem;color:#94a3b8;">(${m.recipientEmail || ''})</span>`;
    const sel = selectedIds.messages.has(m.id);
    return `
      <tr class="${sel ? 'row-selected' : ''}">
        <td><input type="checkbox" class="row-checkbox" data-id="${m.id}" ${sel ? 'checked' : ''} onchange="toggleRowSelect('messages','${m.id}',this)"></td>
        <td><div style="font-size:0.875rem;">${dateStr}</div><div style="font-size:0.72rem;color:#475569;">${timeStr}</div></td>
        <td><div style="font-weight:600;font-size:0.875rem;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.subject}</div><div style="font-size:0.72rem;color:#94a3b8;">by ${m.sentBy}</div></td>
        <td><div class="msg-audience-badge">${recipientLabel}</div></td>
        <td><span class="msg-channel-pill msg-channel-${m.channel}"><i class="fa-solid ${channelIcon[m.channel] || 'fa-envelope'}"></i> ${m.channel}</span></td>
        <td><span class="msg-type-badge msg-type-${m.type}">${m.type === 'broadcast' ? '<i class="fa-solid fa-bullhorn"></i> Broadcast' : '<i class="fa-solid fa-paper-plane"></i> Direct'}</span></td>
        <td><div class="actions"><button class="btn-icon" style="background:#6366f1;" onclick="viewMessage('${m.id}')" title="View"><i class="fa-solid fa-eye"></i></button><button class="btn-icon" style="background:#ef4444;" onclick="deleteMessage('${m.id}')" title="Delete"><i class="fa-solid fa-trash"></i></button></div></td>
      </tr>`;
  }).join('');
  renderPaginationBar('messages-pagination', 'messages', total, page, totalPages, pp);
}

async function deleteMessage(msgId) {
  const msg = messages.find(m => m.id === msgId);
  const ok  = await customConfirm(`Delete message "${msg?.subject || 'this message'}"? This cannot be undone.`, 'Delete Message', 'Delete', '#ef4444');
  if (!ok) return;
  try { await apiRequest(`/admin/messages/${msgId}`, { method: 'DELETE' }); } catch {}
  const idx = messages.findIndex(m => m.id === msgId);
  if (idx !== -1) messages.splice(idx, 1);
  // await addLog('system', `Message deleted: ${msg?.subject}`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, msgId });
  renderMessages();
  updateMessageStats();
  toast.success('Message deleted', 'The message record has been removed.');
}

async function bulkDeleteMessages() {
  const ids = [...selectedIds.messages];
  if (!ids.length) return;
  showBulkConfirm('Delete Messages', `Permanently delete ${ids.length} message(s)?`, async () => {
    let ok = 0;
    for (const id of ids) {
      try { await apiRequest(`/admin/messages/${id}`, { method: 'DELETE' }); } catch {}
      const idx = messages.findIndex(m => m.id === id);
      if (idx !== -1) { messages.splice(idx, 1); ok++; }
    }
    //await addLog('system', `Bulk deleted ${ok} message(s)`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, count: ok });
    selectedIds.messages.clear();
    renderMessages();
    updateMessageStats();
    toast.success('Done', `${ok} message(s) deleted.`);
  });
}

function updateMessageStats() {
  const broadcasts  = messages.filter(m => m.type === 'broadcast');
  const directs     = messages.filter(m => m.type === 'direct');
  const totalRecip  = messages.reduce((s, m) => s + (m.recipientCount || 0), 0);
  setText('msg-stat-total',      messages.length);
  setText('msg-stat-broadcasts', broadcasts.length);
  setText('msg-stat-direct',     directs.length);
  setText('msg-stat-recipients', totalRecip);
}

async function loadMessages() {
  try {
    const res = await apiRequest('/admin/messages');
    messages = (res.messages || []).map(m => ({ ...m, id: m.id || m._id?.toString() }));
  } catch {
    if (!messages.length) messages = [];
  }
  // Newsletter subscriber count for the broadcast audience preview.
  // Endpoint added in the newsletter backend pass; falls back to 0 if absent.
  try {
    const stats = await apiRequest('/admin/newsletter/stats');
    newsletterSubscribedCount = Number(stats?.subscribed) || 0;
  } catch {
    newsletterSubscribedCount = 0;
  }
  renderMessages();
  updateMessageStats();
  updateBroadcastAudiencePreview();
}
