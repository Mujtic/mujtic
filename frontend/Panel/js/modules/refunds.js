// ===============================================
// REFUNDS MANAGEMENT
// ===============================================
// Lifecycle:  pending → approved → completed (paid)      or   pending → rejected
//   pending   : a buyer asked, waiting for review
//   approved  : money is owed to the buyer, not paid yet
//               (also how refunds created by an event cancellation start)
//   completed : an admin paid it out and recorded the reference
//   PATCH /admin/refunds/:id/complete moves approved → completed (admins only)

function _resolveRefundUser(r) {
  const uid = r.userId?.id || r.userId?._id?.toString() || r.userId;
  return users.find(u => u.id === uid);
}
function _resolveRefundTicket(r) {
  const tid = r.ticketId?.id || r.ticketId?._id?.toString() || r.ticketId;
  return tickets.find(t => t.id === tid);
}
function _resolveRefundTicketIdString(r) {
  if (!r.ticketId) return '—';
  if (typeof r.ticketId === 'string') return r.ticketId;
  if (typeof r.ticketId === 'object') return r.ticketId.id || r.ticketId._id?.toString() || '—';
  return String(r.ticketId);
}
function _reasonLabel(reason) {
  if (!reason) return 'Other';
  return reason.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function _reasonPill(reason) {
  const r = reason || 'other';
  return `<span class="refund-reason-pill ${r}">${_reasonLabel(r)}</span>`;
}

// ── helpers added for the payout step ─────────────────────────────

// Only admins pay refunds out; moderators can review but not mark as paid.
function _canPayRefunds() {
  return currentAdmin?.role === 'admin';
}

// uses the error toast if the panel has one, otherwise the warning toast
function _notifyRefundError(title, message) {
  if (typeof toast.error === 'function') toast.error(title, message);
  else toast.warning(title, message);
}

// the API stores processedAt; older panel code used resolvedAt
function _refundResolvedAt(r) {
  return r.processedAt || r.resolvedAt || null;
}

// one place that decides how a status looks
function _refundStatusView(r) {
  switch (r.status) {
    case 'completed':
      return {
        badge: 'badge-completed', icon: 'fa-circle-check', label: 'Paid',
        note: r.completedAt ? `<div style="font-size:0.7rem;color:#34d399;margin-top:0.3rem;"><i class="fa-regular fa-calendar-check"></i> ${new Date(r.completedAt).toLocaleDateString()}</div>` : '',
      };
    case 'approved':
      return {
        badge: 'badge-info', icon: 'fa-hourglass-half', label: 'Approved',
        note: '<div style="font-size:0.7rem;color:#94a3b8;margin-top:0.3rem;">Awaiting payout</div>',
      };
    case 'rejected':
      return {
        badge: 'badge-rejected', icon: 'fa-circle-xmark', label: 'Rejected',
        note: r.rejectionReason ? `<div style="font-size:0.7rem;color:#f87171;margin-top:0.3rem;" title="${r.rejectionReason}"><i class="fa-solid fa-triangle-exclamation"></i> ${r.rejectionReason.substring(0, 30)}</div>` : '',
      };
    default:
      return { badge: 'badge-pending', icon: 'fa-clock', label: 'Pending', note: '' };
  }
}

// small tag that explains where a refund came from
function _refundSourceTag(r) {
  if (r.source === 'event_cancelled') {
    return '<div style="margin-top:0.35rem;"><span class="badge badge-info"><i class="fa-solid fa-calendar-xmark"></i> Auto · event cancelled</span></div>';
  }
  if (r.source === 'admin_cancelled') {
    return '<div style="margin-top:0.35rem;"><span class="badge badge-info"><i class="fa-solid fa-user-shield"></i> Ticket cancelled by staff</span></div>';
  }
  return '';
}

// copy what the server answered into the local row (no guessing)
function _applyRefundUpdate(r, updated, fallbackStatus) {
  if (!r) return;
  r.status = updated?.status || fallbackStatus;
  if (updated?.processedAt)     r.processedAt = updated.processedAt;
  if (updated?.completedAt)     r.completedAt = updated.completedAt;
  if (updated?.paymentReference !== undefined) r.paymentReference = updated.paymentReference;
  if (updated?.rejectionReason) r.rejectionReason = updated.rejectionReason;
  if (updated?.amount != null)  r.amount = updated.amount;
}

function _refreshRefundViews() {
  calculateStats(); renderDashboard(); renderRefunds(); renderReports();
}

// ── table ─────────────────────────────────────────────────────────

function renderRefunds() {
  const tb = document.getElementById('refunds-table');
  if (!tb) return;
  const base     = getFilteredRefunds();
  const enriched = base.map(r => ({ ...r, userName: r.userName || _resolveRefundUser(r)?.name || '—' }));
  const sorted   = applySorting(enriched, 'refunds');
  const { rows, page, totalPages, total, pp } = paginate(sorted, 'refunds');

  const pendingTotal = refunds
    .filter(r => r.status === 'pending')
    .reduce((s, r) => s + (r.amount || 0), 0);
  setText('pending-refund-amount', `₵${pendingTotal.toFixed(2)}`);

  // optional stat card: money approved but not yet paid out
  const awaitingEl = document.getElementById('awaiting-payout-amount');
  if (awaitingEl) {
    const awaitingTotal = refunds
      .filter(r => r.status === 'approved')
      .reduce((s, r) => s + (r.amount || 0), 0);
    awaitingEl.textContent = `₵${awaitingTotal.toFixed(2)}`;
  }

  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fa-solid fa-rotate-left" style="font-size:1.5rem;display:block;margin-bottom:0.5rem;"></i>No refund requests found</td></tr>';
    renderPaginationBar('refunds-pagination', 'refunds', 0, 1, 1, pp);
    return;
  }
  tb.innerHTML = rows.map(r => {
    const ticket       = _resolveRefundTicket(r);
    const ev           = ticket ? resolveEventForTicket(ticket) : null;
    const ticketIdStr  = _resolveRefundTicketIdString(r);
    const shortTicketId = ticketIdStr !== '—' ? ticketIdStr.substring(0, 10).toUpperCase() : '—';
    const shortId       = String(r.id).substring(0, 8).toUpperCase();
    const reqDate       = new Date(r.requestedAt).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
    const sv      = _refundStatusView(r);
    const sel     = selectedIds.refunds.has(r.id);
    const customerEmail = r.userEmail || _resolveRefundUser(r)?.email || '—';
    return `
      <tr class="${sel ? 'row-selected' : ''}">
        <td><input type="checkbox" class="row-checkbox" data-id="${r.id}" ${sel ? 'checked' : ''} onchange="toggleRowSelect('refunds','${r.id}',this)"></td>
        <td>
          <div class="refund-table-id"><i class="fa-solid fa-fingerprint" style="margin-right:0.3rem;color:#475569;"></i>#${shortId}</div>
          <div style="font-size:0.7rem;color:#475569;margin-top:0.2rem;">${reqDate}</div>
        </td>
        <td>
          <div class="refund-table-user">${r.userName || '—'}</div>
          <div class="refund-table-sub"><i class="fa-regular fa-envelope"></i> ${customerEmail}</div>
          ${r.userPhone ? `<div class="refund-table-sub"><i class="fa-solid fa-mobile-screen-button"></i> ${r.userPhone}</div>` : ''}
        </td>
        <td>
          <div class="refund-table-amount">₵${(r.amount || 0).toFixed(2)}</div>
          <div class="refund-table-reason">${_reasonPill(r.reason)}</div>
          ${_refundSourceTag(r)}
        </td>
        <td>
          <div class="refund-table-ticket"><i class="fa-solid fa-ticket" style="margin-right:0.3rem;color:#6366f1;font-size:0.75rem;"></i>${shortTicketId}</div>
          <div class="refund-table-event"><i class="fa-regular fa-calendar"></i> ${r.eventTitle || ev?.title || '—'}</div>
        </td>
        <td>
          <span class="badge ${sv.badge}"><i class="fa-solid ${sv.icon}"></i> ${sv.label}</span>
          ${sv.note}
        </td>
        <td><div class="actions">
          <button class="btn-icon" style="background:#6366f1;" onclick="viewRefund('${r.id}')" title="View"><i class="fa-solid fa-eye"></i></button>
          ${r.status === 'pending' ? `
            <button class="btn-icon" style="background:#10b981;" onclick="approveRefund('${r.id}')" title="Approve"><i class="fa-solid fa-check"></i></button>
            <button class="btn-icon" style="background:#ef4444;" onclick="openRefundRejectModal('${r.id}')" title="Reject"><i class="fa-solid fa-xmark"></i></button>` : ''}
          ${r.status === 'approved' && _canPayRefunds() ? `
            <button class="btn-icon" style="background:#0ea5e9;" onclick="markRefundPaid('${r.id}')" title="Mark as paid"><i class="fa-solid fa-money-bill-transfer"></i></button>` : ''}
        </div></td>
      </tr>`;
  }).join('');
  renderPaginationBar('refunds-pagination', 'refunds', total, page, totalPages, pp);
}

