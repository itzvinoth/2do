// Markdown import/export. The format is a plain Markdown task list, one
// "## Category" heading per category, with task metadata as trailing inline
// code tokens so that the file stays readable anywhere. Indented items are
// subtasks of the item above them:
//
//   ## Personal
//
//   - [ ] Buy milk `priority:high` `due:2026-11-10`
//     > Optional notes, indented and quoted.
//     - [ ] Check the fridge first
//   - [x] Pay rent `priority:medium` `done:2026-11-03T14:20:00.000Z`

import { PRIORITIES, uid } from './store.js';

const KEYS = ['priority', 'due', 'done', 'created'];
const reToken = new RegExp(`\\s+\`(${KEYS.join('|')}):([^\`\\s]+)\`$`);
const reTask = /^[-*+]\s+(?:\[([ xX])\]\s+)?(.+)$/;
const reDate = /^\d{4}-\d{2}-\d{2}$/;

export function toMarkdown({ categories, tasks }) {
  const out = ['# 2do', '', `Exported on ${new Date().toLocaleString()}`, ''];

  // Open tasks first, then finished ones; otherwise in stored order.
  const children = parentId => tasks.filter(t => (t.parentId || null) === parentId)
    .sort((a, b) => !!a.completedAt - !!b.completedAt);

  const write = (t, depth) => {
    const pad = '  '.repeat(depth);
    let line = `${pad}- [${t.completedAt ? 'x' : ' '}] ${t.title.replace(/\n/g, ' ')} \`priority:${t.priority}\``;
    if (t.due) line += ` \`due:${t.due}\``;
    if (t.completedAt) line += ` \`done:${t.completedAt}\``;
    if (t.createdAt) line += ` \`created:${t.createdAt}\``;
    out.push(line);

    for (const n of (t.notes || '').split('\n').filter(Boolean)) {
      out.push(`${pad}  > ${n}`);
    }
    children(t.id).forEach(c => write(c, depth + 1));
  };

  for (const c of categories) {
    out.push(`## ${c.name}`, '');
    children(null).filter(t => t.categoryId === c.id).forEach(t => write(t, 0));
    out.push('');
  }

  return out.join('\n');
}

export function fromMarkdown(text) {
  const categories = [];
  const tasks = [];
  let cat = null;
  let last = null;

  // Tasks that can still take subtasks, with their indentation.
  let stack = [];

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
    const line = raw.replace(/\t/g, '    ').trimEnd();
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (line.startsWith('## ')) {
      cat = category(line.slice(3).trim() || 'Imported');
      last = null;
      stack = [];
      continue;
    }

    // Indented quoted lines (or plain indented text) under a task are its notes.
    if (last && indent >= 2 && (trimmed.startsWith('>') || !reTask.test(trimmed))) {
      last.notes += (last.notes ? '\n' : '') + trimmed.replace(/^>\s?/, '');
      continue;
    }

    const m = trimmed.match(reTask);
    if (!m) {
      last = null;
      if (trimmed) stack = [];
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

    // The parent is the nearest task above with less indentation.
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1)?.task ?? null;

    const done = m[1] && m[1] !== ' ';
    cat ??= category('Imported');

    last = {
      id: uid(),
      parentId: parent?.id ?? null,
      title,
      notes: '',
      priority: PRIORITIES.includes(meta.priority) ? meta.priority : 'low',
      due: reDate.test(meta.due || '') ? meta.due : null,
      categoryId: cat.id,
      createdAt: validISO(meta.created) || new Date().toISOString(),
      completedAt: done ? (validISO(meta.done) || new Date().toISOString()) : null,
    };
    tasks.push(last);
    stack.push({ indent, task: last });
  }

  return { categories, tasks };
}

function validISO(s) {
  return s && !isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
}
