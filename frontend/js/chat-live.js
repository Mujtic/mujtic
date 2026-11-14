/* ============================================================
   MUJTIC — live chat widget (visitor side)
   Load AFTER app.js.  <script src="js/chat-live.js"></script>
============================================================ */
(function () {
  'use strict';

  const API     = (window.MUJTIC_CONFIG?.apiBase || '/api').replace(/\/$/, '');
  const POLL_MS = 3000;
  const STORE   = 'mujtic_chat_visitor_id';
  const SEEN    = 'mujtic_chat_seen';

  function uuid() {
    return 'v_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  function visitorId() {
    let id = localStorage.getItem(STORE);
    if (!id) { id = uuid(); localStorage.setItem(STORE, id); }
    return id;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtTime(d) {
    const t = new Date(d);
    return isNaN(t) ? '' : t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  function seenThisSession() {
    try { return sessionStorage.getItem(SEEN) === '1'; } catch { return false; }
  }
  function markSeen() {
    try { sessionStorage.setItem(SEEN, '1'); } catch {}
  }
  // True when the backend says the conversation no longer exists.
  function isNotFound(msg) {
    return /not\s*found/i.test(String(msg || ''));
  }

  const CSS = `
    .lcw-btn{position:fixed;bottom:22px;right:22px;z-index:9998;width:56px;height:56px;border-radius:50%;border:none;
      background:var(--teal,#0d9488);color:#fff;font-size:1.4rem;cursor:pointer;box-shadow:0 8px 22px rgba(0,0,0,.22);
      display:flex;align-items:center;justify-content:center;transition:transform .15s,background .15s}
    .lcw-btn:hover{transform:scale(1.06);background:var(--teal-d,#0f766e)}
    .lcw-btn[aria-expanded="true"]{background:var(--coral,#e5484d)}
    .lcw-btn .lcw-badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;
      background:var(--coral,#e5484d);color:#fff;font-size:11px;font-weight:700;display:none;align-items:center;justify-content:center}
    .lcw-btn.has-badge .lcw-badge{display:flex}

    /* Attention: bounce on load */
    .lcw-btn.pulse { animation: lcwBounce 1.4s ease-in-out infinite; }
    @keyframes lcwBounce {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.1); }
    }
    /* Attention: expanding ring */
    .lcw-btn::after {
      content: ''; position: absolute; inset: -4px; border-radius: 50%;
      border: 2px solid var(--teal, #0d9488);
      pointer-events: none; opacity: 0; transform: scale(.85);
    }
    .lcw-btn.ripple::after { animation: lcwRing 2s ease-out infinite; }
    @keyframes lcwRing {
      0%   { transform: scale(.85); opacity: .65; }
      85%  { transform: scale(1.9); opacity: 0; }
      100% { transform: scale(1.9); opacity: 0; }
    }
    /* Attention: wiggle on new message */
    .lcw-btn.wiggle { animation: lcwWiggle .7s ease-in-out; }
    @keyframes lcwWiggle {
      0%, 100%   { transform: rotate(0); }
      20%, 60%   { transform: rotate(-10deg); }
      40%, 80%   { transform: rotate(10deg); }
    }

    /* "Need help?" tooltip pill */
    .lcw-tip {
      position: fixed; bottom: 32px; right: 88px; z-index: 9997;
      background: var(--bg-2, #fff); color: var(--text, #0b1624);
      border: 1px solid var(--border, #dbe3ec); border-radius: 100px;
      padding: .5rem .85rem; font-family: 'Outfit', system-ui, sans-serif;
      font-size: .82rem; font-weight: 500;
      box-shadow: 0 6px 20px rgba(0,0,0,.14);
      display: flex; align-items: center; gap: .45rem;
      white-space: nowrap;
      opacity: 0; transform: translateX(8px); pointer-events: none;
      transition: opacity .3s ease, transform .3s ease;
      cursor: pointer;
    }
    .lcw-tip.show { opacity: 1; transform: none; pointer-events: auto; }
    .lcw-tip::after {
      content: ''; position: absolute; right: -5px; top: 50%;
      transform: translateY(-50%) rotate(45deg);
      width: 10px; height: 10px; background: var(--bg-2, #fff);
      border-right: 1px solid var(--border, #dbe3ec);
      border-top: 1px solid var(--border, #dbe3ec);
    }
    .lcw-tip .lcw-tip-close {
      margin-left: .15rem; border: none; background: transparent;
      color: var(--muted, #6b7f93); font-size: 1rem;
      padding: 0 .15rem; line-height: 1; cursor: pointer;
    }

    /* Panel */
    .lcw-panel{position:fixed;bottom:88px;right:22px;z-index:9999;width:min(380px,calc(100vw - 32px));
      max-height:min(560px,calc(100vh - 110px));background:var(--bg-2,#fff);color:var(--text,#0b1624);
      border:1px solid var(--border,#dbe3ec);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.22);
      display:flex;flex-direction:column;overflow:hidden;font-family:'Outfit',system-ui,sans-serif;
      transform:translateY(12px);opacity:0;pointer-events:none;transition:transform .2s,opacity .2s}
    .lcw-panel.open{transform:none;opacity:1;pointer-events:auto}
    .lcw-head{display:flex;align-items:center;gap:.6rem;padding:.8rem 1rem;background:var(--teal,#0d9488);color:#fff}
    .lcw-head .lcw-avatar{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.2);
      display:flex;align-items:center;justify-content:center;font-weight:700}
    .lcw-head h3{margin:0;font-size:.92rem;font-weight:600}
    .lcw-head small{display:block;opacity:.82;font-size:.72rem}
    .lcw-head button{margin-left:auto;background:none;border:none;color:#fff;font-size:1.1rem;cursor:pointer;padding:4px 8px}
    .lcw-log{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.6rem;background:var(--bg,#f4f7fa)}
    .lcw-msg{max-width:84%;padding:.6rem .85rem;border-radius:14px;font-size:.85rem;line-height:1.45;word-wrap:break-word}
    .lcw-msg.owner{align-self:flex-start;background:var(--bg-2,#fff);color:var(--text,#0b1624);
      border:1px solid var(--border,#dbe3ec);border-bottom-left-radius:4px}
    .lcw-msg.visitor{align-self:flex-end;background:var(--teal,#0d9488);color:#fff;border-bottom-right-radius:4px}
    .lcw-msg.system{align-self:center;background:transparent;color:var(--muted,#6b7f93);font-size:.72rem;text-align:center;padding:.2rem}
    .lcw-msg .lcw-meta{display:block;margin-top:.3rem;font-size:.65rem;opacity:.7}
    .lcw-form{display:flex;gap:.4rem;padding:.7rem;background:var(--bg-2,#fff);border-top:1px solid var(--border,#dbe3ec)}
    .lcw-form input{flex:1;padding:.55rem .8rem;border:1px solid var(--border,#dbe3ec);border-radius:100px;
      font-family:inherit;font-size:.85rem;background:var(--bg,#f4f7fa);color:var(--text,#0b1624)}
    .lcw-form input:focus{outline:none;border-color:var(--teal,#0d9488)}
    .lcw-form button{width:38px;height:38px;border-radius:50%;border:none;background:var(--teal,#0d9488);color:#fff;cursor:pointer}
    .lcw-form button:disabled{opacity:.4;cursor:default}

    @media(max-width:480px){
      .lcw-panel{right:12px;left:12px;bottom:80px;width:auto}
      .lcw-btn{right:16px;bottom:16px}
      .lcw-tip{right:82px;bottom:26px;font-size:.78rem}
    }

    @media (prefers-reduced-motion: reduce) {
      .lcw-btn.pulse, .lcw-btn.wiggle { animation: none !important; }
      .lcw-btn.ripple::after { display: none; }
      .lcw-tip { transition: opacity .15s ease; }
    }
  `;

  function injectCSS() {
    if (document.getElementById('lcw-css')) return;
    const s = document.createElement('style');
    s.id = 'lcw-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function boot() {
    injectCSS();
    if (document.getElementById('lcw-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'lcw-btn'; btn.id = 'lcw-btn';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Chat with support');
    btn.innerHTML = '<i class="fas fa-comment-dots"></i><span class="lcw-badge" id="lcw-badge">0</span>';
    document.body.appendChild(btn);

    // "Need help?" tooltip
    const tip = document.createElement('div');
    tip.className = 'lcw-tip'; tip.id = 'lcw-tip';
    tip.setAttribute('role', 'button');
    tip.setAttribute('tabindex', '0');
    tip.innerHTML = `<span>Need help? 💬</span><button type="button" class="lcw-tip-close" aria-label="Dismiss">×</button>`;
    document.body.appendChild(tip);

    const panel = document.createElement('div');
    panel.className = 'lcw-panel'; panel.id = 'lcw-panel';
    panel.setAttribute('role', 'dialog');
    panel.innerHTML = `
      <div class="lcw-head">
        <div class="lcw-avatar">M</div>
        <div><h3>MUJTIC Support</h3><small id="lcw-status">Send us a message</small></div>
        <button id="lcw-close" aria-label="Close">&times;</button>
      </div>
      <div class="lcw-log" id="lcw-log"></div>
      <form class="lcw-form" id="lcw-form">
        <input id="lcw-input" placeholder="Type your message…" autocomplete="off" maxlength="2000">
        <button type="submit" id="lcw-send" aria-label="Send"><i class="fas fa-paper-plane"></i></button>
      </form>`;
    document.body.appendChild(panel);

    const log      = document.getElementById('lcw-log');
    const input    = document.getElementById('lcw-input');
    const sendBtn  = document.getElementById('lcw-send');
    const statusEl = document.getElementById('lcw-status');
    const badgeEl  = document.getElementById('lcw-badge');

    let convId = null;
    let lastAt = null;
    let pollTimer = null;
    let busy = false;
    let closedShown = false;

    // ── Attention sequence ──────────────────────────────────
    let attentionTimers = [];

    function stopAttention() {
      attentionTimers.forEach(clearTimeout);
      attentionTimers = [];
      btn.classList.remove('pulse', 'ripple');
      tip.classList.remove('show');
    }

    function startAttention() {
      if (seenThisSession()) return;

      attentionTimers.push(setTimeout(() => {
        btn.classList.add('pulse', 'ripple');
        tip.classList.add('show');
      }, 3500));

      attentionTimers.push(setTimeout(() => {
        btn.classList.remove('pulse', 'ripple');
      }, 10000));

      attentionTimers.push(setTimeout(() => {
        tip.classList.remove('show');
      }, 12000));
    }

    tip.addEventListener('click', (e) => {
      if (e.target.closest('.lcw-tip-close')) {
        e.stopPropagation();
        tip.classList.remove('show');
        stopAttention();
        markSeen();
        return;
      }
      open();
    });
    tip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    // ── Chat logic ─────────────────────────────────────────

    function bubble(role, text, meta) {
      const el = document.createElement('div');
      el.className = `lcw-msg ${role}`;
      el.innerHTML = esc(text) + (meta ? `<span class="lcw-meta">${esc(meta)}</span>` : '');
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    }
    function system(text) { bubble('system', text); }

    async function startConv() {
      try {
        const u = window.app?.currentUser;
        const r = await fetch(`${API}/chat/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visitorId: visitorId(), name: u?.name, email: u?.email }),
        }).then(r => r.json());
        if (!r.success) throw new Error(r.message);
        convId = r.conversation._id;
        statusEl.textContent = 'We reply within 2–4 hours';
        return true;
      } catch (err) {
        statusEl.textContent = 'Could not connect. Try again.';
        return false;
      }
    }

    // Called when the server says the conversation no longer exists (admin
    // deleted it). Reset local state so the next send opens a fresh thread.
    function resetForRemovedConversation(showMessage) {
      convId = null;
      lastAt = null;
      closedShown = true;
      if (showMessage) {
        system('This conversation was removed. Send a new message to start fresh.');
      }
    }

    async function load(since = null) {
      if (!convId) return;
      try {
        const q = `visitorId=${encodeURIComponent(visitorId())}` + (since ? `&since=${encodeURIComponent(since)}` : '');
        const r = await fetch(`${API}/chat/${convId}?${q}`).then(r => r.json());

        if (!r.success) {
          if (isNotFound(r.message)) resetForRemovedConversation(true);
          return;
        }

        if (r.conversation?.status === 'closed' && !closedShown) {
          closedShown = true;
          system('This conversation has been closed. Send a new message to start a fresh one.');
        }

        (r.messages || []).forEach(m => {
          bubble(m.from, m.text, fmtTime(m.createdAt));
          lastAt = m.createdAt;
        });
      } catch {}
    }

    async function sendMessage(text) {
      if (busy) return;
      text = text.trim(); if (!text) return;
      busy = true; sendBtn.disabled = true;

      if (closedShown) {
        convId = null; lastAt = null; closedShown = false;
        log.innerHTML = '';
      }

      if (!convId && !(await startConv())) {
        busy = false; sendBtn.disabled = false; return;
      }

      bubble('visitor', text, 'Sending…');
      input.value = '';

      try {
        const r = await fetch(`${API}/chat/${convId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visitorId: visitorId(), text }),
        }).then(r => r.json());

        if (!r.success) {
          // Deleted mid-send: backend responds 404 "Conversation not found".
          // Wipe the optimistic bubble, reset state, keep their text so they
          // can just press enter again — the next attempt starts fresh.
          if (isNotFound(r.message)) {
            log.innerHTML = '';
            convId = null;
            lastAt = null;
            closedShown = false;
            system('This conversation was removed. Press send to start a new one.');
            input.value = text;
            return;
          }
          throw new Error(r.message);
        }

        lastAt = r.message.createdAt;
        const last = [...log.querySelectorAll('.lcw-msg.visitor')].pop();
        if (last && last.querySelector('.lcw-meta')) {
          last.querySelector('.lcw-meta').textContent = fmtTime(r.message.createdAt);
        }
        if (!log.dataset.greeted) {
          system('Message sent — a team member will reply soon.');
          log.dataset.greeted = '1';
        }
      } catch (err) {
        system('Could not send: ' + (err.message || 'try again'));
      } finally {
        busy = false; sendBtn.disabled = false; input.focus();
      }
    }

    function startPolling() {
      stopPolling();
      pollTimer = setInterval(async () => {
        if (document.hidden) return;
        await load(lastAt);
      }, POLL_MS);
    }
    function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    async function open() {
      stopAttention();
      markSeen();
      panel.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.remove('has-badge');
      badgeEl.textContent = '0';
      if (!convId) {
        system('Connecting…');
        const ok = await startConv();
        log.innerHTML = '';
        if (ok) system('Hi 👋 Send us a message — we reply within 2–4 hours.');
        else system('Could not connect. Please try again later.');
      }
      await load(null);
      startPolling();
      setTimeout(() => input.focus(), 200);
    }
    function close() {
      panel.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      stopPolling();
    }

    btn.onclick = () => panel.classList.contains('open') ? close() : open();
    document.getElementById('lcw-close').onclick = close;
    document.getElementById('lcw-form').onsubmit = e => { e.preventDefault(); sendMessage(input.value); };

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && panel.classList.contains('open') && convId) load(lastAt);
    });

    // Unread badge + wiggle for owner replies while the panel is closed.
    // Also detects a mid-session delete (404 from server) and quietly resets
    // so the next open() creates a fresh thread.
    setInterval(async () => {
      if (!convId || panel.classList.contains('open')) return;
      try {
        const r = await fetch(`${API}/chat/${convId}?visitorId=${encodeURIComponent(visitorId())}`).then(r => r.json());

        if (!r.success) {
          if (isNotFound(r.message)) {
            // Silent reset — the panel is closed so no message to show.
            // Next open() sees !convId and starts fresh with a greeting.
            convId = null;
            lastAt = null;
            closedShown = false;
            btn.classList.remove('has-badge');
            badgeEl.textContent = '0';
          }
          return;
        }

        const ownerMsgs = (r.messages || []).filter(m => m.from === 'owner' && (!lastAt || m.createdAt > lastAt));
        if (ownerMsgs.length) {
          lastAt = ownerMsgs[ownerMsgs.length - 1].createdAt;
          btn.classList.add('has-badge');
          badgeEl.textContent = String(Math.min(ownerMsgs.length, 9));
          btn.classList.remove('wiggle');
          void btn.offsetWidth;
          btn.classList.add('wiggle');
          setTimeout(() => btn.classList.remove('wiggle'), 800);
        }
      } catch {}
    }, 8000);

    if (!document.hidden) startAttention();
    else document.addEventListener('visibilitychange', function once() {
      if (!document.hidden) { startAttention(); document.removeEventListener('visibilitychange', once); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
