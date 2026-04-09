/* ============================================
   RD Manager — Background Service Worker
   ============================================ */

const API_BASE = 'https://api.real-debrid.com/rest/1.0';
const ALARM_NAME = 'rd-completion-check';
const POLL_INTERVAL_MINUTES = 1;

// ---- Install ----
browser.runtime.onInstalled.addListener(async () => {
  scheduleAlarm();
  updateContextMenu();
});

browser.runtime.onStartup.addListener(() => {
  scheduleAlarm();
  updateContextMenu();
  checkForCompletedDownloads();
});

// ---- Context menu toggle ----
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

// ---- Alarm ----
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
  const { rd_api_key } = await browser.storage.local.get('rd_api_key');
  if (!rd_api_key) return;

  for (const id of ids) {
    try {
      await fetchWithTimeout(`${API_BASE}/torrents/delete/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${rd_api_key}` },
      });
    } catch (_) { /* best effort */ }
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkForCompletedDownloads();
  }
});

// ---- Completion check ----
async function checkForCompletedDownloads() {
  const { rd_api_key, rd_notifications_enabled } = await browser.storage.local.get(['rd_api_key', 'rd_notifications_enabled']);
  if (!rd_api_key) return;
  if (rd_notifications_enabled === false) return;

  try {
    const { rd_tracked_ids } = await browser.storage.local.get('rd_tracked_ids');
    const trackedIds = new Set(rd_tracked_ids || []);
    if (trackedIds.size === 0) return;

    const torrents = await apiFetch(rd_api_key, '/torrents');
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

// ---- Badge accent color ----
const DEFAULT_BADGE_COLOR = '#1a9c4a';

async function getBadgeAccent() {
  const { rd_accent_color } = await browser.storage.local.get('rd_accent_color');
  return rd_accent_color || DEFAULT_BADGE_COLOR;
}

async function withPendingBadge(workFn) {
  browser.action.setBadgeBackgroundColor({ color: await getBadgeAccent() });
  browser.action.setBadgeText({ text: '...' });
  await workFn();
}

// ---- Context menu ----
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'send-to-rd') return;

  const url = info.linkUrl || (info.selectionText ? info.selectionText.trim() : null);
  if (!url) { showBadge(false); return; }

  if (!info.linkUrl) {
    const isValid = url.startsWith('magnet:') || url.startsWith('http://') || url.startsWith('https://');
    if (!isValid) { showBadge(false); return; }
  }

  const { rd_api_key } = await browser.storage.local.get('rd_api_key');
  if (!rd_api_key) { showBadge(false); return; }

  let workFn;
  if (url.startsWith('magnet:')) {
    workFn = () => addMagnet(rd_api_key, url);
  } else if (url.endsWith('.torrent') || url.includes('.torrent?')) {
    workFn = () => addTorrentFile(rd_api_key, url);
  } else {
    workFn = () => unrestrictLink(rd_api_key, url);
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

async function addMagnet(apiKey, magnet) {
  const res = await fetch(`${API_BASE}/torrents/addMagnet`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `magnet=${encodeURIComponent(magnet)}`
  });
  if (!res.ok) throw new Error(`API error (${res.status})`);
  const data = await res.json();
  if (data.id) {
    await autoSelectFiles(apiKey, data.id);
    await trackId(String(data.id));
  }
}

async function addTorrentFile(apiKey, url) {
  const fileRes = await fetch(url);
  if (!fileRes.ok) throw new Error('Failed to fetch .torrent file');
  const blob = await fileRes.blob();
  const res = await fetch(`${API_BASE}/torrents/addTorrent`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: blob
  });
  if (!res.ok) throw new Error(`API error (${res.status})`);
  const data = await res.json();
  if (data.id) {
    await autoSelectFiles(apiKey, data.id);
    await trackId(String(data.id));
  }
}

async function autoSelectFiles(apiKey, torrentId) {
  const res = await fetch(`${API_BASE}/torrents/selectFiles/${torrentId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'files=all'
  });
  if (!res.ok && res.status !== 204 && res.status !== 202) {
    throw new Error(`Select files error (${res.status})`);
  }
}

async function unrestrictLink(apiKey, link) {
  const res = await fetch(`${API_BASE}/unrestrict/link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `link=${encodeURIComponent(link)}`
  });
  if (!res.ok) throw new Error(`API error (${res.status})`);
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

// ---- Helpers ----

async function trackId(id) {
  const { rd_tracked_ids } = await browser.storage.local.get('rd_tracked_ids');
  const tracked = new Set(rd_tracked_ids || []);
  tracked.add(id);
  await browser.storage.local.set({ rd_tracked_ids: [...tracked] });
}

const TIMEOUT_MS = 10_000;

function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function apiFetch(apiKey, path) {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error(`API error (${res.status})`);
  return res.json();
}

function isReady(dl) {
  return (dl.status || '').toLowerCase() === 'downloaded';
}

async function updateBadgeCount() {
  const { rd_local_notifications } = await browser.storage.local.get('rd_local_notifications');
  const unread = (rd_local_notifications || []).filter(n => !n.read).length;
  if (unread > 0) {
    browser.action.setBadgeText({ text: unread > 99 ? '99+' : String(unread) });
    browser.action.setBadgeBackgroundColor({ color: await getBadgeAccent() });
  } else {
    browser.action.setBadgeText({ text: '' });
  }
}

async function showBadge(success) {
  browser.action.setBadgeBackgroundColor({ color: success ? await getBadgeAccent() : '#f46878' });
  browser.action.setBadgeText({ text: success ? '✓' : '!' });
  setTimeout(() => updateBadgeCount(), 2000);
}
