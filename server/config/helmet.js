// config/helmet.js
const helmet = require('helmet');

// ── Scope note ──
// This server returns JSON and serves /uploads (images only). CSP directives
// like scriptSrc/styleSrc/fontSrc are inert on non-HTML responses — browsers
// only apply CSP to documents. They're kept here so that IF the frontend is
// ever served from this Express app, the policy is at least syntactically
// valid and includes the sources the current SPA needs (Chart.js, jsPDF,
// QRCode, Font Awesome, Google Fonts).
//
// The real protections for the API come from helmet's other defaults:
//   - strictTransportSecurity (HSTS)
//   - xContentTypeOptions: nosniff  ← critical for /uploads
//   - frameguard (X-Frame-Options: SAMEORIGIN)
//   - referrerPolicy
//   - hidePoweredBy
// Those remain active because only contentSecurityPolicy is overridden below.
//
// ⚠️  'unsafe-inline' in scriptSrc negates CSP's XSS protection. It's required
// because index.html uses inline onClick handlers and inline <script> blocks.
// Do NOT rely on this CSP to stop XSS unless you refactor the frontend to use
// addEventListener + nonced scripts.

const helmetConfig = {
  contentSecurityPolicy: {
    // Single directives block — a previous version had two, and the second
    // silently shadowed the first (JS object literals keep the last key).
    directives: {
      defaultSrc: ["'self'"],

      scriptSrc: [
        "'self'",
        "'unsafe-inline'",              // required by current frontend (see note above)
        "http://localhost:63342",       // local dev server
        "https://mujtic.vercel.app/",
        "https://cdn.jsdelivr.net",     // Chart.js, jsPDF
        "https://cdnjs.cloudflare.com", // jsPDF, QRCode, Font Awesome
      ],

      styleSrc: [
        "'self'",
        "'unsafe-inline'",              // required for inline styles
        "https://fonts.googleapis.com", // Google Fonts CSS
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com", // Font Awesome CSS
      ],

      // Google Fonts serves the actual font FILES from gstatic.com, not
      // googleapis.com. `https:` below covers it, but if the CSP is ever
      // tightened to an explicit list, this entry must be added.
      fontSrc: ["'self'", "data:", "https:", "https://fonts.gstatic.com"],

      imgSrc: ["'self'", "data:", "https:"],

      connectSrc: [
        "'self'",
        "http://localhost:63342",
        "https://glycr.netlify.app/",
      ],

      // Hardening directives — cheap defense-in-depth even though inert on JSON
      objectSrc: ["'none'"],       // no <object>/<embed> (Flash/PDF)
      baseUri: ["'self'"],          // prevent <base> tag hijacking
      formAction: ["'self'"],       // restrict form submissions to same origin
      frameAncestors: ["'none'"],   // no iframing at all (stricter than default 'self')
    },
  },

  // COEP blocks loading cross-origin images/fonts — the frontend pulls from
  // Unsplash and Google Fonts, so keep it off.
  crossOriginEmbedderPolicy: false,

  // Allow the frontend (different port in dev, different domain in prod) to
  // load /uploads/* images. Without this, <img src="http://api/uploads/...">
  // is blocked with a CORP error.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
};

module.exports = helmet(helmetConfig);