function getFilteredRefunds() {
  const search = (document.getElementById('refund-search')?.value || '').toLowerCase();
  const status = document.getElementById('refund-status-filter')?.value || 'all';
  const reason = document.getElementById('refund-reason-filter')?.value || 'all';
  const source = document.getElementById('refund-source-filter')?.value || 'all';   // optional filter
  const dfrom  = document.getElementById('refund-date-from')?.value;
  const dto    = document.getElementById('refund-date-to')?.value;
  return [...refunds].sort((a,b) => new Date(b.requestedAt) - new Date(a.requestedAt)).filter(r => {
    const mSearch = !search || String(r.id).toLowerCase().includes(search) || (r.userName||'').toLowerCase().includes(search) || (r.userEmail||'').toLowerCase().includes(search) || (r.eventTitle||'').toLowerCase().includes(search);
    return mSearch
      && (status === 'all' || r.status === status)
      && (reason === 'all' || r.reason === reason)
      && (source === 'all' || (r.source || 'buyer_request') === source)
      && applyDateRangeFilter(r.requestedAt, dfrom, dto);
  });
}

// ── details modal ─────────────────────────────────────────────────

function viewRefund(refundId) {
  const r = refunds.find(x => x.id === refundId);
  if (!r) return;
  const user        = _resolveRefundUser(r);
  const ticket      = _resolveRefundTicket(r);
  const ev          = ticket ? resolveEventForTicket(ticket) : null;
  const ticketIdStr = _resolveRefundTicketIdString(r);
  const sv          = _refundStatusView(r);
  const resolvedAt  = _refundResolvedAt(r);
  const customerEmail = r.userEmail || user?.email || '—';
  const sourceLabel = { buyer_request: 'Buyer request', admin_cancelled: 'Ticket cancelled by staff', event_cancelled: 'Event cancelled (automatic)' }[r.source || 'buyer_request'];

  document.getElementById('refund-modal-body').innerHTML = `
    <div class="detail-grid">
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-fingerprint"></i> Refund ID</div><div class="detail-value" style="font-family:monospace;font-size:0.85rem;">${r.id}</div></div>
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-circle-dot"></i> Status</div><div class="detail-value"><span class="badge ${sv.badge}"><i class="fa-solid ${sv.icon}"></i> ${sv.label}</span></div></div>
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-coins"></i> Refund Amount</div><div class="detail-value" style="font-size:1.25rem;color:#ef4444;">₵${(r.amount||0).toFixed(2)}</div></div>
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-circle-info"></i> Reason</div><div class="detail-value">${_reasonPill(r.reason)}</div></div>
      <div class="detail-item"><div class="detail-label"><i class="fa-regular fa-calendar"></i> Requested At</div><div class="detail-value">${new Date(r.requestedAt).toLocaleString()}</div></div>
      ${resolvedAt ? `<div class="detail-item"><div class="detail-label"><i class="fa-solid fa-calendar-check"></i> Resolved At</div><div class="detail-value">${new Date(resolvedAt).toLocaleString()}</div></div>` : '<div></div>'}
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-route"></i> Source</div><div class="detail-value">${sourceLabel}</div></div>
      ${r.status === 'completed' && r.completedAt ? `<div class="detail-item"><div class="detail-label"><i class="fa-solid fa-money-bill-transfer"></i> Paid At</div><div class="detail-value">${new Date(r.completedAt).toLocaleString()}</div></div>` : '<div></div>'}
      ${r.status === 'completed' && r.paymentReference ? `<div class="detail-item" style="grid-column:span 2;"><div class="detail-label"><i class="fa-solid fa-receipt"></i> Payment Reference</div><div class="detail-value" style="font-family:monospace;font-size:0.85rem;">${r.paymentReference}</div></div>` : ''}
    </div>
    <div style="padding:1rem;background:#0f172a;border-radius:0.5rem;margin-bottom:1rem;">
      <h4 style="font-weight:700;margin-bottom:0.75rem;"><i class="fa-regular fa-user" style="color:#6366f1;margin-right:0.4rem;"></i>Customer</h4>
      <div style="font-size:0.875rem;line-height:1.8;color:#94a3b8;">
        <div><i class="fa-regular fa-user" style="margin-right:0.3rem;"></i>${r.userName || user?.name || '—'}</div>
        <div><i class="fa-regular fa-envelope" style="margin-right:0.3rem;"></i>${customerEmail}</div>
        <div><i class="fa-solid fa-mobile-screen-button" style="margin-right:0.3rem;"></i>${r.userPhone || user?.phone || '—'}</div>
      </div>
    </div>
    <div style="padding:1rem;background:#0f172a;border-radius:0.5rem;margin-bottom:1rem;">
      <h4 style="font-weight:700;margin-bottom:0.75rem;"><i class="fa-solid fa-ticket" style="color:#6366f1;margin-right:0.4rem;"></i>Ticket &amp; Event</h4>
      <div style="font-size:0.875rem;line-height:1.8;color:#94a3b8;">
        <div><i class="fa-solid fa-fingerprint" style="margin-right:0.3rem;"></i>Ticket: ${ticketIdStr.substring(0,20).toUpperCase()}</div>
        ${ticket ? `<div><i class="fa-solid fa-tag" style="margin-right:0.3rem;"></i>Type: ${(ticket.ticketType||'—').toUpperCase()} &nbsp;·&nbsp; ₵${(ticket.price||0).toFixed(2)}</div>` : ''}
        <div><i class="fa-regular fa-calendar" style="margin-right:0.3rem;"></i>${r.eventTitle || ev?.title || '—'}</div>
        ${ev ? `<div><i class="fa-solid fa-location-dot" style="margin-right:0.3rem;"></i>${ev.venue}${ev.location ? ', '+ev.location : ''}</div>` : ''}
      </div>
    </div>
    ${r.originalAmountPaid != null || r.originalPrice != null ? `
    <div style="padding:1rem;background:#0f172a;border-radius:0.5rem;margin-bottom:1rem;">
      <h4 style="font-weight:700;margin-bottom:0.75rem;"><i class="fa-solid fa-receipt" style="color:#6366f1;margin-right:0.4rem;"></i>Amount Breakdown</h4>
      <div style="font-size:0.85rem;line-height:1.8;color:#94a3b8;">
        ${r.originalPrice != null ? `<div>Face price: <strong style="color:#f1f5f9;">₵${Number(r.originalPrice).toFixed(2)}</strong></div>` : ''}
        ${r.originalAmountPaid != null ? `<div>Buyer paid: <strong style="color:#f1f5f9;">₵${Number(r.originalAmountPaid).toFixed(2)}</strong></div>` : ''}
        <div>Refunding: <strong style="color:#ef4444;">₵${Number(r.amount || 0).toFixed(2)}</strong>${r.isPartial ? ' <span class="refund-reason-pill" style="font-size:0.68rem;">Partial</span>' : ''}</div>
      </div>
    </div>` : ''}
    ${r.notes ? `<div style="padding:1rem;background:#0f172a;border-radius:0.5rem;margin-bottom:1rem;"><h4 style="font-weight:700;margin-bottom:0.5rem;"><i class="fa-regular fa-note-sticky"></i> Customer Notes</h4><p style="color:#94a3b8;font-size:0.875rem;">${r.notes}</p></div>` : ''}
    ${r.status === 'rejected' && r.rejectionReason ? `<div class="info-box error" style="margin-top:0.5rem;"><i class="fa-solid fa-triangle-exclamation" style="margin-right:0.4rem;"></i><strong>Rejection Reason:</strong> ${r.rejectionReason}</div>` : ''}
    ${r.status === 'pending' ? `
    <div style="display:flex;gap:0.75rem;margin-top:1.5rem;">
      <button class="btn btn-success" style="flex:1;" onclick="approveRefund('${r.id}');closeModal('refund-modal');"><i class="fa-solid fa-check"></i> Approve</button>
      <button class="btn btn-danger"  style="flex:1;" onclick="openRefundRejectModal('${r.id}');closeModal('refund-modal');"><i class="fa-solid fa-xmark"></i> Reject</button>
    </div>` : ''}
    ${r.status === 'approved' && _canPayRefunds() ? `
    <div style="display:flex;gap:0.75rem;margin-top:1.5rem;">
      <button class="btn btn-primary" style="flex:1;" onclick="closeModal('refund-modal');markRefundPaid('${r.id}');"><i class="fa-solid fa-money-bill-transfer"></i> Mark as paid</button>
    </div>` : ''}
    ${r.status === 'approved' && !_canPayRefunds() ? `
    <div class="info-box" style="margin-top:1rem;"><i class="fa-solid fa-circle-info" style="margin-right:0.4rem;"></i>Approved and waiting to be paid out. Only admins can mark a refund as paid.</div>` : ''}`;
  //addLog('system', 'Viewed refund details', { adminName: currentAdmin.name, adminRole: currentAdmin.role, refundId });
  openModal('refund-modal');
}

