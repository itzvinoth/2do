import * as store from './store.js';
import { toMarkdown, fromMarkdown } from './markdown.js';

const $ = (sel, el = document) => el.querySelector(sel);

const PRIORITY = {
  high: { label: 'High', rank: 0 },
  medium: { label: 'Medium', rank: 1 },
  low: { label: 'Low', rank: 2 },
};

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
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

// The task being typed in the add row. Kept across re-renders.
const draft = { title: '', priority: 'low', due: null, categoryId: null };
let focusAdd = true;
let archiveFilter = '';

function render() {
  renderSidebar();

  const r = route();
  const main = $('#view');
  if (r.view === 'archive') renderArchive(main);
  else renderTasks(main, r.view === 'category' ? r.id : null);

  if (focusAdd) {
    $('#add-title')?.focus();
    focusAdd = false;
  }
}

function renderSidebar() {
  const { categories, tasks } = store.get();
  const open = tasks.filter(t => !t.completedAt);
  const r = route();

  $('#count-all').textContent = open.length || '';
  $('#count-archive').textContent = (tasks.length - open.length) || '';

  $('#nav-categories').innerHTML = categories.map(c => {
    const n = open.filter(t => t.categoryId === c.id).length;
    return `<li><a href="#/c/${c.id}" ${r.id === c.id ? 'aria-current="page"' : ''}>
      ${icon('tag')}<span class="name">${esc(c.name)}</span><span class="count">${n || ''}</span></a></li>`;
  }).join('');

  document.querySelectorAll('[data-view]').forEach(a => {
    a.toggleAttribute('aria-current', a.dataset.view === r.view);
  });
}

function sortOpen(a, b) {
  return PRIORITY[a.priority].rank - PRIORITY[b.priority].rank
    || (a.due || '9999').localeCompare(b.due || '9999')
    || a.createdAt.localeCompare(b.createdAt);
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
  const list = tasks.filter(t => !t.completedAt && (!catId || t.categoryId === catId)).sort(sortOpen);
  const nDone = tasks.filter(t => t.completedAt && (!catId || t.categoryId === catId)).length;

  if (!categories.some(c => c.id === draft.categoryId)) draft.categoryId = categories[0]?.id ?? null;

  main.innerHTML = `
    <div class="page">
      <div class="view-head">
        <h1>${esc(catId ? categoryName(catId) : 'All tasks')}</h1>
        ${catId ? `
        <ot-dropdown>
          <button class="ghost icon" popovertarget="cat-menu" title="Category options">${icon('more')}</button>
          <menu popover id="cat-menu">
            <button role="menuitem" data-act="rename-cat">${icon('pencil')} Rename</button>
            <button role="menuitem" data-act="delete-cat" class="danger">${icon('trash')} Delete</button>
          </menu>
        </ot-dropdown>` : ''}
      </div>

      <ul class="tasks">${list.map(t => taskRow(t, !catId)).join('')}</ul>

      ${categories.length ? addRow(catId) : `<p class="hint">Create a category in the sidebar to start adding tasks.</p>`}

      ${nDone ? `<a class="done-link" href="#/archive" data-cat="${catId || ''}">${icon('check')} ${nDone} finished</a>` : ''}
    </div>`;
}

