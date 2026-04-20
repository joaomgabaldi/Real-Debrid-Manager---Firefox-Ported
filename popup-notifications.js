import { state, DOM } from './popup-state.js';
import { rdStorage } from './storage.js';
import { i18n, formatTimeAgo, el, toast } from './utils.js';
import { openModalWithNode, closeModal } from './popup-modals.js';

export async function updateBellFromDownloads(downloads) {
  if (!state.cachedNotificationsEnabled) return;
  const { rd_tracked_ids } = await rdStorage.get('rd_tracked_ids');
  const trackedIds = new Set(rd_tracked_ids || []);
  
  if (trackedIds.size === 0) {
    await loadLocalNotifications();
    return;
  }
  
  const justCompleted = downloads.filter(dl => isReady(dl) && trackedIds.has(String(dl.id)));
  if (justCompleted.length === 0) {
    await loadLocalNotifications();
    return;
  }
  
  justCompleted.forEach(dl => trackedIds.delete(String(dl.id)));
  await rdStorage.set({ rd_tracked_ids: [...trackedIds] });
  
  const existing = await rdStorage.getLocalNotifications();
  const merged = [
    ...justCompleted.map(dl => ({
      id: `${dl.id}-${Date.now()}`,
      title: i18n('dlAvailable'),
      message: dl.name || i18n('dlCompletedMsg'),
      type: dl._type,
      created_at: new Date().toISOString(),
      read: false,
    })),
    ...existing,
  ].slice(0, 99);
  
  await rdStorage.saveLocalNotifications(merged);
  await loadLocalNotifications();
}

function isReady(dl) {
  return (dl.download_state || '').toLowerCase() === 'completed';
}

export async function loadLocalNotifications() {
  if (!state.cachedNotificationsEnabled) {
    state.notifications = [];
    updateNotificationBadge();
    return;
  }
  const allNotifications = await rdStorage.getLocalNotifications();
  state.notifications = allNotifications.filter(n => !n.read);
  updateNotificationBadge();
}

export function showNotificationsModal() {
  const hasNotifications = state.notifications.length > 0;
  const bodyEl = document.createElement('div');

  if (hasNotifications) {
    const listEl = document.createElement('div');
    listEl.className = 'notifications-list';
    listEl.id = 'notifications-list';

    state.notifications.forEach(n => {
      const item = el('div', {className: 'notification-item unread'},
        el('div', {className: 'notification-header'},
          el('span', {className: 'notification-title'}, n.title || i18n('dlAvailable')),
          el('span', {className: 'notification-time'}, formatTimeAgo(n.created_at))
        ),
        el('div', {className: 'notification-message'}, n.message || '')
      );
      item.dataset.id = n.id;

      item.addEventListener('click', async () => {
        item.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
        item.style.opacity = '0';
        item.style.transform = 'translateX(-10px)';
        await clearNotification(item.dataset.id);
        setTimeout(() => {
          item.remove();
          if (state.notifications.length === 0) {
            const list = DOM.$('#notifications-list');
            if (list) list.replaceChildren(el('div', {className: 'notifications-empty'}, i18n('noNotifications')));
            DOM.$('#btn-mark-all-read')?.remove();
          }
        }, 150);
      });
      listEl.appendChild(item);
    });
    bodyEl.appendChild(listEl);
  } else {
    bodyEl.appendChild(el('div', {className: 'notifications-empty'}, i18n('noNotifications')));
  }

  openModalWithNode(i18n('notifications'), bodyEl);

  if (hasNotifications) {
    const modalHeader = DOM.$('.modal-header');
    const markAllBtn = document.createElement('button');
    markAllBtn.className = 'notifications-mark-all';
    markAllBtn.id = 'btn-mark-all-read';
    markAllBtn.setAttribute('aria-label', i18n('clearAll'));
    markAllBtn.textContent = i18n('clearAll');
    modalHeader.insertBefore(markAllBtn, DOM.$('#modal-close'));

    markAllBtn.addEventListener('click', async () => {
      await clearAllNotifications();
      closeModal();
    });
  }
}

export async function updateNotificationBadge() {
  const badge = DOM.$('#notification-badge');
  const count = state.notifications.length;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.remove('hidden');
    browser.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
    browser.action.setBadgeBackgroundColor({ color: '#1a9c4a' });
  } else {
    badge.classList.add('hidden');
    browser.action.setBadgeText({ text: '' });
  }
}

async function clearNotification(id) {
  const allNotifications = await rdStorage.getLocalNotifications();
  const updated = allNotifications.map(n => n.id === id ? { ...n, read: true } : n);
  await rdStorage.saveLocalNotifications(updated);
  state.notifications = state.notifications.filter(n => n.id !== id);
  updateNotificationBadge();
}

async function clearAllNotifications() {
  const allNotifications = await rdStorage.getLocalNotifications();
  const updated = allNotifications.map(n => ({ ...n, read: true }));
  await rdStorage.saveLocalNotifications(updated);
  state.notifications = [];
  updateNotificationBadge();
  toast(i18n('allCleared'), 'success');
}
