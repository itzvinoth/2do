// Markdown import/export. The format is a plain Markdown task list, one
// "## Category" heading per category, with task metadata as trailing inline
// code tokens so that the file stays readable anywhere:
//
//   ## Personal
//
//   - [ ] Buy milk `priority:high` `due:2026-11-10`
//     > Optional notes, indented and quoted.
//   - [x] Pay rent `priority:medium` `done:2026-11-03T14:20:00.000Z`

import { PRIORITIES, uid } from './store.js';

const KEYS = ['priority', 'due', 'done', 'created'];
const reToken = new RegExp(`\\s+\`(${KEYS.join('|')}):([^\`\\s]+)\`$`);
const reTask = /^[-*+]\s+(?:\[([ xX])\]\s+)?(.+)$/;
const reDate = /^\d{4}-\d{2}-\d{2}$/;

export function toMarkdown({ categories, tasks }) {
  const out = ['# 2do', '', `Exported on ${new Date().toLocaleString()}`, ''];

  for (const c of categories) {
    out.push(`## ${c.name}`, '');

    // Open tasks first, then finished ones.
    const list = tasks.filter(t => t.categoryId === c.id)
      .sort((a, b) => !!a.completedAt - !!b.completedAt);

    for (const t of list) {
      let line = `- [${t.completedAt ? 'x' : ' '}] ${t.title.replace(/\n/g, ' ')} \`priority:${t.priority}\``;
      if (t.due) line += ` \`due:${t.due}\``;
      if (t.completedAt) line += ` \`done:${t.completedAt}\``;
      if (t.createdAt) line += ` \`created:${t.createdAt}\``;
      out.push(line);

      for (const n of (t.notes || '').split('\n').filter(Boolean)) {
        out.push(`  > ${n}`);
      }
    }
    out.push('');
  }

  return out.join('\n');
}

export function fromMarkdown(text) {
  const categories = [];
  const tasks = [];
  let cat = null;
  let last = null;

  // A repeated heading (case-insensitive) continues the same category.
  const category = name => {
    let c = categories.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!c) {
      c = { id: uid(), name };
      categories.push(c);
    }
    return c;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();

    if (line.startsWith('## ')) {
      cat = category(line.slice(3).trim() || 'Imported');
      last = null;
      continue;
    }

    // Indented lines under a task are its notes.
    const trimmed = line.trim();
    if (last && /^\s{2,}\S/.test(line) && (trimmed.startsWith('>') || !reTask.test(trimmed))) {
      last.notes += (last.notes ? '\n' : '') + trimmed.replace(/^>\s?/, '');
      continue;
    }

    const m = trimmed.match(reTask);
    if (!m) {
      last = null;
      continue;
    }

    let title = m[2];
    const meta = {};
    let tm;
    while ((tm = title.match(reToken))) {
      meta[tm[1]] = tm[2];
      title = title.slice(0, tm.index);
    }
    title = title.trim();
    if (!title) continue;

    const done = m[1] && m[1] !== ' ';
    cat ??= category('Imported');

    last = {
      id: uid(),
      title,
      notes: '',
      priority: PRIORITIES.includes(meta.priority) ? meta.priority : 'low',
      due: reDate.test(meta.due || '') ? meta.due : null,
      categoryId: cat.id,
      createdAt: validISO(meta.created) || new Date().toISOString(),
      completedAt: done ? (validISO(meta.done) || new Date().toISOString()) : null,
    };
    tasks.push(last);
  }

  return { categories, tasks };
}

function validISO(s) {
  return s && !isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
}
