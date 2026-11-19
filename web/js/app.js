import * as store from './store.js';
import { toMarkdown, fromMarkdown, taskToMarkdown, categoryToMarkdown } from './markdown.js';
import { mdToHtml, htmlToMd, setupEditor } from './editor.js';

const $ = (sel, el = document) => el.querySelector(sel);

const PRIORITY = {
  high: { label: 'High' },
  medium: { label: 'Medium' },
  low: { label: 'Low' },
};

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// Task titles are plain text, except that `backticks` render as inline code
// and links, [text](url) or a bare https://… address, are clickable. Bare
// links are shown without the https://, and trailing punctuation, or a ")"
// with no "(" in the link, is left out.
// Titles inside buttons pass links = false, since links can't nest in them.
const reTitle = /`([^`]+)`|\[([^\]]+)\]\(((?:https?:|mailto:)[^)\s]+)\)|(https?:\/\/[^\s<>`]*[^\s<>`.,;:!?'"\]])/i;

function fmtTitle(s, links = true) {
  const link = (url, text) => links
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${text}</a>` : text;
  let out = '';
  let m;
  while ((m = s.match(reTitle))) {
    let len = m[0].length;
    out += esc(s.slice(0, m.index));
    if (m[1]) out += `<code>${esc(m[1])}</code>`;
    else if (m[2]) out += link(m[3], esc(m[2]));
    else {
      let url = m[4];
      const count = c => url.split(c).length;
      while (url.endsWith(')') && count('(') < count(')')) url = url.slice(0, -1);
      len = url.length;
      out += link(url, esc(url.replace(/^https?:\/\/(www\.)?/i, '')));
    }
    s = s.slice(m.index + len);
  }
  return out + esc(s);
}
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

// Routing: #/all, #/archive, #/c/<category id>, and #/t/<task id> for a
// task's full-screen view.
function route() {
  const [, view, id] = location.hash.split('/');
  if (view === 'archive') return { view: 'archive' };
  if (view === 'c' && store.get().categories.some(c => c.id === id)) return { view: 'category', id };
  if (view === 't' && store.find(id)) return { view: 'task', id };
  return { view: 'all' };
}

// The task shown full screen, if any.
const focused = () => { const r = route(); return r.view === 'task' ? store.find(r.id) : null; };

// Where the full-screen view goes back to, and the scroll position there;
// and the scroll position for the next view (the top if null).
let back = null;
let nextScroll = null;

// The task being typed in the add row, and the inline subtask input
// ({parentId, title}). Kept across re-renders. A draft with a parentId is
// added as a subtask; lastAddedId is what Tab nests the next one under.
const draft = { title: '', priority: 'low', due: null, categoryId: null, parentId: null };
let subDraft = null;
let lastAddedId = null;

// Element to focus, task to start renaming, or task whose drag handle to
// focus (after moving it with the keyboard), after the next render.
let focusId = 'add-title';
let renameId = null;
let dragFocusId = null;
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
  else if (r.view === 'task') renderFocus(main, store.find(r.id));
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
  if (dragFocusId) {
    $(`.task[data-id="${dragFocusId}"] .drag`)?.focus();
    dragFocusId = null;
  }
}

function renderSidebar() {
  const { categories, tasks } = store.get();
  const roots = tasks.filter(t => !t.parentId);
  const open = roots.filter(t => !t.completedAt);
  const r = route();
  const catId = r.view === 'task' ? store.find(r.id).categoryId : r.id;

  $('#count-all').textContent = open.length || '';
  $('#count-archive').textContent = (roots.length - open.length) || '';

  $('#nav-categories').innerHTML = categories.map(c => {
    const n = open.filter(t => t.categoryId === c.id).length;
    return `<li><a href="#/c/${c.id}" ${catId === c.id ? 'aria-current="page"' : ''}>
      ${icon('tag')}<span class="name">${esc(c.name)}</span><span class="count">${n || ''}</span></a></li>`;
  }).join('');

  document.querySelectorAll('[data-view]').forEach(a => {
    a.toggleAttribute('aria-current', a.dataset.view === r.view);
  });
}

