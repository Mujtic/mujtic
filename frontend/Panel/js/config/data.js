// ===============================================
// DATA LOAD, STATISTICS, DASHBOARD
// ===============================================

// ── ticket helpers (shared by stats, reports and charts) ──────────
// A ticket only counts as a sale while it is not cancelled or refunded.
const VOIDED_TICKET_STATUSES = ['cancelled', 'refund_pending', 'refunded'];

function isSaleTicket(t) {
  return !VOIDED_TICKET_STATUSES.includes(t.status) && !t.refunded;
}
// one document = 1 ticket, except group tickets that hold several slots
function ticketQty(t) {
  return t.isGroupTicket ? (Number(t.totalSlots) || 1) : 1;
}
// face value of the ticket (what the organizer priced)
function ticketRevenue(t) {
  return (Number(t.price) || 0) * ticketQty(t);
}
function saleTickets() {
  return tickets.filter(isSaleTicket);
}

// ── fee helpers ──────────────────────────────────────────────────
// Two independent tracks live on each Ticket:
//   platformFee   → ORGANIZER-side, deducted from payouts
//   processingFee → BUYER-side, added at checkout
// For legacy tickets (pre-split) processingFee is null and the whole fee
// lives in platformFee, paid by whoever feePaidBy recorded.

// ORGANIZER-side fee for one ticket, as recorded at purchase time.
// Falls back to today's configured percentage (with the configured floor,
// capped at the ticket value) for very old tickets with no stored fee.
function ticketPlatformFee(t) {
  if (t.platformFee !== null && t.platformFee !== undefined) {
    return Number(t.platformFee) || 0;
  }
  const gross  = ticketRevenue(t);
  const pctFee = gross * (Number(platformFeePercent) || 0) / 100;
  const floor  = Number(platformFeeFloor) || 0;
  return Math.min(gross, Math.max(pctFee, floor));
}

// BUYER-side processing fee. Zero for legacy tickets whose single fee is
// already counted in platformFee above.
function ticketProcessingFee(t) {
  if (t.processingFee !== null && t.processingFee !== undefined) {
    return Number(t.processingFee) || 0;
  }
  return 0;
}

// TOTAL platform take for one ticket — both fee tracks together.
// This is what the platform actually received from that ticket.
function ticketTotalFee(t) {
  return ticketPlatformFee(t) + ticketProcessingFee(t);
}

// Platform income = total fees on tickets that are still sales.
// Refunds return the full amountPaid (incl. processing fee), so nothing
// is retained on a refunded ticket.
function platformIncomeOf(t) {
  return isSaleTicket(t) ? ticketTotalFee(t) : 0;
}

// ── load ──────────────────────────────────────────────────────────
async function loadData() {
  const normalize = arr => (Array.isArray(arr) ? arr : [])
    .map(r => ({ ...r, id: r.id || r._id?.toString() || r._id }));

  const sources = [
    { name: 'users',            path: '/admin/users',            set: v => { users = normalize(v); } },
    { name: 'events',           path: '/admin/events',           set: v => { events = normalize(v); } },
    { name: 'tickets',          path: '/admin/tickets',          set: v => { tickets = normalize(v); } },
    { name: 'payouts',          path: '/admin/payouts',          set: v => { payouts = normalize(v); } },
    { name: 'refunds',          path: '/admin/refunds/all',      set: v => { refunds = normalize(v); } },
    { name: 'waitlist',         path: '/admin/waitlists',        set: v => { waitlist = normalize(v); } },
    { name: 'service requests', path: '/admin/service-requests', set: v => { serviceRequests = normalize(v); } },
  ];
  const failed = [];

  const fetched = await Promise.allSettled(sources.map(s => apiRequest(s.path)));
  fetched.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      sources[i].set(res.value);
    } else {
      failed.push(sources[i].name);
      console.error(`Failed to load ${sources[i].name}`, res.reason);
    }
  });

  const extras = [
    { name: 'messages',     run: loadMessages },
    { name: 'transactions', run: loadTransactions },
    { name: 'logs',         run: loadLogs },
    { name: 'chat',         run: loadChat },
  ];
  const extraResults = await Promise.allSettled(extras.map(x => x.run()));
  extraResults.forEach((res, i) => {
    if (res.status === 'rejected') {
      failed.push(extras[i].name);
      console.error(`Failed to load ${extras[i].name}`, res.reason);
    }
  });

  [
    calculateStats, renderDashboard, renderUsers, renderEvents, renderTickets,
    renderPayouts, renderRefunds, renderWaitlist, renderServiceRequests,
    renderReports, populateWaitlistEventFilter, updateBroadcastAudiencePreview,
    renderChatList,
  ].forEach(fn => {
    try { fn(); } catch (err) { console.error(`${fn.name} failed`, err); }
  });

  if (failed.length) {
    toast.error('Some data could not be loaded', `${failed.join(', ')}. The rest of the panel still works.`);
  }
}

