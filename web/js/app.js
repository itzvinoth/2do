import * as store from './store.js';
import { toMarkdown, fromMarkdown, taskToMarkdown, categoryToMarkdown } from './markdown.js';
import { mdToHtml, htmlToMd, setupEditor } from './editor.js';

const $ = (sel, el = document) => el.querySelector(sel);

const PRIORITY = {
  high: { label: 'High', rank: 0 },
  medium: { label: 'Medium', rank: 1 },
  low: { label: 'Low', rank: 2 },
};

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// Task titles are plain text, except that `backticks` render as inline code.
const fmtTitle = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const icon = name => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// Dates. Due dates are local YYYY-MM-DD strings.
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function fmtDay(d) {
  const today = new Date();
  if (ymd(d) === ymd(today)) return 'Today';
  if (ymd(d) === ymd(addDays(today, -1))) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtShort(d) {
  const opt = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opt.year = 'numeric';
  return d.toLocaleDateString(undefined, opt);
}

function fmtDue(due) {
  const today = new Date();
  if (due === ymd(today)) return 'Today';
  if (due === ymd(addDays(today, 1))) return 'Tomorrow';
  if (due === ymd(addDays(today, -1))) return 'Yesterday';
  return fmtShort(parseYmd(due));
}

const dueState = due => !due ? '' : due < ymd(new Date()) ? 'overdue' : due === ymd(new Date()) ? 'today' : 'later';

const fmtTime = d => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// Routing: #/all, #/archive, #/c/<category id>.
function route() {
  const [, view, id] = location.hash.split('/');
  if (view === 'archive') return { view: 'archive' };
  if (view === 'c' && store.get().categories.some(c => c.id === id)) return { view: 'category', id };
  return { view: 'all' };
}

// The task being typed in the add row, and the inline subtask input
// ({parentId, title}). Kept across re-renders.
const draft = { title: '', priority: 'low', due: null, categoryId: null };
let subDraft = null;

// Element to focus, or task to start renaming, after the next render.
let focusId = 'add-title';
let renameId = null;
let archiveFilter = '';

// Whether a task list shows its finished tasks below it, and the tasks whose
// finished subtasks are shown. Up to SUBS_DONE_SHOWN finished subtasks are
// always shown; more fold into a stack.
let showDone = false;
const showSubsDone = new Set();
const SUBS_DONE_SHOWN = 2;
const subsDoneHidden = (id, nDone) => nDone > SUBS_DONE_SHOWN && !showSubsDone.has(id);

function render() {
  renderSidebar();

  const r = route();
  const main = $('#view');
  if (r.view === 'archive') renderArchive(main);
  else renderTasks(main, r.view === 'category' ? r.id : null);
  main.querySelector('.page').insertAdjacentHTML('afterbegin', `
    <div class="page-resize start" title="Drag to resize, double-click to reset"></div>
    <div class="page-resize end" title="Drag to resize, double-click to reset"></div>`);

  if (focusId) {
    document.getElementById(focusId)?.focus();
    focusId = null;
  }
  if (renameId) {
    const span = $(`.task[data-id="${renameId}"] .title`);
    renameId = null;
    if (span) startRename(span);
  }
}

function renderSidebar() {
  const { categories, tasks } = store.get();
  const roots = tasks.filter(t => !t.parentId);
  const open = roots.filter(t => !t.completedAt);
  const r = route();

  $('#count-all').textContent = open.length || '';
  $('#count-archive').textContent = (roots.length - open.length) || '';

  $('#nav-categories').innerHTML = categories.map(c => {
    const n = open.filter(t => t.categoryId === c.id).length;
    return `<li><a href="#/c/${c.id}" ${r.id === c.id ? 'aria-current="page"' : ''}>
      ${icon('tag')}<span class="name">${esc(c.name)}</span><span class="count">${n || ''}</span></a></li>`;
  }).join('');

  document.querySelectorAll('[data-view]').forEach(a => {
    a.toggleAttribute('aria-current', a.dataset.view === r.view);
  });
}

// A task you've started and not finished yet.
const inProgress = t => !!t.startedAt && !t.completedAt;

// In-progress tasks first, then by priority, due date and age.
function sortOpen(a, b) {
  return inProgress(b) - inProgress(a)
    || PRIORITY[a.priority].rank - PRIORITY[b.priority].rank
    || (a.due || '9999').localeCompare(b.due || '9999')
    || a.createdAt.localeCompare(b.createdAt);
}

// Open top-level tasks shown in a view, in display order.
const rootsFor = catId => store.get().tasks
  .filter(t => !t.parentId && !t.completedAt && (!catId || t.categoryId === catId)).sort(sortOpen);

// Subtasks of a task: open ones by priority, then finished ones.
const childrenOf = id => store.get().tasks.filter(t => t.parentId === id)
  .sort((a, b) => !!a.completedAt - !!b.completedAt || sortOpen(a, b));

const categoryName = id => store.get().categories.find(c => c.id === id)?.name ?? '?';

// Priority flag with a dropdown to change it. `act` is the menu action.
function priorityPicker(id, priority, act, withLabel = false) {
  return `
    <ot-dropdown>
      <button type="button" class="flag ${withLabel ? 'chip' : 'ghost icon small'} ${priority === 'low' ? 'reveal' : ''}"
        data-p="${priority}" popovertarget="prio-${id}" title="Priority: ${PRIORITY[priority].label}">
        ${icon('flag')}${withLabel && priority !== 'low' ? `<span>${PRIORITY[priority].label}</span>` : ''}
      </button>
      <menu popover id="prio-${id}">
        ${Object.entries(PRIORITY).map(([k, p]) => `
          <button type="button" role="menuitem" class="flag" data-p="${k}" data-act="${act}" data-value="${k}">
            ${icon('flag')} ${p.label} ${k === priority ? `<span class="tick">${icon('check')}</span>` : ''}
          </button>`).join('')}
      </menu>
    </ot-dropdown>`;
}

// Due date chip. In task rows it opens the details dialog; in the add row it
// opens the native date picker of the hidden input next to it.
function dueChip(due, act) {
  return `
    <button type="button" class="chip due ${due ? dueState(due) : 'reveal'}" data-act="${act}"
      title="${due ? `Due ${parseYmd(due).toDateString()}` : 'Set due date'}">
      ${icon('calendar')}${due ? `<span>${fmtDue(due)}</span>` : ''}
    </button>`;
}

function renderTasks(main, catId) {
  const { categories, tasks } = store.get();
  const list = rootsFor(catId);
  const done = finishedRoots(catId);

  if (!categories.some(c => c.id === draft.categoryId)) draft.categoryId = categories[0]?.id ?? null;

  main.innerHTML = `
    <div class="page">
      <div class="view-head">
        <h1>${esc(catId ? categoryName(catId) : 'All tasks')}</h1>
        ${catId ? `
        <ot-dropdown>
          <button class="ghost icon" popovertarget="cat-menu" title="Category options">${icon('more')}</button>
          <menu popover id="cat-menu">
            <button role="menuitem" data-act="copy-cat">${icon('copy')} Copy as Markdown</button>
            <button role="menuitem" data-act="rename-cat">${icon('pencil')} Rename</button>
            <button role="menuitem" data-act="delete-cat" class="danger">${icon('trash')} Delete</button>
          </menu>
        </ot-dropdown>` : ''}
      </div>

      <ul class="tasks">${list.map(t => taskTree(t, 0, !catId)).join('')}</ul>

      ${categories.length ? addRow(catId) : `<p class="hint">Create a category in the sidebar to start adding tasks.</p>`}

      ${done.length ? `
      <button class="done-link" data-act="toggle-done" aria-expanded="${showDone}">
        ${icon(showDone ? 'chevron-down' : 'chevron-right')} ${done.length} finished
      </button>
      ${showDone ? doneGroups(done, !catId) : ''}` : ''}
    </div>`;
}

// A task row followed by its open subtasks (unless collapsed), the inline
// "Add a subtask" input when open, and its finished subtasks (folded into a
// stack when there are many).
function taskTree(t, depth, showCat) {
  let html = taskRow(t, depth, showCat);
  const kids = t.collapsed ? [] : childrenOf(t.id);
  const done = kids.filter(c => c.completedAt);
  html += kids.filter(c => !c.completedAt).map(c => taskTree(c, depth + 1, false)).join('');
  if (subDraft?.parentId === t.id) html += subAddRow(depth + 1);
  if (done.length > SUBS_DONE_SHOWN) html += subsDoneStack(t.id, done, depth + 1);
  if (!subsDoneHidden(t.id, done.length)) html += done.map(c => taskTree(c, depth + 1, false)).join('');
  return html;
}

// Many finished subtasks fold into a stack of cards, the latest one on top;
// clicking it expands them, and a "Show less" row in its place folds them.
function subsDoneStack(id, done, depth) {
  const shown = showSubsDone.has(id);
  const top = done.reduce((a, b) => (a.completedAt > b.completedAt ? a : b));
  return `
    <li class="task sub sub-stack ${shown ? 'open' : ''}" data-id="${id}" style="--depth: ${depth}">
      <button class="stack" data-act="toggle-sub-done" aria-expanded="${shown}"
        title="${shown ? 'Hide' : 'Show'} ${done.length} finished subtasks">
        ${shown ? `${icon('chevron-up')} Show less` : `
        ${icon('check')}<span class="title">${fmtTitle(top.title)}</span>
        <span class="more">+${done.length - 1} finished</span>`}
      </button>
    </li>`;
}

function taskRow(t, depth, showCat) {
  const subs = store.descendants(t.id);
  const nDone = subs.filter(s => s.completedAt).length;

  return `
    <li class="task ${depth ? 'sub' : ''} ${t.completedAt ? 'checked' : ''} ${inProgress(t) ? 'active' : ''}" data-id="${t.id}" style="--depth: ${depth}">
      <input type="checkbox" data-act="complete" ${t.completedAt ? 'checked' : ''} aria-label="Mark as done">
      <span class="title" data-act="rename" title="Click to edit">${fmtTitle(t.title)}</span>
      ${inProgress(t) ? `<span class="status" title="Started ${new Date(t.startedAt).toLocaleString()}"><span class="dot"></span>In progress</span>` : ''}
      ${subs.length ? `
      <button class="chip progress ${nDone === subs.length ? 'all-done' : ''}" data-act="toggle"
        title="${t.collapsed ? 'Show' : 'Hide'} subtasks" aria-expanded="${!t.collapsed}">
        ${icon(t.collapsed ? 'chevron-right' : 'chevron-down')}<span>${nDone}/${subs.length}</span>
      </button>` : ''}
      ${t.notes ? `<button class="ghost icon small notes" data-act="edit" title="${esc(t.notes.slice(0, 200))}">${icon('notes')}</button>` : ''}
      ${showCat ? `<span class="cat">${esc(categoryName(t.categoryId))}</span>` : ''}
      ${dueChip(t.due, 'edit-due')}
      ${priorityPicker(t.id, t.priority, 'set-priority')}
      ${t.completedAt ? '' : `
      <button class="ghost icon small reveal" data-act="progress" title="${inProgress(t) ? 'Stop progress' : 'Start progress'}">${icon(inProgress(t) ? 'pause' : 'play')}</button>`}
      <button class="ghost icon small reveal" data-act="add-sub" title="Add subtask">${icon('list-plus')}</button>
      <button class="ghost icon small reveal" data-act="copy" title="Copy as Markdown">${icon('copy')}</button>
      <button class="ghost icon small reveal" data-act="edit" title="Details">${icon('pencil')}</button>
      <button class="ghost icon small reveal danger" data-act="delete" title="Delete">${icon('trash')}</button>
    </li>`;
}

function subAddRow(depth) {
  return `
    <li class="task sub sub-add" style="--depth: ${depth}">
      ${icon('plus')}
      <input id="sub-title" placeholder="Add a subtask" maxlength="500" value="${esc(subDraft.title)}"
        autocomplete="off" aria-label="New subtask">
    </li>`;
}

function addRow(catId) {
  return `
    <form id="form-task" class="add-row" autocomplete="off">
      ${icon('plus')}
      <input id="add-title" name="title" placeholder="Add a task" maxlength="500" value="${esc(draft.title)}" aria-label="New task">
      <div class="extras">
        ${catId ? '' : `
        <ot-dropdown>
          <button type="button" class="chip" popovertarget="cat-pick" title="Category">${icon('tag')}<span>${esc(categoryName(draft.categoryId))}</span></button>
          <menu popover id="cat-pick">
            ${store.get().categories.map(c => `
              <button type="button" role="menuitem" data-act="draft-cat" data-value="${c.id}">${icon('tag')} ${esc(c.name)}</button>`).join('')}
          </menu>
        </ot-dropdown>`}
        <span class="due-wrap">
          ${dueChip(draft.due, 'pick-date')}
          <input type="date" class="picker" data-act="draft-due" value="${draft.due || ''}" tabindex="-1" aria-label="Due date">
        </span>
        ${priorityPicker('new', draft.priority, 'draft-priority', true)}
      </div>
    </form>`;
}

function renderArchive(main) {
  const { categories, tasks } = store.get();
  if (archiveFilter && !categories.some(c => c.id === archiveFilter)) archiveFilter = '';

  const done = finishedRoots(archiveFilter);

  main.innerHTML = `
    <div class="page">
      <div class="view-head">
        <h1>Archive</h1>
        <select id="archive-filter" aria-label="Filter by category">
          <option value="">All categories</option>
          ${categories.map(c => `<option value="${c.id}" ${c.id === archiveFilter ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      ${done.length ? doneGroups(done, true)
        : `<div class="empty">${icon('archive')}<p>Finished tasks show up here.</p></div>`}
    </div>`;
}

// Finished top-level tasks, most recent first.
const finishedRoots = catId => store.get().tasks
  .filter(t => !t.parentId && t.completedAt && (!catId || t.categoryId === catId))
  .sort((a, b) => b.completedAt.localeCompare(a.completedAt));

// Finished tasks grouped by the local date on which they were finished.
function doneGroups(done, showCat) {
  const groups = new Map();
  for (const t of done) {
    const key = ymd(new Date(t.completedAt));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups].map(([day, list]) => `
    <section class="group">
      <h2>${fmtDay(parseYmd(day))} <span class="count">${list.length}</span></h2>
      <ul class="tasks">${list.map(t => archiveRow(t, showCat) + archiveSubs(t.id, 1)).join('')}</ul>
    </section>`).join('');
}

function archiveRow(t, showCat) {
  const fin = new Date(t.completedAt);
  const info = [`Finished ${fin.toLocaleString()}`];
  if (t.startedAt) info.push(`Started ${new Date(t.startedAt).toLocaleString()}`);
  info.push(`Created ${new Date(t.createdAt).toLocaleString()}`);
  if (t.due) info.push(`Was due ${parseYmd(t.due).toDateString()}`);

  return `
    <li class="task done" data-id="${t.id}">
      <span class="done-mark">${icon('check')}</span>
      <span class="title" title="${esc(info.join('\n'))}">${fmtTitle(t.title)}</span>
      ${t.notes ? `<span class="notes" title="${esc(t.notes.slice(0, 200))}">${icon('notes')}</span>` : ''}
      ${showCat ? `<span class="cat">${esc(categoryName(t.categoryId))}</span>` : ''}
      <span class="flag" data-p="${t.priority}" title="Priority: ${PRIORITY[t.priority].label}">${t.priority === 'low' ? '' : icon('flag')}</span>
      <time class="time" datetime="${t.completedAt}">${fmtTime(fin)}</time>
      <button class="ghost icon small reveal" data-act="reopen" title="Reopen">${icon('reopen')}</button>
      <button class="ghost icon small reveal" data-act="copy" title="Copy as Markdown">${icon('copy')}</button>
      <button class="ghost icon small reveal danger" data-act="delete" title="Delete">${icon('trash')}</button>
    </li>`;
}

function archiveSubs(id, depth) {
  return childrenOf(id).map(t => `
    <li class="task done sub" style="--depth: ${depth}">
      <span class="done-mark ${t.completedAt ? '' : 'open'}">${icon(t.completedAt ? 'check' : 'circle')}</span>
      <span class="title">${fmtTitle(t.title)}</span>
    </li>${archiveSubs(t.id, depth + 1)}`).join('');
}

// Inline title editing. Enter or blur saves, Escape cancels. Tab makes the
// task a subtask of the one above it, Shift+Tab moves it up a level.
function startRename(span) {
  const id = span.closest('.task').dataset.id;
  const t = store.get().tasks.find(t => t.id === id);

  const input = document.createElement('input');
  input.className = 'title-edit';
  input.value = t.title;
  input.maxLength = 500;
  span.replaceWith(input);
  input.focus();

  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== t.title) store.updateTask(id, { title: v });
    else render();
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    if (e.key !== 'Tab') return;

    e.preventDefault();
    let parentId;
    if (e.shiftKey) {
      if (!t.parentId) return finish(true);
      parentId = store.find(t.parentId).parentId || null;
    } else {
      const siblings = t.parentId ? childrenOf(t.parentId) : rootsFor(route().id);
      const prev = siblings[siblings.findIndex(s => s.id === id) - 1];
      if (!prev) return finish(true);
      parentId = prev.id;
    }

    // Keep editing the same task after it moves.
    done = true;
    renameId = id;
    if (!store.setParent(id, parentId, { title: input.value.trim() || t.title })) render();
  });
  input.addEventListener('blur', () => finish(true));
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    ot.toast(message, 'Copied', { variant: 'success' });
  } catch (e) {
    ot.toast(e.message, 'Copy failed', { variant: 'danger' });
  }
}

// Snackbar-style toast with an action button.
function toastAction(message, label, fn) {
  const el = document.createElement('output');
  el.className = 'snack';
  el.innerHTML = `<span>${esc(message)}</span><button class="ghost small">${esc(label)}</button>`;

  const t = ot.toast.el(el, { duration: 5000, placement: 'bottom-left' });
  $('button', t).addEventListener('click', () => { fn(); t.remove(); }, { once: true });
}

// Dialogs.

// ask() shows a confirm/prompt dialog and resolves to {action, value}.
function ask({ title, message = '', input = null, maxLength = 80, buttons }) {
  const dlg = $('#dlg-ask');
  $('[data-title]', dlg).textContent = title;
  $('[data-message]', dlg).textContent = message;

  const wrap = $('[data-input-wrap]', dlg);
  const field = $('input', wrap);
  wrap.hidden = input === null;
  field.required = input !== null;
  field.value = input ?? '';
  field.maxLength = maxLength;

  // Cancel isn't a submit button, so Enter in the input picks the action.
  $('[data-buttons]', dlg).innerHTML = `<button type="button" class="ghost" commandfor="dlg-ask" command="close">Cancel</button>`
    + buttons.map(b => `<button value="${b.value}" class="${b.cls || ''}" ${b.variant ? `data-variant="${b.variant}"` : ''}>${esc(b.label)}</button>`).join('');

  return new Promise(resolve => {
    dlg.returnValue = 'cancel';
    dlg.addEventListener('close', () => resolve({ action: dlg.returnValue, value: field.value.trim() }), { once: true });
    dlg.showModal();
    if (input !== null) field.select();
  });
}

function editTask(id, focus = 'notes') {
  const t = store.get().tasks.find(t => t.id === id);
  if (!t) return;

  const dlg = $('#dlg-task');
  const f = $('form', dlg).elements;
  f.categoryId.innerHTML = store.get().categories
    .map(c => `<option value="${c.id}" ${c.id === t.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  f.title.value = t.title;
  const notes = $('#notes');
  notes.innerHTML = mdToHtml(t.notes);
  f.priority.value = t.priority;
  f.due.value = t.due || '';
  f.categoryId.closest('label').hidden = !!t.parentId;

  dlg.returnValue = '';
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    store.updateTask(id, {
      title: f.title.value.trim() || t.title,
      notes: htmlToMd(notes),
      priority: f.priority.value,
      due: f.due.value || null,
      categoryId: f.categoryId.value,
    });
  }, { once: true });
  dlg.showModal();
  if (focus === 'notes') {
    // Cursor at the end of the notes.
    notes.focus();
    getSelection().selectAllChildren(notes);
    getSelection().collapseToEnd();
  } else {
    f[focus].focus();
  }
}

// Import / export.

async function exportMarkdown() {
  const md = toMarkdown(store.get());
  const name = `2do-${ymd(new Date())}.md`;

  // Native save dialog where supported (Chromium), plain download otherwise.
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
      });
      const w = await h.createWritable();
      await w.write(md);
      await w.close();
      ot.toast(`Saved ${h.name}`, 'Exported', { variant: 'success' });
    } catch (e) {
      if (e.name !== 'AbortError') ot.toast(e.message, 'Export failed', { variant: 'danger' });
    }
    return;
  }

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importMarkdown(file) {
  const data = fromMarkdown(await file.text());
  if (!data.tasks.length && !data.categories.length) {
    ot.toast('No tasks or categories found in the file.', 'Nothing to import', { variant: 'warning' });
    return;
  }

  const nSub = data.tasks.filter(t => t.parentId).length;
  const { action } = await ask({
    title: `Import ${file.name}?`,
    message: `Found ${data.tasks.length - nSub} task(s)${nSub ? ` and ${nSub} subtask(s)` : ''} in ` +
      `${data.categories.length} categor${data.categories.length === 1 ? 'y' : 'ies'}. ` +
      'Merge adds them to your existing tasks. Replace deletes everything you have first.',
    buttons: [
      { label: 'Replace', value: 'replace', variant: 'danger', cls: 'outline' },
      { label: 'Merge', value: 'merge' },
    ],
  });

  if (action === 'merge') {
    const n = store.merge(data);
    ot.toast(`${n} new task(s) added.`, 'Imported', { variant: 'success' });
  } else if (action === 'replace') {
    store.replace(data);
    location.hash = '#/all';
    ot.toast(`${data.tasks.length} task(s) imported.`, 'Imported', { variant: 'success' });
  }
}

