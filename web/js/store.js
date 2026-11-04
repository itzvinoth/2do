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
  return d;
}

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

export function deleteCategory(id) {
  state.categories = state.categories.filter(c => c.id !== id);
  state.tasks = state.tasks.filter(t => t.categoryId !== id);
  commit();
}

// Tasks. A task with a parentId is a subtask; subtasks always share their
// root task's category.
export function addTask(t) {
  state.tasks.push({
    id: uid(),
    parentId: t.parentId || null,
    title: t.title,
    notes: t.notes || '',
    priority: t.priority || 'low',
    due: t.due || null,
    categoryId: t.categoryId,
    createdAt: new Date().toISOString(),
    completedAt: null,
  });
  commit();
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

export function deleteTask(id) {
  const gone = new Set([id, ...descendants(id).map(t => t.id)]);
  state.tasks = state.tasks.filter(t => !gone.has(t.id));
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

// Move a task under a new parent (or to the top level with null), optionally
// updating other fields at the same time. Returns false if the move is invalid.
export function setParent(id, parentId, fields = {}) {
  const t = find(id);
  if (!t || parentId === id || descendants(id).some(d => d.id === parentId)) return false;
  Object.assign(t, fields);
  t.parentId = parentId;
  if (parentId) {
    const p = find(parentId);
    p.collapsed = false;
    [t, ...descendants(id)].forEach(d => d.categoryId = p.categoryId);
  }
  commit();
  return true;
}

// Merge imported data: categories are matched by name, and tasks that already
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
