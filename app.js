(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────
  const STORAGE_KEY = 'taskflow_tasks';
  const THEME_KEY   = 'taskflow_theme';
  const SORT_KEY    = 'taskflow_sort';

  // ── State ────────────────────────────────────────────────
  const state = {
    tasks: [],
    filter: 'all',
    sort: 'created-desc',
    searchQuery: '',
    categoryFilter: 'all',
    theme: 'light',
    editingId: null,
    prevStats: { total: -1, active: -1, done: -1, overdue: -1 },
    subtaskBuffer: [],       // working list while modal open
    confirmCallback: null,
  };

  // ── Persistence ──────────────────────────────────────────
  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state.tasks = Array.isArray(parsed) ? parsed.map(migrateTask) : [];
      }
    } catch (_) { state.tasks = []; }

    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme) {
      state.theme = savedTheme;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      state.theme = 'dark';
    }

    const savedSort = localStorage.getItem(SORT_KEY);
    if (savedSort) state.sort = savedSort;
  }

  function saveToStorage() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks)); } catch (_) {}
    localStorage.setItem(THEME_KEY, state.theme);
    localStorage.setItem(SORT_KEY, state.sort);
  }

  function migrateTask(t) {
    return {
      id:          t.id          ?? uid(),
      title:       t.title       ?? '',
      description: t.description ?? '',
      completed:   t.completed   ?? false,
      priority:    t.priority    ?? 'medium',
      category:    t.category    ?? 'personal',
      tags:        Array.isArray(t.tags) ? t.tags : [],
      dueDate:     t.dueDate     ?? null,
      subtasks:    Array.isArray(t.subtasks) ? t.subtasks : [],
      createdAt:   t.createdAt   ?? Date.now(),
      order:       t.order       ?? 0,
    };
  }

  // ── Utilities ────────────────────────────────────────────
  function uid() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function todayStr() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function dueSoonStr() {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return d.toISOString().slice(0, 10);
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }

  function parseTags(str) {
    return str.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  }

  // ── Task CRUD ────────────────────────────────────────────
  function createTask(fields) {
    return {
      id:          uid(),
      title:       (fields.title || '').trim(),
      description: (fields.description || '').trim(),
      completed:   false,
      priority:    fields.priority  || 'medium',
      category:    fields.category  || 'personal',
      tags:        fields.tags      || [],
      dueDate:     fields.dueDate   || null,
      subtasks:    fields.subtasks  || [],
      createdAt:   Date.now(),
      order:       state.tasks.length,
    };
  }

  function addTask(fields) {
    if (!fields.title || !fields.title.trim()) return;
    const task = createTask(fields);
    state.tasks.unshift(task);
    state.tasks.forEach((t, i) => t.order = i);
    saveToStorage();
    render();
    // animate the new item
    requestAnimationFrame(() => {
      const el = document.querySelector(`.task-item[data-id="${task.id}"]`);
      if (el) {
        el.classList.add('entering');
        el.addEventListener('animationend', () => el.classList.remove('entering'), { once: true });
      }
    });
  }

  function updateTask(id, changes) {
    const idx = state.tasks.findIndex(t => t.id === id);
    if (idx === -1) return;
    Object.assign(state.tasks[idx], changes);
    saveToStorage();
    render();
  }

  function toggleTask(id) {
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    task.completed = !task.completed;
    saveToStorage();

    // partial DOM update — just toggle class and re-render stats, avoid full re-render flicker
    const el = document.querySelector(`.task-item[data-id="${id}"]`);
    if (el) {
      el.classList.toggle('completed', task.completed);
      const cb = el.querySelector('.task-checkbox');
      if (cb) cb.checked = task.completed;
      const titleEl = el.querySelector('.task-title');
      if (titleEl) titleEl.classList.toggle('done', task.completed);
      el.classList.add('flash');
      el.addEventListener('animationend', () => el.classList.remove('flash'), { once: true });
    }
    renderStats();
    // if filtered view needs to change (e.g. active filter hiding completed), do full render after anim
    if (state.filter !== 'all') {
      setTimeout(() => render(), 100);
    } else {
      updateDueBadge(id);
    }
  }

  function deleteTask(id) {
    const el = document.querySelector(`.task-item[data-id="${id}"]`);
    if (!el) { _removeTaskFromState(id); render(); return; }
    el.classList.add('exiting');
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      _removeTaskFromState(id);
      if (el.parentNode) el.remove();
      renderStats();
      updateEmptyState();
      renderCategoryFilter();
    };
    el.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, 400);
  }

  function _removeTaskFromState(id) {
    state.tasks = state.tasks.filter(t => t.id !== id);
    saveToStorage();
  }

  // ── Query ────────────────────────────────────────────────
  function getFilteredTasks() {
    let tasks = [...state.tasks];

    if (state.filter === 'active')    tasks = tasks.filter(t => !t.completed);
    if (state.filter === 'completed') tasks = tasks.filter(t =>  t.completed);

    if (state.categoryFilter !== 'all')
      tasks = tasks.filter(t => t.category === state.categoryFilter);

    const q = state.searchQuery.toLowerCase().trim();
    if (q) {
      tasks = tasks.filter(t =>
        t.title.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags.some(tag => tag.includes(q))
      );
    }
    return tasks;
  }

  function getSortedTasks(arr) {
    const p = { high: 3, medium: 2, low: 1 };
    const s = [...arr];
    switch (state.sort) {
      case 'created-desc': return s.sort((a,b) => b.createdAt - a.createdAt);
      case 'created-asc':  return s.sort((a,b) => a.createdAt - b.createdAt);
      case 'due-asc':
        return s.sort((a,b) => {
          if (!a.dueDate && !b.dueDate) return 0;
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return a.dueDate.localeCompare(b.dueDate);
        });
      case 'due-desc':
        return s.sort((a,b) => {
          if (!a.dueDate && !b.dueDate) return 0;
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return b.dueDate.localeCompare(a.dueDate);
        });
      case 'priority-desc': return s.sort((a,b) => p[b.priority] - p[a.priority]);
      case 'priority-asc':  return s.sort((a,b) => p[a.priority] - p[b.priority]);
      case 'alpha-asc':     return s.sort((a,b) => a.title.localeCompare(b.title));
      case 'alpha-desc':    return s.sort((a,b) => b.title.localeCompare(a.title));
      default:              return s.sort((a,b) => a.order - b.order);
    }
  }

  function getVisibleTasks() {
    return getSortedTasks(getFilteredTasks());
  }

  // ── Render ───────────────────────────────────────────────
  function render() {
    renderTaskList();
    renderStats();
    updateEmptyState();
    renderCategoryFilter();
  }

  function renderTaskList() {
    const list = document.getElementById('task-list');
    const tasks = getVisibleTasks();
    const q = state.searchQuery.toLowerCase().trim();
    const frag = document.createDocumentFragment();
    tasks.forEach(task => frag.appendChild(renderTaskItem(task, q)));
    list.innerHTML = '';
    list.appendChild(frag);
  }

  function renderTaskItem(task, query) {
    const li = document.createElement('li');
    li.className = 'task-item' + (task.completed ? ' completed' : '');
    li.dataset.id = task.id;
    li.dataset.priority = task.priority;
    li.dataset.category = task.category;
    li.setAttribute('draggable', 'false');

    // Drag handle
    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    handle.setAttribute('draggable', 'true');
    handle.dataset.dragHandle = '1';
    handle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="9" cy="5" r="1.5" fill="currentColor"/><circle cx="15" cy="5" r="1.5" fill="currentColor"/>
      <circle cx="9" cy="12" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1.5" fill="currentColor"/>
      <circle cx="9" cy="19" r="1.5" fill="currentColor"/><circle cx="15" cy="19" r="1.5" fill="currentColor"/>
    </svg>`;

    // Checkbox
    const cbWrap = document.createElement('div');
    cbWrap.className = 'task-checkbox-wrap';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'task-checkbox';
    cb.checked = task.completed;
    cb.dataset.action = 'toggle';
    cb.dataset.id = task.id;
    cb.setAttribute('aria-label', 'Mark task complete');
    cbWrap.appendChild(cb);

    // Body
    const body = document.createElement('div');
    body.className = 'task-body';

    // Title (with search highlight)
    const titleEl = document.createElement('div');
    titleEl.className = 'task-title';
    if (query) {
      const escaped = escapeHtml(task.title);
      const escapedQ = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      titleEl.innerHTML = escaped.replace(new RegExp(`(${escapedQ})`, 'gi'), '<mark>$1</mark>');
    } else {
      titleEl.textContent = task.title;
    }

    body.appendChild(titleEl);

    // Description
    if (task.description) {
      const desc = document.createElement('p');
      desc.className = 'task-desc';
      desc.textContent = task.description;
      body.appendChild(desc);
    }

    // Meta row
    const meta = document.createElement('div');
    meta.className = 'task-meta';

    const catBadge = document.createElement('span');
    catBadge.className = 'category-badge';
    catBadge.textContent = task.category.charAt(0).toUpperCase() + task.category.slice(1);
    meta.appendChild(catBadge);

    if (task.dueDate) {
      const today = todayStr();
      const soon  = dueSoonStr();
      const chip = document.createElement('span');
      chip.className = 'due-chip';
      if (!task.completed && task.dueDate < today) {
        chip.classList.add('overdue');
        chip.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Overdue · ${formatDate(task.dueDate)}`;
      } else if (!task.completed && task.dueDate <= soon) {
        chip.classList.add('due-soon');
        chip.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${formatDate(task.dueDate)}`;
      } else {
        chip.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${formatDate(task.dueDate)}`;
      }
      meta.appendChild(chip);
    }

    task.tags.forEach(tag => {
      const tc = document.createElement('span');
      tc.className = 'tag-chip';
      tc.textContent = '#' + tag;
      meta.appendChild(tc);
    });

    body.appendChild(meta);

    // Subtasks
    if (task.subtasks && task.subtasks.length > 0) {
      body.appendChild(renderSubtasksSection(task));
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'task-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'task-action-btn edit-btn';
    editBtn.dataset.action = 'edit';
    editBtn.dataset.id = task.id;
    editBtn.setAttribute('aria-label', 'Edit task');
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>`;

    const delBtn = document.createElement('button');
    delBtn.className = 'task-action-btn delete-btn';
    delBtn.dataset.action = 'delete';
    delBtn.dataset.id = task.id;
    delBtn.setAttribute('aria-label', 'Delete task');
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
      <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
    </svg>`;

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    li.appendChild(handle);
    li.appendChild(cbWrap);
    li.appendChild(body);
    li.appendChild(actions);
    return li;
  }

  function renderSubtasksSection(task) {
    const done  = task.subtasks.filter(s => s.completed).length;
    const total = task.subtasks.length;
    const pct   = Math.round((done / total) * 100);

    const wrap = document.createElement('div');
    wrap.className = 'subtask-summary';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'subtask-toggle-btn';
    toggleBtn.dataset.subtaskToggle = task.id;
    toggleBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>${done}/${total}`;

    const barWrap = document.createElement('div');
    barWrap.className = 'subtask-progress-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'subtask-progress-bar' + (pct === 100 ? ' complete' : '');
    bar.style.width = pct + '%';
    barWrap.appendChild(bar);

    wrap.appendChild(toggleBtn);
    wrap.appendChild(barWrap);

    const inlineList = document.createElement('ul');
    inlineList.className = 'subtask-inline-list collapsed';
    inlineList.dataset.subtaskListFor = task.id;

    task.subtasks.forEach(sub => {
      const sli = document.createElement('li');
      sli.className = 'subtask-inline-item';
      const sch = document.createElement('input');
      sch.type = 'checkbox';
      sch.className = 'subtask-inline-check';
      sch.checked = sub.completed;
      sch.dataset.action = 'subtask-toggle';
      sch.dataset.taskId = task.id;
      sch.dataset.subtaskId = sub.id;
      const lbl = document.createElement('span');
      lbl.className = 'subtask-inline-label' + (sub.completed ? ' done' : '');
      lbl.textContent = sub.title;
      sli.appendChild(sch);
      sli.appendChild(lbl);
      inlineList.appendChild(sli);
    });

    return document.createDocumentFragment && (() => {
      const frag = document.createElement('div');
      frag.style.cssText = 'display:contents';
      frag.appendChild(wrap);
      frag.appendChild(inlineList);
      return frag;
    })();
  }

  function renderStats() {
    const today = todayStr();
    const total   = state.tasks.length;
    const done    = state.tasks.filter(t => t.completed).length;
    const active  = total - done;
    const overdue = state.tasks.filter(t => t.dueDate && !t.completed && t.dueDate < today).length;

    setStatChip('stat-total',   `${total} task${total !== 1 ? 's' : ''}`,     total !== state.prevStats.total);
    setStatChip('stat-active',  `${active} active`,                            active !== state.prevStats.active);
    setStatChip('stat-done',    `${done} done`,                                done !== state.prevStats.done);
    setStatChip('stat-overdue', `${overdue} overdue`,                          overdue !== state.prevStats.overdue);

    const overdueEl = document.getElementById('stat-overdue');
    if (overdue > 0) overdueEl.classList.remove('hidden');
    else overdueEl.classList.add('hidden');

    state.prevStats = { total, active, done, overdue };
  }

  function setStatChip(id, text, changed) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (changed) {
      el.classList.remove('pulse');
      void el.offsetWidth;
      el.classList.add('pulse');
      el.addEventListener('animationend', () => el.classList.remove('pulse'), { once: true });
    }
  }

  function updateEmptyState() {
    const el = document.getElementById('empty-state');
    const tasks = getVisibleTasks();
    const msgEl = document.getElementById('empty-message');
    if (tasks.length === 0) {
      el.classList.remove('hidden');
      if (state.searchQuery) msgEl.textContent = 'No tasks match your search.';
      else if (state.filter === 'completed') msgEl.textContent = 'No completed tasks yet.';
      else if (state.filter === 'active') msgEl.textContent = 'No active tasks. Great job!';
      else msgEl.textContent = 'No tasks yet. Add one above!';
    } else {
      el.classList.add('hidden');
    }
  }

  function renderCategoryFilter() {
    const sel = document.getElementById('category-filter');
    const current = sel.value;
    const categories = [...new Set(state.tasks.map(t => t.category))].sort();
    const labels = { personal:'Personal', work:'Work', shopping:'Shopping', health:'Health', finance:'Finance', other:'Other' };
    sel.innerHTML = '<option value="all">All categories</option>';
    categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = labels[cat] || cat;
      sel.appendChild(opt);
    });
    if (categories.includes(current)) sel.value = current;
  }

  function updateDueBadge(id) {
    // no-op: badge re-renders on full render cycle; called after toggle
  }

  function formatDate(str) {
    if (!str) return '';
    const [y, m, d] = str.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(m,10)-1]} ${parseInt(d,10)}, ${y}`;
  }

  // ── Modal ────────────────────────────────────────────────
  function openModal(taskId = null) {
    state.editingId = taskId;
    state.subtaskBuffer = [];
    const modal = document.getElementById('task-modal');
    const form  = document.getElementById('task-form');
    form.reset();
    document.getElementById('subtask-edit-list').innerHTML = '';
    document.getElementById('title-error').classList.add('hidden');
    document.getElementById('task-title').classList.remove('error');

    if (taskId) {
      document.getElementById('modal-title').textContent = 'Edit Task';
      document.getElementById('form-submit').textContent = 'Update Task';
      const task = state.tasks.find(t => t.id === taskId);
      if (task) populateForm(task);
    } else {
      document.getElementById('modal-title').textContent = 'Add Task';
      document.getElementById('form-submit').textContent = 'Save Task';
      // pre-fill title from quick-add if any
      const qa = document.getElementById('quick-add-input').value.trim();
      if (qa) document.getElementById('task-title').value = qa;
    }
    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('task-title').focus(), 60);
  }

  function closeModal() {
    document.getElementById('task-modal').classList.add('hidden');
    state.editingId = null;
    state.subtaskBuffer = [];
  }

  function populateForm(task) {
    document.getElementById('task-title').value       = task.title;
    document.getElementById('task-description').value = task.description;
    document.getElementById('task-priority').value    = task.priority;
    document.getElementById('task-due').value         = task.dueDate || '';
    document.getElementById('task-category').value    = task.category;
    document.getElementById('task-tags').value        = task.tags.join(', ');
    state.subtaskBuffer = task.subtasks.map(s => ({ ...s }));
    renderSubtaskEditList();
  }

  function getFormValues() {
    return {
      title:       document.getElementById('task-title').value,
      description: document.getElementById('task-description').value,
      priority:    document.getElementById('task-priority').value,
      dueDate:     document.getElementById('task-due').value || null,
      category:    document.getElementById('task-category').value,
      tags:        parseTags(document.getElementById('task-tags').value),
      subtasks:    state.subtaskBuffer.slice(),
    };
  }

  function handleFormSubmit(e) {
    e.preventDefault();
    const fields = getFormValues();
    const titleInput = document.getElementById('task-title');
    const titleError = document.getElementById('title-error');

    if (!fields.title.trim()) {
      titleInput.classList.add('error', 'shake');
      titleError.classList.remove('hidden');
      titleInput.addEventListener('animationend', () => titleInput.classList.remove('shake'), { once: true });
      titleInput.focus();
      return;
    }
    titleInput.classList.remove('error');
    titleError.classList.add('hidden');

    if (state.editingId) {
      updateTask(state.editingId, fields);
    } else {
      // clear quick-add input
      document.getElementById('quick-add-input').value = '';
      addTask(fields);
    }
    closeModal();
  }

  // Subtask editing in modal
  function addSubtaskToBuffer(title) {
    const t = title.trim();
    if (!t) return;
    state.subtaskBuffer.push({ id: uid(), title: t, completed: false });
    renderSubtaskEditList();
  }

  function removeSubtaskFromBuffer(id) {
    state.subtaskBuffer = state.subtaskBuffer.filter(s => s.id !== id);
    renderSubtaskEditList();
  }

  function renderSubtaskEditList() {
    const ul = document.getElementById('subtask-edit-list');
    ul.innerHTML = '';
    state.subtaskBuffer.forEach(sub => {
      const li = document.createElement('li');
      li.className = 'subtask-edit-item';
      const lbl = document.createElement('span');
      lbl.className = 'subtask-edit-label';
      lbl.textContent = sub.title;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'subtask-edit-remove';
      rm.dataset.subtaskRemove = sub.id;
      rm.setAttribute('aria-label', 'Remove subtask');
      rm.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      li.appendChild(lbl);
      li.appendChild(rm);
      ul.appendChild(li);
    });
  }

  // ── Confirm Dialog ───────────────────────────────────────
  function openConfirm(message, onConfirm) {
    document.getElementById('confirm-message').textContent = message;
    state.confirmCallback = onConfirm;
    document.getElementById('confirm-dialog').classList.remove('hidden');
  }

  function closeConfirm() {
    document.getElementById('confirm-dialog').classList.add('hidden');
    state.confirmCallback = null;
  }

  // ── Drag & Drop ──────────────────────────────────────────
  let dragId = null;

  function initDragDrop() {
    const list = document.getElementById('task-list');

    list.addEventListener('dragstart', e => {
      const handle = e.target.closest('[data-drag-handle]');
      if (!handle) { e.preventDefault(); return; }
      const item = handle.closest('.task-item');
      if (!item) return;
      dragId = item.dataset.id;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });

    list.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const item = e.target.closest('.task-item');
      list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      if (item && item.dataset.id !== dragId) item.classList.add('drag-over');
    });

    list.addEventListener('dragleave', e => {
      const item = e.target.closest('.task-item');
      if (item) item.classList.remove('drag-over');
    });

    list.addEventListener('drop', e => {
      e.preventDefault();
      const target = e.target.closest('.task-item');
      list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      if (!target || !dragId || target.dataset.id === dragId) return;
      reorderTasks(dragId, target.dataset.id);
    });

    list.addEventListener('dragend', () => {
      list.querySelectorAll('.dragging, .drag-over').forEach(el => {
        el.classList.remove('dragging', 'drag-over');
      });
      dragId = null;
    });
  }

  function reorderTasks(fromId, toId) {
    const fromIdx = state.tasks.findIndex(t => t.id === fromId);
    const toIdx   = state.tasks.findIndex(t => t.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [item] = state.tasks.splice(fromIdx, 1);
    state.tasks.splice(toIdx, 0, item);
    state.tasks.forEach((t, i) => t.order = i);
    // switch sort to custom order
    state.sort = 'order';
    document.getElementById('sort-select').value = 'order';
    saveToStorage();
    render();
  }

  // Touch drag
  function initTouchDragDrop() {
    if (!('ontouchstart' in window)) return;
    const list = document.getElementById('task-list');
    let ghost = null;
    let touchDragId = null;
    let offsetX = 0, offsetY = 0;

    list.addEventListener('touchstart', e => {
      const handle = e.target.closest('[data-drag-handle]');
      if (!handle) return;
      const item = handle.closest('.task-item');
      if (!item) return;
      touchDragId = item.dataset.id;
      const touch = e.touches[0];
      const rect  = item.getBoundingClientRect();
      offsetX = touch.clientX - rect.left;
      offsetY = touch.clientY - rect.top;
      ghost = item.cloneNode(true);
      ghost.style.cssText = `position:fixed;pointer-events:none;opacity:0.7;z-index:9999;width:${rect.width}px;left:${rect.left}px;top:${rect.top}px;`;
      document.body.appendChild(ghost);
      item.classList.add('dragging');
    }, { passive: true });

    list.addEventListener('touchmove', e => {
      if (!ghost) return;
      e.preventDefault();
      const touch = e.touches[0];
      ghost.style.left = (touch.clientX - offsetX) + 'px';
      ghost.style.top  = (touch.clientY - offsetY) + 'px';
      ghost.style.display = 'none';
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      ghost.style.display = '';
      list.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
      const target = el && el.closest('.task-item');
      if (target && target.dataset.id !== touchDragId) target.classList.add('drag-over');
    }, { passive: false });

    list.addEventListener('touchend', e => {
      if (!ghost) return;
      const touch = e.changedTouches[0];
      ghost.style.display = 'none';
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      ghost.remove(); ghost = null;
      list.querySelectorAll('.dragging, .drag-over').forEach(x => x.classList.remove('dragging','drag-over'));
      const target = el && el.closest('.task-item');
      if (target && touchDragId && target.dataset.id !== touchDragId) {
        reorderTasks(touchDragId, target.dataset.id);
      }
      touchDragId = null;
    });
  }

  // ── Theme ────────────────────────────────────────────────
  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    const btn = document.getElementById('theme-toggle');
    btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    localStorage.setItem(THEME_KEY, theme);
  }

  function toggleTheme() {
    setTheme(state.theme === 'dark' ? 'light' : 'dark');
  }

  // ── Event Listeners ──────────────────────────────────────
  function initEventListeners() {
    // Quick add
    const qaInput = document.getElementById('quick-add-input');
    qaInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const val = qaInput.value.trim();
        if (val) { addTask({ title: val }); qaInput.value = ''; }
      }
    });
    document.getElementById('quick-add-btn').addEventListener('click', () => {
      const val = qaInput.value.trim();
      if (val) { addTask({ title: val }); qaInput.value = ''; }
    });
    document.getElementById('expand-form-btn').addEventListener('click', () => openModal(null));

    // Filter tabs
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.filter = btn.dataset.filter;
        render();
      });
    });

    // Search
    const searchInput = document.getElementById('search-input');
    const searchClear = document.getElementById('search-clear');
    const debouncedSearch = debounce(q => {
      state.searchQuery = q;
      searchClear.classList.toggle('hidden', !q);
      render();
    }, 150);
    searchInput.addEventListener('input', e => debouncedSearch(e.target.value));
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      state.searchQuery = '';
      searchClear.classList.add('hidden');
      render();
      searchInput.focus();
    });

    // Sort
    document.getElementById('sort-select').addEventListener('change', e => {
      state.sort = e.target.value;
      saveToStorage();
      render();
    });

    // Category filter
    document.getElementById('category-filter').addEventListener('change', e => {
      state.categoryFilter = e.target.value;
      render();
    });

    // Bulk actions
    document.getElementById('mark-all-btn').addEventListener('click', () => {
      const targets = state.filter === 'active'
        ? state.tasks.filter(t => !t.completed)
        : state.tasks;
      if (targets.every(t => t.completed)) {
        targets.forEach(t => t.completed = false);
      } else {
        targets.forEach(t => t.completed = true);
      }
      saveToStorage();
      render();
    });

    document.getElementById('clear-completed-btn').addEventListener('click', () => {
      const count = state.tasks.filter(t => t.completed).length;
      if (!count) return;
      openConfirm(`Remove ${count} completed task${count !== 1 ? 's' : ''}?`, () => {
        state.tasks = state.tasks.filter(t => !t.completed);
        saveToStorage();
        render();
      });
    });

    // Theme toggle
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

    // Task list event delegation
    const taskList = document.getElementById('task-list');
    taskList.addEventListener('click', e => {
      const cb = e.target.closest('[data-action="toggle"]');
      if (cb) { toggleTask(cb.dataset.id); return; }

      const editBtn = e.target.closest('[data-action="edit"]');
      if (editBtn) { openModal(editBtn.dataset.id); return; }

      const delBtn = e.target.closest('[data-action="delete"]');
      if (delBtn) {
        openConfirm('Delete this task?', () => deleteTask(delBtn.dataset.id));
        return;
      }

      const subtaskToggle = e.target.closest('[data-subtask-toggle]');
      if (subtaskToggle) {
        const id = subtaskToggle.dataset.subtaskToggle;
        const ul = document.querySelector(`[data-subtask-list-for="${id}"]`);
        if (ul) {
          ul.classList.toggle('collapsed');
          subtaskToggle.classList.toggle('open');
        }
        return;
      }

      const subtaskCb = e.target.closest('[data-action="subtask-toggle"]');
      if (subtaskCb) {
        const { taskId, subtaskId } = subtaskCb.dataset;
        const task = state.tasks.find(t => t.id === taskId);
        if (task) {
          const sub = task.subtasks.find(s => s.id === subtaskId);
          if (sub) {
            sub.completed = subtaskCb.checked;
            const lbl = subtaskCb.nextElementSibling;
            if (lbl) lbl.classList.toggle('done', sub.completed);
            // Update progress bar
            const done = task.subtasks.filter(s => s.completed).length;
            const total = task.subtasks.length;
            const pct = Math.round(done / total * 100);
            const bar = document.querySelector(`.task-item[data-id="${taskId}"] .subtask-progress-bar`);
            if (bar) { bar.style.width = pct + '%'; bar.classList.toggle('complete', pct === 100); }
            const label = document.querySelector(`.task-item[data-id="${taskId}"] .subtask-toggle-btn`);
            if (label) label.innerHTML = label.innerHTML.replace(/\d+\/\d+/, `${done}/${total}`);
            saveToStorage();
          }
        }
        return;
      }
    });

    // Modal form
    document.getElementById('task-form').addEventListener('submit', handleFormSubmit);
    document.getElementById('form-cancel').addEventListener('click', closeModal);
    document.querySelector('.modal-close').addEventListener('click', closeModal);
    document.getElementById('task-modal').addEventListener('click', e => {
      if (e.target === document.getElementById('task-modal')) closeModal();
    });

    // Subtask add in modal
    const subtaskInput = document.getElementById('subtask-input');
    document.getElementById('subtask-add-btn').addEventListener('click', () => {
      addSubtaskToBuffer(subtaskInput.value);
      subtaskInput.value = '';
      subtaskInput.focus();
    });
    subtaskInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSubtaskToBuffer(subtaskInput.value);
        subtaskInput.value = '';
      }
    });
    document.getElementById('subtask-edit-list').addEventListener('click', e => {
      const btn = e.target.closest('[data-subtask-remove]');
      if (btn) removeSubtaskFromBuffer(btn.dataset.subtaskRemove);
    });

    // Confirm dialog
    document.getElementById('confirm-ok').addEventListener('click', () => {
      if (state.confirmCallback) state.confirmCallback();
      closeConfirm();
    });
    document.getElementById('confirm-cancel').addEventListener('click', closeConfirm);
    document.getElementById('confirm-dialog').addEventListener('click', e => {
      if (e.target === document.getElementById('confirm-dialog')) closeConfirm();
    });
  }

  // ── Keyboard Shortcuts ───────────────────────────────────
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
      const typing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);
      const modalOpen = !document.getElementById('task-modal').classList.contains('hidden');
      const confirmOpen = !document.getElementById('confirm-dialog').classList.contains('hidden');

      if (e.key === 'Escape') {
        if (confirmOpen) { closeConfirm(); return; }
        if (modalOpen)   { closeModal();   return; }
        if (state.searchQuery) {
          document.getElementById('search-input').value = '';
          state.searchQuery = '';
          document.getElementById('search-clear').classList.add('hidden');
          render();
        }
        return;
      }

      if (!typing && !modalOpen) {
        if (e.key === '/' ) { e.preventDefault(); document.getElementById('search-input').focus(); }
        if (e.key === 'n' ) { e.preventDefault(); document.getElementById('quick-add-input').focus(); }
        if (e.key === 'N' ) { e.preventDefault(); openModal(null); }
      }
    });
  }

  // ── Init ─────────────────────────────────────────────────
  function init() {
    loadFromStorage();
    setTheme(state.theme);
    document.getElementById('sort-select').value = state.sort;
    render();
    initEventListeners();
    initDragDrop();
    initTouchDragDrop();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
