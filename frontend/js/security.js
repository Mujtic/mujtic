/* ============================================================
   MUJTIC — security utilities
   Load FIRST, before app.js / chat-live.js / any module that
   renders untrusted content. No dependencies.
   ============================================================ */
(function () {
  'use strict';

  const ENTITY = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;', '/':'&#x2F;', '`':'&#96;' };

  const SecurityUtils = {
    /**
     * Escape HTML special characters. Safe for innerHTML.
     * Non-strings are coerced; null/undefined → ''.
     */
    escapeHtml(text) {
      if (text == null) return '';
      return String(text).replace(/[&<>"'`\/]/g, ch => ENTITY[ch]);
    },

    /** Escape for HTML attribute values (same as escapeHtml, kept distinct for clarity). */
    escapeAttr(value) {
      return this.escapeHtml(value);
    },

    /** Escape for CSS content: property values, class names you build dynamically. */
    escapeCss(value) {
      if (typeof value !== 'string') return '';
      return value.replace(/[\\'"{}()]/g, '\\$&');
    },

    /** Escape for JS string literals (e.g. building inline onclick handlers). */
    escapeJs(value) {
      if (typeof value !== 'string') return '';
      return value
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
    },

    /**
     * Set element.innerHTML to escaped text.
     * N.B. — this only escapes, it does NOT parse HTML. Use when you want
     * to display user input as literal text, not when you need markup.
     */
    setSafeText(element, text) {
      if (!element) return;
      element.textContent = text == null ? '' : String(text);
    },

    /** Create an HTML-escaped string from any value (safe to concatenate into innerHTML). */
    createSafeString(value) {
      return this.escapeHtml(value);
    },

    /**
     * Sanitise a URL. Allow only http, https, mailto, tel, and relative
     * paths. Blocks javascript:, data:, vbscript:, etc.
     */
    sanitizeUrl(url) {
      if (typeof url !== 'string') return '';
      const u = url.trim();
      if (!u) return '';
      if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
      if (u.startsWith('/') || u.startsWith('#')) return u;
      return '';
    },

    /**
     * Strip script tags, iframe/object/embed payloads and inline event
     * handlers from user-supplied text. Display escaping should still run
     * afterwards — this is belt-and-braces so stored values never *look*
     * executable to future code that forgets to escape.
     */
    sanitizeInput(input, options = {}) {
      if (typeof input !== 'string') return '';
      let out = input.trim()
        .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
        .replace(/<\s*script\b[^>]*\/?>/gi, '')
        .replace(/<\s*iframe\b[^>]*>[\s\S]*?<\s*\/\s*iframe\s*>/gi, '')
        .replace(/<\s*object\b[^>]*>[\s\S]*?<\s*\/\s*object\s*>/gi, '')
        .replace(/<\s*embed\b[^>]*\/?>/gi, '')
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/javascript:/gi, '')
        .replace(/vbscript:/gi, '')
        .replace(/data:text\/html/gi, '');
      if (options.maxLength && out.length > options.maxLength) {
        out = out.substring(0, options.maxLength);
      }
      return out;
    },

    /**
     * Escape and preserve newlines as <br>.
     */
    escapeHtmlWithLines(text) {
      return this.escapeHtml(text).replace(/\n/g, '<br>').replace(/\r/g, '');
    },

    /**
     * Safe template interpolation: {0}, {1}, … are replaced with escaped args.
     */
    safeFormat(template, ...args) {
      return String(template).replace(/\{(\d+)\}/g, (m, n) => {
        const v = args[Number(n)];
        return v !== undefined ? this.escapeHtml(v) : m;
      });
    },
  };

  // Freeze the method set — callers shouldn't monkey-patch escape rules.
  Object.freeze(SecurityUtils);

  window.SecurityUtils = SecurityUtils;
  if (typeof module !== 'undefined' && module.exports) module.exports = SecurityUtils;
})();
