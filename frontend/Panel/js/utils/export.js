// ===============================================
// ADVANCED EXPORT MODAL
// ===============================================

const EXPORT_TYPE_LABELS = {
  users:'Users', events:'Events', revenue:'Revenue', tickets:'Tickets',
  payouts:'Payouts', refunds:'Refunds', logs:'Logs', waitlist:'Waitlist',
  'service-requests':'Service Requests', transactions:'Transactions',
};

function openExportModal(type, selectedOnly = false) {
  document.getElementById('export-data-type').value     = type;
  document.getElementById('export-selected-only').value = selectedOnly ? 'true' : 'false';
  document.getElementById('export-modal-label').textContent = EXPORT_TYPE_LABELS[type] || 'Data';
  const notice    = document.getElementById('export-selected-notice');
  const noticeMsg = document.getElementById('export-selected-msg');
  if (selectedOnly) {
    const count = selectedIds[type]?.size || 0;
    notice.style.display = 'block';
    if (noticeMsg) noticeMsg.textContent = `Exporting ${count} selected record(s) only.`;
  } else {
    notice.style.display = 'none';
  }
  const defRange  = document.querySelector('input[name="export-range"][value="24h"]');
  const defFormat = document.querySelector('input[name="export-format"][value="csv"]');
  if (defRange)  defRange.checked  = true;
  if (defFormat) defFormat.checked = true;
  document.getElementById('custom-date-range').style.display = 'none';
  const now = new Date(); const prev = new Date(now); prev.setDate(prev.getDate()-1);
  const dfrom = document.getElementById('export-date-from');
  const dto   = document.getElementById('export-date-to');
  if (dfrom) dfrom.value = prev.toISOString().slice(0,10);
  if (dto)   dto.value   = now.toISOString().slice(0,10);
  updateExportPreview();
  openModal('export-modal');
}

function updateExportPreview() {
  const type  = document.getElementById('export-data-type')?.value || '';
  const fmt   = document.querySelector('input[name="export-format"]:checked')?.value || 'csv';
  const range = document.querySelector('input[name="export-range"]:checked')?.value  || '24h';
  const label = EXPORT_TYPE_LABELS[type] || 'records';
  const rMap  = { '24h':'last 24 hours', '30d':'last 30 days', '90d':'last 90 days', 'custom':'the selected date range' };
  const selOnly = document.getElementById('export-selected-only')?.value === 'true';
  const scope   = selOnly ? `${selectedIds[type]?.size || 0} selected records` : `${label} from ${rMap[range] || 'all time'}`;
  const previewEl = document.getElementById('export-preview-text');
  if (previewEl) previewEl.textContent = `Exporting ${scope} as ${fmt.toUpperCase()}.`;
}

function _getExportSourceData(type) {
  const selectedOnly = document.getElementById('export-selected-only')?.value === 'true';
  const ids = selectedIds[type] || new Set();
  const sourceMap = {
    users: users, events: events, revenue: tickets, tickets: tickets,
    payouts: payouts, refunds: refunds, logs: logs,
    waitlist: waitlist, 'service-requests': serviceRequests, transactions: transactions,
  };
  let data = sourceMap[type] || [];
  if (selectedOnly && ids.size > 0) data = data.filter(item => ids.has(item.id));
  return data;
}

function _applyExportDateFilter(data, type) {
  const range = document.querySelector('input[name="export-range"]:checked')?.value || '24h';
  const now   = new Date();
  let from, to = now;
  if      (range === '24h')    { from = new Date(now); from.setHours(from.getHours()-24); }
  else if (range === '30d')    { from = new Date(now); from.setDate(from.getDate()-30); }
  else if (range === '90d')    { from = new Date(now); from.setDate(from.getDate()-90); }
  else if (range === 'custom') {
    const fv = document.getElementById('export-date-from')?.value;
    const tv = document.getElementById('export-date-to')?.value;
    from = fv ? new Date(fv) : new Date(0);
    to   = tv ? new Date(tv + 'T23:59:59') : now;
  } else { return data; }
  if (document.getElementById('export-selected-only')?.value === 'true') return data;
  const dateField = {
    users:'createdAt', events:'date', tickets:'purchasedAt', revenue:'purchasedAt',
    payouts:'requestedAt', refunds:'requestedAt', logs:'timestamp',
    waitlist:'joinedAt', 'service-requests':'submittedAt', transactions:'createdAt',
  }[type] || 'createdAt';
  return data.filter(item => {
    const d = new Date(item[dateField] || item.createdAt || item.timestamp);
    return !isNaN(d) && d >= from && d <= to;
  });
}

