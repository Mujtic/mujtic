// services/serviceRequestService.js
const ServiceRequest = require('../models/ServiceRequest');
const User = require('../models/User');
const { sendEmail } = require('./notificationService');
const { AppError } = require('../utils/appError');
const { logger } = require('../config/logger');
const { escapeHtml, sanitizeHeader } = require('../utils/htmlSecurity');

// Must match the enum on ServiceRequest.status in models/ServiceRequest.js
const VALID_STATUSES = ['pending', 'in_progress', 'resolved', 'closed', 'cancelled'];

// Must match the <select id="help-subject"> options in index.html
const VALID_CATEGORIES = [
  'ticket_issue',
  'payment_problem',
  'refund_request',
  'organizer_support',
  'account_issue',
  'bug_report',
  'other',
];

const CATEGORY_LABELS = {
  ticket_issue:       'Ticket Issue',
  payment_problem:    'Payment Problem',
  refund_request:     'Refund Request',
  organizer_support:  'Organizer Support',
  account_issue:      'Account Issue',
  bug_report:         'Bug Report',
  other:              'Other',
};

const assertNonEmpty = (value, field) => {
  if (!value || typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required`, 400);
  }
};

const assertEmail = (email) => {
  assertNonEmpty(email, 'userEmail');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError('userEmail must be a valid email address', 400);
  }
};

const buildRequestId = (count, now) => {
  const year = now.getFullYear().toString().slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const position = String(count).padStart(2, '0');
  return `SR-${position}${day}${month}${year}`;
};

// ── Email templates ──────────────────────────────────────────

const fmtDate = (d) => new Date(d).toLocaleString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

const buildConfirmationHtml = (request) => {
  const categoryLabel = CATEGORY_LABELS[request.category] || 'Other';
  return `
    <h2>We've received your request</h2>

    <p>Hi ${escapeHtml(request.userName)},</p>

    <p>Thank you for contacting Glycr support. Your request has been logged and
    our team will respond within 2–4 hours.</p>

    <div style="margin: 1.5rem 0; padding: 1rem 1.25rem; background: #f4f7fa;
                border: 1px solid #dbe3ec; border-radius: 6px; text-align: center;">
      <div style="font-size: 0.7rem; color: #6b7f93; text-transform: uppercase;
                  letter-spacing: 0.08em; margin-bottom: 0.4rem;">
        Reference Number
      </div>
      <div style="font-family: 'Courier New', monospace; font-size: 1.25rem;
                  color: #0d9488; font-weight: 600; letter-spacing: 0.05em;">
        ${escapeHtml(request.requestId)}
      </div>
    </div>

    <table style="width: 100%; border-collapse: collapse; margin: 1.5rem 0;
                  font-size: 0.9rem; color: #1f2d3d;">
      <tr>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;
                   color: #6b7f93; width: 130px;">Category</td>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;">
          ${escapeHtml(categoryLabel)}
        </td>
      </tr>
      <tr>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;
                   color: #6b7f93;">Subject</td>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;">
          ${escapeHtml(request.subject)}
        </td>
      </tr>
      <tr>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;
                   color: #6b7f93;">Submitted</td>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;">
          ${fmtDate(request.submittedAt)}
        </td>
      </tr>
    </table>

    <div style="padding: 0.9rem 1rem; background: #f4f7fa;
                border-left: 3px solid #0d9488; border-radius: 4px;
                font-size: 0.88rem; color: #4a6075; margin: 1.5rem 0;">
      <strong>Need to follow up?</strong><br>
      Quote <strong>${escapeHtml(request.requestId)}</strong> when replying to this email
      or when contacting support — it helps us find your request instantly.
    </div>

    <p style="font-size: 0.85rem; color: #6b7f93;">
      You don't need to do anything else. If you didn't submit this request,
      reply to this email and we'll investigate.
    </p>

    <p>– Glycr Support</p>
  `;
};

const buildConfirmationText = (request) => {
  const categoryLabel = CATEGORY_LABELS[request.category] || 'Other';
  return [
    `Hi ${request.userName},`,
    '',
    'Thank you for contacting Glycr support. Your request has been logged and our team will respond within 2–4 hours.',
    '',
    `Reference Number: ${request.requestId}`,
    '',
    `Category:  ${categoryLabel}`,
    `Subject:   ${request.subject}`,
    `Submitted: ${fmtDate(request.submittedAt)}`,
    '',
    `Quote ${request.requestId} when replying to this email or when contacting support — it helps us find your request instantly.`,
    '',
    "You don't need to do anything else. If you didn't submit this request, reply to this email and we'll investigate.",
    '',
    '– Glycr Support',
  ].join('\n');
};

const buildResolvedHtml = (request) => {
  const categoryLabel = CATEGORY_LABELS[request.category] || 'Other';
  return `
    <h2>Your support request has been resolved</h2>

    <p>Hi ${escapeHtml(request.userName)},</p>

    <p>Good news — the Glycr team has resolved your support request. Here's
    a summary so you have it on record.</p>

    <div style="margin: 1.5rem 0; padding: 1rem 1.25rem; background: #f4f7fa;
                border: 1px solid #dbe3ec; border-radius: 6px; text-align: center;">
      <div style="font-size: 0.7rem; color: #6b7f93; text-transform: uppercase;
                  letter-spacing: 0.08em; margin-bottom: 0.4rem;">
        Reference Number
      </div>
      <div style="font-family: 'Courier New', monospace; font-size: 1.25rem;
                  color: #0d9488; font-weight: 600; letter-spacing: 0.05em;">
        ${escapeHtml(request.requestId)}
      </div>
    </div>

    <table style="width: 100%; border-collapse: collapse; margin: 1.5rem 0;
                  font-size: 0.9rem; color: #1f2d3d;">
      <tr>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;
                   color: #6b7f93; width: 130px;">Category</td>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;">
          ${escapeHtml(categoryLabel)}
        </td>
      </tr>
      <tr>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;
                   color: #6b7f93;">Subject</td>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;">
          ${escapeHtml(request.subject)}
        </td>
      </tr>
      <tr>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;
                   color: #6b7f93;">Submitted</td>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;">
          ${fmtDate(request.submittedAt)}
        </td>
      </tr>
      <tr>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;
                   color: #6b7f93;">Resolved</td>
        <td style="padding: 0.5rem 0; border-bottom: 1px solid #eef2f7;">
          ${fmtDate(request.resolvedAt)}
        </td>
      </tr>
    </table>

    <div style="margin: 1.5rem 0; padding: 1rem 1.25rem;
                background: #f4f7fa; border-left: 3px solid #059669;
                border-radius: 4px; font-size: 0.9rem; color: #1f2d3d;">
      <strong style="color: #059669; display: block; margin-bottom: 0.4rem;">
        Resolution notes
      </strong>
      ${escapeHtml(request.resolutionNotes || '').replace(/\n/g, '<br>')}
    </div>

    <div style="padding: 0.9rem 1rem; background: #f4f7fa;
                border-left: 3px solid #0d9488; border-radius: 4px;
                font-size: 0.88rem; color: #4a6075; margin: 1.5rem 0;">
      <strong>Not satisfied?</strong><br>
      Reply to this email and quote <strong>${escapeHtml(request.requestId)}</strong> —
      we'll reopen the conversation and take another look.
    </div>

    <p>– Glycr Support</p>
  `;
};

const buildResolvedText = (request) => {
  const categoryLabel = CATEGORY_LABELS[request.category] || 'Other';
  return [
    `Hi ${request.userName},`,
    '',
    'Good news — the Glycr team has resolved your support request.',
    '',
    `Reference Number: ${request.requestId}`,
    '',
    `Category:  ${categoryLabel}`,
    `Subject:   ${request.subject}`,
    `Submitted: ${fmtDate(request.submittedAt)}`,
    `Resolved:  ${fmtDate(request.resolvedAt)}`,
    '',
    'Resolution notes:',
    (request.resolutionNotes || '').trim(),
    '',
    `Not satisfied? Reply to this email and quote ${request.requestId} — we'll reopen the conversation and take another look.`,
    '',
    '– Glycr Support',
  ].join('\n');
};