// ── statistics ────────────────────────────────────────────────────
function calculateStats() {
  const sales = saleTickets();
  const amountOf = (list, ...statuses) => list
    .filter(x => statuses.includes(x.status))
    .reduce((s, x) => s + (Number(x.amount) || 0), 0);

  const totalRevenue = sales.reduce((s, t) => s + ticketRevenue(t), 0);

  // Fee split — computed once here so dashboard and reports agree.
  const organizerFeeTotal = sales.reduce((s, t) => s + ticketPlatformFee(t), 0);
  const buyerFeeTotal     = sales.reduce((s, t) => s + ticketProcessingFee(t), 0);
  const totalFeeCollected = organizerFeeTotal + buyerFeeTotal;

  stats = {
    totalUsers:       users.length,
    totalOrganizers:  users.filter(u => u.role === 'organizer').length,
    totalEvents:      events.length,
    liveEvents:       events.filter(e => e.isPublished && !e.isCancelled && new Date(e.date) > new Date()).length,

    // sales (face value)
    totalRevenue,
    totalTickets:     sales.reduce((s, t) => s + ticketQty(t), 0),

    // fee totals — the dashboard shows `platformFeeAmount` (the total);
    // reports uses the two components + the effective rate
    organizerFeeTotal,
    buyerFeeTotal,
    platformFeeAmount: totalFeeCollected,
    effectiveFeeRate:  totalRevenue > 0 ? (totalFeeCollected / totalRevenue) * 100 : 0,
    platformFeeRate:   Number(platformFeePercent) || 0,
    platformFeeFloor:  Number(platformFeeFloor) || 0,

    // payouts
    pendingPayouts:   amountOf(payouts, 'pending', 'approved'),
    approvedPayouts:  amountOf(payouts, 'approved'),
    paidPayouts:      amountOf(payouts, 'completed'),

    // refunds
    pendingRefunds:       amountOf(refunds, 'pending'),
    awaitingRefundPayout: amountOf(refunds, 'approved'),
    paidRefunds:          amountOf(refunds, 'completed'),
    totalRefunded:        amountOf(refunds, 'approved', 'completed'),

    flaggedEvents:    events.filter(e => e.flagged).length,
    waitlistCount:    waitlist.length,
    openServiceRequests: serviceRequests.filter(r => r.status !== 'resolved').length,
  };
}

// ── dashboard ─────────────────────────────────────────────────────
function renderDashboard() {
  setText('stat-users',         stats.totalUsers);
  setText('stat-live-events',   stats.liveEvents);
  setText('stat-revenue',       `₵${stats.totalRevenue.toFixed(2)}`);
  setText('stat-tickets',       stats.totalTickets);
  setText('stat-organizers',    stats.totalOrganizers);
  setText('stat-total-events',  stats.totalEvents);
  setText('stat-avg-revenue',   `₵${stats.totalEvents > 0 ? (stats.totalRevenue / stats.totalEvents).toFixed(2) : '0.00'}`);
  setText('quick-users-count',      stats.totalUsers);
  setText('quick-pending-payouts',  `₵${stats.pendingPayouts.toFixed(2)}`);
  setText('quick-pending-refunds',  `₵${stats.pendingRefunds.toFixed(2)}`);
  setText('quick-flagged-events',   stats.flaggedEvents);
  setText('quick-log-count',        typeof logs !== 'undefined' ? logs.length : 0);
  setText('quick-waitlist-count',   stats.waitlistCount);
  setText('quick-sr-count',         stats.openServiceRequests);
  setText('open-sr-count',          stats.openServiceRequests);

  // Platform Fee row — headline is the TOTAL collected (organizer + buyer).
  // The suffix shows the CONFIGURED rate in force (3% + ₵5 floor), not the
  // effective collection rate — that lives on Reports and in the tooltip,
  // so it can't be misread as "amount = face × rate."
  const feeEl = document.getElementById('stat-platform-fee');
  if (feeEl) {
    const pct   = Number(stats.platformFeeRate);
    const floor = Number(stats.platformFeeFloor) || 0;
    const rateTx = Number.isFinite(pct)
      ? (floor > 0 ? `${pct}% + ₵${floor} floor` : `${pct}%`)
      : '';

    feeEl.textContent = rateTx
      ? `₵${stats.platformFeeAmount.toFixed(2)} · ${rateTx}`
      : `₵${stats.platformFeeAmount.toFixed(2)}`;

    feeEl.title =
      `Organizer-side: ₵${stats.organizerFeeTotal.toFixed(2)}\n` +
      `Buyer-side:     ₵${stats.buyerFeeTotal.toFixed(2)}\n` +
      `Effective:      ${stats.effectiveFeeRate.toFixed(2)}% of face value\n` +
      `Configured:     ${Number.isFinite(pct) ? pct + '%' : '—'}` +
      (floor > 0 ? ` + ₵${floor} floor` : '');
  }

  const txnCount = document.getElementById('quick-transactions-count');
  if (txnCount) txnCount.textContent = typeof transactions !== 'undefined' ? transactions.length : 0;
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
