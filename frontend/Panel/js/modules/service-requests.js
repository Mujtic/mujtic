// ===============================================
// SERVICE REQUESTS
// ===============================================

const SR_CATEGORY_ICONS = {
  ticket_issue:      'fa-solid fa-ticket',
  payment_problem:   'fa-solid fa-credit-card',
  refund_request:    'fa-solid fa-rotate-left',
  organizer_support: 'fa-solid fa-user-tie',
  account_issue:     'fa-solid fa-user-lock',
  bug_report:        'fa-solid fa-bug',
  other:             'fa-solid fa-circle-question',
};

function _srStatusBadge(status) {
  const map = {
    pending:     ['badge-sr-pending',     'fa-clock',        'Pending'],
    in_progress: ['badge-sr-in_progress', 'fa-spinner',      'In Progress'],
    resolved:    ['badge-sr-resolved',    'fa-circle-check', 'Resolved'],
  };
  return map[status] || map.pending;
}

function renderServiceRequests() {
  const tb = document.getElementById('sr-table');
  if (!tb) return;
  const sorted = applySorting(getFilteredServiceRequests(), 'service-requests');
  const { rows, page, totalPages, total, pp } = paginate(sorted, 'service-requests');
  const openCount = serviceRequests.filter(r => r.status !== 'resolved').length;
  setText('open-sr-count', openCount);
  setText('quick-sr-count', openCount);
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="8" class="empty-state"><i class="fa-solid fa-headset" style="font-size:1.5rem;display:block;margin-bottom:0.5rem;"></i>No service requests found</td></tr>';
    renderPaginationBar('sr-pagination', 'service-requests', 0, 1, 1, pp);
    return;
  }
  tb.innerHTML = rows.map(r => {
    const [sBadge, sIcon, sLabel] = _srStatusBadge(r.status);
    const shortId   = r.requestId || String(r.id).substring(0, 8).toUpperCase();
    const subDate   = new Date(r.submittedAt).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
    const subTime   = new Date(r.submittedAt).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
    const catIcon   = SR_CATEGORY_ICONS[r.category] || SR_CATEGORY_ICONS.other;
    const isResolved = r.status === 'resolved';
    const sel       = selectedIds['service-requests'].has(r.id);
    const emailDisplay = Array.isArray(r.userEmail) ? (r.userEmail[0] || '—') : (r.userEmail || '—');
    return `
      <tr class="${sel ? 'row-selected' : ''} ${isResolved ? 'sr-row-resolved' : ''}">
        <td><input type="checkbox" class="row-checkbox" data-id="${r.id}" ${sel ? 'checked' : ''} onchange="toggleRowSelect('service-requests','${r.id}',this)"></td>
        <td>
          <div class="sr-table-id"><i class="fa-solid fa-fingerprint" style="margin-right:0.3rem;color:#475569;"></i>#${shortId}</div>
          <div style="font-size:0.7rem;color:#475569;margin-top:0.2rem;">${subDate}</div>
        </td>
        <td>
          <div class="sr-table-user">${r.userName || '—'}</div>
          <div class="sr-table-sub"><i class="fa-regular fa-envelope"></i> ${emailDisplay}</div>
          ${r.userPhone ? `<div class="sr-table-sub"><i class="fa-solid fa-phone"></i> <a href="tel:${r.userPhone}" style="color:#22d3ee;text-decoration:none;">${r.userPhone}</a></div>` : ''}
        </td>
        <td>
          <div class="sr-table-subject" title="${r.subject || ''}">${r.subject ? r.subject.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase()) : '—'}</div>
          <div class="sr-table-preview">${(r.message || '').substring(0,60)}${(r.message||'').length > 60 ? '…' : ''}</div>
        </td>
        <td>
          <span class="sr-category-pill ${r.category || 'other'}">
            <i class="${catIcon}"></i> ${(r.category||'other').charAt(0).toUpperCase()+(r.category||'other').slice(1)}
          </span>
        </td>
        <td>
          <div style="font-size:0.875rem;">${subDate}</div>
          <div style="font-size:0.72rem;color:#475569;">${subTime}</div>
        </td>
        <td>
          <span class="badge ${sBadge}"><i class="fa-solid ${sIcon}"></i> ${sLabel}</span>
          ${isResolved && r.resolvedAt ? `<div style="font-size:0.7rem;color:#34d399;margin-top:0.3rem;"><i class="fa-regular fa-calendar-check"></i> ${new Date(r.resolvedAt).toLocaleDateString()}</div>` : ''}
        </td>
        <td><div class="actions">
          <button class="btn-icon" style="background:#6366f1;" onclick="viewServiceRequest('${r.id}')" title="View"><i class="fa-solid fa-eye"></i></button>
          ${r.status === 'pending' ? `<button class="btn-icon" style="background:#0891b2;" onclick="markServiceRequestInProgress('${r.id}')" title="Mark In Progress"><i class="fa-solid fa-spinner"></i></button>` : ''}
          ${!isResolved ? `<button class="btn-icon" style="background:#10b981;" onclick="openResolveServiceRequestModal('${r.id}')" title="Mark Resolved"><i class="fa-solid fa-circle-check"></i></button>` : ''}
        </div></td>
      </tr>`;
  }).join('');
  renderPaginationBar('sr-pagination', 'service-requests', total, page, totalPages, pp);
}