// A task you've started and not finished yet.
const inProgress = t => !!t.startedAt && !t.completedAt;

// Tasks are in the order you put them in (store.moveTask).
const byOrder = (a, b) => a.order - b.order;

// Open top-level tasks shown in a view, in display order.
const rootsFor = catId => store.get().tasks
  .filter(t => !t.parentId && !t.completedAt && (!catId || t.categoryId === catId)).sort(byOrder);

// Subtasks of a task: open ones, then finished ones.
const childrenOf = id => store.get().tasks.filter(t => t.parentId === id)
  .sort((a, b) => !!a.completedAt - !!b.completedAt || byOrder(a, b));

// Open top-level tasks of the current view; in a task's full-screen view,
// its open subtasks.
function viewRoots() {
  const r = route();
  return r.view === 'task' ? childrenOf(r.id).filter(t => !t.completedAt) : rootsFor(r.id);
}

// Open tasks as they appear in the current view, top to bottom.
const visibleOpen = () => viewRoots().flatMap(function walk(t) {
  return [t, ...(t.collapsed ? [] : childrenOf(t.id).filter(c => !c.completedAt).flatMap(walk))];
});

// The task the add row nests under with Tab, and its ancestors up to the top
// of the view, top first: the task just added from the add row, or else the
// last one in the list.
function nestChain() {
  const open = visibleOpen();
  let t = open.find(t => t.id === lastAddedId) || open.at(-1);
  const chain = [];
  for (; t && t !== focused(); t = store.find(t.parentId)) chain.unshift(t);
  return chain;
}

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
  const cat = categories.find(c => c.id === catId);
  const list = rootsFor(catId);
  const done = finishedRoots(catId);

  if (!categories.some(c => c.id === draft.categoryId)) draft.categoryId = categories[0]?.id ?? null;
  if (draft.parentId && !visibleOpen().some(t => t.id === draft.parentId)) draft.parentId = null;

  main.innerHTML = `
    <div class="page">
      <div class="view-head">
        <h1>${esc(catId ? categoryName(catId) : 'All tasks')}</h1>
        ${catId ? `
        <span class="actions">
        <button class="ghost icon" data-act="cat-notes" title="${cat.notes ? 'Edit notes' : 'Add notes'}">${icon('notes')}</button>
        <ot-dropdown>
          <button class="ghost icon" popovertarget="cat-menu" title="Category options">${icon('more')}</button>
          <menu popover id="cat-menu">
            <button role="menuitem" data-act="copy-cat">${icon('copy')} Copy as Markdown</button>
            <button role="menuitem" data-act="rename-cat">${icon('pencil')} Rename</button>
            <button role="menuitem" data-act="delete-cat" class="danger">${icon('trash')} Delete</button>
          </menu>
        </ot-dropdown>
        </span>` : ''}
      </div>

      ${cat?.notes ? `<div class="cat-notes rich" data-act="cat-notes" title="Click to edit">${mdToHtml(cat.notes)}</div>` : ''}

      <ul class="tasks">${list.map(t => taskTree(t, 0, !catId)).join('')}</ul>

      ${categories.length ? addRow(catId) : `<p class="hint">Create a category in the sidebar to start adding tasks.</p>`}

      ${done.length ? `
      <button class="done-link" data-act="toggle-done" aria-expanded="${showDone}">
        ${icon(showDone ? 'chevron-down' : 'chevron-right')} ${done.length} finished
      </button>
      ${showDone ? doneGroups(done, !catId) : ''}` : ''}
    </div>`;
}

// A task row followed by its subtasks, unless collapsed.
const taskTree = (t, depth, showCat) => taskRow(t, depth, showCat) + (t.collapsed ? '' : subtaskRows(t, depth + 1));

