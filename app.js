/* ============================================================
   TO-DO LIST APP — Main Logic
   Sections:
     A. Initialization
     B. Authentication
     C. Firestore CRUD (Tasks)
     D. Firestore CRUD (Categories)
     E. UI Rendering
     F. View Navigation
     G. Form Handling
     H. Notifications
     I. PWA Install Prompt
   ============================================================ */

'use strict';

// ============================================================
// A. INITIALIZATION
// ============================================================

let db, auth, currentUser;
let unsubscribeTasks = null;
let unsubscribeCategories = null;
let allTasks = [];
let allCategories = [];
let currentFilter = 'all';
let currentCategoryFilter = '';
let editingTaskId = null;
let scheduledNotifications = [];
let deferredInstallPrompt = null;

// DOM References
const authScreen = document.getElementById('auth-screen');
const appScreen = document.getElementById('app-screen');
const googleSignInBtn = document.getElementById('google-signin-btn');
const signOutBtn = document.getElementById('signout-btn');
const userNameEl = document.getElementById('user-name');

const addTaskForm = document.getElementById('add-task-form');
const taskTitleInput = document.getElementById('task-title');
const taskDueDateInput = document.getElementById('task-due-date');
const taskPrioritySelect = document.getElementById('task-priority');
const taskCategorySelect = document.getElementById('task-category');
const taskNotesInput = document.getElementById('task-notes');
const addTaskBtn = document.getElementById('add-task-btn');
const titleError = document.getElementById('title-error');

const taskList = document.getElementById('task-list');
const emptyState = document.getElementById('empty-state');
const filterTabs = document.querySelectorAll('.tab');
const filterCategorySelect = document.getElementById('filter-category');

const editModal = document.getElementById('edit-modal');
const editTaskForm = document.getElementById('edit-task-form');
const editTitleInput = document.getElementById('edit-title');
const editDueDateInput = document.getElementById('edit-due-date');
const editPrioritySelect = document.getElementById('edit-priority');
const editCategorySelect = document.getElementById('edit-category');
const editNotesInput = document.getElementById('edit-notes');
const editTitleError = document.getElementById('edit-title-error');
const saveEditBtn = document.getElementById('save-edit-btn');
const cancelEditBtn = document.getElementById('cancel-edit-btn');

const notifBanner = document.getElementById('notif-banner');
const enableNotifBtn = document.getElementById('enable-notif-btn');
const dismissNotifBtn = document.getElementById('dismiss-notif-btn');

const installBanner = document.getElementById('install-banner');
const installBtn = document.getElementById('install-btn');
const dismissInstallBtn = document.getElementById('dismiss-install-btn');

// View navigation
const viewTabs = document.querySelectorAll('.view-tab');
const viewPanels = document.querySelectorAll('.view-panel');

// Category management
const categoryNameInput = document.getElementById('category-name-input');
const addCategoryBtn = document.getElementById('add-category-btn');
const categoryListEl = document.getElementById('category-list');
const categoryEmpty = document.getElementById('category-empty');

document.addEventListener('DOMContentLoaded', () => {
  // Initialize Firebase
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  auth = firebase.auth();

  // Enable offline persistence
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

  // Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }

  // Auth listener
  setupAuthListener();

  // Static event listeners
  googleSignInBtn.addEventListener('click', signInWithGoogle);
  signOutBtn.addEventListener('click', () => auth.signOut());

  addTaskForm.addEventListener('submit', handleAddTask);

  filterTabs.forEach(tab => {
    tab.addEventListener('click', () => setFilter(tab.dataset.filter));
  });

  filterCategorySelect.addEventListener('change', () => {
    currentCategoryFilter = filterCategorySelect.value;
    renderTasks();
  });

  cancelEditBtn.addEventListener('click', closeEditModal);
  editModal.addEventListener('click', (e) => {
    if (e.target === editModal) closeEditModal();
  });
  editTaskForm.addEventListener('submit', saveEdit);

  enableNotifBtn.addEventListener('click', () => {
    requestNotificationPermission(true);
    notifBanner.classList.add('hidden');
  });
  dismissNotifBtn.addEventListener('click', () => {
    notifBanner.classList.add('hidden');
    sessionStorage.setItem('notifDismissed', '1');
  });

  dismissInstallBtn.addEventListener('click', () => {
    installBanner.classList.add('hidden');
  });
  installBtn.addEventListener('click', triggerInstall);

  // View tab navigation
  viewTabs.forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });

  // Category management
  addCategoryBtn.addEventListener('click', handleAddCategory);
  categoryNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddCategory();
    }
  });

  // PWA install prompt capture
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBanner.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    installBanner.classList.add('hidden');
    deferredInstallPrompt = null;
  });
});

