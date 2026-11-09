// services/analyticsService.js
const Ticket = require('../models/Ticket');
const Event = require('../models/Event');
const Payout = require('../models/Payout');
const { AppError } = require('../utils/appError');
const settingsService = require('./settingsService');
const revenueService = require('./revenueService');
const payoutService = require('./payoutService');

const MAX_DAYS = 90;
const TZ = 'Africa/Accra';   // day boundaries for the sales trend (UTC+0, no daylight saving)

// Same rules as the summary: only active or used tickets are sales,
// group tickets count all their slots.
const { SALE_STATUSES, QTY, REVENUE } = revenueService;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

class AnalyticsService {
  async getSalesTrend(organizerId, days = 7) {
    // --- Input validation (AppError → maps to 4xx in errorHandler) ---
    if (!organizerId) throw new AppError('organizerId is required', 400);

    const parsed = Number(days);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DAYS) {
      throw new AppError(`days must be an integer between 1 and ${MAX_DAYS}`, 400);
    }

    // --- Fetch events (only ids) ---
    const events = await Event.find({ organizerId }).select('_id').lean();
    const eventIds = events.map((e) => e._id);

    // --- One aggregation instead of loading every ticket into memory ---
    const DAY_MS = 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - (parsed + 1) * DAY_MS);   // a day of margin; days are matched by key below

    const rows = await Ticket.aggregate([
      { $match: {
          eventId: { $in: eventIds },
          purchasedAt: { $ne: null, $gte: since },
          status: { $in: SALE_STATUSES },
        } },
      { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$purchasedAt', timezone: TZ } },
          tickets: { $sum: QTY },
          // Face value of sales — the organizer's earning side. Buyer-paid
          // processing fees live on amountPaid and are intentionally NOT
          // included here: the chart shows the organizer's revenue, not the
          // buyer's spend.
          revenue: { $sum: REVENUE },
        } },
    ]);
    const byDay = new Map(rows.map((r) => [r._id, r]));

    // --- Build day-by-day trend (oldest → today) ---
    const labels = [];
    const ticketsData = [];
    const revenueData = [];

    for (let i = parsed - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY_MS);
      const key = d.toLocaleDateString('en-CA', { timeZone: TZ });   // YYYY-MM-DD
      labels.push(d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: TZ }));

      const row = byDay.get(key);
      ticketsData.push(row ? row.tickets : 0);
      revenueData.push(row ? r2(row.revenue) : 0);
    }

    return { labels, tickets: ticketsData, revenue: revenueData };
  }

  async getOrganizerSummary(organizerId) {
    if (!organizerId) throw new AppError('organizerId is required', 400);

    const settings = await settingsService.getSettings();

    const [breakdown, payoutRows, availableForPayout] = await Promise.all([
      revenueService.getOrganizerBreakdown(organizerId),
      // approved = reserved but not sent yet, so it is still money owed to the organizer
      Payout.find({ organizerId, status: { $in: ['pending', 'approved', 'completed'] } })
        .select('status amount')
        .lean(),
      // single source of truth: exactly what the payout form allows them to request
      payoutService.getAvailableBalance(organizerId),
    ]);

    const paid = (status) =>
      payoutRows
        .filter((p) => p.status === status)
        .reduce((sum, p) => sum + (p.amount || 0), 0);

    return {
      // ── Organizer-side fee ─────────────────────────────────────
      // The part the organizer actually bears. Deducted from their payouts.
      // Matches `organizerFees` below.
      feePercent: settings.platformFee,
      feeFloor:   settings.platformFeeFloor,

      // ── Buyer-side fee ─────────────────────────────────────────
      // Shown for transparency (e.g. "buyers pay an extra 2% at checkout").
      // Never deducted from the organizer.
      processingFeePercent: settings.processingFee,
      processingFeeFloor:   settings.processingFeeFloor,

      // ── Volume ─────────────────────────────────────────────────
      totalEvents: breakdown.totalEvents,
      ticketsSold: breakdown.ticketsSold,
      grossRevenue: breakdown.gross,            // face value of sales

      // ── Fees ───────────────────────────────────────────────────
      // `platformFees` is the TOTAL platform take on this organizer's sales
      // (organizer-side + buyer-side). Kept under this name for existing
      // dashboard frontends. Use `organizerFees` / `buyerFees` when the UI
      // needs to split it.
      platformFees:  breakdown.fees,
      organizerFees: breakdown.organizerFees,   // deducted from this organizer
      buyerFees:     breakdown.buyerFees,       // added on top, at checkout

      // ── Net ────────────────────────────────────────────────────
      netRevenue: breakdown.net,                // gross − organizerFees

      // ── Payouts ────────────────────────────────────────────────
      completedPayouts: r2(paid('completed')),
      pendingPayouts:   r2(paid('pending') + paid('approved')),
      approvedPayouts:  r2(paid('approved')),
      availableForPayout,

      // ── Detail ─────────────────────────────────────────────────
      perEvent: breakdown.perEvent,
      byType:   breakdown.byType,
    };
  }
}

module.exports = new AnalyticsService();
