// Markdown import/export. The format is a plain Markdown task list, one
// "## Category" heading per category, with task metadata as trailing inline
// code tokens so that the file stays readable anywhere. Indented items are
// subtasks of the item above them:
//
//   ## Personal
//
//   > Optional category notes, quoted and not indented.
//
//   - [ ] Buy milk `priority:high` `due:2026-11-10`
//     > Optional notes, indented and quoted.
//     - [ ] Check the fridge first
//   - [ ] Fix the tap `started:2026-11-04T09:00:00.000Z`
//   - [x] Pay rent `priority:medium` `done:2026-11-03T14:20:00.000Z`
//
// On import, `- [/] Title` also marks a task as in progress.

import { PRIORITIES, uid } from './store.js';

const KEYS = ['priority', 'due', 'started', 'done', 'created'];
const reToken = new RegExp(`\\s+\`(${KEYS.join('|')}):([^\`\\s]+)\`$`);
const reTask = /^[-*+]\s+(?:\[([ xX/])\]\s+)?(.+)$/;
const reDate = /^\d{4}-\d{2}-\d{2}$/;

export function toMarkdown({ categories, tasks }) {
  const out = ['# 2do', '', `Exported on ${new Date().toLocaleString()}`, ''];

  for (const c of categories) {
    out.push(`## ${c.name}`, '');
    writeNotes(out, c.notes);
    children(tasks, null).filter(t => t.categoryId === c.id).forEach(t => write(out, tasks, t, 0, true));
    out.push('');
  }

  return out.join('\n');
}

// One task and its subtasks, for copying. Leaves out the default priority and
// creation times so the text reads well when pasted; it still imports.
export function taskToMarkdown(task, tasks) {
  const out = [];
  write(out, tasks, task, 0, false);
  return out.join('\n');
}

// A category's notes and open tasks under its heading, for copying.
export function categoryToMarkdown(cat, roots, tasks) {
  const out = [`## ${cat.name}`, ''];
  writeNotes(out, cat.notes);
  roots.forEach(t => write(out, tasks, t, 0, false));
  return out.join('\n');
}

// Open tasks first, then finished ones, each in their manual order.
function children(tasks, parentId) {
  return tasks.filter(t => (t.parentId || null) === parentId)
    .sort((a, b) => !!a.completedAt - !!b.completedAt || a.order - b.order);
}

// Category notes as a quote block; blank lines stay as empty quote lines so
// paragraphs survive.
function writeNotes(out, notes) {
  if (!notes) return;
  notes.split('\n').forEach(n => out.push(n ? `> ${n}` : '>'));
  out.push('');
}

function write(out, tasks, t, depth, full) {
  const pad = '  '.repeat(depth);
  let line = `${pad}- [${t.completedAt ? 'x' : ' '}] ${t.title.replace(/\n/g, ' ')}`;
  if (full || t.priority !== 'low') line += ` \`priority:${t.priority}\``;
  if (t.due) line += ` \`due:${t.due}\``;
  if (t.startedAt) line += ` \`started:${t.startedAt}\``;
  if (t.completedAt) line += ` \`done:${t.completedAt}\``;
  if (full && t.createdAt) line += ` \`created:${t.createdAt}\``;
  out.push(line);

  for (const n of (t.notes || '').split('\n').filter(Boolean)) {
    out.push(`${pad}  > ${n}`);
  }
  children(tasks, t.id).forEach(c => write(out, tasks, c, depth + 1, full));
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
      c = { id: uid(), name, notes: '' };
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

    // Quoted lines that aren't indented are the category's notes.
    if (cat && indent === 0 && trimmed.startsWith('>')) {
      cat.notes += (cat.notes ? '\n' : '') + trimmed.replace(/^>\s?/, '');
      last = null;
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

    const done = m[1] === 'x' || m[1] === 'X';
    cat ??= category('Imported');

    last = {
      id: uid(),
      parentId: parent?.id ?? null,
      title,
      notes: '',
      priority: PRIORITIES.includes(meta.priority) ? meta.priority : 'low',
      due: reDate.test(meta.due || '') ? meta.due : null,
      categoryId: cat.id,
      order: tasks.length,
      startedAt: validISO(meta.started) || (m[1] === '/' ? new Date().toISOString() : null),
      createdAt: validISO(meta.created) || new Date().toISOString(),
      completedAt: done ? (validISO(meta.done) || new Date().toISOString()) : null,
    };
    tasks.push(last);
    stack.push({ indent, task: last });
  }

  categories.forEach(c => c.notes = c.notes.trim());
  return { categories, tasks };
}

function validISO(s) {
  return s && !isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
}