// A task's open subtasks, the inline "Add a subtask" input when open, and its
// finished subtasks (folded into a stack when there are many).
function subtaskRows(t, depth) {
  const kids = childrenOf(t.id);
  const done = kids.filter(c => c.completedAt);
  let html = kids.filter(c => !c.completedAt).map(c => taskTree(c, depth, false)).join('');
  if (subDraft?.parentId === t.id) html += subAddRow(depth);
  if (done.length > SUBS_DONE_SHOWN) html += subsDoneStack(t.id, done, depth);
  if (!subsDoneHidden(t.id, done.length)) html += done.map(c => taskTree(c, depth, false)).join('');
  return html;
}

// A task full screen: its subtasks fill the page and the sidebar is hidden.
// The breadcrumbs lead back up; Esc or the collapse button go back to where
// it was opened from.
function renderFocus(main, t) {
  if (draft.parentId && !visibleOpen().some(x => x.id === draft.parentId)) draft.parentId = null;
  const up = [];
  for (let p = store.find(t.parentId); p; p = store.find(p.parentId)) up.unshift(p);
  const subs = store.descendants(t.id);

  main.innerHTML = `
    <div class="page focus" data-id="${t.id}">
      <nav class="crumbs">
        <a href="#/c/${t.categoryId}">${icon('tag')} ${esc(categoryName(t.categoryId))}</a>
        ${up.map(p => `<span class="sep">/</span><a href="#/t/${p.id}">${fmtTitle(p.title, false)}</a>`).join('')}
      </nav>
      <div class="view-head">
        <h1 class="${t.completedAt ? 'done' : ''}">${fmtTitle(t.title)}</h1>
        <span class="actions">
          <span class="count" title="Subtasks finished">${subs.filter(s => s.completedAt).length}/${subs.length}</span>
          <button class="ghost icon" data-act="edit" title="Details">${icon('pencil')}</button>
          <button class="ghost icon" data-act="unfocus" title="Exit full screen (Esc)">${icon('minimize')}</button>
        </span>
      </div>

      ${t.notes ? `<div class="cat-notes rich" data-act="edit" title="Click to edit">${mdToHtml(t.notes)}</div>` : ''}

      <ul class="tasks">${subtaskRows(t, 0)}</ul>

      ${addRow(t.categoryId)}
    </div>`;
}

function openFocus(id) {
  if (!focused()) back = { hash: location.hash || '#/all', scroll: $('#view').scrollTop };
  location.hash = `#/t/${id}`;
}

function leaveFocus() {
  const to = back ?? { hash: `#/c/${focused().categoryId}`, scroll: 0 };
  nextScroll = to.scroll;
  location.hash = to.hash;
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
        ${icon('check')}<span class="title">${fmtTitle(top.title, false)}</span>
        <span class="more">+${done.length - 1} finished</span>`}
      </button>
    </li>`;
}

// Open tasks have a drag handle and a data-parent, which marks the rows they
// can be moved among.
function taskRow(t, depth, showCat) {
  const subs = store.descendants(t.id);
  const nDone = subs.filter(s => s.completedAt).length;

  return `
    <li class="task ${depth ? 'sub' : ''} ${t.completedAt ? 'checked' : ''} ${inProgress(t) ? 'active' : ''}" data-id="${t.id}"
      ${t.completedAt ? '' : `data-parent="${t.parentId || ''}"`} style="--depth: ${depth}">
      ${t.completedAt ? '' : `
      <button class="ghost icon small reveal drag" title="Drag to reorder, or press ↑ ↓" aria-label="Reorder">${icon('grip')}</button>`}
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
      <button class="ghost icon small reveal" data-act="add-sub" title="Add subtask">${icon('list-plus')}</button>
      <button class="ghost icon small reveal" data-act="edit" title="Details">${icon('pencil')}</button>
      ${taskMenu(t, subs.length)}
    </li>`;
}