function getFilteredServiceRequests() {
  const search   = (document.getElementById('sr-search')?.value || '').toLowerCase();
  const status   = document.getElementById('sr-status-filter')?.value   || 'all';
  const category = document.getElementById('sr-category-filter')?.value || 'all';
  const dfrom    = document.getElementById('sr-date-from')?.value;
  const dto      = document.getElementById('sr-date-to')?.value;
  return [...serviceRequests].sort((a,b) => new Date(b.submittedAt) - new Date(a.submittedAt)).filter(r => {
    const emailStr = Array.isArray(r.userEmail) ? r.userEmail.join(' ') : (r.userEmail || '');
    const phoneStr = r.userPhone || '';
    const mSearch = !search
      || String(r.id).toLowerCase().includes(search)
      || (r.requestId||'').toLowerCase().includes(search)
      || (r.userName||'').toLowerCase().includes(search)
      || emailStr.toLowerCase().includes(search)
      || phoneStr.toLowerCase().includes(search)
      || (r.subject||'').toLowerCase().includes(search)
      || (r.message||'').toLowerCase().includes(search);
    return mSearch && (status === 'all' || r.status === status) && (category === 'all' || r.category === category) && applyDateRangeFilter(r.submittedAt, dfrom, dto);
  });
}

function viewServiceRequest(srId) {
  const r = serviceRequests.find(x => x.id === srId);
  if (!r) return;
  const [sBadge, sIcon, sLabel] = _srStatusBadge(r.status);
  const emailDisplay = Array.isArray(r.userEmail) ? (r.userEmail[0] || '—') : (r.userEmail || '—');
  const catIcon = SR_CATEGORY_ICONS[r.category] || SR_CATEGORY_ICONS.other;
  document.getElementById('sr-modal-body').innerHTML = `
    <div class="detail-grid">
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-fingerprint"></i> Request ID</div><div class="detail-value" style="font-family:monospace;font-size:0.85rem;">${r.requestId || r.id}</div></div>
      <div class="detail-item"><div class="detail-label"><i class="fa-solid fa-circle-dot"></i> Status</div><div class="detail-value"><span class="badge ${sBadge}"><i class="fa-solid ${sIcon}"></i> ${sLabel}</span></div></div>
      <div class="detail-item"><div class="detail-label"><i class="${catIcon}"></i> Category</div><div class="detail-value"><span class="sr-category-pill ${r.category||'other'}">${(r.category||'other').charAt(0).toUpperCase()+(r.category||'other').slice(1)}</span></div></div>
      <div class="detail-item"><div class="detail-label"><i class="fa-regular fa-calendar"></i> Submitted</div><div class="detail-value">${new Date(r.submittedAt).toLocaleString()}</div></div>
      ${r.resolvedAt ? `<div class="detail-item"><div class="detail-label"><i class="fa-solid fa-calendar-check"></i> Resolved</div><div class="detail-value">${new Date(r.resolvedAt).toLocaleString()}</div></div>` : '<div></div>'}
    </div>
    <div style="padding:1rem;background:#0f172a;border-radius:0.5rem;margin-bottom:1rem;">
      <h4 style="font-weight:700;margin-bottom:0.75rem;"><i class="fa-regular fa-user" style="color:#06b6d4;margin-right:0.4rem;"></i>Customer</h4>
      <div style="font-size:0.875rem;line-height:1.8;color:#94a3b8;">
        <div><i class="fa-regular fa-user" style="margin-right:0.3rem;"></i>${r.userName || '—'}</div>
        <div><i class="fa-regular fa-envelope" style="margin-right:0.3rem;"></i>${emailDisplay}</div>
        ${r.userPhone
    ? `<div><i class="fa-solid fa-phone" style="margin-right:0.3rem;"></i><a href="tel:${r.userPhone}" style="color:#22d3ee;text-decoration:none;">${r.userPhone}</a></div>`
    : '<div style="color:#475569;"><i class="fa-solid fa-phone" style="margin-right:0.3rem;"></i>No phone on file</div>'}
      </div>
    </div>
    <div style="margin-bottom:1rem;">
      <h4 style="font-weight:700;margin-bottom:0.5rem;"><i class="fa-solid fa-message" style="color:#06b6d4;margin-right:0.4rem;"></i>Subject</h4>
      <div style="font-size:0.95rem;font-weight:600;color:#f1f5f9;">${r.subject ? r.subject.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase()) : '—'}</div>
    </div>
    <div style="margin-bottom:1rem;">
      <h4 style="font-weight:700;margin-bottom:0.5rem;"><i class="fa-regular fa-comment" style="color:#06b6d4;margin-right:0.4rem;"></i>Message</h4>
      <div class="sr-message-box">${r.message || '—'}</div>
    </div>
    ${r.resolutionNotes ? `
    <div style="margin-bottom:1rem;">
      <h4 style="font-weight:700;margin-bottom:0.5rem;"><i class="fa-solid fa-circle-check" style="color:#34d399;margin-right:0.4rem;"></i>Resolution Notes</h4>
      <div class="sr-resolution-box">${r.resolutionNotes}</div>
    </div>` : ''}
    ${r.status !== 'resolved' ? `
    <div style="display:flex;gap:0.75rem;margin-top:1.5rem;">
      ${r.status === 'pending' ? `<button class="btn" style="flex:1;background:#0891b2;color:white;" onclick="markServiceRequestInProgress('${r.id}');closeModal('sr-modal');"><i class="fa-solid fa-spinner"></i> Mark In Progress</button>` : ''}
      <button class="btn" style="flex:1;background:#10b981;color:white;" onclick="openResolveServiceRequestModal('${r.id}');closeModal('sr-modal');"><i class="fa-solid fa-circle-check"></i> Mark as Resolved</button>
    </div>` : ''}`;
  // addLog('system', `Viewed service request: ${r.subject}`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, srId });
  openModal('sr-modal');
}

