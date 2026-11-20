/* ============================================================
   Mujtic formatting toolbar  (js/editor-toolbar.js)
   - MujticEditor.attach(textarea)  adds the toolbar + preview
   - MujticEditor.render(text)      safe text -> HTML
   - MujticEditor.plain(text)       strips formatting (meta tags etc.)
   - MujticEditor.sync(textarea)    leaves preview mode (call after form.reset())
   Everything is HTML-escaped BEFORE formatting is applied, so user
   text can never inject markup.
============================================================ */
(function (global) {
  'use strict';

  const esc = v => String(v ?? '').replace(/[&<>"'`]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch]));

  /* ───────── Rendering ───────── */
  function inline(s) {
    const stash = [];
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, t, u) => {
      stash.push(`<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
      return `\u0000${stash.length - 1}\u0000`;
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?;:)]|$)/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i] || '');
  }

  function render(src) {
    const clean = String(src ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
    const lines = esc(clean).split('\n');
    const out = [];
    let para = [], list = null;

    const flushP = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
    const flushL = () => {
      if (list) { out.push(`<${list.t}>` + list.items.map(i => `<li>${inline(i)}</li>`).join('') + `</${list.t}>`); list = null; }
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flushP(); flushL(); continue; }
      if ((m = /^#{1,3}\s+(.+)$/.exec(line))) { flushP(); flushL(); out.push(`<h4>${inline(m[1])}</h4>`); continue; }
      if ((m = /^\s*[-*]\s+(.+)$/.exec(line))) {
        flushP(); if (!list || list.t !== 'ul') { flushL(); list = { t: 'ul', items: [] }; }
        list.items.push(m[1]); continue;
      }
      if ((m = /^\s*\d+[.)]\s+(.+)$/.exec(line))) {
        flushP(); if (!list || list.t !== 'ol') { flushL(); list = { t: 'ol', items: [] }; }
        list.items.push(m[1]); continue;
      }
      flushL(); para.push(line);
    }
    flushP(); flushL();
    return out.join('');
  }

  function plain(src) {
    return String(src ?? '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,3}\s+/gm, '')
      .replace(/^\s*(?:[-*]|\d+[.)])\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|\s)_([^_]+)_/g, '$1$2')
      .replace(/\s+/g, ' ').trim();
  }

  /* ───────── Text operations ───────── */
  // insertText keeps the browser's undo stack; setRangeText is the fallback
  function exec(ta, start, end, text, selStart, selEnd) {
    ta.focus();
    ta.setSelectionRange(start, end);
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { /* fall through */ }
    if (!ok) {
      ta.setRangeText(text, start, end, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    ta.setSelectionRange(selStart, selEnd);
  }

  function wrap(ta, before, after, placeholder) {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd, sel = v.slice(s, e);
    // selection already contains the markers → remove them
    if (sel.length >= before.length + after.length && sel.startsWith(before) && sel.endsWith(after)) {
      const inner = sel.slice(before.length, sel.length - after.length);
      return exec(ta, s, e, inner, s, s + inner.length);
    }
    // markers sit just outside the selection → remove them
    if (s >= before.length && v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
      const a = s - before.length;
      return exec(ta, a, e + after.length, sel, a, a + sel.length);
    }
    const text = sel || placeholder;
    exec(ta, s, e, before + text + after, s + before.length, s + before.length + text.length);
  }

  function prefixLines(ta, kind) {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const ls = s === 0 ? 0 : v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e); if (le < 0) le = v.length;
    const block = v.slice(ls, le);
    const first = kind === 'h' ? '## ' : kind === 'ul' ? '- ' : '1. ';
    if (!block.trim()) return exec(ta, ls, le, first, ls + first.length, ls + first.length);

    const re = { h: /^#{1,3}\s+/, ul: /^\s*[-*]\s+/, ol: /^\s*\d+[.)]\s+/ }[kind];
    const lines = block.split('\n');
    const allOn = lines.every(l => !l.trim() || re.test(l));
    let n = 0;
    const out = lines.map(l => {
      if (!l.trim()) return l;
      if (allOn) return l.replace(re, '');
      const bare = l.replace(/^#{1,3}\s+|^\s*[-*]\s+|^\s*\d+[.)]\s+/, '');
      n++;
      return (kind === 'h' ? '## ' : kind === 'ul' ? '- ' : `${n}. `) + bare;
    }).join('\n');
    exec(ta, ls, le, out, ls, ls + out.length);
  }

  function link(ta) {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const label = v.slice(s, e) || 'link text';
    let url = global.prompt('Link address (https://…)', 'https://');
    if (!url) return;
    url = url.trim();
    if (!/^(https?:\/\/|mailto:)/i.test(url)) {
      global.alert('Links must start with https://, http:// or mailto:');
      return;
    }
    url = url.replace(/\s/g, '%20').replace(/\)/g, '%29');
    exec(ta, s, e, `[${label}](${url})`, s + 1, s + 1 + label.length);
  }

  const BUTTONS = [
    ['bold',   'fa-bold',      'Bold (Ctrl+B)',   ta => wrap(ta, '**', '**', 'bold text')],
    ['italic', 'fa-italic',    'Italic (Ctrl+I)', ta => wrap(ta, '_', '_', 'italic text')],
    ['h',      'fa-heading',   'Heading',         ta => prefixLines(ta, 'h')],
    ['ul',     'fa-list-ul',   'Bulleted list',   ta => prefixLines(ta, 'ul')],
    ['ol',     'fa-list-ol',   'Numbered list',   ta => prefixLines(ta, 'ol')],
    ['link',   'fa-link',      'Link (Ctrl+K)',   link],
  ];

  /* ───────── Attach ───────── */
  function attach(ta) {
    if (!ta) return null;
    if (ta._mdApi) return ta._mdApi;

    const bar = document.createElement('div');
    bar.className = 'md-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Text formatting');

    const fmtBtns = BUTTONS.map(([id, icon, title, run]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'md-btn'; b.dataset.md = id;
      b.title = title; b.setAttribute('aria-label', title);
      b.innerHTML = `<i class="fas ${icon}"></i>`;
      b.addEventListener('mousedown', e => e.preventDefault());   // keep the text selection
      b.addEventListener('click', () => run(ta));
      bar.appendChild(b);
      return b;
    });

    const spacer = document.createElement('span'); spacer.className = 'md-spacer'; bar.appendChild(spacer);

    const pvBtn = document.createElement('button');
    pvBtn.type = 'button'; pvBtn.className = 'md-btn md-btn-text'; pvBtn.setAttribute('aria-pressed', 'false');
    pvBtn.innerHTML = '<i class="fas fa-eye"></i> Preview';
    bar.appendChild(pvBtn);

    const prev = document.createElement('div');
    prev.className = 'md-preview md-body'; prev.hidden = true;

    const hint = document.createElement('p');
    hint.className = 'md-hint';
    hint.textContent = 'Select text, then use the buttons. Use Preview to see what buyers will see.';

    ta.parentNode.insertBefore(bar, ta);
    ta.parentNode.insertBefore(prev, ta.nextSibling);
    prev.parentNode.insertBefore(hint, prev.nextSibling);
    ta.classList.add('md-textarea');

    function setPreview(on) {
      if (on) prev.innerHTML = render(ta.value) || '<p class="md-empty">Nothing to preview yet.</p>';
      prev.hidden = !on;
      // hidden visually but still focusable, so a `required` textarea never blocks form submit
      ta.classList.toggle('md-ta-hidden', on);
      fmtBtns.forEach(b => { b.disabled = on; });
      pvBtn.setAttribute('aria-pressed', String(on));
      pvBtn.innerHTML = on ? '<i class="fas fa-pen"></i> Edit' : '<i class="fas fa-eye"></i> Preview';
    }
    pvBtn.addEventListener('mousedown', e => e.preventDefault());
    pvBtn.addEventListener('click', () => setPreview(prev.hidden));

    ta.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); wrap(ta, '**', '**', 'bold text'); }
      else if (k === 'i') { e.preventDefault(); wrap(ta, '_', '_', 'italic text'); }
      else if (k === 'k') { e.preventDefault(); link(ta); }
    });

    ta._mdApi = { setPreview };
    return ta._mdApi;
  }

  global.MujticEditor = {
    attach, render, plain,
    sync(ta) { ta && ta._mdApi && ta._mdApi.setPreview(false); },
  };
})(window);
