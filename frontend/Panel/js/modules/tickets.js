// ===============================================
// TICKETS MANAGEMENT
// ===============================================

function resolveEventForTicket(ticket) {
  const eid = ticket.eventId?.id || ticket.eventId?._id?.toString() || ticket.eventId;
  return events.find(e => e.id === eid);
}
function resolveUserForTicket(ticket) {
  const uid = ticket.userId?.id || ticket.userId?._id?.toString() || ticket.userId;
  return users.find(u => u.id === uid);
}
function getTicketStatus(ticket) { return ticket.status || 'active'; }

function renderTickets() {
  const tb      = document.getElementById('tickets-table');
  const base    = getFilteredTickets();
  const enriched = base.map(t => ({ ...t, eventTitle: resolveEventForTicket(t)?.title || '' }));
  const sorted  = applySorting(enriched, 'tickets');
  const { rows, page, totalPages, total, pp } = paginate(sorted, 'tickets');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty-state"><i class="fa-solid fa-ticket" style="font-size:1.5rem;display:block;margin-bottom:0.5rem;"></i>No tickets found</td></tr>';
    renderPaginationBar('tickets-pagination', 'tickets', 0, 1, 1, pp);
    return;
  }
  tb.innerHTML = rows.map(ticket => {
    const ev      = resolveEventForTicket(ticket);
    const user    = resolveUserForTicket(ticket);
    const status  = getTicketStatus(ticket);
    const shortId = String(ticket.id).substring(0, 12).toUpperCase() + (String(ticket.id).length > 12 ? '…' : '');
    const dateStr = ev ? new Date(ev.date).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '—';
    const statusMap = { used:['badge-used','fa-circle-check','Used'], cancelled:['badge-cancelled','fa-circle-xmark','Cancelled'] };
    const [sBadge, sIcon, sLabel] = statusMap[status] || ['badge-active','fa-circle-check','Active'];
    const sel = selectedIds.tickets.has(ticket.id);
    return `
      <tr class="${sel ? 'row-selected' : ''}">
        <td><input type="checkbox" class="row-checkbox" data-id="${ticket.id}" ${sel ? 'checked' : ''} onchange="toggleRowSelect('tickets','${ticket.id}',this)"></td>
        <td>
          <div class="ticket-table-id" title="${ticket.id}">${shortId}</div>
          <div class="ticket-table-type">${ticket.ticketType || '—'}</div>
          <div style="font-size:0.7rem;color:#475569;">₵${(ticket.price||0).toFixed(2)}</div>
        </td>
        <td>
          <div class="ticket-table-event">${ev?.title || 'Unknown Event'}</div>
          <div class="ticket-table-event-meta"><span><i class="fa-regular fa-calendar"></i> ${dateStr}</span>${ev?.venue ? `<span><i class="fa-solid fa-location-dot"></i> ${ev.venue}</span>` : ''}</div>
        </td>
        <td>
          <div class="ticket-table-user">${user?.name || '—'}</div>
          <div class="ticket-table-user-sub"><i class="fa-regular fa-envelope"></i> ${ticket.userEmail || user?.email || '—'}</div>
          ${ticket.purchasedAt ? `<div style="font-size:0.7rem;color:#475569;">${new Date(ticket.purchasedAt).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</div>` : ''}
        </td>
        <td><span class="badge ${sBadge}"><i class="fa-solid ${sIcon}"></i> ${sLabel}</span></td>
        <td><div class="actions">
          <button class="btn-icon" style="background:#6366f1;" onclick="viewTicket('${ticket.id}')" title="View"><i class="fa-solid fa-eye"></i></button>
          <button class="btn-icon" style="background:#8b5cf6;" onclick="openResendTicketModal('${ticket.id}')" title="Resend"><i class="fa-solid fa-envelope"></i></button>
          ${status === 'active' ? `<button class="btn-icon" style="background:#10b981;" onclick="validateTicket('${ticket.id}')" title="Validate"><i class="fa-solid fa-circle-check"></i></button>` : ''}
          ${status === 'active' ? `<button class="btn-icon" style="background:#ef4444;" onclick="cancelTicket('${ticket.id}')" title="Cancel"><i class="fa-solid fa-ban"></i></button>` : ''}
        </div></td>
      </tr>`;
  }).join('');
  renderPaginationBar('tickets-pagination', 'tickets', total, page, totalPages, pp);
}

