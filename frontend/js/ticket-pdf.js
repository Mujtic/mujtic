/* ============================================================
   MUJTIC — generative PDF ticket (v2)
   Drop-in for the jsPDF ticket in app.js. No edits to app.js:
   load this file AFTER app.js and it replaces these methods on
   MujticApp.prototype:
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

  const ORIG = { tile: '#2dd4bf', fg: '#0d1117', mid: '#ff6b6b', ring: '#0d1117' };   // the logo in its own colours (dark version)
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
    const flag = !!(ticket.earlyBird || ticket.isEarlyBird);
    const raw = String(ticket.ticketType || ticket.type || 'ticket').toUpperCase();
    const early = flag && !/EARLY/.test(raw);   // early bird on top of another type, e.g. VIP
    return {
      id: String(ticket.id || ticket._id || ticket.ticketId || 'TICKET'),
      label: raw + (early ? ' - EARLY BIRD' : ''),
      early,
      raw,
      group: !!(ticket.isGroupTicket && Number(ticket.totalSlots) > 1),
      slots: Number(ticket.totalSlots) || 1,
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

  // The MUJTIC wordmark as vector outlines (Outfit Bold) with the coral ticket in place of the I
  const WM = {"cap":0.706,"tw":4.1,"tx":3.081,"L":[{"x":0,"c":[{"p":[0.0675,0.0],"s":[[0.0,-0.706],[0.1125,0.0],[0.278,0.4335],[-0.0575,-0.0],[0.2775,-0.4335],[0.1125,0.0],[0.0,0.706],[-0.1565,0.0],[0.0,-0.441],[0.0275,0.0075],[-0.1805,0.2815],[-0.104,0.0],[-0.18,-0.2815],[0.027,-0.0075],[0.0,0.441]]}]},{"x":0.938,"c":[{"p":[0.3522,0.011],"s":[[-0.0579,-0.0,-0.109,-0.0124,-0.1533,-0.0372],[-0.0443,-0.0248,-0.079,-0.059,-0.1042,-0.1025],[-0.0251,-0.0435,-0.0377,-0.0931,-0.0377,-0.1487],[0.0,-0.4285],[0.1575,0.0],[0.0,0.437],[0.0,0.0283,0.0061,0.0528,0.0182,0.0733],[0.0122,0.0205,0.0287,0.0363,0.0495,0.0473],[0.0209,0.011,0.0441,0.0164,0.0698,0.0164],[0.0263,-0.0,0.0495,-0.0055,0.0696,-0.0164],[0.0202,-0.011,0.0361,-0.0266,0.0478,-0.047],[0.0117,-0.0204,0.0175,-0.0446,0.0175,-0.0726],[0.0,-0.438],[0.158,0.0],[0.0,0.4295],[0.0,0.0556,-0.0124,0.105,-0.0372,0.1482],[-0.0248,0.0432,-0.0591,0.0772,-0.103,0.102],[-0.0439,0.0248,-0.0947,0.0372,-0.1526,0.0372]]}]},{"x":1.72,"c":[{"p":[0.215,0.011],"s":[[-0.0447,-0.0,-0.0835,-0.0082,-0.1165,-0.0245],[-0.033,-0.0163,-0.0612,-0.0392,-0.0845,-0.0685],[0.1045,-0.101],[0.012,0.0167,0.0262,0.0293,0.0428,0.038],[0.0165,0.0087,0.0351,0.013,0.0558,0.013],[0.0197,-0.0,0.0369,-0.0041,0.0517,-0.0123],[0.0148,-0.0082,0.0265,-0.0202,0.035,-0.036],[0.0085,-0.0158,0.0127,-0.0354,0.0127,-0.0587],[0.0,-0.467],[0.158,0.0],[0.0,0.4585],[0.0,0.0527,-0.0106,0.0983,-0.0318,0.137],[-0.0212,0.0387,-0.0511,0.0686,-0.0897,0.0897],[-0.0387,0.0212,-0.0847,0.0318,-0.138,0.0318]]}]},{"x":2.332,"c":[{"p":[0.2405,0.0],"s":[[0.0,-0.696],[0.1575,0.0],[0.0,0.696]]},{"p":[0.02,-0.5685],"s":[[0.0,-0.1375],[0.599,0.0],[0.0,0.1375]]}]},{"x":3.411,"c":[{"p":[0.4025,0.011],"s":[[-0.0527,-0.0,-0.1015,-0.0092,-0.1465,-0.0275],[-0.045,-0.0183,-0.0843,-0.0441,-0.118,-0.0772],[-0.0337,-0.0332,-0.0597,-0.0719,-0.0783,-0.1163],[-0.0185,-0.0443,-0.0278,-0.0922,-0.0278,-0.1435],[0.0,-0.0517,0.0092,-0.0996,0.0278,-0.1437],[0.0185,-0.0442,0.0445,-0.0826,0.078,-0.1153],[0.0335,-0.0327,0.0727,-0.0583,0.1175,-0.0767],[0.0448,-0.0185,0.0936,-0.0278,0.1462,-0.0278],[0.056,-0.0,0.1058,0.009,0.1495,0.027],[0.0437,0.018,0.082,0.0427,0.115,0.074],[-0.1055,0.106],[-0.0183,-0.02,-0.0407,-0.0357,-0.067,-0.047],[-0.0263,-0.0113,-0.057,-0.017,-0.092,-0.017],[-0.0307,-0.0,-0.0587,0.0052,-0.0843,0.0155],[-0.0255,0.0103,-0.0475,0.0253,-0.066,0.0447],[-0.0185,0.0195,-0.0328,0.0428,-0.043,0.07],[-0.0102,0.0272,-0.0152,0.0573,-0.0152,0.0902],[0.0,0.0333,0.0051,0.0636,0.0152,0.0907],[0.0102,0.0272,0.0245,0.0505,0.043,0.07],[0.0185,0.0195,0.0405,0.0345,0.066,0.045],[0.0255,0.0105,0.0536,0.0158,0.0843,0.0158],[0.0363,-0.0,0.0678,-0.0056,0.0945,-0.0168],[0.0267,-0.0112,0.0495,-0.0269,0.0685,-0.0473],[0.106,0.106],[-0.0337,0.0317,-0.0723,0.0564,-0.116,0.0742],[-0.0437,0.0178,-0.0943,0.0267,-0.152,0.0267]]}]}]};
  function drawWordmark(doc, x, base, size, color, iColor, bg, align) {
    const w = WM.tw * size, x0 = align === 'center' ? x - w / 2 : x;
    doc.setFillColor(color);
    WM.L.forEach(g => g.c.forEach(c => doc.lines(c.s, x0 + (g.x + c.p[0]) * size, base + c.p[1] * size, [size, size], 'F', true)));
    const iw = 0.22 * size, ih = WM.cap * size, ix = x0 + WM.tx * size, iy = base - ih;
    doc.setFillColor(iColor); doc.roundedRect(ix, iy, iw, ih, iw * 0.14, iw * 0.14, 'F');
    doc.setFillColor(bg); doc.circle(ix, iy + ih / 2, iw * 0.18, 'F'); doc.circle(ix + iw, iy + ih / 2, iw * 0.18, 'F');
    return w;
  }

  // Ticket type pills: the type, plus an EARLY BIRD pill when it is an early bird VIP, VVIP, etc.
  function drawPills(doc, ticket, th, x, y, h, layout) {
    const t = info(ticket), items = [{ text: t.raw, star: !!th.stars }];
    if (t.early) items.push({ text: 'EARLY BIRD', early: true });
    doc.setFont('courier', 'bold'); doc.setFontSize(8);
    items.forEach(it => {
      const w = doc.getTextWidth(it.text) + 1.4 * (it.text.length - 1) + 8 + (it.star ? 5 : 0);
      let bg, fg;
      if (layout === 'portrait') { bg = it.early ? '#ff6b6b' : th.acc; fg = '#0d1117'; }
      else if (it.early) { bg = th.body === CORAL ? '#ffffff' : CORAL; fg = th.body === CORAL ? CORAL : '#ffffff'; }
      else { bg = th.badgeBg; fg = th.badgeFg; }
      doc.setFillColor(bg); doc.roundedRect(x, y, w, h, h / 2, h / 2, 'F');
      if (it.star) star(doc, x + 4.6, y + h / 2, 1.7, fg);
      doc.setTextColor(fg); tracked(doc, it.text, x + w / 2 + (it.star ? 2.5 : 0), y + h / 2 + 1.35, 1.4, 'center');
      x += w + 2;
    });
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
      try { doc.setGState(new doc.GState({ opacity: 0.14 })); drawStamp(doc, 124, 38, 26, { tile: ORIG.tile, fg: '#0d2030', mid: ORIG.mid, ring: '#0d2030' }); doc.setGState(new doc.GState({ opacity: 1 })); } catch (e) {}
    }
    doc.setFillColor(acc); doc.rect(0, BH, PW, 1.4, 'F');
    if (th.border) { doc.setDrawColor(th.border); doc.setLineWidth(0.45); doc.roundedRect(1.8, 1.8, PW - 3.6, PH - 3.6, 3, 3, 'S'); }

    // MUJTIC embedded in the banner: stamp + wordmark, admit line
    drawStamp(doc, 18.5, 13.5, 6.5, ORIG);
    drawWordmark(doc, 28.5, 13.5 + WM.cap * 3.1, 6.2, '#eaf2f8', ORIG.mid, '#0f1722');
    doc.setFont('courier', 'bold'); doc.setFontSize(8); doc.setTextColor(acc);
    tracked(doc, t.group ? `ADMITS ${t.slots}` : 'ADMIT ONE', PW - 12, 15, 2.2, 'right');

    // title (bottom-left of the banner) and ticket type pill
    doc.setFont('helvetica', 'bold');
    const ft = fitTitle(doc, String(event.title || 'Event'), 124, 18, 16);
    doc.setFontSize(ft.size); doc.setTextColor('#eaf2f8');
    const lh = ft.size * 0.3528 * 1.1; let ty = 40 - (ft.lines.length - 1) * lh;
    ft.lines.forEach(l => { doc.text(l, 12, ty); ty += lh; });
    drawPills(doc, ticket, th, 12, 45.5, 6.8, 'portrait');

    // details
    const rows = [['DATE', dateText(event)], ['VENUE', [event.venue, event.location].filter(Boolean).join(', ')]];
    rows.push(['TYPE', t.raw + (t.hasPrice && !(Number(ticket.price) === 0 && /FREE/.test(t.raw)) ? `  -  ${money(ticket.price, event.currency)}` : '')]);
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
    const url = `\u00B7  ${CFG.url}`, uw = doc.getTextWidth(url) + 1.2 * (url.length - 1), wmS = 3.4;
    const total = 5.6 + 2.4 + WM.tw * wmS + 2.6 + uw, x0 = (PW - total) / 2;
    drawStamp(doc, x0 + 2.8, 201.6, 2.8, ORIG);
    drawWordmark(doc, x0 + 8, 201.6 + WM.cap * wmS / 2, wmS, '#eaf2f8', ORIG.mid, '#131a23');
    doc.setTextColor('#ccd9e3'); doc.text(url, x0 + 8 + WM.tw * wmS + 2.6, 202.8, { charSpace: 1.2 });
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
    drawPills(doc, ticket, th, mx, TY + 8, 6.6, 'landscape');

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

    doc.setFont('courier', 'bold'); doc.setFontSize(8); doc.setTextColor(th.sub);
    tracked(doc, `No. ${t.id}`, mx, TY + TH - 7, 0.6, 'left');
    if (t.hasPrice) { doc.setTextColor(th.text); doc.setFontSize(9); tracked(doc, money(ticket.price, event.currency), TX + PERF - 7, TY + TH - 7, 0.6, 'right'); }

    const cx = TX + PERF + (TW - PERF) / 2;
    drawWordmark(doc, cx, TY + 7 + WM.cap * 2.2, 4.4, INK, CORAL, MIST, 'center');
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
  if (typeof MujticApp === 'undefined') return;

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

  Object.assign(MujticApp.prototype, {
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