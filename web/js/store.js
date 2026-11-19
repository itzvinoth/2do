// App state and persistence. In the desktop app, data is saved to a JSON file
// through the local server's /api/data. Otherwise (PWA / static hosting) it
// is kept in localStorage.

const LS_KEY = '2do:data';

export const PRIORITIES = ['high', 'medium', 'low'];

let state = { categories: [], tasks: [] };
let backend = 'local';
let saveTimer = null;
const listeners = [];

export const uid = () => crypto.randomUUID();

export function emptyState() {
  return { categories: [{ id: uid(), name: 'Personal' }], tasks: [] };
}

export async function load() {
  try {
    const res = await fetch('api/data', { cache: 'no-store' });
    if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
      backend = 'file';
      state = normalize(await res.json());
      return;
    }
  } catch {
    // Offline or no server. Fall through to localStorage.
  }

  try {
    state = normalize(JSON.parse(localStorage.getItem(LS_KEY)));
  } catch {
    state = normalize(null);
  }
}

function normalize(d) {
  if (!d || !Array.isArray(d.categories) || !Array.isArray(d.tasks)) {
    return emptyState();
  }
  if (!d.tasks.every(t => typeof t.order === 'number')) numberTasks(d.tasks);
  return d;
}

// Tasks are kept in a manual order: each list of siblings is sorted by
// `order`. Data from before that has none, so it's numbered in the order it
// used to be sorted in (in progress, priority, due date, age), so that
// nothing moves.
function numberTasks(tasks) {
  const key = t => [!(t.startedAt && !t.completedAt), PRIORITIES.indexOf(t.priority), t.due || '9999', t.createdAt];
  const cmp = (a, b) => {
    const [x, y] = [key(a), key(b)];
    const i = x.findIndex((v, i) => v !== y[i]);
    return i < 0 ? 0 : x[i] < y[i] ? -1 : 1;
  };
  const groups = Map.groupBy(tasks, t => t.parentId || null);
  for (const list of groups.values()) list.sort(cmp).forEach((t, i) => t.order = i);
}

// The order that puts a task last among the children of parentId.
const nextOrder = parentId => Math.max(-1, ...state.tasks.filter(t => t.parentId === parentId).map(t => t.order)) + 1;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const body = JSON.stringify(state);
    if (backend === 'local') {
      localStorage.setItem(LS_KEY, body);
      return;
    }

    try {
      const res = await fetch('api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-2do': '1' },
        body,
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e) {
      window.ot.toast(e.message, 'Could not save', { variant: 'danger' });
    }
  }, 150);
}

// Opens a link from the app. The desktop app's server opens it in the default
// browser, since its own window is a separate browser profile; otherwise (or
// if that fails) it opens in a new browser window as usual.
export async function openLink(url) {
  if (backend === 'file') {
    try {
      const res = await fetch('api/open', { method: 'POST', headers: { 'X-2do': '1' }, body: url });
      if (res.ok) return;
    } catch {
      // Fall through.
    }
  }
  window.open(url, '_blank', 'noopener');
}

export function onChange(fn) {
  listeners.push(fn);
}

// Every mutation goes through here so that it's persisted and rendered.
function commit() {
  persist();
  listeners.forEach(fn => fn());
}

export const get = () => state;

export function replace(next) {
  state = normalize(next);
  commit();
}

// Categories.
export function addCategory(name) {
  const c = { id: uid(), name };
  state.categories.push(c);
  commit();
  return c;
}

export function renameCategory(id, name) {
  const c = state.categories.find(c => c.id === id);
  if (c) c.name = name;
  commit();
}

export function setCategoryNotes(id, notes) {
  const c = state.categories.find(c => c.id === id);
  if (c) c.notes = notes;
  commit();
}

export function deleteCategory(id) {
  state.categories = state.categories.filter(c => c.id !== id);
  state.tasks = state.tasks.filter(t => t.categoryId !== id);
  commit();
}

