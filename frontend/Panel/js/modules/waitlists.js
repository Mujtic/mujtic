// ===============================================
// WAITLIST MANAGEMENT
// ===============================================

function populateWaitlistEventFilter() {
  const select = document.getElementById('waitlist-event-filter');
  if (!select) return;
  const cur = select.value;
  select.innerHTML = '<option value="all">All Events</option>';
  [...new Set(waitlist.map(w => w.eventId))].forEach(eid => {
    const title = events.find(e => e.id === eid)?.title || waitlist.find(w => w.eventId === eid)?.eventTitle || eid;
    const opt   = document.createElement('option');
    opt.value   = eid; opt.textContent = title;
    if (cur === eid) opt.selected = true;
    select.appendChild(opt);
  });
}

function renderWaitlist() {
  const tb = document.getElementById('waitlist-table');
  if (!tb) return;
  const sorted = applySorting(getFilteredWaitlist(), 'waitlist');
  const { rows, page, totalPages, total, pp } = paginate(sorted, 'waitlist');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fa-solid fa-list-ol" style="font-size:1.5rem;display:block;margin-bottom:0.5rem;"></i>No waitlist entries found</td></tr>';
    renderPaginationBar('waitlist-pagination', 'waitlist', 0, 1, 1, pp);
    return;
  }
  tb.innerHTML = rows.map(entry => {
    const joined = entry.joinedAt ? new Date(entry.joinedAt) : null;
    const jDate  = joined ? joined.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '—';
    const jTime  = joined ? joined.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }) : '';
    const sel    = selectedIds.waitlist.has(entry.id);
    return `
      <tr class="${sel ? 'row-selected' : ''}">
        <td><input type="checkbox" class="row-checkbox" data-id="${entry.id}" ${sel ? 'checked' : ''} onchange="toggleRowSelect('waitlist','${entry.id}',this)"></td>
        <td>
          <div style="font-weight:600;">${entry.userName || '—'}</div>
          ${entry.userId ? `<div style="font-size:0.72rem;color:#94a3b8;">ID: ${entry.userId}</div>` : ''}
        </td>
        <td>
          <div style="font-size:0.875rem;"><i class="fa-regular fa-envelope" style="margin-right:0.3rem;"></i>${entry.userEmail || '—'}</div>
          ${entry.userPhone ? `<div style="font-size:0.75rem;color:#94a3b8;"><i class="fa-solid fa-mobile-screen-button" style="margin-right:0.3rem;"></i>${entry.userPhone}</div>` : ''}
        </td>
        <td>
          <div style="font-weight:600;font-size:0.875rem;">${entry.eventTitle || 'Unknown Event'}</div>
          ${entry.eventDate ? `<div style="font-size:0.72rem;color:#94a3b8;"><i class="fa-regular fa-calendar" style="margin-right:0.25rem;"></i>${new Date(entry.eventDate).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</div>` : ''}
        </td>
        <td>
          <div style="font-size:0.875rem;">${jDate}</div>
          <div style="font-size:0.72rem;color:#475569;">${jTime}</div>
        </td>
        <td><div class="waitlist-position">${entry.position || '—'}</div></td>
        <td><div class="actions">
          <button class="btn-icon" style="background:#f59e0b;" onclick="openWaitlistNotifyModal('${entry.id}')" title="Notify"><i class="fa-solid fa-bell"></i></button>
          <button class="btn-icon" style="background:#10b981;" onclick="openWaitlistConvertModal('${entry.id}')" title="Convert to Ticket"><i class="fa-solid fa-ticket"></i></button>
          <button class="btn-icon" style="background:#ef4444;" onclick="removeWaitlistEntry('${entry.id}')" title="Remove"><i class="fa-solid fa-trash"></i></button>
        </div></td>
      </tr>`;
  }).join('');
  renderPaginationBar('waitlist-pagination', 'waitlist', total, page, totalPages, pp);
}

function getFilteredWaitlist() {
  const search   = (document.getElementById('waitlist-search')?.value || '').toLowerCase();
  const evFilter = document.getElementById('waitlist-event-filter')?.value || 'all';
  const dfrom    = document.getElementById('waitlist-date-from')?.value;
  const dto      = document.getElementById('waitlist-date-to')?.value;
  const posFrom  = parseInt(document.getElementById('waitlist-position-from')?.value, 10);
  const posTo    = parseInt(document.getElementById('waitlist-position-to')?.value, 10);
  return waitlist.filter(w => {
    const mSearch = !search || (w.userName||'').toLowerCase().includes(search) || (w.userEmail||'').toLowerCase().includes(search) || (w.eventTitle||'').toLowerCase().includes(search);
    const pos  = Number(w.position);
    const mPos = (isNaN(posFrom) && isNaN(posTo))
      || (isNaN(posFrom) ? pos <= posTo
        : isNaN(posTo)  ? pos >= posFrom
          : pos >= posFrom && pos <= posTo);
    return mSearch && (evFilter === 'all' || w.eventId === evFilter) && mPos && applyDateRangeFilter(w.joinedAt, dfrom, dto);
  });
}