// ── actions (no local fallback: if the server refuses, nothing changed) ──

async function approveRefund(refundId) {
  const r = refunds.find(x => x.id === refundId);
  if (!r) return;
  try {
    const updated = await apiRequest(`/refunds/${refundId}/approve`, { method: 'PATCH' });
    _applyRefundUpdate(r, updated, 'approved');
  } catch (err) {
    _notifyRefundError('Could not approve refund', err.message || 'Please try again.');
    return;
  }
  await addLog('system', 'Refund approved', { adminName: currentAdmin.name, adminRole: currentAdmin.role, refundId, amount: r?.amount, userEmail: r?.userEmail });
  _refreshRefundViews();
  toast.success('Refund approved', `₵${(r?.amount||0).toFixed(2)} is approved. Mark it as paid once the money has been sent.`);
}

function openRefundRejectModal(refundId) {
  const r = refunds.find(x => x.id === refundId);
  if (!r) return;
  document.getElementById('reject-refund-id').value = refundId;
  document.getElementById('reject-refund-info').innerHTML =
    `<strong>${r.userName || '—'}</strong> &nbsp;·&nbsp; ₵${(r.amount||0).toFixed(2)}<br>
     <span style="font-size:0.75rem;color:#94a3b8;">${r.eventTitle || '—'} &nbsp;·&nbsp; ${_reasonLabel(r.reason)}</span>`;
  document.getElementById('refund-reject-reason').value = '';
  openModal('refund-reject-modal');
}