// Events.

function addFromDraft() {
  const title = draft.title.trim();
  const catId = route().id || draft.categoryId;
  if (!title || !catId) return;

  store.addTask({ title, priority: draft.priority, due: draft.due, categoryId: catId });
  Object.assign(draft, { title: '', priority: 'low', due: null });
  focusId = 'add-title';
  render();
}

function addSubFromDraft() {
  const title = subDraft.title.trim();
  const parent = store.find(subDraft.parentId);
  if (!title || !parent) return;

  subDraft.title = '';
  focusId = 'sub-title';
  store.addTask({ title, parentId: parent.id, categoryId: parent.categoryId });
}

function bind() {
  window.addEventListener('hashchange', () => {
    // Close the sidebar overlay on mobile after navigating.
    $('[data-sidebar-layout]').removeAttribute('data-sidebar-open');
    draft.title = '';
    subDraft = null;
    focusId = 'add-title';
    render();
  });

  $('#form-category').addEventListener('submit', e => {
    e.preventDefault();
    const name = e.target.elements.name.value.trim();
    if (!name) return;
    const c = store.addCategory(name);
    e.target.reset();
    location.hash = `#/c/${c.id}`;
  });

  $('#btn-export').addEventListener('click', exportMarkdown);
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importMarkdown(f);
  });

  const main = $('#view');

  main.addEventListener('input', e => {
    if (e.target.id === 'add-title') draft.title = e.target.value;
    if (e.target.id === 'sub-title') subDraft.title = e.target.value;
  });

  main.addEventListener('keydown', e => {
    if (e.target.id === 'add-title') {
      if (e.key === 'Enter') {
        e.preventDefault();
        addFromDraft();
      } else if (e.key === 'Escape') {
        draft.title = e.target.value = '';
      }
    }

    if (e.target.id === 'sub-title') {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSubFromDraft();
      } else if (e.key === 'Escape') {
        subDraft = null;
        render();
      }
    }
  });

  // Close an empty subtask input when focus leaves it (but not when a
  // re-render just recreated and refocused it).
  main.addEventListener('focusout', e => {
    if (e.target.id !== 'sub-title') return;
    setTimeout(() => {
      if (subDraft && !subDraft.title.trim() && document.activeElement?.id !== 'sub-title') {
        subDraft = null;
        render();
      }
    });
  });

  main.addEventListener('submit', e => e.preventDefault());

  main.addEventListener('change', e => {
    const el = e.target;
    const id = el.closest('.task')?.dataset.id;

    switch (el.dataset.act || el.id) {
      case 'archive-filter':
        archiveFilter = el.value;
        render();
        break;

      case 'draft-due':
        draft.due = el.value || null;
        focusId = 'add-title';
        render();
        break;

      case 'complete': {
        // Ticked subtasks slide into their parent's stack of finished ones (or
        // stay in place if few are finished or the stack is open); top-level
        // tasks move to the archive.
        const t = store.find(id);
        const nDone = t.parentId && childrenOf(t.parentId).filter(c => c.completedAt).length + 1;
        if (!el.checked) {
          store.reopenTask(id);
        } else if (t.parentId && !subsDoneHidden(t.parentId, nDone)) {
          store.completeTask(id);
        } else {
          el.closest('.task').classList.add('completing');
          setTimeout(() => {
            const ids = store.completeTask(id);
            if (!t.parentId) toastAction('Task finished.', 'Undo', () => store.reopenMany(ids));
          }, 300);
        }
        break;
      }
    }
  });

  main.addEventListener('click', async e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const id = el.closest('.task')?.dataset.id;

    switch (el.dataset.act) {
      case 'rename':
        startRename(el);
        break;

      case 'pick-date': {
        const input = el.nextElementSibling;
        try {
          input.showPicker();
        } catch {
          input.focus();
        }
        break;
      }

      case 'set-priority':
        store.updateTask(id, { priority: el.dataset.value });
        break;

      case 'draft-priority':
      case 'draft-cat':
        draft[el.dataset.act === 'draft-cat' ? 'categoryId' : 'priority'] = el.dataset.value;
        focusId = 'add-title';
        render();
        break;

      case 'edit':
        editTask(id);
        break;

      case 'edit-due':
        editTask(id, 'due');
        break;

      case 'toggle-done':
        showDone = !showDone;
        render();
        break;

      case 'toggle-sub-done':
        if (!showSubsDone.delete(id)) showSubsDone.add(id);
        render();
        break;

      case 'toggle':
        store.updateTask(id, { collapsed: !store.find(id).collapsed });
        break;

      case 'progress':
        store.updateTask(id, { startedAt: inProgress(store.find(id)) ? null : new Date().toISOString() });
        break;

      case 'add-sub':
        subDraft = { parentId: id, title: '' };
        focusId = 'sub-title';
        if (store.find(id).collapsed) store.updateTask(id, { collapsed: false });
        else render();
        break;

      case 'copy': {
        const n = store.descendants(id).length;
        copyText(taskToMarkdown(store.find(id), store.get().tasks),
          n ? `Task and ${n} subtask(s) copied as Markdown.` : 'Task copied as Markdown.');
        break;
      }

      case 'copy-cat': {
        const cid = route().id;
        const roots = rootsFor(cid);
        copyText(categoryToMarkdown(categoryName(cid), roots, store.get().tasks),
          `${roots.length} open task(s) copied as Markdown.`);
        break;
      }

      case 'reopen':
        store.reopenTask(id);
        toastAction('Task reopened.', 'Undo', () => store.completeTask(id));
        break;

      case 'delete': {
        const t = store.find(id);
        const n = store.descendants(id).length;
        const { action } = await ask({
          title: 'Delete task?',
          message: `"${t.title}"${n ? ` and its ${n} subtask(s)` : ''} will be permanently deleted.`,
          buttons: [{ label: 'Delete', value: 'ok', variant: 'danger' }],
        });
        if (action === 'ok') store.deleteTask(id);
        break;
      }

      case 'rename-cat': {
        const cid = route().id;
        const { action, value } = await ask({
          title: 'Rename category', input: categoryName(cid),
          buttons: [{ label: 'Rename', value: 'ok' }],
        });
        if (action === 'ok' && value) store.renameCategory(cid, value);
        break;
      }

      case 'delete-cat': {
        const cid = route().id;
        const n = store.get().tasks.filter(t => t.categoryId === cid).length;
        const { action } = await ask({
          title: `Delete "${categoryName(cid)}"?`,
          message: n ? `This also permanently deletes its ${n} task(s), including archived ones.` : '',
          buttons: [{ label: 'Delete', value: 'ok', variant: 'danger' }],
        });
        if (action === 'ok') {
          store.deleteCategory(cid);
          location.hash = '#/all';
        }
        break;
      }
    }
  });
}