function openWaitlistNotifyModal(entryId) {
  const entry = waitlist.find(w => w.id === entryId);
  if (!entry) return;
  document.getElementById('waitlist-notify-id').value = entryId;
  document.getElementById('waitlist-notify-info').innerHTML =
    `<strong>${entry.userName || '—'}</strong> — ${entry.userEmail || '—'}<br>
     <span style="color:#94a3b8;font-size:0.78rem;">${entry.eventTitle || 'Unknown Event'}</span>`;
  openModal('waitlist-notify-modal');
}

async function submitWaitlistNotify() {
  const entryId = document.getElementById('waitlist-notify-id').value;
  const channel = document.getElementById('waitlist-notify-channel').value;
  const message = document.getElementById('waitlist-notify-message').value.trim();
  const entry   = waitlist.find(w => w.id === entryId);
  if (!message) { toast.warning('Missing message', 'Please enter a notification message.'); return; }
  try { await apiRequest(`/admin/waitlist/${entryId}/notify`, { method:'POST', body: JSON.stringify({ channel, message }) }); } catch {}
  if (entry) entry.notified = true;
  //await addLog('system', `Waitlist notification sent via ${channel}`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, entryId, userEmail: entry?.userEmail, eventTitle: entry?.eventTitle });
  closeModal('waitlist-notify-modal');
  renderWaitlist();
  toast.success('Notification sent', `Message delivered via ${channel}.`);
}

function openWaitlistConvertModal(entryId) {
  const entry = waitlist.find(w => w.id === entryId);
  if (!entry) return;
  document.getElementById('waitlist-convert-id').value = entryId;
  document.getElementById('waitlist-convert-info').innerHTML =
    `<strong>${entry.userName || '—'}</strong> — ${entry.userEmail || '—'}<br>
     <span style="color:#94a3b8;font-size:0.78rem;">${entry.eventTitle || 'Unknown Event'}</span>`;
  document.getElementById('waitlist-convert-type').value    = 'regular';
  document.getElementById('waitlist-convert-gateway').value = 'manual';
  document.getElementById('waitlist-convert-ref').value     = '';
  document.getElementById('waitlist-convert-amount').value  = '';
  document.getElementById('waitlist-convert-paidat').value  = '';
  openModal('waitlist-convert-modal');
}

async function submitWaitlistConvert() {
  const entryId          = document.getElementById('waitlist-convert-id').value;
  const ticketType       = document.getElementById('waitlist-convert-type').value;
  const paymentGateway   = document.getElementById('waitlist-convert-gateway').value;
  const paymentReference = document.getElementById('waitlist-convert-ref').value.trim();
  const amountPaidStr    = document.getElementById('waitlist-convert-amount').value.trim();
  const paidAtStr        = document.getElementById('waitlist-convert-paidat').value;

  if (!paymentReference) {
    toast.warning('Payment reference required',
      'Enter the MoMo receipt, bank reference, or gateway transaction ID.');
    return;
  }

  const body = { ticketType, paymentReference, paymentGateway };
  if (amountPaidStr) {
    const n = parseFloat(amountPaidStr);
    if (isNaN(n) || n < 0) { toast.warning('Invalid amount', 'Amount Paid must be a positive number.'); return; }
    body.amountPaid = n;
  }
  if (paidAtStr) body.paidAt = new Date(paidAtStr).toISOString();

  const entry = waitlist.find(w => w.id === entryId);
  try {
    const result = await apiRequest(`/admin/waitlist/${entryId}/convert`, {
      method: 'POST', body: JSON.stringify(body),
    });
    const idx = waitlist.findIndex(w => w.id === entryId);
    if (idx !== -1) waitlist.splice(idx, 1);
    renderWaitlist(); calculateStats(); renderDashboard();
    toast.success('Converted',
      `${entry?.userName || 'User'} issued a ${ticketType.toUpperCase()} ticket${result?.ticket?.amountPaid != null ? ' (₵' + Number(result.ticket.amountPaid).toFixed(2) + ')' : ''}.`);
    closeModal('waitlist-convert-modal');
  } catch (err) {
    // Keep the modal open so the admin can fix the reference without losing input
    toast.error('Conversion failed', err.message || 'Could not convert waitlist entry.');
  }
}