// Everything else you can do with a task, with labels, in its ⋯ menu. On
// touch screens this menu is the only control shown, so it repeats the two
// shown on hover.
function taskMenu(t, nSubs) {
  const item = (act, ic, label, cls = '') =>
    `<button type="button" role="menuitem" data-act="${act}" class="${cls}">${icon(ic)} ${label}</button>`;
  const open = !t.completedAt;
  return `
    <ot-dropdown class="more-menu">
      <button type="button" class="ghost icon small reveal more" popovertarget="menu-${t.id}" title="More actions">${icon('more')}</button>
      <menu popover id="menu-${t.id}">
        ${item('edit', 'pencil', 'Details')}
        ${item('add-sub', 'list-plus', 'Add subtask')}
        ${open ? item('progress', inProgress(t) ? 'pause' : 'play', inProgress(t) ? 'Stop progress' : 'Start progress') : ''}
        ${nSubs && open ? item('focus', 'maximize', 'Open full screen') : ''}
        ${t.parentId ? item('promote', 'promote', 'Convert to main task') : ''}
        ${item('copy', 'copy', 'Copy as Markdown')}
        ${item('delete', 'trash', 'Delete', 'danger')}
      </menu>
    </ot-dropdown>`;
}

function subAddRow(depth) {
  return `
    <li class="task sub sub-add" style="--depth: ${depth}">
      ${icon('plus')}
      <input id="sub-title" placeholder="Add a subtask" maxlength="500" value="${esc(subDraft.title)}"
        autocomplete="off" aria-label="New subtask">
    </li>`;
}

// Tab nests the new task under the task above it, Shift+Tab moves it back out.
// In a task's full-screen view, new tasks are its subtasks.
function addRow(catId) {
  const parent = store.find(draft.parentId);
  let depth = 0;
  for (let t = parent; t && t !== focused(); t = store.find(t.parentId)) depth++;
  const canNest = nestChain().length > depth;
  const sub = parent || focused();

  return `
    <form id="form-task" class="add-row ${parent ? 'nested' : ''}" autocomplete="off" style="--depth: ${depth}">
      ${icon(parent ? 'corner' : 'plus')}
      <input id="add-title" name="title" placeholder="${sub ? 'Add a subtask' : 'Add a task'}" maxlength="500"
        value="${esc(draft.title)}" aria-label="${sub ? 'New subtask' : 'New task'}">
      <div class="extras">
        ${parent ? `
        <button type="button" class="chip parent" data-act="draft-unnest" title="Subtask of “${esc(parent.title)}”. Click or press Shift+Tab to move it out">
          ${icon('list-plus')}<span>${fmtTitle(parent.title, false)}</span>${icon('x')}
        </button>` : canNest ? `<span class="key-hint"><kbd>Tab</kbd> subtask</span>` : ''}
        ${catId || parent ? '' : `
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
      if (!t.parentId || t.parentId === focused()?.id) return finish(true);
      parentId = store.find(t.parentId).parentId || null;
    } else {
      const siblings = t.parentId ? childrenOf(t.parentId) : viewRoots();
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
  if (focus === 'notes') focusEnd(notes);
  else f[focus].focus();
}

// Category notes, shown at the top of the category's page.
function editCategoryNotes(id) {
  const c = store.get().categories.find(c => c.id === id);
  const dlg = $('#dlg-cat-notes');
  const notes = $('#cat-notes');
  $('[data-title]', dlg).textContent = `${c.name} notes`;
  notes.innerHTML = c.notes ? mdToHtml(c.notes) : '';

  dlg.returnValue = '';
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'save') store.setCategoryNotes(id, htmlToMd(notes));
  }, { once: true });
  dlg.showModal();
  focusEnd(notes);
}