function getFilteredTickets() {
  const search = (document.getElementById('ticket-search')?.value || '').toLowerCase();
  const status = document.getElementById('ticket-status-filter')?.value || 'all';
  const type   = document.getElementById('ticket-type-filter')?.value   || 'all';
  const dfrom  = document.getElementById('ticket-date-from')?.value;
  const dto    = document.getElementById('ticket-date-to')?.value;
  return tickets.filter(t => {
    const ev   = resolveEventForTicket(t);
    const user = resolveUserForTicket(t);
    const mSearch = !search || String(t.id).toLowerCase().includes(search)
      || (ev?.title || '').toLowerCase().includes(search)
      || (t.userEmail || '').toLowerCase().includes(search)
      || (user?.name  || '').toLowerCase().includes(search)
      || (user?.email || '').toLowerCase().includes(search);
    return mSearch
      && (status === 'all' || getTicketStatus(t) === status)
      && (type   === 'all' || (t.ticketType || '').toLowerCase() === type)
      && applyDateRangeFilter(t.purchasedAt, dfrom, dto);
  });
}

function viewTicket(ticketId) {
  const ticket = tickets.find(t => t.id === ticketId);
  if (!ticket) return;
  const ev     = resolveEventForTicket(ticket);
  const user   = resolveUserForTicket(ticket);
  const status = getTicketStatus(ticket);
  const sMap   = { used:['badge-used','fa-circle-check','Used'], cancelled:['badge-cancelled','fa-circle-xmark','Cancelled'] };
  const [sBadge, sIcon, sLabel] = sMap[status] || ['badge-active','fa-circle-check','Active'];

  // Payment split — mirrors how the API records the charge
  const basePrice    = Number(ticket.price) || 0;
  const platformFee  = ticket.platformFee != null ? Number(ticket.platformFee) : null;
  const feePaidByLbl = ticket.feePaidBy === 'buyer'     ? 'Buyer'
    : ticket.feePaidBy === 'organizer' ? 'Organizer'
      : '—';
  const discount     = Number(ticket.discountAmount) || 0;
  const amountPaid   = ticket.amountPaid != null
    ? Number(ticket.amountPaid)
    : basePrice - discount + (ticket.feePaidBy === 'buyer' && platformFee ? platformFee : 0);

  document.getElementById('ticket-modal-body').innerHTML = `
    <div class="detail-grid">
      <div class="detail-item" style="grid-column:span 2;"><div class="detail-label"><i class="fa-solid fa-fingerprint"></i> Ticket ID</div>
        <div class="detail-value" style="font-family:monospace;font-size:0.82rem;word-break:break-all;">${ticket.id}</div></div>
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-tag"></i> Type</div><div class="detail-value" style="text-transform:uppercase;">${ticket.ticketType||'—'}</div></div>
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-circle-dot"></i> Status</div><div class="detail-value"><span class="badge ${sBadge}"><i class="fa-solid ${sIcon}"></i> ${sLabel}</span></div></div>
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-coins"></i> Base Price</div><div class="detail-value">₵${basePrice.toFixed(2)}</div></div>
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-percent"></i> Platform Fee</div><div class="detail-value">${platformFee != null ? '₵' + platformFee.toFixed(2) : '—'}</div></div>
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-user-tag"></i> Fee Paid By</div><div class="detail-value">${feePaidByLbl}</div></div>
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-sack-dollar"></i> Amount Paid</div><div class="detail-value" style="color:#34d399;font-weight:700;">₵${amountPaid.toFixed(2)}</div></div>
      <div class="detail-item" style="grid-column:span 2;"><div class="detail-label"><i class="fa-regular fa-clock"></i> Purchased At</div><div class="detail-value">${ticket.purchasedAt ? new Date(ticket.purchasedAt).toLocaleString() : '—'}</div></div>
    </div>
    <div style="padding:1rem;background:#0f172a;border-radius:0.5rem;margin-bottom:1rem;">
      <h4 style="font-weight:700;margin-bottom:0.75rem;"><i class="fa-regular fa-calendar" style="color:#6366f1;margin-right:0.4rem;"></i>Event</h4>
      ${ev ? `<div style="font-weight:600;margin-bottom:0.25rem;">${ev.title}</div>
        <div style="font-size:0.82rem;color:#94a3b8;line-height:1.7;">
          <div><i class="fa-regular fa-calendar" style="margin-right:0.3rem;"></i>${new Date(ev.date).toLocaleString()}</div>
          <div><i class="fa-solid fa-location-dot" style="margin-right:0.3rem;"></i>${ev.venue}${ev.location ? ', '+ev.location : ''}</div>
        </div>` : '<p style="color:#94a3b8;">Event not found</p>'}
    </div>
    <div style="padding:1rem;background:#0f172a;border-radius:0.5rem;margin-bottom:1rem;">
      <h4 style="font-weight:700;margin-bottom:0.75rem;"><i class="fa-regular fa-user" style="color:#6366f1;margin-right:0.4rem;"></i>Customer</h4>
      <div style="font-size:0.875rem;line-height:1.8;color:#94a3b8;">
        <div><i class="fa-regular fa-user" style="margin-right:0.3rem;"></i>${user?.name || '—'}</div>
        <div><i class="fa-regular fa-envelope" style="margin-right:0.3rem;"></i>${ticket.userEmail || user?.email || '—'}</div>
        <div><i class="fa-solid fa-mobile-screen-button" style="margin-right:0.3rem;"></i>${ticket.userPhone || user?.phone || '—'}</div>
      </div>
    </div>
    <div style="display:flex;gap:0.75rem;flex-wrap:wrap;">
      <button class="btn btn-primary" onclick="openResendTicketModal('${ticket.id}');closeModal('ticket-modal');"><i class="fa-solid fa-envelope"></i> Resend</button>
      ${status === 'active' ? `
        <button class="btn btn-success" onclick="validateTicket('${ticket.id}');closeModal('ticket-modal');"><i class="fa-solid fa-circle-check"></i> Validate</button>
        <button class="btn btn-danger"  onclick="cancelTicket('${ticket.id}');closeModal('ticket-modal');"><i class="fa-solid fa-ban"></i> Cancel</button>` : ''}
    </div>`;
  openModal('ticket-modal');
}