async function removeWaitlistEntry(entryId) {
  const ok = await customConfirm('Remove this entry from the waitlist?', 'Remove Entry', 'Remove', '#ef4444');
  if (!ok) return;
  const entry = waitlist.find(w => w.id === entryId);
  try { await apiRequest(`/admin/waitlist/${entryId}`, { method: 'DELETE' }); } catch {}
  const idx = waitlist.findIndex(w => w.id === entryId);
  if (idx !== -1) waitlist.splice(idx, 1);
  //await addLog('warning', 'Waitlist entry removed', { adminName: currentAdmin.name, adminRole: currentAdmin.role, entryId, userEmail: entry?.userEmail });
  renderWaitlist(); calculateStats(); renderDashboard();
  toast.info('Removed', 'Entry removed from the waitlist.');
}

async function bulkNotifyWaitlist() {
  const ids = [...selectedIds.waitlist];
  if (!ids.length) return;
  const message = await customPrompt(`Notification message to send to ${ids.length} selected waitlisted user(s):`, 'A spot has become available. Click here to claim your ticket.', 'Bulk Notify Waitlist', 'Type your message...');
  if (!message) return;
  let ok = 0;
  for (const id of ids) {
    try { await apiRequest(`/admin/waitlist/${id}/notify`, { method:'POST', body: JSON.stringify({ channel:'both', message }) }); } catch {}
    ok++;
  }
  //await addLog('system', `Bulk waitlist notification sent to ${ok} user(s)`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, count: ok });
  selectedIds.waitlist.clear();
  updateBulkBar('waitlist');
  toast.success('Done', `${ok} waitlisted user(s) notified.`);
}

async function bulkConvertWaitlist() {
  const ids = [...selectedIds.waitlist];
  if (!ids.length) return;

  const ticketType = await customPrompt(
    'Ticket type to assign to all selected entries:', 'regular',
    'Bulk Convert Waitlist', 'regular / vip / vvip / free'
  );
  if (!ticketType) return;

  const batchRef = await customPrompt(
    'Batch payment reference (MoMo disbursement ID, bank batch ref, etc.).\n' +
    'Each converted ticket will be tagged under this reference.',
    '', 'Bulk Convert Waitlist', 'e.g. MoMo-BATCH-20250101-001'
  );
  if (!batchRef || !batchRef.trim()) return;

  showBulkConfirm('Convert Waitlist',
    `Convert ${ids.length} waitlisted user(s) to ${ticketType} tickets using batch reference "${batchRef.trim()}"?`,
    async () => {
      let ok = 0, failed = 0, lastError = '';
      let ticketIndex = 0;
      for (const id of ids) {
        try {
          ticketIndex++;
          await apiRequest(`/admin/waitlist/${id}/convert`, {
            method: 'POST',
            body: JSON.stringify({
              ticketType,
              paymentReference: `${batchRef.trim()}-${String(ticketIndex).padStart(3, '0')}`,
              paymentGateway: 'manual',
            }),
          });
          const idx = waitlist.findIndex(w => w.id === id);
          if (idx !== -1) { waitlist.splice(idx, 1); ok++; }
        } catch (err) { failed++; lastError = err.message || ''; }
      }
      selectedIds.waitlist.clear();
      renderWaitlist(); calculateStats(); renderDashboard();
      if (failed) toast.warning('Some conversions failed', `${ok} converted, ${failed} failed. ${lastError}`);
      else        toast.success('Done', `${ok} user(s) converted to ${ticketType} tickets.`);
    });
}

async function bulkRemoveWaitlist() {
  const ids = [...selectedIds.waitlist];
  if (!ids.length) return;
  showBulkConfirm('Remove Waitlist Entries', `Remove ${ids.length} selected entries from the waitlist?`, async () => {
    let ok = 0;
    for (const id of ids) {
      try { await apiRequest(`/admin/waitlist/${id}`, { method: 'DELETE' }); } catch {}
      const idx = waitlist.findIndex(w => w.id === id); if (idx !== -1) { waitlist.splice(idx, 1); ok++; }
    }
   // await addLog('warning', `Bulk removed ${ok} waitlist entries`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, count: ok });
    selectedIds.waitlist.clear();
    renderWaitlist(); calculateStats(); renderDashboard();
    toast.info('Done', `${ok} waitlist entr${ok === 1 ? 'y' : 'ies'} removed.`);
  });
}