async function executeExport() {
  const type   = document.getElementById('export-data-type').value;
  const fmt    = document.querySelector('input[name="export-format"]:checked')?.value || 'csv';
  const label  = EXPORT_TYPE_LABELS[type] || type;
  if (type === 'logs') {
    try { const r = await apiRequest('/admin/logs?limit=10000'); logs = (r.logs || logs).filter(l => !_isExcludedLog(l.message)); } catch {}
  }
  const rawData  = _getExportSourceData(type);
  const filtered = _applyExportDateFilter(rawData, type);
  if (!filtered.length) { toast.warning('No data', `No ${label} records match the selected criteria.`); return; }
  const selOnly   = document.getElementById('export-selected-only')?.value === 'true';
  const rangeStr  = selOnly ? 'selected' : (document.querySelector('input[name="export-range"]:checked')?.value || 'all');
  const filename  = `glycr_${type.replace('-','_')}_${rangeStr}_${new Date().toISOString().slice(0,10)}`;
  if      (fmt === 'json') exportJson(filtered, `${filename}.json`);
  else if (fmt === 'pdf')  exportPdf(filtered, type, label, `${filename}.pdf`);
  else                     exportCsvForType(filtered, type, `${filename}.csv`);
  await addLog('system', `Exported ${filtered.length} ${label} record(s) as ${fmt.toUpperCase()}`, { adminName: currentAdmin.name, adminRole: currentAdmin.role, type, format: fmt, count: filtered.length, selectedOnly: selOnly });
  toast.success('Export started', `${filtered.length} ${label} record${filtered.length !== 1 ? 's' : ''} — ${fmt.toUpperCase()} downloading.`);
  closeModal('export-modal');
}