async function submitRefundReject() {
  const refundId = document.getElementById('reject-refund-id').value;
  const reason   = document.getElementById('refund-reject-reason').value.trim();
  if (!reason) { toast.warning('Reason required', 'Please provide a rejection reason.'); return; }
  const r = refunds.find(x => x.id === refundId);
  try {
    const updated = await apiRequest(`/refunds/${refundId}/reject`, { method: 'PATCH', body: JSON.stringify({ reason }) });
    _applyRefundUpdate(r, updated, 'rejected');
    if (r && !r.rejectionReason) r.rejectionReason = reason;
  } catch (err) {
    _notifyRefundError('Could not reject refund', err.message || 'Please try again.');
    return;
  }
  // await addLog('warning', 'Refund rejected', { adminName: currentAdmin.name, adminRole: currentAdmin.role, refundId, reason, userEmail: r?.userEmail });
  closeModal('refund-reject-modal');
  _refreshRefundViews();
  toast.warning('Refund rejected', 'The customer will be notified.');
}

// Admin only: record that an approved refund has been paid out.
async function markRefundPaid(refundId) {
  const r = refunds.find(x => x.id === refundId);
  if (!r) return;
  if (!_canPayRefunds()) { toast.warning('Admins only', 'Only admins can mark refunds as paid.'); return; }
  if (r.status !== 'approved') { toast.warning('Not payable', 'Only approved refunds can be marked as paid.'); return; }

  const reference = await customPrompt(
    `Refund of ₵${(r.amount||0).toFixed(2)} to ${r.userName || r.userEmail || 'the customer'}.\nEnter the MoMo or bank transaction reference you paid it with (type CASH if paid in cash):`,
    '', 'Mark Refund as Paid', 'e.g. MoMo transaction ID'
  );
  if (!reference || !reference.trim()) return;   // cancelled or empty: a reference is required for the audit trail

  try {
    const updated = await apiRequest(`/admin/refunds/${refundId}/complete`, {
      method: 'PATCH',
      body: JSON.stringify({ paymentReference: reference.trim() }),
    });
    _applyRefundUpdate(r, updated, 'completed');
    if (!r.paymentReference) r.paymentReference = reference.trim();
    if (!r.completedAt) r.completedAt = new Date().toISOString();
  } catch (err) {
    _notifyRefundError('Could not mark as paid', err.message || 'Please try again.');
    return;
  }
  _refreshRefundViews();
  toast.success('Marked as paid', `₵${(r.amount||0).toFixed(2)} recorded as paid out.`);
}

