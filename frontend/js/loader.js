/* ============================================================
   MUJTIC — branded screens: loader, empty states, ticket scanner
   Additive. Load AFTER js/app.js (same pattern as ticket-pdf.js).
   - hides the loading screen once the first data has arrived
   - adds app.emptyState(kind, options) for branded empty states
   - adds a camera ticket scanner (button appears on the Validate page)
============================================================ */
(function () {
  'use strict';

  /* ---------- 1. LOADING SCREEN ---------- */
  (function () {
    const L = document.getElementById('app-loader');
    if (!L) return;
    const t0 = performance.now(); let done = false;
    const hide = () => {
      if (done) return; done = true;
      setTimeout(() => { L.classList.add('done'); setTimeout(() => L.remove(), 600); }, Math.max(0, 900 - (performance.now() - t0)));
    };
    const iv = setInterval(() => {
      let ready = false;
      try {
        const g = document.getElementById('events-grid');
        ready = (typeof app !== 'undefined' && app.dataLoaded) ||
          (g && g.children.length && !g.querySelector('.loading-placeholder'));
      } catch (e) {}
      if (ready) { clearInterval(iv); hide(); }
    }, 120);
    setTimeout(() => { clearInterval(iv); hide(); }, 8000);   // never trap the user behind the loader
  })();

  if (typeof MujticApp === 'undefined') return;
  const E = s => String(s == null ? '' : s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));

  /* ---------- 2. EMPTY STATES ---------- */
  const ES = {
    generic:    { icon: 'fa-inbox', title: 'Nothing here yet', text: 'When there is something to show, it will appear here.' },
    events:     { icon: 'fa-search', title: 'No events match your search', text: 'Try a different keyword, category or location.', action: { label: 'Clear filters', call: 'app.clearFilters()' } },
    purchases:  { icon: 'fa-ticket-alt', title: 'No tickets yet', text: 'Your tickets will live here once you buy one.', action: { label: 'Browse events', call: "app.showSection('home')" } },
    favourites: { icon: 'fa-heart', title: 'No saved events', text: 'Tap the heart on an event to keep it here for later.', action: { label: 'Browse events', call: "app.showSection('home')" } },
    refunds:    { icon: 'fa-undo', title: 'No refund requests', text: 'If you ask for a refund, you can follow it here.' },
    reminders:  { icon: 'fa-bell', title: 'No reminders set', text: 'Switch on a reminder when you buy a ticket and it will show up here.' },
    reviews:    { icon: 'fa-star', title: 'No reviews yet', text: 'After an event, tell others how it went.' },
    myevents:   { icon: 'fa-calendar-alt', title: 'No events found', text: 'Change the filters, or create your next event.', action: { label: 'New event', call: 'app.showEventForm()' } },
    orgRefunds: { icon: 'fa-undo', title: 'No refund requests', text: 'Refund requests for your events will appear here.' },
    coupons:    { icon: 'fa-tag', title: 'No promo codes yet', text: 'Create a code on the left to offer a discount.', compact: true },
    staff:      { icon: 'fa-users', title: 'No staff yet', text: 'Add a scanner on the left so they can check people in.', compact: true },
    checkins:   { icon: 'fa-qrcode', title: 'No check-ins yet', text: 'Tickets will show up here as they are scanned.', compact: true },
    error:      { icon: 'fa-exclamation-triangle', title: 'Something went wrong', text: 'Please try again.' },
  };
  MujticApp.prototype.emptyState = function (kind, o) {
    const p = Object.assign({}, ES[kind] || ES.generic, o || {}), a = p.action;
    return `<div class="es${p.compact ? ' compact' : ''}${kind === 'error' ? ' error' : ''}" role="status">` +
      `<div class="es-ico"><i class="fas ${p.icon}"></i></div><h3>${E(p.title)}</h3><p>${E(p.text)}</p>` +
      (a ? `<button type="button" class="btn ${a.ghost ? 'btn-ghost' : 'btn-primary'} btn-sm" onclick="${a.call}">${E(a.label)}</button>` : '') + '</div>';
  };

  /* ---------- 3. TICKET SCANNER ---------- */
  const SC = { active: false, busy: false, stream: null, timer: null, last: '', lastAt: 0, hide: null, det: null };
  let ctx = null, audio = null;

  function beep(ok) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain(); o.connect(g); g.connect(audio.destination);
      o.frequency.value = ok ? 880 : 220; o.type = ok ? 'sine' : 'square'; g.gain.value = .08;
      o.start(); o.stop(audio.currentTime + (ok ? .12 : .28));
    } catch (e) {}
  }
  const loadJsQR = () => new Promise((res, rej) => {
    if (window.jsQR) return res();
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js';
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
  const q = id => document.getElementById(id);

  function build() {
    if (q('scanner-screen')) return;
    const d = document.createElement('div'); d.id = 'scanner-screen'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Ticket scanner');
    d.innerHTML = `
      <video class="sc-video" id="sc-video" playsinline muted></video>
      <div class="sc-msg" id="sc-msg" style="display:none;"></div>
      <div class="sc-frame"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i><span class="sc-line"></span></div>
      <div class="sc-hint">Point at the ticket QR code</div>
      <div class="sc-top">
        <img class="sc-logo" src="public/img/logo-dark.svg" alt="MUJTIC">
        <select class="sc-event" id="sc-event" aria-label="Event being scanned"></select>
        <button class="sc-btn" id="sc-torch" style="display:none;" aria-label="Torch"><i class="fas fa-bolt"></i></button>
        <button class="sc-btn" id="sc-close" aria-label="Close scanner"><i class="fas fa-times"></i></button>
      </div>
      <div class="sc-bottom">
        <div class="sc-stats"><span class="sc-stat"><i class="fas fa-check-circle"></i><span id="sc-count">Pick an event</span></span></div>
        <form class="sc-manual" id="sc-manual"><input id="sc-code" placeholder="Or type the ticket ID" autocomplete="off" autocapitalize="characters"><button type="submit">Check</button></form>
      </div>
      <div class="sc-result" id="sc-result" aria-live="assertive"></div>`;
    document.body.appendChild(d);
    q('sc-close').onclick = () => app.closeScanner();
    q('sc-event').onchange = () => app._scannerStats();
    q('sc-result').onclick = () => app._scannerResume();
    q('sc-manual').onsubmit = e => { e.preventDefault(); const v = q('sc-code').value; q('sc-code').value = ''; if (v.trim()) app._scannerHandle(v); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && SC.active) app.closeScanner(); });
  }

  Object.assign(MujticApp.prototype, {
    async openScanner() {
      try { this.acl.requireOrganizer(); } catch (e) { return; }
      build();
      const sel = q('sc-event'), pre = (q('validation-event-select') || {}).value || sel.value;
      sel.innerHTML = '<option value="">Select event…</option>' + (this.orgEvents || []).filter(e => !e.isCancelled).map(e => `<option value="${E(e._id)}">${E(e.title)}</option>`).join('');
      if (pre) sel.value = pre;
      q('scanner-screen').classList.add('open'); document.body.style.overflow = 'hidden';
      SC.active = true; SC.busy = false; this._scannerStats();
      const msg = q('sc-msg'); msg.style.display = 'none';
      try {
        SC.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        const v = q('sc-video'); v.srcObject = SC.stream; await v.play();
        const track = SC.stream.getVideoTracks()[0], caps = (track.getCapabilities && track.getCapabilities()) || {};
        const tb = q('sc-torch'); tb.style.display = caps.torch ? '' : 'none'; tb.classList.remove('on');
        tb.onclick = async () => { const on = !tb.classList.contains('on'); try { await track.applyConstraints({ advanced: [{ torch: on }] }); tb.classList.toggle('on', on); } catch (e) {} };
        SC.det = ('BarcodeDetector' in window) ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
        if (!SC.det) await loadJsQR();
        this._scannerTick();
      } catch (err) {
        msg.style.display = 'block';
        msg.innerHTML = 'The camera could not start.<br><span style="color:#7a96aa;font-size:.8rem;">Allow camera access, or type the ticket ID below.</span>';
      }
    },

    closeScanner() {
      SC.active = false; clearTimeout(SC.timer); clearTimeout(SC.hide);
      if (SC.stream) SC.stream.getTracks().forEach(t => t.stop()); SC.stream = null;
      const s = q('scanner-screen'); if (s) s.classList.remove('open');
      const r = q('sc-result'); if (r) r.classList.remove('show');
      document.body.style.overflow = '';
      if (typeof this._loadValidationStats === 'function') { const id = (q('validation-event-select') || {}).value; if (id) { this._loadValidationStats(id); this._loadCheckinFeed(id); } }
    },

    _scannerTick() {
      if (!SC.active) return;
      const v = q('sc-video');
      const next = () => { SC.timer = setTimeout(() => requestAnimationFrame(() => this._scannerTick()), 110); };
      if (SC.busy || v.readyState < 2) return next();
      const done = code => { if (code) this._scannerHandle(code); next(); };
      if (SC.det) SC.det.detect(v).then(r => done(r[0] && r[0].rawValue)).catch(() => next());
      else if (window.jsQR) {
        const c = this._scCanvas || (this._scCanvas = document.createElement('canvas')), w = 480, h = Math.round(w * v.videoHeight / (v.videoWidth || 1)) || 360;
        c.width = w; c.height = h; ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(v, 0, 0, w, h);
        const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' }); done(r && r.data);
      } else next();
    },

    async _scannerStats() {
      const id = (q('sc-event') || {}).value, el = q('sc-count'); if (!el) return;
      if (!id) { el.textContent = 'Pick an event'; return; }
      try { const s = await this.fetchApi(`/tickets/checkin-stats?eventId=${encodeURIComponent(id)}`, { successMsg: false }); el.textContent = `${s.used} / ${s.total} checked in`; }
      catch (e) { el.textContent = 'Check-ins unavailable'; }
    },

    async _scannerHandle(raw) {
      let id = String(raw).trim(); if (!id) return;
      const now = Date.now(); if (id === SC.last && now - SC.lastAt < 3500) return; SC.last = id; SC.lastAt = now;
      try { const u = new URL(id); id = u.pathname.split('/').filter(Boolean).pop() || id; } catch (e) {}
      const eventId = (q('sc-event') || {}).value;
      if (!eventId) { this._scanResult('warn', 'PICK AN EVENT', 'Choose the event you are scanning for.'); return; }
      SC.busy = true;
      try {
        this.acl.requireEventScope(eventId);
        const r = await this.fetchApi(`/tickets/${encodeURIComponent(id)}/validate`, { method: 'PATCH', successMsg: false, body: JSON.stringify({ eventId, method: 'scan', staffName: (this.currentUser && this.currentUser.name) || 'organizer' }) });
        const t = r.ticket || r, type = (t.ticketType || r.ticketType || '').toString().toUpperCase(), who = t.buyerName || r.buyerName || t.userName || t.buyerEmail || r.buyerEmail || '';
        const total = Number(t.totalSlots || r.totalSlots) || 0, used = Number(t.usedSlots || r.usedSlots || r.slot) || 0;
        const slots = total > 1 ? { total, used: Math.min(used || 1, total) } : null;
        if (r.result === 'valid') this._scanResult('ok', 'VALID', who || 'Checked in', type, slots, id);
        else if (r.result === 'already_used') this._scanResult('warn', 'ALREADY USED', who, type || 'This ticket was scanned before', slots, id);
        else this._scanResult('bad', 'NOT VALID', r.message || 'This ticket cannot be used.', '', null, id);
      } catch (err) {
        if (String(err.message).startsWith('[AccessDenied]')) this._scanResult('bad', 'WRONG EVENT', 'This ticket is not for the event you picked.');
        else this._scanResult('bad', 'NOT VALID', err.message || 'Ticket not found.', id);
      }
      this._scannerStats();
    },

    _scanResult(kind, title, line, sub, slots, id) {
      const r = q('sc-result'); if (!r) return;
      const icon = { ok: 'fa-check', warn: 'fa-exclamation', bad: 'fa-times' }[kind];
      r.className = `sc-result ${kind}`;
      r.innerHTML = `<div class="sc-r-ico"><i class="fas ${icon}"></i></div><div class="sc-r-title">${E(title)}</div>` +
        (line ? `<div class="sc-r-line">${E(line)}</div>` : '') + (sub ? `<div class="sc-r-sub">${E(sub)}</div>` : '') +
        (slots ? `<div class="sc-slots" aria-label="Person ${slots.used} of ${slots.total}">${Array.from({ length: slots.total }, (_, i) => `<b class="${i < slots.used ? 'on' : ''}"></b>`).join('')}</div><div class="sc-r-sub">Person ${slots.used} of ${slots.total}</div>` : '') +
        '<div class="sc-tap">Tap to scan next</div>';
      requestAnimationFrame(() => r.classList.add('show'));
      beep(kind === 'ok'); if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 60 : [120, 60, 120]);
      clearTimeout(SC.hide); SC.hide = setTimeout(() => this._scannerResume(), kind === 'ok' ? 1900 : 2800);
    },

    _scannerResume() {
      clearTimeout(SC.hide); const r = q('sc-result'); if (r) r.classList.remove('show');
      setTimeout(() => { SC.busy = false; }, 250);
    },
  });

  // entry point: a "Scan with camera" button next to Check-in Log on the Validate page
  function addScanButton() {
    const ref = document.getElementById('checkin-log-btn');
    if (!ref || document.getElementById('open-scanner-btn')) return;
    const b = document.createElement('button');
    b.className = 'btn btn-primary'; b.id = 'open-scanner-btn'; b.style.fontSize = '0.82rem';
    b.innerHTML = '<i class="fas fa-camera"></i> Scan with camera';
    b.onclick = () => app.openScanner();
    ref.parentNode.insertBefore(b, ref.parentNode.firstChild);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addScanButton); else addScanButton();
})();