function exportCsvForType(data, type, filename) {
  let csv = '';
  if (type === 'users') {
    csv = 'ID,Name,Email,Phone,Role,Suspended,CreatedAt\n';
    data.forEach(u => { csv += `${u.id},"${u.name||''}","${u.email}","${u.phone||''}","${u.role}",${u.suspended||false},"${u.createdAt||''}"\n`; });
  } else if (type === 'events') {
    csv = 'ID,Title,Organizer Email,Date,Venue,Location,Category,Published,Cancelled,Flagged\n';
    data.forEach(e => {
      const org = users.find(u => u.id === (e.organizerId?.id||e.organizerId?._id?.toString()));
      csv += `${e.id},"${e.title}","${org?.email||'Unknown'}","${e.date}","${e.venue||''}","${e.location||''}","${e.category||''}",${e.isPublished},${e.isCancelled},${e.flagged||false}\n`;
    });
  } else if (type === 'revenue' || type === 'tickets') {
    csv = 'TicketID,Type,Price,Status,EventTitle,EventDate,BuyerName,BuyerEmail,BuyerPhone,PurchasedAt\n';
    data.forEach(t => {
      const ev   = resolveEventForTicket(t);
      const user = resolveUserForTicket(t);
      csv += `"${t.id}","${t.ticketType||''}",${t.price||0},"${getTicketStatus(t)}","${ev?.title||''}","${ev?.date||''}","${user?.name||''}","${t.userEmail||user?.email||''}","${t.userPhone||user?.phone||''}","${t.purchasedAt||''}"\n`;
    });
  } else if (type === 'payouts') {
    csv = 'ID,OrganizerEmail,PayoutEmail,Amount,Method,Status,RequestedAt,CompletedAt,RejectionReason\n';
    data.forEach(p => {
      const org = users.find(u => u.id === (p.organizerId?.id||p.organizerId?._id?.toString()));
      csv += `"${p.id}","${org?.email||''}","${p.email}",${p.amount},"${p.method}","${p.status}","${p.requestedAt}","${p.completedAt||''}","${(p.rejectionReason||'').replace(/"/g,"'")}"\n`;
    });
  } else if (type === 'logs') {
    csv = 'Timestamp,Type,Message,AdminName,AdminRole,Meta\n';
    data.forEach(l => {
      const meta = { ...l.meta };
      const adminName = meta.adminName || ''; delete meta.adminName;
      const adminRole = meta.adminRole || ''; delete meta.adminRole;
      csv += `"${l.timestamp}","${l.type}","${l.message}","${adminName}","${adminRole}","${JSON.stringify(meta).replace(/"/g,"'")}"\n`;
    });
  } else if (type === 'refunds') {
    csv = 'ID,CustomerName,CustomerEmail,Amount,Reason,Status,TicketID,EventTitle,RequestedAt,ResolvedAt,RejectionReason\n';
    data.forEach(r => {
      const ticketIdStr = _resolveRefundTicketIdString(r);
      const user   = users.find(u => u.id === (r.userId?.id||r.userId?._id?.toString()||r.userId));
      const ticket = _resolveRefundTicket(r);
      const ev     = ticket ? resolveEventForTicket(ticket) : null;
      csv += `"${r.id}","${r.userName||user?.name||''}","${r.userEmail||user?.email||''}",${r.amount||0},"${r.reason||''}","${r.status}","${ticketIdStr}","${ev?.title||r.eventTitle||''}","${r.requestedAt||''}","${r.resolvedAt||''}","${(r.rejectionReason||'').replace(/"/g,"'")}"\n`;
    });
  } else if (type === 'waitlist') {
    csv = 'ID,UserName,UserEmail,UserPhone,EventTitle,EventDate,Position,JoinedAt,Notified\n';
    data.forEach(w => { csv += `"${w.id}","${w.userName||''}","${w.userEmail||''}","${w.userPhone||''}","${w.eventTitle||''}","${w.eventDate||''}",${w.position||''},"${w.joinedAt||''}",${w.notified||false}\n`; });
  } else if (type === 'service-requests') {
    csv = 'RequestID,UserName,UserEmail,UserPhone,Category,Subject,Status,SubmittedAt,ResolvedAt,ResolutionNotes\n';
    data.forEach(r => {
      const emailStr = Array.isArray(r.userEmail) ? (r.userEmail[0] || '') : (r.userEmail || '');
      const refId    = r.requestId || r.id;
      csv += `"${refId}","${r.userName||''}","${emailStr}","${r.userPhone||''}","${r.category||''}","${(r.subject||'').replace(/"/g,"'")}","${r.status}","${r.submittedAt||''}","${r.resolvedAt||''}","${(r.resolutionNotes||'').replace(/"/g,"'")}"\n`;
    });
  } else if (type === 'transactions') {
    csv = 'ID,Type,Category,Amount,Status,Method,UserName,UserEmail,Reference,Description,EventTitle,CreatedAt\n';
    data.forEach(t => {
      csv += `"${t.id}","${t.type}","${t.category||''}",${t.amount||0},"${t.status}","${t.method||''}","${t.userName||''}","${t.userEmail||''}","${t.reference||''}","${(t.description||'').replace(/"/g,"'")}","${t.eventTitle||''}","${t.createdAt||''}"\n`;
    });
  }
  downloadBlob(csv, filename, 'text/csv');
}

function exportJson(data, filename) {
  downloadBlob(JSON.stringify(data, null, 2), filename, 'application/json');
}

function exportPdf(data, type, label, filename) {
  const rows = data.slice(0, 500);
  const keys = rows.length ? Object.keys(rows[0]).slice(0, 8) : [];
  const tableRows = rows.map(r =>
    `<tr>${keys.map(k => `<td style="padding:4px 8px;border:1px solid #ccc;font-size:10px;">${String(r[k]??'').substring(0,60)}</td>`).join('')}</tr>`
  ).join('');
  const html = `<!DOCTYPE html><html><head><title>${label} Report</title>
    <style>body{font-family:sans-serif;padding:20px;}h1{font-size:18px;}table{width:100%;border-collapse:collapse;}th{background:#1e293b;color:#fff;padding:6px 8px;font-size:11px;border:1px solid #ccc;}</style>
    </head><body>
    <h1>${label} Report — ${new Date().toLocaleString()}</h1>
    <p style="font-size:12px;color:#555;">${rows.length} records</p>
    <table><thead><tr>${keys.map(k=>`<th>${k}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table>
    </body></html>`;
  const win = window.open('', '_blank');
  if (win) { win.document.write(html); win.document.close(); win.focus(); setTimeout(() => win.print(), 500); }
  else toast.warning('Popup blocked', 'Please allow popups for PDF export.');
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}