function taskRow(t, showCat) {
  return `
    <li class="task" data-id="${t.id}">
      <input type="checkbox" data-act="complete" aria-label="Mark as done">
      <span class="title" data-act="rename" title="Click to edit">${esc(t.title)}</span>
      ${t.notes ? `<button class="ghost icon small notes" data-act="edit" title="${esc(t.notes.slice(0, 200))}">${icon('notes')}</button>` : ''}
      ${showCat ? `<span class="cat">${esc(categoryName(t.categoryId))}</span>` : ''}
      ${dueChip(t.due, 'edit-due')}
      ${priorityPicker(t.id, t.priority, 'set-priority')}
      <button class="ghost icon small reveal" data-act="edit" title="Details">${icon('pencil')}</button>
      <button class="ghost icon small reveal danger" data-act="delete" title="Delete">${icon('trash')}</button>
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

  const done = tasks.filter(t => t.completedAt && (!archiveFilter || t.categoryId === archiveFilter))
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));

  // Group by the local date on which the task was finished.
  const groups = new Map();
  for (const t of done) {
    const key = ymd(new Date(t.completedAt));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  main.innerHTML = `
    <div class="page">
      <div class="view-head">
        <h1>Archive</h1>
        <select id="archive-filter" aria-label="Filter by category">
          <option value="">All categories</option>
          ${categories.map(c => `<option value="${c.id}" ${c.id === archiveFilter ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      ${done.length ? [...groups].map(([day, list]) => `
        <section class="group">
          <h2>${fmtDay(parseYmd(day))} <span class="count">${list.length}</span></h2>
          <ul class="tasks">${list.map(archiveRow).join('')}</ul>
        </section>`).join('')
        : `<div class="empty">${icon('archive')}<p>Finished tasks show up here.</p></div>`}
    </div>`;
}

function archiveRow(t) {
  const fin = new Date(t.completedAt);
  const info = [`Finished ${fin.toLocaleString()}`, `Created ${new Date(t.createdAt).toLocaleString()}`];
  if (t.due) info.push(`Was due ${parseYmd(t.due).toDateString()}`);

  return `
    <li class="task done" data-id="${t.id}">
      <span class="done-mark">${icon('check')}</span>
      <span class="title" title="${esc(info.join('\n'))}">${esc(t.title)}</span>
      ${t.notes ? `<span class="notes" title="${esc(t.notes.slice(0, 200))}">${icon('notes')}</span>` : ''}
      <span class="cat">${esc(categoryName(t.categoryId))}</span>
      <span class="flag" data-p="${t.priority}" title="Priority: ${PRIORITY[t.priority].label}">${t.priority === 'low' ? '' : icon('flag')}</span>
      <time class="time" datetime="${t.completedAt}">${fmtTime(fin)}</time>
      <button class="ghost icon small reveal" data-act="reopen" title="Reopen">${icon('reopen')}</button>
      <button class="ghost icon small reveal danger" data-act="delete" title="Delete">${icon('trash')}</button>
    </li>`;
}

// Inline title editing. Enter or blur saves, Escape cancels.
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
  });
  input.addEventListener('blur', () => finish(true));
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
function ask({ title, message = '', input = null, buttons }) {
  const dlg = $('#dlg-ask');
  $('[data-title]', dlg).textContent = title;
  $('[data-message]', dlg).textContent = message;

  const wrap = $('[data-input-wrap]', dlg);
  const field = $('input', wrap);
  wrap.hidden = input === null;
  field.required = input !== null;
  field.value = input ?? '';

  $('[data-buttons]', dlg).innerHTML = [{ label: 'Cancel', value: 'cancel', cls: 'ghost', formnovalidate: true }, ...buttons]
    .map(b => `<button value="${b.value}" class="${b.cls || ''}" ${b.variant ? `data-variant="${b.variant}"` : ''}
      ${b.formnovalidate ? 'formnovalidate' : ''}>${esc(b.label)}</button>`).join('');

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
  f.notes.value = t.notes;
  f.priority.value = t.priority;
  f.due.value = t.due || '';

  dlg.returnValue = '';
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    store.updateTask(id, {
      title: f.title.value.trim() || t.title,
      notes: f.notes.value.trim(),
      priority: f.priority.value,
      due: f.due.value || null,
      categoryId: f.categoryId.value,
    });
  }, { once: true });
  dlg.showModal();
  f[focus].focus();
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

  const { action } = await ask({
    title: `Import ${file.name}?`,
    message: `Found ${data.tasks.length} task(s) in ${data.categories.length} categor${data.categories.length === 1 ? 'y' : 'ies'}. ` +
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
  focusAdd = true;
  render();
}

function bind() {
  window.addEventListener('hashchange', () => {
    // Close the sidebar overlay on mobile after navigating.
    $('[data-sidebar-layout]').removeAttribute('data-sidebar-open');
    draft.title = '';
    focusAdd = true;
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
  });

  main.addEventListener('keydown', e => {
    if (e.target.id !== 'add-title') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      addFromDraft();
    } else if (e.key === 'Escape') {
      draft.title = e.target.value = '';
    }
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
        focusAdd = true;
        render();
        break;

      case 'complete': {
        const li = el.closest('.task');
        li.classList.add('completing');
        setTimeout(() => {
          store.completeTask(id);
          toastAction('Task finished.', 'Undo', () => store.reopenTask(id));
        }, 300);
        break;
      }
    }
  });

  main.addEventListener('click', async e => {
    const el = e.target.closest('[data-act], .done-link');
    if (!el) return;
    const id = el.closest('.task')?.dataset.id;

    if (el.classList.contains('done-link')) {
      archiveFilter = el.dataset.cat;
      return;
    }

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
        focusAdd = true;
        render();
        break;

      case 'edit':
        editTask(id);
        break;

      case 'edit-due':
        editTask(id, 'due');
        break;

      case 'reopen':
        store.reopenTask(id);
        toastAction('Task reopened.', 'Undo', () => store.completeTask(id));
        break;

      case 'delete': {
        const t = store.get().tasks.find(t => t.id === id);
        const { action } = await ask({
          title: 'Delete task?', message: `"${t.title}" will be permanently deleted.`,
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

async function init() {
  await store.load();
  store.onChange(render);
  bind();
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
