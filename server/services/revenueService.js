// services/revenueService.js
//
// The single source of truth for "how much did this organizer earn?".
// Payouts, the organizer dashboard and the reports all read from here, so
// they can never disagree.
//
// Money model, per ticket (recorded when the ticket is bought):
//   price         → face price the organizer set (after discounts)
//   platformFee   → ORGANIZER-paid fee, deducted from payout
//   processingFee → BUYER-paid fee, added on top of what the buyer paid
//   amountPaid    → price + processingFee (what the buyer actually spent)
//
// Legacy tickets (bought before the split) have processingFee = null and a
// single platformFee whose payer is recorded in feePaidBy:
//   feePaidBy === 'organizer' → organizer pays platformFee, buyer pays 0
//   feePaidBy === 'buyer'     → buyer pays platformFee, organizer pays 0
//
// organizer net = Σ price − Σ organizer-paid fees
// Total platform revenue = Σ organizer-paid fees + Σ buyer-paid fees
//
// Fees are read from the ticket, never recomputed from today's settings,
// except for very old tickets with no stored platformFee — for those only
// the current percentage is used (run scripts/backfillPlatformFee.js once).
const Ticket = require('../models/Ticket');
const Event = require('../models/Event');
const settingsService = require('./settingsService');
const { AppError } = require('../utils/appError');

// A ticket counts as a sale while it is active or used. Cancelled, refund
// pending and refunded tickets are not revenue.
const SALE_STATUSES = ['active', 'used'];

// One ticket document = 1 ticket, except group tickets, which hold `totalSlots` tickets.
const QTY = { $cond: [{ $eq: ['$isGroupTicket', true] }, '$totalSlots', 1] };
const REVENUE = { $multiply: [{ $ifNull: ['$price', 0] }, QTY] };

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

class RevenueService {
  async getOrganizerBreakdown(organizerId) {
    if (!organizerId) throw new AppError('organizerId is required', 400);

    const events = await Event.find({ organizerId }).select('_id').lean();
    const eventIds = events.map((e) => e._id);

    const settings = await settingsService.getSettings();
    const legacyRate = (Number(settings.platformFee) || 0) / 100;

    // Legacy ticket: no processingFee stored. New ticket: processingFee is a
    // number (possibly 0).
    const IS_LEGACY = { $eq: [{ $ifNull: ['$processingFee', null] }, null] };

    // Fee stored at purchase; very old tickets with no stored platformFee
    // fall back to the current percentage. Same fallback as before the split.
    const LEGACY_FEE = { $ifNull: ['$platformFee', { $multiply: [REVENUE, legacyRate] }] };

    // The portion of each ticket's fees the ORGANIZER bears.
    //   new ticket             → platformFee (organizer-side)
    //   legacy 'organizer'     → platformFee
    //   legacy 'buyer'         → 0
    const ORGANIZER_FEE = {
      $cond: [
        { $and: [IS_LEGACY, { $eq: ['$feePaidBy', 'buyer'] }] },
        0,
        LEGACY_FEE,
      ],
    };

    // The portion of each ticket's fees the BUYER bears.
    //   new ticket             → processingFee
    //   legacy 'buyer'         → platformFee
    //   legacy 'organizer'     → 0
    const BUYER_FEE = {
      $cond: [
        IS_LEGACY,
        { $cond: [{ $eq: ['$feePaidBy', 'buyer'] }, LEGACY_FEE, 0] },
        { $ifNull: ['$processingFee', 0] },
      ],
    };

    const rows = await Ticket.aggregate([
      { $match: { eventId: { $in: eventIds }, status: { $in: SALE_STATUSES } } },
      { $group: {
          _id: { eventId: '$eventId', type: '$ticketType' },
          sold:          { $sum: QTY },
          gross:         { $sum: REVENUE },
          organizerFees: { $sum: ORGANIZER_FEE },
          buyerFees:     { $sum: BUYER_FEE },
        } },
    ]);

    const perEvent = {};
    const byType = {};
    let ticketsSold = 0;
    let gross = 0;
    let organizerFees = 0;
    let buyerFees = 0;

    for (const row of rows) {
      const id = String(row._id.eventId);
      const pe = (perEvent[id] ||= {
        sold: 0, revenue: 0,
        organizerFees: 0, buyerFees: 0, fees: 0, net: 0,
      });
      pe.sold += row.sold;
      pe.revenue += row.gross;
      pe.organizerFees += row.organizerFees;
      pe.buyerFees += row.buyerFees;

      byType[row._id.type] = (byType[row._id.type] || 0) + row.sold;
      ticketsSold += row.sold;
      gross += row.gross;
      organizerFees += row.organizerFees;
      buyerFees += row.buyerFees;
    }
    for (const pe of Object.values(perEvent)) {
      pe.revenue = r2(pe.revenue);
      pe.organizerFees = r2(pe.organizerFees);
      pe.buyerFees = r2(pe.buyerFees);
      pe.fees = r2(pe.organizerFees + pe.buyerFees);
      pe.net = r2(pe.revenue - pe.organizerFees);
    }

    return {
      totalEvents: events.length,
      ticketsSold,
      gross: r2(gross),                                       // face value of everything sold
      fees: r2(organizerFees + buyerFees),                    // total platform take
      organizerFees: r2(organizerFees),                       // the part deducted from the organizer
      buyerFees: r2(buyerFees),                               // the part the buyers paid on top
      net: r2(gross - organizerFees),                         // what the organizer has earned
      perEvent,
      byType,
    };
  }
}

const service = new RevenueService();
Object.assign(service, { SALE_STATUSES, QTY, REVENUE });
module.exports = service;