// ── Service ──────────────────────────────────────────────────

class ServiceRequestService {
  // actingUser: { id, email } | null — null for anonymous submissions.
  async createRequest(actingUser, body) {
    const { name, email, phone, category, subject, message } = body || {};

    let userId = null;
    let userName;
    let userEmail;
    let userPhone;

    if (actingUser?.id) {
      userId = actingUser.id;
      // JWT email is authoritative — prevents a logged-in user from spoofing
      // a different email in the form body.
      userEmail = actingUser.email || email;
      // JWT doesn't carry name/phone — fetch them. Body phone overrides
      // profile phone (user might want us to call a different number this once).
      const user = await User.findById(actingUser.id).select('name phone').lean();
      userName  = user?.name  || name;
      userPhone = phone || user?.phone || null;
    } else {
      userName  = name;
      userEmail = email;
      userPhone = phone;
    }

    // ── Validation ──
    assertNonEmpty(userName, 'userName');
    assertEmail(userEmail);
    assertNonEmpty(subject, 'subject');
    assertNonEmpty(message, 'message');
    if (!VALID_CATEGORIES.includes(category)) {
      throw new AppError(`Category must be one of: ${VALID_CATEGORIES.join(', ')}`, 400);
    }
    if (subject.length > 200) {
      throw new AppError('Subject must be at most 200 characters', 400);
    }
    if (message.length > 5000) {
      throw new AppError('Message must be at most 5000 characters', 400);
    }

    // Phone: required for guests (their only phone contact), optional for
    // logged-in users (falls back to their profile phone).
    if (!userPhone || typeof userPhone !== 'string' || !userPhone.trim()) {
      if (!userId) {
        throw new AppError('Phone number is required', 400);
      }
    } else if (!/^\+233\d{9}$/.test(userPhone.trim())) {
      throw new AppError('Phone must be in +233xxxxxxxxx format', 400);
    }

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const countToday = await ServiceRequest.countDocuments({
        submittedAt: { $gte: startOfDay, $lte: endOfDay },
      });

      const request = new ServiceRequest({
        requestId: buildRequestId(countToday + 1 + attempt, now),
        userId: userId || null,
        userName: userName.trim(),
        userEmail: userEmail.toLowerCase().trim(),
        userPhone: userPhone ? userPhone.trim() : null,
        category,
        subject: subject.trim(),
        message: message.trim(),
        status: 'pending',
      });

      try {
        await request.save();

        // ── Confirmation email (fire-and-forget) ──
        // A failed send never fails the submission — the user already has the
        // reference ID in the browser response. submitLimiter (5/hour/IP) caps
        // the email-volume ceiling to match the submission ceiling.
        const subjectSafe = sanitizeHeader(
          `Your support request [${request.requestId}] has been received — Glycr`
        );
        sendEmail(
          request.userEmail,
          subjectSafe,
          buildConfirmationHtml(request),
          buildConfirmationText(request)
        ).catch((err) =>
          logger.error('Service request confirmation email failed', {
            requestId: request.requestId,
            to: request.userEmail,
            err: err.message,
          })
        );

        return request;
      } catch (err) {
        if (err.code === 11000 && err.keyPattern?.requestId) continue;
        if (err.code === 11000) {
          throw new AppError('A request with these details already exists', 409);
        }
        throw err;
      }
    }