function openResendTicketModal(ticketId) {
  const ticket = tickets.find(t => t.id === ticketId);
  if (!ticket) return;
  const ev   = resolveEventForTicket(ticket);
  const user = resolveUserForTicket(ticket);
  document.getElementById('resend-ticket-id').value = ticketId;
  document.getElementById('resend-ticket-info').innerHTML =
    `<strong>${(ticket.ticketType || 'TICKET').toUpperCase()}</strong> — ${ev?.title || 'Unknown Event'}<br>
     <span style="color:#94a3b8;font-size:0.78rem;">ID: ${ticket.id}</span>`;
  document.getElementById('resend-email').value = ticket.userEmail || user?.email || '';
  document.getElementById('resend-phone').value = ticket.userPhone || user?.phone || '';
  document.getElementById('resend-status').style.display = 'none';
  openModal('resend-ticket-modal');
}

async function submitResendTicket() {
  const ticketId = document.getElementById('resend-ticket-id').value;
  const email    = document.getElementById('resend-email').value.trim();
  const phone    = document.getElementById('resend-phone').value.trim();
  const statusEl = document.getElementById('resend-status');
  if (!email && !phone) { toast.warning('No contact info', 'Please enter an email or phone number.'); return; }
  _setResendStatus(statusEl, 'loading');
  const channels = [];
  try {
    if (email) await apiRequest(`/admin/tickets/${ticketId}/resend`, { method:'POST', body:JSON.stringify({ channel:'email', email }) });
    if (phone) await apiRequest(`/admin/tickets/${ticketId}/resend`, { method:'POST', body:JSON.stringify({ channel:'sms', phone }) });
  } catch {}
  if (email) channels.push('email');
  if (phone) channels.push('SMS');
  //await addLog('system', `Ticket resent via ${channels.join(' & ')}`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, ticketId, email, phone });
  _setResendStatus(statusEl, 'success', `Sent via ${channels.join(' & ')}!`);
  toast.success('Ticket resent', `Sent via ${channels.join(' & ')}.`);
  setTimeout(() => closeModal('resend-ticket-modal'), 1800);
}