function focusEnd(el) {
  el.focus();
  getSelection().selectAllChildren(el);
  getSelection().collapseToEnd();
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

// After adding, the add row stays at the same level, so several subtasks
// can be typed in a row.
function addFromDraft() {
  const title = draft.title.trim();
  const parent = store.find(draft.parentId) || focused();
  const catId = parent?.categoryId || route().id || draft.categoryId;
  if (!title || !catId) return;

  if (parent?.collapsed) parent.collapsed = false;
  lastAddedId = store.addTask({ title, priority: draft.priority, due: draft.due, categoryId: catId, parentId: parent?.id }).id;
  Object.assign(draft, { title: '', priority: 'low', due: null });
  focusId = 'add-title';
  render();
}

// Move the add row one level in (nest under the next task of nestChain) or
// out. Returns false if it can't move.
function nestDraft(inward) {
  const chain = nestChain();
  const i = chain.findIndex(t => t.id === draft.parentId);
  const next = inward ? chain[i + 1] : draft.parentId && chain[i - 1] || null;
  if (inward ? !next : !draft.parentId) return false;

  draft.parentId = next?.id ?? null;
  focusId = 'add-title';
  render();
  return true;
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
  // Picking a menu item closes its menu (the menus in task rows close anyway
  // when the list re-renders, but not every action re-renders it).
  document.addEventListener('click', e => {
    const menu = e.target.closest('[role=menuitem]')?.closest('[popover]');
    if (menu?.matches(':popover-open')) menu.hidePopover();
  });

  // Esc leaves a task's full-screen view, unless it's for something else:
  // typing, a dialog or a menu.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !focused() || e.defaultPrevented) return;
    if (e.target.closest('input, textarea, [contenteditable], dialog') || document.querySelector(':popover-open')) return;
    leaveFocus();
  });

  window.addEventListener('hashchange', () => {
    if (!focused()) back = null;
    // Close the sidebar overlay on mobile after navigating.
    $('[data-sidebar-layout]').removeAttribute('data-sidebar-open');
    draft.title = '';
    draft.parentId = lastAddedId = null;
    subDraft = null;
    focusId = 'add-title';
    render();
    $('#view').scrollTop = nextScroll ?? 0;
    nextScroll = null;
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
      } else if (e.key === 'Tab' && nestDraft(!e.shiftKey)) {
        e.preventDefault();
      } else if (e.key === 'Escape') {
        if (draft.title) draft.title = e.target.value = '';
        else if (!nestDraft(false) && focused()) leaveFocus();
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
    // Links in titles and notes open in the browser instead of starting an
    // edit.
    const a = e.target.closest('.title a, .cat-notes a, h1 a');
    if (a) {
      e.preventDefault();
      store.openLink(a.href);
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    // The task a control belongs to: its row, or the full-screen view's task.
    const id = el.closest('.task, .page[data-id]')?.dataset.id;

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

      case 'draft-unnest':
        draft.parentId = null;
        focusId = 'add-title';
        render();
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

      case 'focus':
        openFocus(id);
        break;

      case 'unfocus':
        leaveFocus();
        break;

      case 'add-sub':
        subDraft = { parentId: id, title: '' };
        focusId = 'sub-title';
        if (store.find(id).collapsed) store.updateTask(id, { collapsed: false });
        else render();
        break;

      // A subtask becomes a top-level task in the same category, taking its
      // own subtasks with it.
      case 'promote': {
        const parentId = store.find(id).parentId;
        store.setParent(id, null);
        toastAction('Converted to a main task.', 'Undo', () => store.setParent(id, parentId));
        break;
      }

      case 'copy': {
        const n = store.descendants(id).length;
        copyText(taskToMarkdown(store.find(id), store.get().tasks),
          n ? `Task and ${n} subtask(s) copied as Markdown.` : 'Task copied as Markdown.');
        break;
      }

      case 'cat-notes':
        editCategoryNotes(route().id);
        break;

      case 'copy-cat': {
        const cid = route().id;
        const roots = rootsFor(cid);
        copyText(categoryToMarkdown(store.get().categories.find(c => c.id === cid), roots, store.get().tasks),
          `${roots.length} open task(s) copied as Markdown.`);
        break;
      }

      case 'reopen':
        store.reopenTask(id);
        toastAction('Task reopened.', 'Undo', () => store.completeTask(id));
        break;

      // No confirmation: the snackbar's Undo puts it back.
      case 'delete': {
        const removed = store.deleteTask(id);
        const n = removed.length - 1;
        toastAction(n ? `Task and ${n} subtask(s) deleted.` : 'Task deleted.', 'Undo', () => store.restoreTasks(removed));
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

// Reordering. A task is dragged by its handle and dropped among its siblings
// (the open tasks with the same parent); its subtasks move with it. A line
// shows where it will land. With the handle focused, ↑ and ↓ move it too.

// The open sibling rows a task can be moved among, itself included.
const siblingRows = row => [...$('#view').querySelectorAll(`.task[data-parent="${row.dataset.parent}"]`)];
const depthOf = row => parseInt(row.style.getPropertyValue('--depth')) || 0;

// A row and the rows of everything nested under it.
function subtreeRows(row) {
  const rows = [row];
  for (let r = row.nextElementSibling; r?.matches('.task') && depthOf(r) > depthOf(row); r = r.nextElementSibling) rows.push(r);
  return rows;
}

function setupDrag() {
  const main = $('#view');
  let drag = null;

  // Where the pointer would drop the task: before a sibling, or after the last.
  function target(y) {
    const others = drag.siblings.filter(r => r !== drag.row);
    const before = others.find(r => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; }) ?? null;
    const edge = before ? before.getBoundingClientRect().top : subtreeRows(others.at(-1)).at(-1).getBoundingClientRect().bottom;
    return { before, edge };
  }

  main.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.drag');
    if (!handle || e.button !== 0) return;
    const row = handle.closest('.task');
    const siblings = siblingRows(row);
    if (siblings.length < 2) return;

    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const line = document.createElement('div');
    line.className = 'drop-line';
    row.closest('.page').append(line);
    subtreeRows(row).forEach(r => r.classList.add('dragging'));
    document.documentElement.classList.add('reordering');
    drag = { row, siblings, line, before: undefined };
  });

  main.addEventListener('pointermove', e => {
    if (!drag) return;
    // Scroll when dragging near the top or bottom edge.
    const m = main.getBoundingClientRect();
    if (e.clientY < m.top + 40) main.scrollBy(0, -12);
    else if (e.clientY > m.bottom - 40) main.scrollBy(0, 12);

    const { before, edge } = target(e.clientY);
    drag.before = before;
    const page = drag.line.parentElement.getBoundingClientRect();
    const start = $('input[type=checkbox]', drag.row).getBoundingClientRect().left;
    Object.assign(drag.line.style, {
      top: `${edge - page.top}px`,
      left: `${start - page.left}px`,
      width: `${drag.row.getBoundingClientRect().right - start}px`,
    });
  });

  const stop = drop => {
    if (!drag) return;
    const { row, siblings, line, before } = drag;
    drag = null;
    line.remove();
    document.documentElement.classList.remove('reordering');
    subtreeRows(row).forEach(r => r.classList.remove('dragging'));

    // Dropping it right where it was changes nothing.
    const next = siblings[siblings.indexOf(row) + 1] ?? null;
    if (drop && before !== undefined && before !== next) store.moveTask(row.dataset.id, before?.dataset.id ?? null);
  };
  main.addEventListener('pointerup', () => stop(true));
  main.addEventListener('pointercancel', () => stop(false));

  main.addEventListener('keydown', e => {
    if (!e.target.matches('.drag') || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const row = e.target.closest('.task');
    const siblings = siblingRows(row);
    const i = siblings.indexOf(row);
    if (e.key === 'ArrowUp' ? i === 0 : i === siblings.length - 1) return;

    dragFocusId = row.dataset.id;
    const before = e.key === 'ArrowUp' ? siblings[i - 1] : siblings[i + 2] ?? null;
    store.moveTask(row.dataset.id, before?.dataset.id ?? null);
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
  setupDrag();
  $('#theme-menu').addEventListener('click', e => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    setTheme(b.dataset.theme);
  });
  const askUrl = async () => {
    const { action, value } = await ask({
      title: 'Add link', input: '', maxLength: 2000,
      buttons: [{ label: 'Add', value: 'ok' }],
    });
    return action === 'ok' ? value : '';
  };
  setupEditor($('#notes'), $('#dlg-task .toolbar'), askUrl);
  // The category notes dialog gets a copy of the task dialog's toolbar.
  const toolbar = $('#dlg-task .toolbar').cloneNode(true);
  $('#dlg-cat-notes .editor').prepend(toolbar);
  setupEditor($('#cat-notes'), toolbar, askUrl);
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
