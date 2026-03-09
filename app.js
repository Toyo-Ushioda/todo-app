/* ============================================================
   TO-DO LIST APP — Main Logic
   Sections:
     A. Initialization
     B. Authentication
     C. Firestore CRUD
     D. UI Rendering
     E. Form Handling
     F. Notifications
     G. PWA Install Prompt
   ============================================================ */

'use strict';

// ============================================================
// A. INITIALIZATION
// ============================================================

let db, auth, currentUser;
let unsubscribeTasks = null;
let allTasks = [];
let currentFilter = 'all';
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
const taskNotesInput = document.getElementById('task-notes');
const addTaskBtn = document.getElementById('add-task-btn');
const titleError = document.getElementById('title-error');

const taskList = document.getElementById('task-list');
const emptyState = document.getElementById('empty-state');
const filterTabs = document.querySelectorAll('.tab');

const editModal = document.getElementById('edit-modal');
const editTaskForm = document.getElementById('edit-task-form');
const editTitleInput = document.getElementById('edit-title');
const editDueDateInput = document.getElementById('edit-due-date');
const editPrioritySelect = document.getElementById('edit-priority');
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

document.addEventListener('DOMContentLoaded', () => {
  // Initialize Firebase
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  auth = firebase.auth();

  // Enable offline persistence
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {
    // Persistence unavailable (private browsing, etc.) — silent fail
  });

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
      subscribeToTasks(user.uid);
      // Delay permission request so it's not the first thing on page load
      setTimeout(() => requestNotificationPermission(false), 2000);
    } else {
      currentUser = null;
      authScreen.classList.remove('hidden');
      appScreen.classList.add('hidden');
      if (unsubscribeTasks) {
        unsubscribeTasks();
        unsubscribeTasks = null;
      }
      clearScheduledNotifications();
      allTasks = [];
      taskList.innerHTML = '';
    }
  });
}

function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  // Try popup first; fall back to redirect if blocked
  auth.signInWithPopup(provider).catch((err) => {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-closed-by-user') {
      auth.signInWithRedirect(provider);
    } else {
      alert('Sign-in failed: ' + err.message);
    }
  });
}

// Handle redirect result on page load
window.addEventListener('DOMContentLoaded', () => {
  if (typeof auth !== 'undefined') return; // handled after initializeApp
});
// We check redirect result inside the auth state change flow automatically.

// ============================================================
// C. FIRESTORE CRUD
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
    notified: false, // allow re-notification if re-opened
  });
}

// ============================================================
// D. UI RENDERING
// ============================================================

function renderTasks() {
  // Filter
  let filtered = allTasks;
  if (currentFilter === 'active') {
    filtered = allTasks.filter(t => !t.completed);
  } else if (currentFilter === 'completed') {
    filtered = allTasks.filter(t => t.completed);
  }

  // Sort: tasks with due dates first (earliest first), then tasks without
  filtered = [...filtered].sort((a, b) => {
    const aDate = a.dueDate ? a.dueDate.toDate() : null;
    const bDate = b.dueDate ? b.dueDate.toDate() : null;
    if (aDate && bDate) return aDate - bDate;
    if (aDate && !bDate) return -1;
    if (!aDate && bDate) return 1;
    return 0;
  });

  // Render
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
  const isSoon = dueDate && !isOverdue && (dueDate - now < 60 * 60 * 1000); // within 1 hour

  if (isOverdue) li.classList.add('overdue');

  // Build due date string
  let dueHtml = '';
  if (dueDate) {
    let dueCls = 'task-due';
    let icon = '🕐';
    if (isOverdue) { dueCls += ' is-overdue'; icon = '⚠️'; }
    else if (isSoon) { dueCls += ' is-soon'; icon = '⏰'; }
    dueHtml = `<span class="${dueCls}">${icon} ${formatDueDate(dueDate)}</span>`;
  }

  // Priority badge
  const priorityLabel = { high: 'High', medium: 'Medium', low: 'Low' }[task.priority] || 'Low';
  const priorityBadge = `<span class="priority-badge ${task.priority || 'low'}">${priorityLabel}</span>`;

  // Notes
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
      </div>
      ${notesHtml}
    </div>
    <div class="task-actions">
      <button class="edit-btn" aria-label="Edit task">Edit</button>
      <button class="delete-btn" aria-label="Delete task">Delete</button>
    </div>
  `;

  // Event listeners
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
// E. FORM HANDLING
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
    taskNotesInput.value.trim()
  );

  addTaskBtn.disabled = true;
  addTaskBtn.textContent = 'Adding…';

  try {
    await addTask(taskData);
    addTaskForm.reset();
    taskPrioritySelect.value = 'medium';
  } catch (err) {
    alert('Could not add task: ' + err.message);
  } finally {
    addTaskBtn.disabled = false;
    addTaskBtn.textContent = '+ Add Task';
  }
}

function buildTaskData(title, dueDateValue, priority, notes) {
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
    completed: false,
    notified: false,
  };
}

function openEditModal(task) {
  editingTaskId = task.id;
  editTitleInput.value = task.title || '';
  editPrioritySelect.value = task.priority || 'medium';
  editNotesInput.value = task.notes || '';
  editTitleError.textContent = '';

  if (task.dueDate) {
    // Convert Firestore Timestamp → local datetime-local string
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
    editNotesInput.value.trim()
  );
  // Preserve completed status — don't overwrite it
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
// F. NOTIFICATIONS
// ============================================================

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function requestNotificationPermission(explicit = false) {
  if (!('Notification' in window)) return;

  if (isIOS()) {
    // iOS doesn't support Web Notifications — show inline info only if explicitly requested
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

  // permission === 'default'
  if (explicit) {
    Notification.requestPermission().then((result) => {
      if (result === 'granted') {
        notifBanner.classList.add('hidden');
        scheduleNotifications(allTasks);
      }
    });
  } else {
    // Show soft nudge banner (don't auto-prompt — browsers block it)
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
  const maxAhead = 24 * 60 * 60 * 1000; // 24 hours

  tasks.forEach(task => {
    if (task.completed || task.notified || !task.dueDate) return;

    const dueMs = task.dueDate.toDate().getTime();
    const msUntilDue = dueMs - now;

    if (msUntilDue <= 0 || msUntilDue > maxAhead) return;

    const timeoutId = setTimeout(() => {
      const notif = new Notification('📋 ' + task.title, {
        body: 'This task is due now!',
        icon: 'icons/icon-192.png',
        tag: task.id, // prevents duplicate notifications
        requireInteraction: true,
      });

      notif.onclick = () => {
        window.focus();
        notif.close();
      };

      // Mark as notified so we don't fire again on reload
      if (currentUser) {
        updateTask(task.id, { notified: true }).catch(() => {});
      }
    }, msUntilDue);

    scheduledNotifications.push(timeoutId);
  });
}

// ============================================================
// G. PWA INSTALL PROMPT
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