    throw new AppError('Could not allocate a request id, please try again', 503);
  }

  async getAllRequests(filters = {}) {
    const limit = Math.min(Number(filters.limit) || 200, 500);
    const skip  = Number(filters.skip) || 0;

    return ServiceRequest.find()
      .sort({ submittedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
  }

  async updateStatus(requestId, status, resolutionNotes = null) {
    if (!requestId) throw new AppError('requestId is required', 400);
    if (!VALID_STATUSES.includes(status)) {
      throw new AppError(`Status must be one of: ${VALID_STATUSES.join(', ')}`, 400);
    }
    if (status === 'resolved') {
      assertNonEmpty(resolutionNotes, 'resolutionNotes');
    }

    const request = await ServiceRequest.findById(requestId);
    if (!request) throw new AppError('Service request not found', 404);

    if (request.status === 'closed' && status !== 'closed') {
      throw new AppError('A closed request cannot be reopened', 409);
    }
    if (request.status === status) {
      throw new AppError(`Request is already in status "${status}"`, 409);
    }

    request.status = status;

    if (status === 'resolved') {
      request.resolvedAt = new Date();
      request.resolutionNotes = resolutionNotes.trim();
    } else {
      request.resolvedAt = null;
      request.resolutionNotes = null;
    }

    await request.save();

    if (status === 'resolved') {
      // Fire-and-forget, same pattern as createRequest. A failed send must
      // never roll back the status change — the admin action succeeded.
      const subjectSafe = sanitizeHeader(
        `Your support request [${request.requestId}] has been resolved — Glycr`
      );
      sendEmail(
        request.userEmail,
        subjectSafe,
        buildResolvedHtml(request),
        buildResolvedText(request)
      ).catch((err) =>
        logger.error('Service request resolution email failed', {
          requestId: request.requestId,
          to: request.userEmail,
          err: err.message,
        })
      );
    }

    return request;
  }

  async resolveRequest(requestId, resolutionNotes) {
    return this.updateStatus(requestId, 'resolved', resolutionNotes);
  }

  async markInProgress(requestId) {
    return this.updateStatus(requestId, 'in_progress');
  }
}

module.exports = new ServiceRequestService();
