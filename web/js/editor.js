// A minimal rich text editor for task notes: bold, italic, strikethrough,
// inline code, bulleted and numbered lists, and links. Notes are stored as a
// small subset of Markdown, so they export and import as readable text. The
// editor's HTML is always rebuilt from that Markdown (with everything
// escaped), so stored notes can't inject markup.

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const safeUrl = url => /^(https?:|mailto:)/i.test(url);

const reInline = /\\([\\*~`[\]])|`([^`]+)`|\*\*(.+?)\*\*|~~(.+?)~~|\*(.+?)\*|\[([^\]]+)\]\(([^)\s]+)\)/;
const reItem = /^(\s*)(-|\*|\d+\.)\s+(.*)$/;

function inline(s) {
  let out = '';
  let m;
  while ((m = s.match(reInline))) {
    out += esc(s.slice(0, m.index));
    if (m[1]) out += esc(m[1]);
    else if (m[2]) out += `<code>${esc(m[2])}</code>`;
    else if (m[3]) out += `<b>${inline(m[3])}</b>`;
    else if (m[4]) out += `<s>${inline(m[4])}</s>`;
    else if (m[5]) out += `<i>${inline(m[5])}</i>`;
    else if (safeUrl(m[7])) out += `<a href="${esc(m[7])}">${inline(m[6])}</a>`;
    else out += esc(m[0]);
    s = s.slice(m.index + m[0].length);
  }
  return out + esc(s);
}

export function mdToHtml(md) {
  const out = [];
  // Open lists, innermost last; each has an open <li>.
  const stack = [];
  const close = () => out.push(`</li></${stack.pop().tag}>`);

  for (const line of (md || '').split('\n')) {
    const m = line.match(reItem);
    if (!m) {
      while (stack.length) close();
      out.push(`<div>${line.trim() ? inline(line) : '<br>'}</div>`);
      continue;
    }

    const indent = m[1].length;
    const tag = m[2].endsWith('.') ? 'ol' : 'ul';
    while (stack.length && (stack.at(-1).indent > indent || (stack.at(-1).indent === indent && stack.at(-1).tag !== tag))) close();

    if (stack.length && stack.at(-1).indent === indent) {
      out.push('</li>');
    } else {
      out.push(`<${tag}>`);
      stack.push({ indent, tag });
    }
    out.push(`<li>${inline(m[3])}`);
  }
  while (stack.length) close();

  return out.join('');
}

export function htmlToMd(root) {
  const lines = [];
  let cur = '';
  const flush = () => { lines.push(cur.trimEnd()); cur = ''; };

  const wrap = (n, mark, depth) => {
    if (!n.textContent.trim()) return walk(n, depth);
    cur += mark;
    walk(n, depth);
    cur += mark;
  };

  const list = (el, depth) => {
    if (cur) flush();
    let i = 0;
    for (const c of el.children) {
      if (c.tagName === 'UL' || c.tagName === 'OL') {
        list(c, depth + 1);
      } else if (c.tagName === 'LI') {
        const marker = '  '.repeat(depth) + (el.tagName === 'OL' ? `${++i}. ` : '- ');
        cur = marker;
        walk(c, depth + 1);
        if (cur === marker) cur = '';
        if (cur) flush();
      }
    }
  };

  const walk = (node, depth) => {
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        cur += n.data.replace(/\u200b/g, '').replace(/\u00a0|\n/g, ' ').replace(/[\\*~`[\]]/g, '\\$&');
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;

      switch (n.tagName) {
        case 'BR': flush(); break;
        case 'B': case 'STRONG': wrap(n, '**', depth); break;
        case 'I': case 'EM': wrap(n, '*', depth); break;
        case 'S': case 'STRIKE': case 'DEL': wrap(n, '~~', depth); break;
        case 'CODE': if (n.textContent) cur += '`' + n.textContent.replace(/`/g, '') + '`'; break;
        case 'A': {
          const href = n.getAttribute('href') || '';
          if (safeUrl(href) && n.textContent.trim()) {
            cur += '[';
            walk(n, depth);
            cur += `](${href.replace(/[\s)]/g, encodeURIComponent)})`;
          } else {
            walk(n, depth);
          }
          break;
        }
        case 'UL': case 'OL': list(n, depth); break;
        case 'DIV': case 'P': case 'LI':
          if (cur.trim()) flush();
          walk(n, depth);
          if (cur.trim()) flush();
          break;
        default: walk(n, depth);
      }
    }
  };

  walk(root, 0);
  if (cur) flush();

  // Collapse runs of blank lines and trim the ends.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Wires up the toolbar buttons (data-cmd) and keyboard handling. askUrl
// returns a promise of the link address, or an empty string to cancel.
export function setupEditor(el, toolbar, askUrl) {
  document.execCommand('defaultParagraphSeparator', false, 'div');

  const run = async cmd => {
    el.focus();
    if (cmd === 'code') {
      const text = getSelection().toString();
      if (text) document.execCommand('insertHTML', false, `<code>${esc(text)}</code>&#8203;`);
    } else if (cmd === 'link') {
      const sel = getSelection();
      const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      let url = await askUrl();
      if (!url) return;
      if (!/^[a-z]+:/i.test(url)) url = url.includes('@') ? `mailto:${url}` : `https://${url}`;
      if (!safeUrl(url)) return;
      el.focus();
      if (range) { sel.removeAllRanges(); sel.addRange(range); }
      if (sel.isCollapsed) {
        document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>&nbsp;`);
      } else {
        document.execCommand('createLink', false, url);
      }
    } else {
      document.execCommand(cmd);
    }
    updateToolbar();
  };

  // mousedown, not click, so that the editor keeps its selection.
  toolbar.addEventListener('mousedown', e => {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    e.preventDefault();
    run(b.dataset.cmd);
  });

  const inListItem = () => {
    const n = getSelection().anchorNode;
    return !!(n?.nodeType === Node.ELEMENT_NODE ? n : n?.parentElement)?.closest('li');
  };

  el.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      run('link');
    } else if (e.key === 'Tab' && inListItem()) {
      e.preventDefault();
      document.execCommand(e.shiftKey ? 'outdent' : 'indent');
    } else if (mod && e.key.toLowerCase() === 'u') {
      // Underline isn't part of the format.
      e.preventDefault();
    }
  });

  // Only plain text comes in, so pasted or dropped markup can't sneak in.
  el.addEventListener('paste', e => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    const text = e.dataTransfer.getData('text/plain');
    const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    if (pos) getSelection().collapse(pos.offsetNode, pos.offset);
    if (text) document.execCommand('insertText', false, text);
  });

  // Ctrl+click opens a link; a plain click places the cursor as usual.
  el.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a && (e.ctrlKey || e.metaKey) && safeUrl(a.href)) window.open(a.href, '_blank', 'noopener');
  });

  const updateToolbar = () => {
    for (const b of toolbar.querySelectorAll('[data-cmd]')) {
      const cmd = b.dataset.cmd;
      if (cmd === 'code' || cmd === 'link') continue;
      b.setAttribute('aria-pressed', document.queryCommandState(cmd));
    }
  };
  document.addEventListener('selectionchange', () => {
    if (el.contains(getSelection().anchorNode)) updateToolbar();
  });
}