// ── bulk actions ──────────────────────────────────────────────────

async function bulkApproveRefunds() {
  const ids = [...selectedIds.refunds].filter(id => refunds.find(r => r.id === id)?.status === 'pending');
  if (!ids.length) { toast.warning('None eligible', 'No pending refunds selected.'); return; }
  showBulkConfirm('Approve Refunds', `Approve ${ids.length} refund(s)?`, async () => {
    let ok = 0, failed = 0, lastError = '';
    for (const id of ids) {
      const r = refunds.find(x => x.id === id);
      try {
        const updated = await apiRequest(`/refunds/${id}/approve`, { method: 'PATCH' });
        _applyRefundUpdate(r, updated, 'approved');
        ok++;
      } catch (err) { failed++; lastError = err.message || ''; }
    }
    //await addLog('system', `Bulk approved ${ok} refund(s)`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, count: ok });
    selectedIds.refunds.clear();
    _refreshRefundViews();
    if (failed) _notifyRefundError('Some refunds were not approved', `${ok} approved, ${failed} failed. ${lastError}`);
    else        toast.success('Done', `${ok} refund(s) approved.`);
  });
}

async function bulkRejectRefunds() {
  const ids = [...selectedIds.refunds].filter(id => refunds.find(r => r.id === id)?.status === 'pending');
  if (!ids.length) { toast.warning('None eligible', 'No pending refunds selected.'); return; }
  const reason = await customPrompt('Rejection reason (will be applied to all selected refunds):', '', 'Bulk Reject Refunds', 'e.g. Policy violation...');
  if (!reason) return;
  let ok = 0, failed = 0, lastError = '';
  for (const id of ids) {
    const r = refunds.find(x => x.id === id);
    try {
      const updated = await apiRequest(`/refunds/${id}/reject`, { method: 'PATCH', body: JSON.stringify({ reason }) });
      _applyRefundUpdate(r, updated, 'rejected');
      if (r && !r.rejectionReason) r.rejectionReason = reason;
      ok++;
    } catch (err) { failed++; lastError = err.message || ''; }
  }
  await addLog('warning', `Bulk rejected ${ok} refund(s)`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, count: ok, failed, reason });
  selectedIds.refunds.clear();
  _refreshRefundViews();
  if (failed) _notifyRefundError('Some refunds were not rejected', `${ok} rejected, ${failed} failed. ${lastError}`);
  else        toast.warning('Done', `${ok} refund(s) rejected.`);
}

