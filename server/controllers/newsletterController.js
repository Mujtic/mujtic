const newsletterService = require('../services/newsletterService');
const logService = require('../services/logService');

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

exports.subscribe = async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const result = await newsletterService.subscribe(email, {
      source: 'footer',
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    // Anonymous endpoint — trace only (not audit), so a bot can't flood the
    // admin log collection with entries from the public form.
    logService.trace('system', `newsletter -> subscribe ${email}`, ctx(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// GET /newsletter/unsubscribe/:token
// Renders a self-contained HTML page — no frontend routing needed.
exports.unsubscribePage = async (req, res) => {
  const { token } = req.params;
  try {
    const result = await newsletterService.unsubscribeByToken(token);
    res.status(200).send(_renderSuccessPage(result.alreadyUnsubscribed));
  } catch (err) {
    res.status(err.statusCode || 400).send(_renderErrorPage(err.message));
  }
};

// GET /admin/newsletter
exports.listSubscribers = async (req, res, next) => {
  try {
    const subscribers = await newsletterService.listSubscribers({
      status: req.query.status,
      search: req.query.search,
      limit: req.query.limit,
      skip: req.query.skip,
    });
    res.json(subscribers);
  } catch (err) {
    next(err);
  }
};

// GET /admin/newsletter/stats
exports.getStats = async (req, res, next) => {
  try {
    res.json(await newsletterService.getStats());
  } catch (err) {
    next(err);
  }
};

// DELETE /admin/newsletter/:id
exports.deleteSubscriber = async (req, res, next) => {
  try {
    const result = await newsletterService.deleteSubscriber(req.params.id);
    logService.audit(req.user.email, 'delete_newsletter_subscriber', req.params.id, {
      type: 'user', adminId: req.user.id, subscriberId: req.params.id, ...ctx(req),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// ── HTML pages ─────────────────────────────────────────────
// Self-contained — no external CSS, no fonts, no JS. Works in any browser,
// even if the frontend is down.

const _page = (title, content) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Glycr</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0d1117;
      color: #ccd9e3;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 1.5rem;
      line-height: 1.6;
    }
    .card {
      max-width: 460px;
      width: 100%;
      background: #131a23;
      border: 1px solid #243347;
      border-radius: 14px;
      padding: 2.5rem 2rem;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    }
    .icon {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
      font-size: 1.75rem;
    }
    .icon-success {
      background: rgba(45,212,191,0.12);
      border: 1px solid rgba(45,212,191,0.3);
      color: #2dd4bf;
    }
    .icon-error {
      background: rgba(255,107,107,0.12);
      border: 1px solid rgba(255,107,107,0.3);
      color: #ff6b6b;
    }
    h1 {
      font-size: 1.4rem;
      font-weight: 700;
      color: #eaf2f8;
      margin-bottom: 0.75rem;
    }
    p {
      font-size: 0.92rem;
      color: #7a96aa;
      margin-bottom: 1.75rem;
    }
    .btn {
      display: inline-block;
      padding: 0.7rem 1.5rem;
      background: #2dd4bf;
      color: #0d1117;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.88rem;
      transition: background 0.15s;
    }
    .btn:hover { background: #1aae9e; }
    .brand {
      margin-top: 1.75rem;
      padding-top: 1.25rem;
      border-top: 1px solid #243347;
      font-size: 0.72rem;
      color: #4a6278;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <div class="card">
    ${content}
    <div class="brand">Glycr · Ghana's event platform</div>
  </div>
</body>
</html>`;

const _renderSuccessPage = (alreadyUnsubscribed) => _page(
  'Unsubscribed',
  `
    <div class="icon icon-success">✓</div>
    <h1>${alreadyUnsubscribed ? 'Already unsubscribed' : 'Successfully unsubscribed'}</h1>
    <p>
      ${alreadyUnsubscribed
    ? "You've already been removed from our newsletter list. Nothing more to do."
    : "You won't receive any more newsletter emails from us. We're sorry to see you go."}
    </p>
    <a href="${process.env.FRONTEND_URL || 'https://glycr.com'}" class="btn">Back to Glycr</a>
    <p style="margin-top:1.25rem; margin-bottom:0; font-size:0.82rem; color:#4a6278;">
      Changed your mind? Subscribe again from the footer on our site.
    </p>
  `
);

const _renderErrorPage = (message) => _page(
  'Invalid unsubscribe link',
  `
    <div class="icon icon-error">!</div>
    <h1>This link doesn't work</h1>
    <p>${String(message || 'The unsubscribe link may have expired or is invalid.')}</p>
    <a href="${process.env.FRONTEND_URL || 'https://glycr.com'}" class="btn">Back to Glycr</a>
    <p style="margin-top:1.25rem; margin-bottom:0; font-size:0.82rem; color:#4a6278;">
      Need help? Contact support@glycr.com
    </p>
  `
);