// ============================================================
// B. AUTHENTICATION
// ============================================================

function setupAuthListener() {
  auth.onAuthStateChanged((user) => {
    if (user) {
      currentUser = user;
      userNameEl.textContent = user.displayName || user.email || '';
      authScreen.classList.add('hidden');
      appScreen.classList.remove('hidden');
      subscribeToCategories(user.uid);
      subscribeToTasks(user.uid);
      setTimeout(() => requestNotificationPermission(false), 2000);
    } else {
      currentUser = null;
      authScreen.classList.remove('hidden');
      appScreen.classList.add('hidden');
      if (unsubscribeTasks) { unsubscribeTasks(); unsubscribeTasks = null; }
      if (unsubscribeCategories) { unsubscribeCategories(); unsubscribeCategories = null; }
      clearScheduledNotifications();
      allTasks = [];
      allCategories = [];
      taskList.innerHTML = '';
    }
  });
}

function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithPopup(provider).catch((err) => {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-closed-by-user') {
      auth.signInWithRedirect(provider);
    } else {
      alert('Sign-in failed: ' + err.message);
    }
  });
}

// ============================================================
// C. FIRESTORE CRUD (Tasks)
// ============================================================

function tasksRef(uid) {
  return db.collection('users').doc(uid).collection('tasks');
}

function subscribeToTasks(uid) {
  if (unsubscribeTasks) unsubscribeTasks();

  unsubscribeTasks = tasksRef(uid)
    .orderBy('createdAt', 'desc')
    .onSnapshot((snapshot) => {
      allTasks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      renderTasks();
      scheduleNotifications(allTasks);
    }, (err) => {
      console.error('Firestore listener error:', err);
    });
}