// Admin only: mark many approved refunds as paid with one shared reference
// (for example the batch ID of a MoMo bulk disbursement). Useful after an
// event cancellation creates hundreds of refunds at once.
async function bulkCompleteRefunds() {
  if (!_canPayRefunds()) { toast.warning('Admins only', 'Only admins can mark refunds as paid.'); return; }
  const ids = [...selectedIds.refunds].filter(id => refunds.find(r => r.id === id)?.status === 'approved');
  if (!ids.length) { toast.warning('None eligible', 'No approved refunds selected.'); return; }

  const total = ids.reduce((s, id) => s + (refunds.find(r => r.id === id)?.amount || 0), 0);
  const reference = await customPrompt(
    `Mark ${ids.length} refund(s) totalling ₵${total.toFixed(2)} as paid.\nEnter the batch or transaction reference:`,
    '', 'Mark Refunds as Paid', 'e.g. MoMo bulk batch ID'
  );
  if (!reference || !reference.trim()) return;

  let ok = 0, failed = 0, lastError = '';
  for (const id of ids) {
    const r = refunds.find(x => x.id === id);
    try {
      const updated = await apiRequest(`/admin/refunds/${id}/complete`, {
        method: 'PATCH',
        body: JSON.stringify({ paymentReference: reference.trim() }),
      });
      _applyRefundUpdate(r, updated, 'completed');
      if (r && !r.paymentReference) r.paymentReference = reference.trim();
      if (r && !r.completedAt) r.completedAt = new Date().toISOString();
      ok++;
    } catch (err) { failed++; lastError = err.message || ''; }
  }
  selectedIds.refunds.clear();
  _refreshRefundViews();
  if (failed) _notifyRefundError('Some refunds were not marked as paid', `${ok} done, ${failed} failed. ${lastError}`);
  else        toast.success('Done', `${ok} refund(s) marked as paid.`);
}