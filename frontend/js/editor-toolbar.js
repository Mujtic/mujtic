/* ============================================================
   Mujtic rich-text editor  (js/editor-toolbar.js)
   - MujticEditor.attach(textarea)  visual editor; the textarea stays
                                    the (hidden) source of truth
   - MujticEditor.render(text)      saved text -> safe HTML
   - MujticEditor.plain(text)       strips formatting (meta tags etc.)
   - MujticEditor.sync(textarea)    reload the editor from the textarea

   Saved format (unchanged):
     **bold**  _italic_  ## heading  - bullet  1. numbered
     [label](https://url)   {center} text  /  {right} text
   The editor never saves HTML: its DOM is converted to this format,
   and render() escapes all text before formatting, so nothing a user
   types or pastes can inject markup.
============================================================ */
(function (global) {
  'use strict';

  const esc = v => String(v ?? '').replace(/[&<>"'`]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch]));

  /* ───────── Render (saved text -> HTML) ───────── */
  function inline(s) {
    const stash = [];
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, t, u) => {
      stash.push(`<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
      return `\u0000${stash.length - 1}\u0000`;
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(>])_([^_\n]+)_(?=[\s.,!?;:)<]|$)/g, '$1<em>$2</em>');
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
      if (para.length && paraAl !== al) flushP();
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

  /* ───────── Serialize (editor DOM -> saved text) ───────── */
  // Whitelist walk: only text, bold, italic, links, headings, lists and
  // alignment are read. Everything else is reduced to its text.
  const BLOCK_RE = /^(div|p|h[1-6]|ul|ol|li|blockquote|pre|section|article|header|footer)$/;
  const tagOf = n => n.nodeName.toLowerCase();
  const isEl = n => n.nodeType === 1;

  function alignOf(el, inherit) {
    const s = (el.style && el.style.textAlign) || '';
    if (s === 'center' || s === 'right') return s;
    if (s === 'left' || s === 'start') return '';
    const a = (el.getAttribute && el.getAttribute('align') || '').toLowerCase();
    if (a === 'center' || a === 'right') return a;
    if (a === 'left') return '';
    if (el.classList) {
      if (el.classList.contains('md-al-center')) return 'center';
      if (el.classList.contains('md-al-right')) return 'right';
    }
    return inherit;
  }

  function wrapMark(text, mark) {
    return text.split('\n').map(seg => {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(seg);
      return m[2] ? m[1] + mark + m[2] + mark + m[3] : seg;
    }).join('\n');
  }

  function inl(n) {
    if (n.nodeType === 3) return n.nodeValue.replace(/\u00a0/g, ' ').replace(/[\r\n]+/g, ' ');
    if (!isEl(n)) return '';
    const t = tagOf(n);
    if (t === 'br') return '\n';
    if (t === 'script' || t === 'style') return '';
    let out = Array.from(n.childNodes).map(inl).join('');
    if (BLOCK_RE.test(t)) return out + '\n';

    const st = n.style || {};
    const fw = String(st.fontWeight || '');
    const bold = t === 'b' || t === 'strong' || fw === 'bold' || (+fw >= 600);
    const ital = t === 'i' || t === 'em' || st.fontStyle === 'italic';

    if (t === 'a') {
      let href = (n.getAttribute('href') || '').trim();
      if (/^(https?:\/\/|mailto:)/i.test(href) && out.trim()) {
        href = href.replace(/\s/g, '%20').replace(/\)/g, '%29');
        out = `[${out.replace(/[\[\]\n]/g, ' ').trim()}](${href})`;
      }
    }
    if (ital) out = wrapMark(out, '_');
    if (bold) out = wrapMark(out, '**');
    return out;
  }

  const inlText = el => Array.from(el.childNodes).map(inl).join('').replace(/\n+$/, '');

  function collect(parent, al, out) {
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const text = run.map(inl).join('').replace(/\n$/, '');
      if (text.trim() || run.some(n => isEl(n) && tagOf(n) === 'br')) out.push({ type: 'div', al, text });
      run = [];
    };
    for (const c of parent.childNodes) {
      if (isEl(c) && BLOCK_RE.test(tagOf(c))) {
        flush();
        const t = tagOf(c), a = alignOf(c, al);
        if (t === 'ul' || t === 'ol') {
          for (const li of c.children) {
            if (tagOf(li) !== 'li') continue;
            out.push({ type: t, al: alignOf(li, a), text: inlText(li) });
          }
        } else if (/^h[1-6]$/.test(t)) {
          out.push({ type: 'h', al: a, text: inlText(c) });
        } else if (Array.from(c.children).some(k => BLOCK_RE.test(tagOf(k)))) {
          collect(c, a, out);
        } else {
          out.push({ type: t === 'p' ? 'p' : 'div', al: a, text: inlText(c) });
        }
      } else run.push(c);
    }
    flush();
  }

  function serialize(root) {
    const blocks = [];
    collect(root, '', blocks);
    let md = '', prev = null, n = 0;
    for (const b of blocks) {
      const mk = b.al ? `{${b.al}} ` : '';
      let chunk;
      if (b.type === 'h') {
        const t = b.text.replace(/\n/g, ' ').trim();
        if (!t) continue;
        chunk = mk + '## ' + t;
      } else if (b.type === 'ul' || b.type === 'ol') {
        const t = b.text.replace(/\n/g, ' ').trim();
        if (!t) continue;
        n = (prev && prev.type === 'ol' && b.type === 'ol') ? n + 1 : 1;
        chunk = mk + (b.type === 'ul' ? '- ' : `${n}. `) + t;
      } else {
        chunk = b.text.split('\n').map(l => l.trim() ? mk + l.trim() : '').join('\n');
      }
      if (prev !== null) {
        const sameList = prev.type === b.type && (b.type === 'ul' || b.type === 'ol');
        const bothDiv = prev.type === 'div' && b.type === 'div';
        md += (sameList || bothDiv) ? '\n' : '\n\n';
      }
      md += chunk;
      prev = b;
    }
    return md.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '');
  }

  /* ───────── Attach ───────── */
  const STATE = {
    bold: 'bold', italic: 'italic', ul: 'insertUnorderedList', ol: 'insertOrderedList',
    'al-l': 'justifyLeft', 'al-c': 'justifyCenter', 'al-r': 'justifyRight',
  };

  function attach(ta) {
    if (!ta) return null;
    if (ta._mdApi) return ta._mdApi;

    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');

    const wrapEl = document.createElement('div');
    wrapEl.className = 'md-wrap';
    ta.parentNode.insertBefore(wrapEl, ta);

    const bar = document.createElement('div');
    bar.className = 'md-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Text formatting');

    const editor = document.createElement('div');
    editor.className = 'input md-editor md-body';
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    editor.setAttribute('aria-label', ta.getAttribute('aria-label') || 'Text');
    editor.dataset.placeholder = ta.getAttribute('placeholder') || '';
    editor.spellcheck = true;

    const hint = document.createElement('p');
    hint.className = 'md-hint';
    hint.textContent = 'Select text, then use the buttons. What you see here is what buyers will see.';

    wrapEl.append(bar, editor, ta, hint);
    ta.classList.add('md-ta-hidden');
    ta.tabIndex = -1;
    ta.setAttribute('aria-hidden', 'true');

    function load(md) {
      editor.innerHTML = render(md) || '<div><br></div>';
      editor.classList.toggle('is-empty', !String(md || '').trim());
    }
    function push() {
      const md = serialize(editor);
      desc.set.call(ta, md);                        // bypass our own setter below
      editor.classList.toggle('is-empty', !md);
    }

    // Code that sets textarea.value (e.g. when editing an event) updates the editor too
    Object.defineProperty(ta, 'value', {
      configurable: true, enumerable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); load(v); },
    });
    load(desc.get.call(ta));

    const form = ta.closest('form');
    if (form) form.addEventListener('reset', () => setTimeout(() => load(desc.get.call(ta)), 0));
    ta.addEventListener('focus', () => editor.focus());   // required-field validation lands here

    const focusEd = () => { if (document.activeElement !== editor) editor.focus(); };
    const cmd = (c, v) => { focusEd(); document.execCommand(c, false, v); push(); refresh(); };

    function heading() {
      focusEd();
      const cur = String(document.queryCommandValue('formatBlock') || '').toLowerCase().replace(/[<>]/g, '');
      document.execCommand('formatBlock', false, cur === 'h4' ? '<div>' : '<h4>');
      push(); refresh();
    }

    function link() {
      focusEd();
      const sel = global.getSelection();
      const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      let url = global.prompt('Link address (https://…)', 'https://');
      if (!url) return;
      url = url.trim();
      if (!/^(https?:\/\/|mailto:)/i.test(url)) {
        global.alert('Links must start with https://, http:// or mailto:');
        return;
      }
      editor.focus();
      if (saved) { sel.removeAllRanges(); sel.addRange(saved); }
      url = url.replace(/\s/g, '%20');
      if (sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>`);
      else document.execCommand('createLink', false, url);
      push();
    }

    const BUTTONS = [
      ['bold',   'fa-bold',         'Bold (Ctrl+B)',   () => cmd('bold')],
      ['italic', 'fa-italic',       'Italic (Ctrl+I)', () => cmd('italic')],
      ['h',      'fa-heading',      'Heading',         heading],
      ['ul',     'fa-list-ul',      'Bulleted list',   () => cmd('insertUnorderedList')],
      ['ol',     'fa-list-ol',      'Numbered list',   () => cmd('insertOrderedList')],
      ['link',   'fa-link',         'Link (Ctrl+K)',   link],
      ['sep'],
      ['al-l',   'fa-align-left',   'Align left',      () => cmd('justifyLeft')],
      ['al-c',   'fa-align-center', 'Align center',    () => cmd('justifyCenter')],
      ['al-r',   'fa-align-right',  'Align right',     () => cmd('justifyRight')],
    ];

    const btns = {};
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
      b.addEventListener('mousedown', e => e.preventDefault());   // keep the selection
      b.addEventListener('click', run);
      bar.appendChild(b);
      btns[id] = b;
    });

    function refresh() {
      const sel = global.getSelection();
      if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) return;
      Object.entries(STATE).forEach(([id, c]) => {
        let on = false;
        try { on = document.queryCommandState(c); } catch { /* ignore */ }
        btns[id].classList.toggle('is-on', !!on);
      });
      let blk = '';
      try { blk = String(document.queryCommandValue('formatBlock') || '').toLowerCase().replace(/[<>]/g, ''); } catch { /* ignore */ }
      btns.h.classList.toggle('is-on', blk === 'h4');
    }
    document.addEventListener('selectionchange', refresh);

    editor.addEventListener('input', push);
    editor.addEventListener('focus', () => {
      try {
        document.execCommand('defaultParagraphSeparator', false, 'div');
        document.execCommand('styleWithCSS', false, false);
      } catch { /* ignore */ }
    });
    editor.addEventListener('paste', e => {          // plain text only
      e.preventDefault();
      const t = (e.clipboardData || global.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, t);
    });
    editor.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); link(); }
    });

    ta._mdApi = { reload() { load(desc.get.call(ta)); }, editor };
    return ta._mdApi;
  }

  function autoAttach() {
    ['event-desc', 'event-terms'].forEach(id => attach(document.getElementById(id)));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoAttach);
  else autoAttach();

  global.MujticEditor = {
    attach, render, plain, serialize,
    sync(ta) { ta && ta._mdApi && ta._mdApi.reload(); },
  };
})(window);