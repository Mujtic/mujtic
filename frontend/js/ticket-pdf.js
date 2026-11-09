/* ============================================================
   MUJTIC — generative PDF ticket (v2)
   Drop-in for the jsPDF ticket in app.js. No edits to app.js:
   load this file AFTER app.js and it replaces these methods on
   GlycrApp.prototype:
     _generateTicketPDF, downloadTicketPDF, downloadTicketPDFById
   and adds _generateTicketsPDF (one PDF page per ticket).

   Two layouts:
     'portrait'   (default) the original A5 ticket: event banner on
                  top, details, dashed tear line, QR, MUJTIC branded
     'landscape'  the notched ticket with the QR on a tear-off stub
   Switch with  window.MUJTIC_PDF_CONFIG = { layout: 'landscape' }
   before this script, or per call:  _generateTicketsPDF(t, ev, { layout })
   Ticket types with their own look: general, VIP, VVIP, early bird, free.
============================================================ */
(function (root) {
  'use strict';

  const CFG = Object.assign({
    brand: 'MUJTIC',
    url: 'mujtic.com',
    footer: 'One entry per ticket slot. Show this QR code at the entrance.',
    filePrefix: 'mujtic',
    layout: 'portrait',
  }, root.MUJTIC_PDF_CONFIG || {});

  const INK = '#0b1624', MIST = '#f4f7fa', SLATE = '#4a6075', CORAL = '#e5484d', GOLD = '#fbbf24';

  // body/tile/fg/mid = landscape colours; acc = accent on the dark portrait ticket
  const THEMES = {
    general: { body: '#0d9488', tile: '#ffffff', fg: '#0d9488', mid: CORAL, text: '#ffffff', sub: '#d6f2ee', badgeBg: '#ffffff', badgeFg: '#0d9488', accent: '#ffffff', acc: '#2dd4bf' },
    vip:     { body: INK,       tile: GOLD,      fg: INK,       mid: CORAL, text: '#ffffff', sub: '#c5d0dd', badgeBg: GOLD,      badgeFg: INK,       accent: GOLD,      acc: GOLD },
    vvip:    { body: '#05080d', tile: '#ffffff', fg: '#05080d', mid: CORAL, text: '#ffffff', sub: '#c5d0dd', badgeBg: GOLD,      badgeFg: '#05080d', accent: GOLD,      acc: GOLD, ring: GOLD, border: GOLD, stars: true },
    early:   { body: CORAL,     tile: '#ffffff', fg: CORAL,     mid: INK,   text: '#ffffff', sub: '#ffe3e3', badgeBg: '#ffffff', badgeFg: CORAL,     accent: '#ffffff', acc: '#ff6b6b' },
    free:    { body: '#059669', tile: '#ffffff', fg: '#059669', mid: CORAL, text: '#ffffff', sub: '#d1fae5', badgeBg: '#ffffff', badgeFg: '#059669', accent: '#ffffff', acc: '#6ee7b7' },
  };

  function themeFor(ticket) {
    const t = String(ticket.ticketType || ticket.type || '').toLowerCase();
    if (/vvip/.test(t)) return THEMES.vvip;
    if (/vip/.test(t)) return THEMES.vip;
    if (ticket.earlyBird || ticket.isEarlyBird || /early/.test(t)) return THEMES.early;
    if (Number(ticket.price) === 0 || /free/.test(t)) return THEMES.free;
    return THEMES.general;
  }

  // jsPDF's built-in fonts cannot print the cedi sign, so Ghana cedi prints as GHS
  const CUR = { GHC: 'GHS', GHS: 'GHS', USD: '$', EUR: '\u20AC', GBP: '\u00A3', CAD: 'CA$' };
  const money = (price, cur) => Number(price) === 0 ? 'FREE' : `${CUR[cur] || cur || 'GHS'} ${Number(price).toFixed(2)}`;

  function info(ticket) {
    const early = !!(ticket.earlyBird || ticket.isEarlyBird);
    const raw = String(ticket.ticketType || ticket.type || 'ticket').toUpperCase();
    return {
      id: String(ticket.id || ticket._id || ticket.ticketId || 'TICKET'),
      label: raw + (early && !/EARLY/.test(raw) ? ' - EARLY BIRD' : ''),
      raw,
      group: !!(ticket.isGroupTicket && Number(ticket.totalSlots) > 1),
      slots: Number(ticket.totalSlots) || 1,
      who: ticket.buyerName || ticket.userName || ticket.name || '',
      hasPrice: ticket.price != null && !isNaN(Number(ticket.price)),
    };
  }

  function dateText(event) {
    const d = new Date(event.date);
    return isNaN(d) ? '' : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '').toUpperCase();
  }

  // ---------- drawing helpers (millimetres) ----------
  function polygon(doc, pts, ox, oy, k, fill) {
    doc.setFillColor(fill);
    const vec = [];
    for (let i = 1; i < pts.length; i++) vec.push([(pts[i][0] - pts[i - 1][0]) * k, (pts[i][1] - pts[i - 1][1]) * k]);
    doc.lines(vec, ox + pts[0][0] * k, oy + pts[0][1] * k, [1, 1], 'F', true);
  }

  function star(doc, cx, cy, r, fill) {
    const pts = [];
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
    polygon(doc, pts, 0, 0, 1, fill);
  }

  function miniTicket(doc, ox, oy, k, ux, uy, scale, fill, tile, stroke) {
    const w = 18 * scale * k, h = 11 * scale * k, x = ox + ux * k, y = oy + uy * k;
    doc.setFillColor(fill);
    if (stroke) { doc.setDrawColor(stroke); doc.setLineWidth(0.75 * k); doc.roundedRect(x, y, w, h, 2 * scale * k, 2 * scale * k, 'FD'); }
    else doc.roundedRect(x, y, w, h, 2 * scale * k, 2 * scale * k, 'F');
    doc.setFillColor(tile);
    doc.circle(x, y + h / 2, 1.7 * scale * k, 'F');
    doc.circle(x + w, y + h / 2, 1.7 * scale * k, 'F');
  }

  // The MUJTIC admit stamp: circle, dotted ring, three tickets (middle one coral), notched M
  function drawStamp(doc, cx, cy, R, th) {
    const k = R / 54, ox = cx - 60 * k, oy = cy - 60 * k;
    doc.setFillColor(th.tile); doc.circle(cx, cy, R, 'F');
    doc.setFillColor(th.ring || th.fg);
    for (let i = 0; i < 43; i++) {
      const a = (i / 43) * Math.PI * 2;
      doc.circle(cx + 48 * k * Math.cos(a), cy + 48 * k * Math.sin(a), 1.15 * k, 'F');
    }
    miniTicket(doc, ox, oy, k, 29, 31.1, 0.89, th.fg, th.tile, null);
    miniTicket(doc, ox, oy, k, 49.5, 29.55, 1.17, th.mid, th.tile, th.fg);
    miniTicket(doc, ox, oy, k, 75, 31.1, 0.89, th.fg, th.tile, null);
    const M = [[0, 38], [0, 0], [10, 0], [24, 22], [38, 0], [48, 0], [48, 38], [39, 38], [39, 12], [24, 34], [9, 12], [9, 38]];
    polygon(doc, M, ox + 36 * k, oy + 52 * k, k, th.fg);
    doc.setFillColor(th.tile);
    doc.circle(ox + 36 * k, oy + 71 * k, 3.4 * k, 'F');
    doc.circle(ox + 84 * k, oy + 71 * k, 3.4 * k, 'F');
  }

  function tracked(doc, str, x, y, space, align) {
    const w = doc.getTextWidth(str) + space * (str.length - 1);
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    doc.text(str, x0, y, { charSpace: space });
    return w;
  }

  function drawQR(doc, matrix, x, y, size) {
    doc.setFillColor('#ffffff'); doc.rect(x - 2, y - 2, size + 4, size + 4, 'F');
    if (!matrix) return false;
    const n = matrix.length, c = size / n;
    doc.setFillColor(INK);
    for (let r = 0; r < n; r++) {
      let c0 = -1;
      for (let q = 0; q <= n; q++) {
        const on = q < n && matrix[r][q];
        if (on && c0 < 0) c0 = q;
        if (!on && c0 >= 0) { doc.rect(x + c0 * c, y + r * c, (q - c0) * c + 0.02, c + 0.02, 'F'); c0 = -1; }
      }
    }
    return true;
  }

  function fitTitle(doc, title, maxW, startSize, twoLineMax) {
    let size = startSize, lines = [title];
    for (; size >= 11; size--) {
      doc.setFontSize(size); lines = doc.splitTextToSize(title, maxW);
      if (lines.length <= 2 && (lines.length === 1 || size <= twoLineMax)) break;
    }
    return { size, lines: lines.slice(0, 2) };
  }

  // ============ PORTRAIT (the original A5 ticket, MUJTIC branded) ============
  const PW = 148, PH = 210, BH = 58, PERF_Y = 124;

  function drawTicketPortrait(doc, ticket, event, qrMatrix, banner) {
    const th = themeFor(ticket), acc = th.acc, t = info(ticket);

    doc.setFillColor('#131a23'); doc.rect(0, 0, PW, PH, 'F');

    // banner: event image, or a branded fallback with a faint stamp
    let drewImage = false;
    if (banner) { try { doc.addImage(banner, 'JPEG', 0, 0, PW, BH); drewImage = true; } catch (e) { drewImage = false; } }
    if (!drewImage) {
      doc.setFillColor('#0d2030'); doc.rect(0, 0, PW, BH, 'F');
      try { doc.setGState(new doc.GState({ opacity: 0.14 })); drawStamp(doc, 124, 38, 26, { tile: acc, fg: '#0d2030', mid: CORAL, ring: '#0d2030' }); doc.setGState(new doc.GState({ opacity: 1 })); } catch (e) {}
    }
    doc.setFillColor(acc); doc.rect(0, BH, PW, 1.4, 'F');
    if (th.border) { doc.setDrawColor(th.border); doc.setLineWidth(0.45); doc.roundedRect(1.8, 1.8, PW - 3.6, PH - 3.6, 3, 3, 'S'); }

    // MUJTIC embedded in the banner: stamp + wordmark, admit line
    drawStamp(doc, 18.5, 13.5, 6.5, { tile: '#ffffff', fg: INK, mid: CORAL, ring: th.ring || INK });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor('#ffffff');
    tracked(doc, CFG.brand, 28.5, 15.6, 2, 'left');
    doc.setFont('courier', 'bold'); doc.setFontSize(8); doc.setTextColor(acc);
    tracked(doc, t.group ? `ADMITS ${t.slots}` : 'ADMIT ONE', PW - 12, 15, 2.2, 'right');

    // title (bottom-left of the banner) and ticket type pill
    doc.setFont('helvetica', 'bold');
    const ft = fitTitle(doc, String(event.title || 'Event'), 124, 18, 16);
    doc.setFontSize(ft.size); doc.setTextColor('#eaf2f8');
    const lh = ft.size * 0.3528 * 1.1; let ty = 40 - (ft.lines.length - 1) * lh;
    ft.lines.forEach(l => { doc.text(l, 12, ty); ty += lh; });
    doc.setFont('courier', 'bold'); doc.setFontSize(8);
    const bw = doc.getTextWidth(t.label) + 1.4 * (t.label.length - 1) + 8 + (th.stars ? 5 : 0);
    doc.setFillColor(acc); doc.roundedRect(12, 45.5, bw, 6.8, 3.4, 3.4, 'F');
    if (th.stars) star(doc, 16.6, 48.9, 1.7, '#05080d');
    doc.setTextColor('#0d1117'); tracked(doc, t.label, 12 + bw / 2 + (th.stars ? 2.5 : 0), 50.2, 1.4, 'center');

    // details
    const rows = [['DATE', dateText(event)], ['VENUE', [event.venue, event.location].filter(Boolean).join(', ')]];
    rows.push(['TYPE', t.raw + (t.hasPrice && !(Number(ticket.price) === 0 && /FREE/.test(t.raw)) ? `  -  ${money(ticket.price, event.currency)}` : '')]);
    if (t.who) rows.push(['ATTENDEE', String(t.who)]);
    if (t.group) rows.push(['ADMITS', `${t.slots} people, one scan each`]);
    let y = 73;
    rows.filter(r => r[1]).forEach(([k, v]) => {
      doc.setFont('courier', 'bold'); doc.setFontSize(7.4); doc.setTextColor('#7a96aa'); doc.text(k, 12, y, { charSpace: 1 });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.6); doc.setTextColor('#ccd9e3');
      const ls = doc.splitTextToSize(v, 92).slice(0, 2); ls.forEach((l, i) => doc.text(l, 45, y + i * 4.6));
      y += Math.max(8.4, ls.length * 4.6 + 3.6);
    });

    // tear line with side notches
    doc.setDrawColor('#4a6278'); doc.setLineWidth(0.35); doc.setLineDashPattern([1, 1.8], 0);
    doc.line(9, PERF_Y, PW - 9, PERF_Y); doc.setLineDashPattern([], 0);
    doc.setFillColor('#ffffff'); doc.circle(0, PERF_Y, 4, 'F'); doc.circle(PW, PERF_Y, 4, 'F');

    // QR
    doc.setFont('courier', 'bold'); doc.setFontSize(8); doc.setTextColor(acc);
    tracked(doc, 'SCAN AT ENTRY', PW / 2, PERF_Y + 9, 2.2, 'center');
    const qs = 46; drawQR(doc, qrMatrix, (PW - qs) / 2, PERF_Y + 14, qs);
    doc.setFont('courier', 'bold'); doc.setFontSize(8); doc.setTextColor('#ccd9e3');
    tracked(doc, `No. ${t.id}`, PW / 2, PERF_Y + 69, 0.6, 'center');

    // MUJTIC strip + footer
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    const txt = `${CFG.brand}  \u00B7  ${CFG.url}`, tw = doc.getTextWidth(txt) + 1.2 * (txt.length - 1), x0 = (PW - (5.6 + 2.4 + tw)) / 2;
    drawStamp(doc, x0 + 2.8, 201.6, 2.8, { tile: acc, fg: '#0d1117', mid: CORAL });
    doc.setTextColor('#ccd9e3'); doc.text(txt, x0 + 8, 202.8, { charSpace: 1.2 });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor('#4a6278');
    doc.text(CFG.footer, PW / 2, 206.6, { align: 'center' });
  }

  // ============ LANDSCAPE (notched ticket with tear-off stub) ============
  const LW = 208, LH = 92, TX = 4, TY = 4, TW = 200, TH = 76, PERF = 148;

  function drawTicketPage(doc, ticket, event, qrMatrix) {
    const th = themeFor(ticket), t = info(ticket);
    doc.setFillColor('#ffffff'); doc.rect(0, 0, LW, LH, 'F');

    doc.setFillColor(th.body); doc.roundedRect(TX, TY, TW, TH, 5, 5, 'F');
    doc.setFillColor(MIST);    doc.roundedRect(TX + PERF, TY, TW - PERF, TH, 5, 5, 'F');
    doc.rect(TX + PERF, TY, 12, TH, 'F');
    if (th.border) { doc.setDrawColor(th.border); doc.setLineWidth(0.4); doc.roundedRect(TX + 1.6, TY + 1.6, PERF - 3.2, TH - 3.2, 3.6, 3.6, 'S'); }
    doc.setFillColor('#ffffff');
    doc.circle(TX + PERF, TY, 3.6, 'F'); doc.circle(TX + PERF, TY + TH, 3.6, 'F');
    doc.setDrawColor(SLATE); doc.setLineWidth(0.35); doc.setLineDashPattern([0.6, 1.8], 0);
    doc.line(TX + PERF, TY + 7, TX + PERF, TY + TH - 7); doc.setLineDashPattern([], 0);

    drawStamp(doc, TX + 25, TY + TH / 2, 17, th);

    const mx = TX + 46;
    doc.setFont('courier', 'bold'); doc.setFontSize(8);
    const bw = doc.getTextWidth(t.label) + 1.4 * (t.label.length - 1) + 8 + (th.stars ? 5 : 0);
    doc.setFillColor(th.badgeBg); doc.roundedRect(mx, TY + 8, bw, 6.6, 3.3, 3.3, 'F');
    if (th.stars) star(doc, mx + 4.6, TY + 11.3, 1.7, th.badgeFg);
    doc.setTextColor(th.badgeFg); tracked(doc, t.label, mx + bw / 2 + (th.stars ? 2.5 : 0), TY + 12.5, 1.4, 'center');

    doc.setFont('courier', 'bold'); doc.setFontSize(9); doc.setTextColor(th.accent);
    tracked(doc, t.group ? `ADMITS ${t.slots}` : 'ADMIT ONE', mx, TY + 24, 2.2, 'left');

    doc.setFont('helvetica', 'bold'); doc.setTextColor(th.text);
    const ft = fitTitle(doc, String(event.title || 'Event'), 94, 22, 20);
    doc.setFontSize(ft.size);
    const lh = ft.size * 0.3528 * 1.08; let y = TY + 35;
    ft.lines.forEach(l => { doc.text(l, mx, y); y += lh; });
    y += -lh + 6.5;

    doc.setFont('courier', 'normal'); doc.setFontSize(8.6); doc.setTextColor(th.sub);
    const ds = dateText(event);
    if (ds) { doc.text(ds, mx, y); y += 4.8; }
    const venue = [event.venue, event.location].filter(Boolean).join(', ');
    if (venue) { doc.text(doc.splitTextToSize(venue.toUpperCase(), 94)[0], mx, y); y += 4.8; }
    if (t.who) doc.text(doc.splitTextToSize(String(t.who).toUpperCase(), 94)[0], mx, y);

    doc.setFont('courier', 'bold'); doc.setFontSize(8); doc.setTextColor(th.sub);
    tracked(doc, `No. ${t.id}`, mx, TY + TH - 7, 0.6, 'left');
    if (t.hasPrice) { doc.setTextColor(th.text); doc.setFontSize(9); tracked(doc, money(ticket.price, event.currency), TX + PERF - 7, TY + TH - 7, 0.6, 'right'); }

    const cx = TX + PERF + (TW - PERF) / 2;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(INK);
    tracked(doc, CFG.brand, cx, TY + 11, 1.6, 'center');
    const qs = 32; drawQR(doc, qrMatrix, cx - qs / 2, TY + 17, qs);
    doc.setFont('courier', 'bold'); doc.setFontSize(7.2); doc.setTextColor(INK);
    tracked(doc, 'SCAN AT ENTRY', cx, TY + 58, 1.2, 'center');
    doc.setFont('courier', 'normal'); doc.setFontSize(6.4); doc.setTextColor(SLATE);
    tracked(doc, t.group ? `${t.slots} PEOPLE - 1 SCAN EACH` : CFG.url.toUpperCase(), cx, TY + 63, 0.6, 'center');

    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8); doc.setTextColor(SLATE);
    doc.text(CFG.footer, LW / 2, LH - 4, { align: 'center' });
  }

  const api = { drawTicketPortrait, drawTicketPage, themeFor, PORTRAIT: [PW, PH], LANDSCAPE: [LW, LH] };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MujticTicketPdf = api;

  // ---------- wire into the app (browser only) ----------
  if (typeof GlycrApp === 'undefined') return;

  // event image, cover-cropped to the banner and darkened so the white text stays readable
  function loadBanner(app, event) {
    return new Promise(resolve => {
      if (!event || !event.image) return resolve(null);
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const W = 1480, H = 580, c = document.createElement('canvas'); c.width = W; c.height = H;
          const g = c.getContext('2d'), ar = W / H, sr = img.naturalWidth / img.naturalHeight;
          let sw = img.naturalWidth, sh = img.naturalHeight, sx = 0, sy = 0;
          if (sr > ar) { sw = sh * ar; sx = (img.naturalWidth - sw) / 2; } else { sh = sw / ar; sy = (img.naturalHeight - sh) / 2; }
          g.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
          const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(13,17,23,0.45)'); gr.addColorStop(1, 'rgba(13,17,23,0.82)');
          g.fillStyle = gr; g.fillRect(0, 0, W, H);
          resolve(c.toDataURL('image/jpeg', 0.85));
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = app.getFullImageUrl(event.image);
    });
  }

  Object.assign(GlycrApp.prototype, {
    async _generateTicketPDF(ticket, event) { return this._generateTicketsPDF([ticket], event); },

    // one page per ticket; a group ticket (5+) is one page with one shared QR
    async _generateTicketsPDF(tickets, event, opts = {}) {
      if (!root.jspdf) { this.showToast('PDF library not loaded. Please try again.'); return; }
      if (!tickets || !tickets.length || !event) { this.showToast('Ticket data not available.'); return; }
      const layout = opts.layout || CFG.layout;
      const size = layout === 'landscape' ? [LW, LH] : [PW, PH], orient = layout === 'landscape' ? 'landscape' : 'portrait';
      const banner = layout === 'portrait' ? await loadBanner(this, event) : null;
      const { jsPDF } = root.jspdf;
      const doc = new jsPDF({ unit: 'mm', format: size, orientation: orient });
      tickets.forEach((t, i) => {
        if (i > 0) doc.addPage(size, orient);
        const id = String(t.id || t._id || t.ticketId || 'TICKET'), qr = this._getQRMatrix(id);
        if (layout === 'landscape') drawTicketPage(doc, t, event, qr); else drawTicketPortrait(doc, t, event, qr, banner);
      });
      const slug = String(event.title || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      doc.save(tickets.length === 1 ? `${CFG.filePrefix}-ticket-${tickets[0].id || tickets[0]._id || 'ticket'}.pdf` : `${CFG.filePrefix}-tickets-${slug}.pdf`);
      this.showSuccess(tickets.length === 1 ? 'Ticket PDF downloaded' : `${tickets.length} tickets downloaded`);
    },

    // modal button: every ticket from the last purchase, not just the first
    async downloadTicketPDF() {
      if (!this.lastPurchasedTickets || !this.lastPurchasedTickets.length) { this.showToast('Ticket data not available.'); return; }
      const sel = this.selectedTicket || {};
      await this._generateTicketsPDF(this.lastPurchasedTickets.map(t => ({ ...t, ticketType: t.ticketType || t.type || sel.type || 'ticket' })), this.lastPurchasedEvent);
    },

    // purchase history: look the full ticket up so group slots and price carry through
    async downloadTicketPDFById(ticketId, eventId, ticketType) {
      try {
        const ev = this.allEvents.find(e => e._id === eventId) || await this.fetchApi(`/events/${eventId}`);
        const full = (this.userTickets || []).find(t => (t.id || t._id) === ticketId) || {};
        await this._generateTicketsPDF([{ ...full, id: ticketId, ticketType: full.ticketType || ticketType }], ev);
      } catch (err) { this.showError('Could not load ticket data.'); }
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
