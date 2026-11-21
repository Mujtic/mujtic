/* ============================================================
   Mujtic formatting toolbar  (js/editor-toolbar.js)
   - MujticEditor.attach(textarea)  adds the toolbar + preview
   - MujticEditor.render(text)      safe text -> HTML
   - MujticEditor.plain(text)       strips formatting (meta tags etc.)
   - MujticEditor.sync(textarea)    leaves preview mode (call after form.reset())

   Syntax:
     **bold**   _italic_   ## heading   - bullet   1. numbered
     [label](https://url)
     {center} text   /   {right} text     (alignment, per line)

   Everything is HTML-escaped BEFORE formatting is applied, so user
   text can never inject markup.
============================================================ */
(function (global) {
  'use strict';

  const esc = v => String(v ?? '').replace(/[&<>"'`]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch]));

  const ALIGN_RE = /^\{(?:center|right)\}[ ]?/;

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
    let para = [], paraAl = '', list = null;

    const cls = al => al ? ` class="md-al-${al}"` : '';
    const flushP = () => {
      if (para.length) {
        out.push(`<p${cls(paraAl)}>` + para.map(inline).join('<br>') + '</p>');
        para = [];
      }
    };
    const flushL = () => {
      if (list) {
        out.push(`<${list.t}${cls(list.al)}>` + list.items.map(i => `<li>${inline(i)}</li>`).join('') + `</${list.t}>`);
        list = null;
      }
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      const am = /^\{(center|right)\}[ ]?/.exec(line);
      const al = am ? am[1] : '';
      const body = am ? line.slice(am[0].length) : line;
      let m;

      if (!body.trim()) { flushP(); flushL(); continue; }

      if ((m = /^#{1,3}\s+(.+)$/.exec(body))) {
        flushP(); flushL();
        out.push(`<h4${cls(al)}>${inline(m[1])}</h4>`);
        continue;
      }
      if ((m = /^\s*[-*]\s+(.+)$/.exec(body))) {
        flushP();
        if (!list || list.t !== 'ul' || list.al !== al) { flushL(); list = { t: 'ul', al, items: [] }; }
        list.items.push(m[1]);
        continue;
      }
      if ((m = /^\s*\d+[.)]\s+(.+)$/.exec(body))) {
        flushP();
        if (!list || list.t !== 'ol' || list.al !== al) { flushL(); list = { t: 'ol', al, items: [] }; }
        list.items.push(m[1]);
        continue;
      }
      flushL();
      if (para.length && paraAl !== al) flushP();   // alignment change starts a new paragraph
      paraAl = al;
      para.push(body);
    }
    flushP(); flushL();
    return out.join('');
  }

  function plain(src) {
    return String(src ?? '')
      .replace(/^\{(?:center|right)\}[ ]?/gm, '')
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

  // splits "{center} text" into ["{center} ", "text"]
  const splitAlign = l => {
    const m = ALIGN_RE.exec(l);
    return m ? [m[0], l.slice(m[0].length)] : ['', l];
  };

  // Heading / bullet / numbered list on the selected lines. Keeps alignment markers.
  function prefixLines(ta, kind) {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const ls = s === 0 ? 0 : v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e); if (le < 0) le = v.length;
    const block = v.slice(ls, le);
    const first = kind === 'h' ? '## ' : kind === 'ul' ? '- ' : '1. ';
    if (!block.trim()) return exec(ta, ls, le, first, ls + first.length, ls + first.length);

    const re = { h: /^#{1,3}\s+/, ul: /^\s*[-*]\s+/, ol: /^\s*\d+[.)]\s+/ }[kind];
    const lines = block.split('\n');
    const allOn = lines.every(l => { const b = splitAlign(l)[1]; return !b.trim() || re.test(b); });
    let n = 0;
    const out = lines.map(l => {
      const [mk, body] = splitAlign(l);
      if (!body.trim()) return l;
      if (allOn) return mk + body.replace(re, '');
      const bare = body.replace(/^#{1,3}\s+|^\s*[-*]\s+|^\s*\d+[.)]\s+/, '');
      n++;
      return mk + (kind === 'h' ? '## ' : kind === 'ul' ? '- ' : `${n}. `) + bare;
    }).join('\n');
    exec(ta, ls, le, out, ls, ls + out.length);
  }

  // Alignment on the selected lines. kind: 'left' | 'center' | 'right'
  function align(ta, kind) {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const ls = s === 0 ? 0 : v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e); if (le < 0) le = v.length;
    const block = v.slice(ls, le);

    if (!block.trim()) {               // empty line: just drop the marker in
      if (kind === 'left') return;
      const t = `{${kind}} `;
      return exec(ta, ls, le, t, ls + t.length, ls + t.length);
    }
    const lines = block.split('\n');
    const cur = l => { const m = /^\{(center|right)\}/.exec(l); return m ? m[1] : 'left'; };
    const filled = lines.filter(l => l.trim());
    // clicking the active alignment again switches it off (back to left)
    const target = (kind !== 'left' && filled.every(l => cur(l) === kind)) ? 'left' : kind;

    const out = lines.map(l => {
      if (!l.trim()) return l;
      const bare = l.replace(ALIGN_RE, '');
      return target === 'left' ? bare : `{${target}} ${bare}`;
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
    ['bold',   'fa-bold',         'Bold (Ctrl+B)',   ta => wrap(ta, '**', '**', 'bold text')],
    ['italic', 'fa-italic',       'Italic (Ctrl+I)', ta => wrap(ta, '_', '_', 'italic text')],
    ['h',      'fa-heading',      'Heading',         ta => prefixLines(ta, 'h')],
    ['ul',     'fa-list-ul',      'Bulleted list',   ta => prefixLines(ta, 'ul')],
    ['ol',     'fa-list-ol',      'Numbered list',   ta => prefixLines(ta, 'ol')],
    ['link',   'fa-link',         'Link (Ctrl+K)',   link],
    ['sep'],
    ['al-l',   'fa-align-left',   'Align left',      ta => align(ta, 'left')],
    ['al-c',   'fa-align-center', 'Align center',    ta => align(ta, 'center')],
    ['al-r',   'fa-align-right',  'Align right',     ta => align(ta, 'right')],
  ];

  /* ───────── Attach ───────── */
  function attach(ta) {
    if (!ta) return null;
    if (ta._mdApi) return ta._mdApi;

    const bar = document.createElement('div');
    bar.className = 'md-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Text formatting');

    const fmtBtns = [];
    BUTTONS.forEach(([id, icon, title, run]) => {
      if (id === 'sep') {
        const d = document.createElement('span');
        d.className = 'md-sep';
        bar.appendChild(d);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'md-btn'; b.dataset.md = id;
      b.title = title; b.setAttribute('aria-label', title);
      b.innerHTML = `<i class="fas ${icon}"></i>`;
      b.addEventListener('mousedown', e => e.preventDefault());   // keep the text selection
      b.addEventListener('click', () => run(ta));
      bar.appendChild(b);
      fmtBtns.push(b);
    });

    const spacer = document.createElement('span');
    spacer.className = 'md-spacer';
    bar.appendChild(spacer);

    const pvBtn = document.createElement('button');
    pvBtn.type = 'button'; pvBtn.className = 'md-btn md-btn-text'; pvBtn.setAttribute('aria-pressed', 'false');
    pvBtn.innerHTML = '<i class="fas fa-eye"></i> Preview';
    bar.appendChild(pvBtn);

    const prev = document.createElement('div');
    prev.className = 'md-preview md-body'; prev.hidden = true;

    const hint = document.createElement('p');
    hint.className = 'md-hint';
    hint.textContent = 'Select text or lines, then use the buttons. Alignment shows as {center} or {right} at the start of a line. Use Preview to see the result.';

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