function _setResendStatus(el, state, msg = '') {
  el.style.display = 'block';
  const configs = {
    loading: ['rgba(99,102,241,0.1)','rgba(99,102,241,0.3)','#818cf8','<i class="fa-solid fa-spinner fa-spin" style="margin-right:0.4rem;"></i>Sending…'],
    success: ['rgba(16,185,129,0.1)','rgba(16,185,129,0.3)','#34d399',`<i class="fa-solid fa-circle-check" style="margin-right:0.4rem;"></i>${msg}`],
  };
  const [bg, border, color, html] = configs[state] || configs.loading;
  el.style.cssText = `display:block;padding:0.75rem;border-radius:0.5rem;font-size:0.82rem;background:${bg};border:1px solid ${border};color:${color};`;
  el.innerHTML = html;
}

async function validateTicket(ticketId) {
  const ok = await customConfirm('Mark this ticket as used/validated? This cannot be undone.', 'Validate Ticket', 'Validate', '#10b981');
  if (!ok) return;
  try { await apiRequest(`/admin/tickets/${ticketId}/validate`, { method: 'PATCH' }); }
  catch { const t = tickets.find(t => t.id === ticketId); if (t) t.status = 'used'; }
  //await addLog('system', 'Ticket validated', { adminName: currentAdmin.name, adminRole: currentAdmin.role, ticketId });
  renderTickets();
  toast.success('Ticket validated', 'Marked as used.');
}

async function cancelTicket(ticketId) {
  const ok = await customConfirm('Cancel this ticket? This action cannot be undone.', 'Cancel Ticket', 'Cancel Ticket', '#ef4444');
  if (!ok) return;
  try { await apiRequest(`/admin/tickets/${ticketId}/cancel`, { method: 'PATCH' }); }
  catch { const t = tickets.find(t => t.id === ticketId); if (t) t.status = 'cancelled'; }
 // await addLog('warning', 'Ticket cancelled by admin', { adminName: currentAdmin.name, adminRole: currentAdmin.role, ticketId });
  renderTickets();
  toast.warning('Ticket cancelled', 'The ticket has been cancelled.');
}

async function bulkValidateTickets() {
  const ids = [...selectedIds.tickets].filter(id => getTicketStatus(tickets.find(t => t.id === id)) === 'active');
  if (!ids.length) { toast.warning('None eligible', 'No active tickets selected.'); return; }
  showBulkConfirm('Validate Tickets', `Mark ${ids.length} ticket(s) as used?`, async () => {
    let ok = 0;
    for (const id of ids) {
      try { await apiRequest(`/admin/tickets/${id}/validate`, { method: 'PATCH' }); }
      catch { const t = tickets.find(t => t.id === id); if (t) t.status = 'used'; }
      ok++;
    }
    //await addLog('system', `Bulk validated ${ok} ticket(s)`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, count: ok });
    selectedIds.tickets.clear();
    renderTickets();
    toast.success('Done', `${ok} ticket(s) validated.`);
  });
}

async function bulkCancelTickets() {
  const ids = [...selectedIds.tickets].filter(id => getTicketStatus(tickets.find(t => t.id === id)) === 'active');
  if (!ids.length) { toast.warning('None eligible', 'No active tickets selected.'); return; }
  showBulkConfirm('Cancel Tickets', `Cancel ${ids.length} ticket(s)? This cannot be undone.`, async () => {
    let ok = 0;
    for (const id of ids) {
      try { await apiRequest(`/admin/tickets/${id}/cancel`, { method: 'PATCH' }); }
      catch { const t = tickets.find(t => t.id === id); if (t) t.status = 'cancelled'; }
      ok++;
    }
   // await addLog('warning', `Bulk cancelled ${ok} ticket(s)`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, count: ok });
    selectedIds.tickets.clear();
    renderTickets();
    toast.warning('Done', `${ok} ticket(s) cancelled.`);
  });
}