// Color themes; the palettes are in app.css. '' is Oat's own (Classic).
const THEMES = [
  ['', 'Classic'], ['paper', 'Paper'], ['sage', 'Sage'], ['mist', 'Mist'], ['blush', 'Blush'],
  ['lavender', 'Lavender'], ['peach', 'Peach'], ['slate', 'Slate'], ['forest', 'Forest'], ['dusk', 'Dusk'],
];

function renderThemes() {
  const cur = document.documentElement.dataset.color || '';
  $('#theme-menu').innerHTML = THEMES.map(([id, name]) => `
    <button role="menuitem" data-theme="${id}" aria-current="${id === cur}">
      <span class="swatch ${id ? '' : 'classic'}" ${id ? `data-color="${id}"` : ''}></span> ${name}
    </button>`).join('');
}

function setTheme(id) {
  if (id) document.documentElement.dataset.color = id;
  else delete document.documentElement.dataset.color;
  try { localStorage.setItem('2do:color', id); } catch {}
  renderThemes();
}

// Dragging either edge of the centered page sets its width; double-click
// resets it. The width is remembered across restarts.
const PAGE_MIN_WIDTH = 480;

function setupPageResize() {
  const main = $('#view');
  const root = document.documentElement;
  let center = null;

  main.addEventListener('pointerdown', e => {
    if (!e.target.matches('.page-resize') || e.button !== 0) return;
    e.preventDefault();
    const r = e.target.parentElement.getBoundingClientRect();
    center = r.left + r.width / 2;
    e.target.setPointerCapture(e.pointerId);
    root.classList.add('resizing');
  });
  main.addEventListener('pointermove', e => {
    if (center === null) return;
    const width = Math.min(main.clientWidth, Math.max(PAGE_MIN_WIDTH, 2 * Math.abs(e.clientX - center)));
    root.style.setProperty('--page-width', `${Math.round(width)}px`);
  });
  const stop = () => {
    if (center === null) return;
    center = null;
    root.classList.remove('resizing');
    try { localStorage.setItem('2do:width', parseInt(root.style.getPropertyValue('--page-width'))); } catch {}
  };
  main.addEventListener('pointerup', stop);
  main.addEventListener('pointercancel', stop);
  main.addEventListener('dblclick', e => {
    if (!e.target.matches('.page-resize')) return;
    root.style.removeProperty('--page-width');
    try { localStorage.removeItem('2do:width'); } catch {}
  });
}

async function init() {
  await store.load();
  store.onChange(render);
  bind();
  renderThemes();
  setupPageResize();
  $('#theme-menu').addEventListener('click', e => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    setTheme(b.dataset.theme);
    $('#theme-menu').hidePopover();
  });
  setupEditor($('#notes'), $('#dlg-task .toolbar'), async () => {
    const { action, value } = await ask({
      title: 'Add link', input: '', maxLength: 2000,
      buttons: [{ label: 'Add', value: 'ok' }],
    });
    return action === 'ok' ? value : '';
  });
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
