import { API_BASE, getValidToken, apiGet, trackId, fetchWithTimeout } from './api.js';

const ALARM_NAME = 'rd-completion-check';
const POLL_INTERVAL_MINUTES = 1;
const DEFAULT_BADGE_COLOR = '#1a9c4a';

browser.runtime.onInstalled.addListener(async () => {
  scheduleAlarm();
  updateContextMenu();
});

browser.runtime.onStartup.addListener(() => {
  scheduleAlarm();
  updateContextMenu();
  checkForCompletedDownloads();
});

function updateContextMenu() {
  browser.storage.local.get('rd_context_menu').then((data) => {
    const enabled = data.rd_context_menu !== false;
    browser.contextMenus.remove('send-to-rd').catch(() => {}).finally(() => {
      if (enabled) {
        browser.contextMenus.create({
          id: 'send-to-rd',
          title: 'Enviar para o RD Manager',
          contexts: ['link', 'selection']
        });
      }
    });
  });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'rd_context_menu' in changes) {
    updateContextMenu();
  }
});

function scheduleAlarm() {
  browser.alarms.get(ALARM_NAME).then((existing) => {
    if (!existing) {
      browser.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
    }
  });
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg === 'rd-check-now') setTimeout(checkForCompletedDownloads, 1000);
  if (msg?.action === 'delete-torrents' && Array.isArray(msg.ids)) {
    deleteTorrentsSequentially(msg.ids);
  }
});

async function deleteTorrentsSequentially(ids) {
  const token = await getValidToken();
  if (!token) return;

  for (const id of ids) {
    try {
      await fetchWithTimeout(`${API_BASE}/torrents/delete/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (_) { /* best effort */ }
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkForCompletedDownloads();
  }
});

async function checkForCompletedDownloads() {
  const data = await browser.storage.local.get(['rd_notifications_enabled']);
  if (data.rd_notifications_enabled === false) return;
  const token = await getValidToken();
  if (!token) return;

  try {
    const { rd_tracked_ids } = await browser.storage.local.get('rd_tracked_ids');
    const trackedIds = new Set(rd_tracked_ids || []);
    if (trackedIds.size === 0) return;

    const torrents = await apiGet('/torrents');
    const current = [];
    if (Array.isArray(torrents)) {
      torrents.forEach(t => current.push({ id: String(t.id), name: t.filename, type: 'torrent', ready: isReady(t) }));
    }

    const { rd_local_downloads } = await browser.storage.local.get('rd_local_downloads');
    if (Array.isArray(rd_local_downloads)) {
      rd_local_downloads.forEach(d => current.push({ id: String(d.id), name: d.name, type: 'web', ready: true }));
    }

    const justCompleted = current.filter(dl => dl.ready && trackedIds.has(dl.id));
    if (justCompleted.length === 0) return;

    justCompleted.forEach(dl => trackedIds.delete(dl.id));
    await browser.storage.local.set({ rd_tracked_ids: [...trackedIds] });

    const { rd_local_notifications } = await browser.storage.local.get('rd_local_notifications');
    const existing = rd_local_notifications || [];
    const merged = [
      ...justCompleted.map(dl => ({
        id: `${dl.id}-${Date.now()}`,
        title: 'Download Disponível',
        message: dl.name || 'Um download foi concluído',
        type: dl.type,
        created_at: new Date().toISOString(),
        read: false,
      })),
      ...existing,
    ].slice(0, 99);
    await browser.storage.local.set({ rd_local_notifications: merged });
    await updateBadgeCount();

  } catch (err) {
    console.warn('Completion check failed');
  }
}

async function withPendingBadge(workFn) {
  browser.action.setBadgeBackgroundColor({ color: DEFAULT_BADGE_COLOR });
  browser.action.setBadgeText({ text: '...' });
  await workFn();
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'send-to-rd') return;

  const url = info.linkUrl || (info.selectionText ? info.selectionText.trim() : null);
  if (!url) { showBadge(false); return; }

  if (!info.linkUrl) {
    const isValid = url.startsWith('magnet:') || url.startsWith('http://') || url.startsWith('https://');
    if (!isValid) { showBadge(false); return; }
  }

  const token = await getValidToken();
  if (!token) { showBadge(false); return; }

  let workFn;
  if (url.startsWith('magnet:')) {
    workFn = () => addMagnet(token, url);
  } else if (url.endsWith('.torrent') || url.includes('.torrent?')) {
    workFn = () => addTorrentFile(token, url);
  } else {
    workFn = () => unrestrictLink(token, url);
  }

  try {
    await withPendingBadge(workFn);
    showBadge(true);
    setTimeout(checkForCompletedDownloads, 1000);
  } catch (err) {
    console.warn('Context menu add failed');
    showBadge(false);
  }
});

async function addMagnet(token, magnet) {
  const res = await fetch(`${API_BASE}/torrents/addMagnet`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `magnet=${encodeURIComponent(magnet)}`
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) await browser.storage.local.remove(['rd_access_token', 'rd_refresh_token']);
    throw new Error(`API error (${res.status})`);
  }
  const data = await res.json();
  if (data.id) await trackId(String(data.id));
}

async function addTorrentFile(token, url) {
  const fileRes = await fetch(url);
  if (!fileRes.ok) throw new Error('Failed to fetch .torrent file');
  const blob = await fileRes.blob();
  const res = await fetch(`${API_BASE}/torrents/addTorrent`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: blob
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) await browser.storage.local.remove(['rd_access_token', 'rd_refresh_token']);
    throw new Error(`API error (${res.status})`);
  }
  const data = await res.json();
  if (data.id) await trackId(String(data.id));
}

async function unrestrictLink(token, link) {
  const res = await fetch(`${API_BASE}/unrestrict/link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `link=${encodeURIComponent(link)}`
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) await browser.storage.local.remove(['rd_access_token', 'rd_refresh_token']);
    throw new Error(`API error (${res.status})`);
  }
  const data = await res.json();
  if (data.download) {
    const entry = {
      id: data.id || `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: data.filename || 'Download sem nome',
      size: data.filesize || 0,
      progress: 1,
      download_state: 'completed',
      created_at: new Date().toISOString(),
      _type: 'web',
      _rd_download: data.download,
      _rd_link: data.link,
      _rd_host: data.host,
      files: [{
        id: 0,
        name: data.filename || 'Download',
        size: data.filesize || 0,
        short_name: data.filename || 'Download',
      }],
    };
    const { rd_local_downloads } = await browser.storage.local.get('rd_local_downloads');
    const existing = rd_local_downloads || [];
    const merged = [entry, ...existing].slice(0, 99);
    await browser.storage.local.set({ rd_local_downloads: merged });
    await trackId(String(entry.id));
  }
}

function isReady(dl) {
  return (dl.status || '').toLowerCase() === 'downloaded';
}

async function updateBadgeCount() {
  const { rd_local_notifications } = await browser.storage.local.get('rd_local_notifications');
  const unread = (rd_local_notifications || []).filter(n => !n.read).length;
  if (unread > 0) {
    browser.action.setBadgeText({ text: unread > 99 ? '99+' : String(unread) });
    browser.action.setBadgeBackgroundColor({ color: DEFAULT_BADGE_COLOR });
  } else {
    browser.action.setBadgeText({ text: '' });
  }
}

async function showBadge(success) {
  browser.action.setBadgeBackgroundColor({ color: success ? DEFAULT_BADGE_COLOR : '#f46878' });
  browser.action.setBadgeText({ text: success ? '✓' : '!' });
  setTimeout(() => updateBadgeCount(), 2000);
}