function openResolveServiceRequestModal(srId) {
  const r = serviceRequests.find(x => x.id === srId);
  if (!r) return;
  document.getElementById('resolve-sr-id').value = srId;
  document.getElementById('resolve-sr-info').innerHTML =
    `<strong>${r.userName || '—'}</strong><br>
     <span style="color:#94a3b8;font-size:0.78rem;">${r.subject || '—'}</span>`;
  document.getElementById('sr-resolution-notes').value = '';
  openModal('sr-resolve-modal');
}

async function markServiceRequestInProgress(srId) {
  const r = serviceRequests.find(x => x.id === srId);
  if (!r) return;
  try { await apiRequest(`/admin/service-requests/${srId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'in_progress' }) }); }
  catch { r.status = 'in_progress'; }
//  await addLog('system', `Service request marked in progress: ${r?.subject}`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, srId, userName: r?.userName });
  calculateStats(); renderDashboard(); renderServiceRequests();
  toast.info('Marked in progress', 'The request has been updated.');
}

async function submitResolveServiceRequest() {
  const srId  = document.getElementById('resolve-sr-id').value;
  const notes = document.getElementById('sr-resolution-notes').value.trim();
  if (!notes) { toast.warning('Notes required', 'Please describe how this request was resolved.'); return; }
  const r = serviceRequests.find(x => x.id === srId);
  try { await apiRequest(`/admin/service-requests/${srId}/resolve`, { method: 'PATCH', body: JSON.stringify({ resolutionNotes: notes }) }); }
  catch { if (r) { r.status = 'resolved'; r.resolvedAt = new Date().toISOString(); r.resolutionNotes = notes; } }
  //await addLog('system', `Service request resolved: ${r?.subject}`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, srId, userName: r?.userName });
  closeModal('sr-resolve-modal');
  calculateStats(); renderDashboard(); renderServiceRequests();
  toast.success('Request resolved', 'The customer will be notified of the resolution.');
}

async function bulkResolveServiceRequests() {
  const ids = [...selectedIds['service-requests']].filter(id => serviceRequests.find(r => r.id === id)?.status !== 'resolved');
  if (!ids.length) { toast.warning('None eligible', 'No unresolved requests selected.'); return; }
  const notes = await customPrompt('Resolution notes (will be applied to all selected requests):', '', 'Bulk Resolve Requests', 'Describe the resolution...');
  if (!notes) return;
  showBulkConfirm('Resolve Requests', `Mark ${ids.length} service request(s) as resolved?`, async () => {
    let ok = 0;
    for (const id of ids) {
      try { await apiRequest(`/admin/service-requests/${id}/resolve`, { method: 'PATCH', body: JSON.stringify({ resolutionNotes: notes }) }); }
      catch { const r = serviceRequests.find(x => x.id === id); if (r) { r.status = 'resolved'; r.resolvedAt = new Date().toISOString(); r.resolutionNotes = notes; } }
      ok++;
    }
    //await addLog('system', `Bulk resolved ${ok} service request(s)`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, count: ok });
    selectedIds['service-requests'].clear();
    calculateStats(); renderDashboard(); renderServiceRequests();
    toast.success('Done', `${ok} service request(s) resolved.`);
  });
}