// Tasks. A task with a parentId is a subtask; subtasks always share their
// root task's category.
export function addTask(t) {
  const task = {
    id: uid(),
    parentId: t.parentId || null,
    title: t.title,
    notes: t.notes || '',
    priority: t.priority || 'low',
    due: t.due || null,
    categoryId: t.categoryId,
    order: nextOrder(t.parentId || null),
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  state.tasks.push(task);
  commit();
  return task;
}

export const find = id => state.tasks.find(t => t.id === id);

export function descendants(id) {
  const out = [];
  for (const t of state.tasks) {
    if (t.parentId === id) out.push(t, ...descendants(t.id));
  }
  return out;
}

export function updateTask(id, fields) {
  const t = find(id);
  if (!t) return;
  Object.assign(t, fields);
  if (fields.categoryId) descendants(id).forEach(d => d.categoryId = fields.categoryId);
  commit();
}

// Deleting a task deletes its subtasks too. Returns them all, for undo.
export function deleteTask(id) {
  const gone = new Set([id, ...descendants(id).map(t => t.id)]);
  const removed = state.tasks.filter(t => gone.has(t.id));
  state.tasks = state.tasks.filter(t => !gone.has(t.id));
  commit();
  return removed;
}

// Puts deleted tasks back. One whose parent has since been deleted too comes
// back as a top-level task.
export function restoreTasks(list) {
  const ids = new Set(list.map(t => t.id));
  for (const t of list) {
    if (t.parentId && !ids.has(t.parentId) && !find(t.parentId)) t.parentId = null;
  }
  state.tasks.push(...list);
  commit();
}

// Finishing a task also finishes its open subtasks. Returns the ids that
// changed, for undo.
export function completeTask(id) {
  const now = new Date().toISOString();
  const changed = [find(id), ...descendants(id)].filter(t => t && !t.completedAt);
  changed.forEach(t => t.completedAt = now);
  commit();
  return changed.map(t => t.id);
}

// Reopening a task also reopens its finished parents, so it's visible again.
export function reopenTask(id) {
  for (let t = find(id); t; t = find(t.parentId)) t.completedAt = null;
  commit();
}

export function reopenMany(ids) {
  ids.forEach(id => { const t = find(id); if (t) t.completedAt = null; });
  commit();
}

// Move a task to before another of its siblings, or to the end with null.
export function moveTask(id, beforeId) {
  const t = find(id);
  const list = state.tasks.filter(s => s.parentId === t.parentId && s !== t).sort((a, b) => a.order - b.order);
  const i = list.findIndex(s => s.id === beforeId);
  list.splice(i < 0 ? list.length : i, 0, t);
  list.forEach((s, n) => s.order = n);
  commit();
}

// Move a task under a new parent (or to the top level with null), as its last
// child, optionally updating other fields at the same time. Returns false if
// the move is invalid.
export function setParent(id, parentId, fields = {}) {
  const t = find(id);
  if (!t || parentId === id || descendants(id).some(d => d.id === parentId)) return false;
  Object.assign(t, fields);
  if (t.parentId !== parentId) t.order = nextOrder(parentId);
  t.parentId = parentId;
  if (parentId) {
    const p = find(parentId);
    p.collapsed = false;
    [t, ...descendants(id)].forEach(d => d.categoryId = p.categoryId);
  }
  commit();
  return true;
}

// Merge imported data: categories are matched by name (keeping existing
// category notes, or taking the imported ones if there are none), and tasks that already
// exist (same category, parent, title and done state) are skipped. A skipped
// task's subtasks are merged under the existing task.
export function merge(incoming) {
  const byName = new Map(state.categories.map(c => [c.name.toLowerCase(), c]));
  const catMap = new Map();

  for (const c of incoming.categories) {
    let ex = byName.get(c.name.toLowerCase());
    if (!ex) {
      ex = { id: uid(), name: c.name };
      state.categories.push(ex);
      byName.set(c.name.toLowerCase(), ex);
    }
    if (!ex.notes && c.notes) ex.notes = c.notes;
    catMap.set(c.id, ex.id);
  }

  const key = t => `${t.categoryId}\n${t.parentId || ''}\n${t.title}\n${!!t.completedAt}`;
  const existing = new Map(state.tasks.map(t => [key(t), t.id]));
  const taskMap = new Map();

  // Incoming tasks are ordered parents-first, so parent ids are already mapped.
  let added = 0;
  for (const t of incoming.tasks) {
    const task = {
      ...t,
      id: uid(),
      categoryId: catMap.get(t.categoryId),
      parentId: t.parentId ? taskMap.get(t.parentId) : null,
    };
    task.order = nextOrder(task.parentId);

    const dup = existing.get(key(task));
    if (dup) {
      taskMap.set(t.id, dup);
      continue;
    }
    existing.set(key(task), task.id);
    taskMap.set(t.id, task.id);
    state.tasks.push(task);
    added++;
  }

  commit();
  return added;
}