async function addTask(taskData) {
  return tasksRef(currentUser.uid).add({
    ...taskData,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

async function updateTask(taskId, updates) {
  return tasksRef(currentUser.uid).doc(taskId).update(updates);
}

async function deleteTask(taskId) {
  return tasksRef(currentUser.uid).doc(taskId).delete();
}

async function toggleComplete(taskId, currentState) {
  return updateTask(taskId, {
    completed: !currentState,
    notified: false,
  });
}

// ============================================================
// D. FIRESTORE CRUD (Categories)
// ============================================================

function categoriesRef(uid) {
  return db.collection('users').doc(uid).collection('categories');
}

function subscribeToCategories(uid) {
  if (unsubscribeCategories) unsubscribeCategories();

  unsubscribeCategories = categoriesRef(uid)
    .orderBy('name')
    .onSnapshot((snapshot) => {
      allCategories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      renderCategories();
      populateCategorySelects();
    }, (err) => {
      console.error('Categories listener error:', err);
    });
}

async function addCategory(name) {
  return categoriesRef(currentUser.uid).add({ name });
}

async function deleteCategory(catId) {
  return categoriesRef(currentUser.uid).doc(catId).delete();
}

async function renameCategory(catId, newName) {
  return categoriesRef(currentUser.uid).doc(catId).update({ name: newName });
}

// ============================================================
// E. UI RENDERING
// ============================================================

function renderTasks() {
  let filtered = allTasks;
  if (currentFilter === 'active') {
    filtered = allTasks.filter(t => !t.completed);
  } else if (currentFilter === 'completed') {
    filtered = allTasks.filter(t => t.completed);
  }

  if (currentCategoryFilter) {
    filtered = filtered.filter(t => t.categoryId === currentCategoryFilter);
  }

  filtered = [...filtered].sort((a, b) => {
    const aDate = a.dueDate ? a.dueDate.toDate() : null;
    const bDate = b.dueDate ? b.dueDate.toDate() : null;
    if (aDate && bDate) return aDate - bDate;
    if (aDate && !bDate) return -1;
    if (!aDate && bDate) return 1;
    return 0;
  });

  taskList.innerHTML = '';

  if (filtered.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  filtered.forEach(task => {
    taskList.appendChild(createTaskElement(task));
  });
}

function createTaskElement(task) {
  const li = document.createElement('li');
  li.className = `task-item priority-${task.priority || 'low'}`;
  li.dataset.id = task.id;
  if (task.completed) li.classList.add('completed');

  const now = new Date();
  const dueDate = task.dueDate ? task.dueDate.toDate() : null;
  const isOverdue = dueDate && dueDate < now && !task.completed;
  const isSoon = dueDate && !isOverdue && (dueDate - now < 60 * 60 * 1000);

  if (isOverdue) li.classList.add('overdue');

  let dueHtml = '';
  if (dueDate) {
    let dueCls = 'task-due';
    let icon = '🕐';
    if (isOverdue) { dueCls += ' is-overdue'; icon = '⚠️'; }
    else if (isSoon) { dueCls += ' is-soon'; icon = '⏰'; }
    dueHtml = `<span class="${dueCls}">${icon} ${formatDueDate(dueDate)}</span>`;
  }

  const priorityLabel = { high: 'High', medium: 'Medium', low: 'Low' }[task.priority] || 'Low';
  const priorityBadge = `<span class="priority-badge ${task.priority || 'low'}">${priorityLabel}</span>`;

  // Category badge
  let categoryBadge = '';
  if (task.categoryId) {
    const cat = allCategories.find(c => c.id === task.categoryId);
    if (cat) {
      categoryBadge = `<span class="category-badge">${escapeHtml(cat.name)}</span>`;
    }
  }

  const notesHtml = task.notes
    ? `<div class="task-notes">${escapeHtml(task.notes)}</div>`
    : '';

  li.innerHTML = `
    <input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''} aria-label="Mark complete" />
    <div class="task-content">
      <span class="task-title">${escapeHtml(task.title)}</span>
      <div class="task-meta">
        ${dueHtml}
        ${priorityBadge}
        ${categoryBadge}
      </div>
      ${notesHtml}
    </div>
    <div class="task-actions">
      <button class="edit-btn" aria-label="Edit task">Edit</button>
      <button class="delete-btn" aria-label="Delete task">Delete</button>
    </div>
  `;

  li.querySelector('.task-checkbox').addEventListener('change', () => {
    toggleComplete(task.id, task.completed);
  });

  li.querySelector('.edit-btn').addEventListener('click', () => {
    openEditModal(task);
  });

  li.querySelector('.delete-btn').addEventListener('click', () => {
    confirmAndDelete(task.id, task.title);
  });

  return li;
}

function renderCategories() {
  categoryListEl.innerHTML = '';

  if (allCategories.length === 0) {
    categoryEmpty.classList.remove('hidden');
    return;
  }

  categoryEmpty.classList.add('hidden');

  allCategories.forEach(cat => {
    const taskCount = allTasks.filter(t => t.categoryId === cat.id).length;
    const div = document.createElement('div');
    div.className = 'category-item';
    div.innerHTML = `
      <span class="category-color" style="background: var(--color-primary-light);"></span>
      <span class="category-name">${escapeHtml(cat.name)}</span>
      <span class="category-count">${taskCount} task${taskCount !== 1 ? 's' : ''}</span>
      <div class="category-actions">
        <button class="edit-btn" aria-label="Rename category">Edit</button>
        <button class="delete-btn" aria-label="Delete category">Delete</button>
      </div>
    `;

    div.querySelector('.edit-btn').addEventListener('click', () => {
      const newName = prompt('Rename category:', cat.name);
      if (newName && newName.trim() && newName.trim() !== cat.name) {
        renameCategory(cat.id, newName.trim()).catch(err => alert('Rename failed: ' + err.message));
      }
    });

    div.querySelector('.delete-btn').addEventListener('click', () => {
      if (taskCount > 0) {
        if (!confirm(`"${cat.name}" has ${taskCount} task(s). Deleting the category will remove it from those tasks. Continue?`)) return;
        // Remove categoryId from tasks using this category
        allTasks.filter(t => t.categoryId === cat.id).forEach(t => {
          updateTask(t.id, { categoryId: '' }).catch(() => {});
        });
      }
      deleteCategory(cat.id).catch(err => alert('Delete failed: ' + err.message));
    });

    categoryListEl.appendChild(div);
  });
}

function populateCategorySelects() {
  const selects = [taskCategorySelect, editCategorySelect, filterCategorySelect];
  selects.forEach(sel => {
    const currentValue = sel.value;
    // Clear all options except the first (placeholder)
    while (sel.options.length > 1) {
      sel.remove(1);
    }
    allCategories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.name;
      sel.appendChild(opt);
    });
    // Restore selection if still valid
    if ([...sel.options].some(o => o.value === currentValue)) {
      sel.value = currentValue;
    }
  });
}

function setFilter(filterValue) {
  currentFilter = filterValue;
  filterTabs.forEach(tab => {
    const isActive = tab.dataset.filter === filterValue;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  renderTasks();
}

function formatDueDate(date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const taskDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (taskDay.getTime() === today.getTime()) return `Today at ${timeStr}`;
  if (taskDay.getTime() === tomorrow.getTime()) return `Tomorrow at ${timeStr}`;

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${timeStr}`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function confirmAndDelete(taskId, taskTitle) {
  if (window.confirm(`Delete task: "${taskTitle}"?`)) {
    await deleteTask(taskId).catch(err => alert('Delete failed: ' + err.message));
  }
}

// ============================================================
// F. VIEW NAVIGATION
// ============================================================

function switchView(viewName) {
  viewTabs.forEach(tab => {
    const isActive = tab.dataset.view === viewName;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  viewPanels.forEach(panel => {
    panel.classList.toggle('active', panel.id === `view-${viewName}`);
  });
}

// ============================================================
// G. FORM HANDLING
// ============================================================

async function handleAddTask(e) {
  e.preventDefault();
  const title = taskTitleInput.value.trim();

  if (!title) {
    titleError.textContent = 'Task title is required.';
    taskTitleInput.focus();
    return;
  }
  titleError.textContent = '';

  const taskData = buildTaskData(
    title,
    taskDueDateInput.value,
    taskPrioritySelect.value,
    taskNotesInput.value.trim(),
    taskCategorySelect.value
  );

  addTaskBtn.disabled = true;
  addTaskBtn.textContent = 'Adding…';

  try {
    await addTask(taskData);
    addTaskForm.reset();
    taskPrioritySelect.value = 'medium';
    taskCategorySelect.value = '';
    // Switch to task list after adding
    switchView('list');
  } catch (err) {
    alert('Could not add task: ' + err.message);
  } finally {
    addTaskBtn.disabled = false;
    addTaskBtn.textContent = '+ Add Task';
  }
}

async function handleAddCategory() {
  const name = categoryNameInput.value.trim();
  if (!name) {
    categoryNameInput.focus();
    return;
  }

  // Check for duplicate
  if (allCategories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    alert('A category with this name already exists.');
    return;
  }

  addCategoryBtn.disabled = true;
  try {
    await addCategory(name);
    categoryNameInput.value = '';
  } catch (err) {
    alert('Could not add category: ' + err.message);
  } finally {
    addCategoryBtn.disabled = false;
  }
}

function buildTaskData(title, dueDateValue, priority, notes, categoryId) {
  let dueDate = null;
  if (dueDateValue) {
    const d = new Date(dueDateValue);
    if (!isNaN(d)) {
      dueDate = firebase.firestore.Timestamp.fromDate(d);
    }
  }
  return {
    title,
    notes: notes || '',
    dueDate,
    priority: priority || 'medium',
    categoryId: categoryId || '',
    completed: false,
    notified: false,
  };
}

function openEditModal(task) {
  editingTaskId = task.id;
  editTitleInput.value = task.title || '';
  editPrioritySelect.value = task.priority || 'medium';
  editCategorySelect.value = task.categoryId || '';
  editNotesInput.value = task.notes || '';
  editTitleError.textContent = '';

  if (task.dueDate) {
    const d = task.dueDate.toDate();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    editDueDateInput.value = local;
  } else {
    editDueDateInput.value = '';
  }

  editModal.classList.remove('hidden');
  editTitleInput.focus();
}

function closeEditModal() {
  editModal.classList.add('hidden');
  editingTaskId = null;
}

async function saveEdit(e) {
  e.preventDefault();
  const title = editTitleInput.value.trim();

  if (!title) {
    editTitleError.textContent = 'Task title is required.';
    editTitleInput.focus();
    return;
  }
  editTitleError.textContent = '';

  const updates = buildTaskData(
    title,
    editDueDateInput.value,
    editPrioritySelect.value,
    editNotesInput.value.trim(),
    editCategorySelect.value
  );
  delete updates.completed;

  saveEditBtn.disabled = true;
  saveEditBtn.textContent = 'Saving…';

  try {
    await updateTask(editingTaskId, updates);
    closeEditModal();
  } catch (err) {
    alert('Could not save changes: ' + err.message);
  } finally {
    saveEditBtn.disabled = false;
    saveEditBtn.textContent = 'Save Changes';
  }
}

// ============================================================
// H. NOTIFICATIONS
// ============================================================

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function requestNotificationPermission(explicit = false) {
  if (!('Notification' in window)) return;

  if (isIOS()) {
    if (explicit) {
      alert('Notification reminders are not supported on iOS Safari. Open the app on your PC or Android device to receive reminder notifications.');
    }
    return;
  }

  if (Notification.permission === 'granted') {
    notifBanner.classList.add('hidden');
    return;
  }

  if (Notification.permission === 'denied') {
    if (explicit) {
      alert('Notifications are blocked. Please enable them in your browser settings for this site.');
    }
    return;
  }

  if (explicit) {
    Notification.requestPermission().then((result) => {
      if (result === 'granted') {
        notifBanner.classList.add('hidden');
        scheduleNotifications(allTasks);
      }
    });
  } else {
    if (!sessionStorage.getItem('notifDismissed')) {
      notifBanner.classList.remove('hidden');
    }
  }
}

function clearScheduledNotifications() {
  scheduledNotifications.forEach(id => clearTimeout(id));
  scheduledNotifications = [];
}

function scheduleNotifications(tasks) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  clearScheduledNotifications();

  const now = Date.now();
  const maxAhead = 24 * 60 * 60 * 1000;

  tasks.forEach(task => {
    if (task.completed || task.notified || !task.dueDate) return;

    const dueMs = task.dueDate.toDate().getTime();
    const msUntilDue = dueMs - now;

    if (msUntilDue <= 0 || msUntilDue > maxAhead) return;

    const timeoutId = setTimeout(() => {
      const notif = new Notification('📋 ' + task.title, {
        body: 'This task is due now!',
        icon: 'icons/icon-192.png',
        tag: task.id,
        requireInteraction: true,
      });

      notif.onclick = () => {
        window.focus();
        notif.close();
      };

      if (currentUser) {
        updateTask(task.id, { notified: true }).catch(() => {});
      }
    }, msUntilDue);

    scheduledNotifications.push(timeoutId);
  });
}

// ============================================================
// I. PWA INSTALL PROMPT
// ============================================================

async function triggerInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') {
    installBanner.classList.add('hidden');
  }
  deferredInstallPrompt = null;
}
