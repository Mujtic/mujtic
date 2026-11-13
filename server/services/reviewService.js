const Review = require('../models/Review');
const Event = require('../models/Event');
const Ticket = require('../models/Ticket');
const { AppError } = require('../utils/appError');
const { isObjectIdString } = require('../utils/validators');



class ReviewService {
  async createReview(userId, { eventId, rating, text } = {}) {
    if (!userId) throw new AppError('Authentication required', 401);
    if (!isObjectIdString(eventId)) {
      throw new AppError('Invalid event', 400);
    }

    const stars = Number(rating);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      throw new AppError('rating must be a whole number between 1 and 5', 400);
    }
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) throw new AppError('Review text is required', 400);
    if (body.length > 1000) throw new AppError('Review must be 1000 characters or fewer', 400);

    const event = await Event.findById(eventId).select('date isCancelled').lean();
    if (!event) throw new AppError('Event not found', 404);
    if (event.isCancelled) throw new AppError('Cancelled events cannot be reviewed', 400);
    if (new Date(event.date) > new Date()) {
      throw new AppError('You can review an event after it has taken place', 400);
    }

    // only people who hold a (non-refunded) ticket can review
    const hasTicket = await Ticket.exists({ eventId, userId, refunded: { $ne: true } });
    if (!hasTicket) throw new AppError('Only ticket holders can review this event', 403);

    let review;
    try {
      review = await Review.create({ userId, eventId, rating: stars, text: body });
    } catch (err) {
      if (err.code === 11000) throw new AppError('You have already reviewed this event', 409);
      throw err;
    }

    await Ticket.updateMany({ eventId, userId }, { $set: { reviewed: true } });
    return review;
  }

  async getMyReviews(userId) {
    if (!userId) throw new AppError('Authentication required', 401);

    const reviews = await Review.find({ userId }).sort({ createdAt: -1 }).lean();
    const events = await Event.find({ _id: { $in: reviews.map((r) => r.eventId) } })
      .select('title')
      .lean();
    const titles = new Map(events.map((e) => [String(e._id), e.title]));

    // plain shape the frontend expects (eventId as a string, title included)
    return reviews.map((r) => ({
      _id: r._id,
      eventId: String(r.eventId),
      eventTitle: titles.get(String(r.eventId)) || 'Event',
      rating: r.rating,
      text: r.text,
      createdAt: r.createdAt,
    }));
  }

  // ── Organizer view ──
  // Returns everything the organizer needs in one call:
  //   summaries: { [eventId]: { average, count } }   for the badges
  //   reviews:   [ { _id, eventId, rating, text, createdAt, userName } ]  for the modal
  // Scoped to events the organizer owns. Verified up front — a forged
  // organizerId can't leak reviews from other organizers' events.
  async getOrganizerReviews(organizerId) {
    if (!organizerId) throw new AppError('Authentication required', 401);

    const ownedEvents = await Event.find({ organizerId })
      .select('_id title')
      .lean();
    if (ownedEvents.length === 0) {
      return { summaries: {}, reviews: [] };
    }

    const eventIds = ownedEvents.map(e => e._id);
    const reviews = await Review.find({ eventId: { $in: eventIds } })
      .populate('userId', 'name')
      .sort({ createdAt: -1 })
      .lean();

    // Aggregate: average + count per event
    const summaries = {};
    for (const ev of ownedEvents) {
      summaries[String(ev._id)] = { average: 0, count: 0, _sum: 0 };
    }
    for (const r of reviews) {
      const key = String(r.eventId);
      if (!summaries[key]) continue;
      summaries[key]._sum += r.rating;
      summaries[key].count++;
    }
    for (const key of Object.keys(summaries)) {
      const s = summaries[key];
      s.average = s.count > 0 ? Math.round((s._sum / s.count) * 10) / 10 : 0;
      delete s._sum;
    }

    // Shape the review rows the frontend expects
    const shaped = reviews.map(r => ({
      _id: r._id,
      eventId: String(r.eventId),
      rating: r.rating,
      text: r.text,
      createdAt: r.createdAt,
      userName: r.userId?.name || 'Ticket holder',
    }));

    return { summaries, reviews: shaped };
  }

  // ── Single-event reviews (organizer) ──
  // Optional standalone method if you ever want a per-event endpoint.
  // Kept alongside getOrganizerReviews so the aggregation logic stays
  // in one place; the frontend uses the combined endpoint for now.
  async getEventReviews(eventId, organizerId) {
    if (!isObjectIdString(eventId)) throw new AppError('Invalid event', 400);
    if (!organizerId) throw new AppError('Authentication required', 401);

    const owns = await Event.exists({ _id: eventId, organizerId });
    if (!owns) throw new AppError('Event not found or not yours', 403);

    const reviews = await Review.find({ eventId })
      .populate('userId', 'name')
      .sort({ createdAt: -1 })
      .lean();

    return reviews.map(r => ({
      _id: r._id,
      eventId: String(r.eventId),
      rating: r.rating,
      text: r.text,
      createdAt: r.createdAt,
      userName: r.userId?.name || 'Ticket holder',
    }));
  }
}

module.exports = new ReviewService();
