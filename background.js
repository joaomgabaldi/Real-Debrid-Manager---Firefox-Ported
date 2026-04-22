import { getValidToken, apiGet, apiPost, apiPut, apiDelete, trackId, onAuthFailure } from './api.js';
import { rdStorage } from './storage.js';

const ALARM_NAME = 'rd-completion-check';
const POLL_INTERVAL_MINUTES = 1;
const DEFAULT_BADGE_COLOR = '#1a9c4a';

function getFranceISOString() {
  const d = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', { 
    timeZone: 'Europe/Paris', 
    year: 'numeric', 
    month: '2-digit', 
    day: '2-digit', 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit', 
    hour12: false 
  });
  const parts = formatter.formatToParts(d);
  const p = {};
  parts.forEach(({ type, value }) => { p[type] = value; });
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}

onAuthFailure(async () => {
  console.warn('RD Manager: Falha de autenticação detetada em background.');
  await browser.alarms.clear(ALARM_NAME);
  browser.runtime.sendMessage({ action: 'force_logout' }).catch(() => {});
});

browser.runtime.onInstalled.addListener(async () => {
  await scheduleAlarm();
  updateContextMenu();
});

browser.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
  updateContextMenu();
  checkForCompletedDownloads();
});

function updateContextMenu() {
  rdStorage.get('rd_context_menu').then((data) => {
    const enabled = data.rd_context_menu !== false;
    browser.contextMenus.remove('send-to-rd').catch(() => {}).finally(() => {
      if (enabled) {
        browser.contextMenus.create({
          id: 'send-to-rd',
          title: browser.i18n.getMessage('contextMenuTitle'),
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

async function scheduleAlarm() {
  await browser.alarms.clear(ALARM_NAME);
  browser.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg === 'rd-check-now') {
    scheduleAlarm();
    setTimeout(checkForCompletedDownloads, 1000);
  }
  if (msg?.action === 'delete-torrents' && Array.isArray(msg.ids)) {
    deleteTorrentsSequentially(msg.ids).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function deleteTorrentsSequentially(ids) {
  for (const id of ids) {
    try {
      await apiDelete(`/torrents/delete/${id}`);
      await sleep(500);
    } catch (err) {
      console.warn(`RD Manager: Falha ao deletar torrent ${id} em background:`, err);
      if (err.message === 'Unauthenticated') {
        break;
      }
    }
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkForCompletedDownloads();
  }
});

let isCheckingCompletion = false;

async function checkForCompletedDownloads() {
  if (isCheckingCompletion) return;
  isCheckingCompletion = true;

  try {
    const data = await rdStorage.get(['rd_notifications_enabled']);
    if (data.rd_notifications_enabled === false) return;
    const token = await getValidToken();
    if (!token) return;

    const { rd_tracked_ids } = await rdStorage.get('rd_tracked_ids');
    const trackedIds = new Set(rd_tracked_ids || []);
    if (trackedIds.size === 0) return;

    const current = [];
    let changedTracked = false;

    const { rd_local_downloads } = await rdStorage.get('rd_local_downloads');
    if (Array.isArray(rd_local_downloads)) {
      rd_local_downloads.forEach(d => current.push({ id: String(d.id), name: d.name, type: 'web', ready: true, status: 'downloaded' }));
    }

    let requestCount = 0;
    for (const id of trackedIds) {
      if (String(id).startsWith('web-')) continue;
      
      try {
        const t = await apiGet(`/torrents/info/${id}`, 10000);
        if (t) current.push({ id: String(t.id), name: t.filename, type: 'torrent', ready: isReady(t), status: t.status });
        
        requestCount++;
        if (requestCount % 5 === 0) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (err) {
        if (err.message && (err.message.includes('404') || err.message.includes('Error: 404'))) {
          trackedIds.delete(id);
          changedTracked = true;
        }
      }
    }

    const justCompleted = current.filter(dl => dl.ready && trackedIds.has(dl.id));

    if (justCompleted.length === 0) {
      if (changedTracked) {
        await rdStorage.set({ rd_tracked_ids: [...trackedIds] });
      }
      return;
    }

    justCompleted.forEach(dl => trackedIds.delete(dl.id));
    await rdStorage.set({ rd_tracked_ids: [...trackedIds] });

    const { rd_local_notifications } = await rdStorage.get('rd_local_notifications');
    const existing = rd_local_notifications || [];
    
    const merged = [
      ...justCompleted.map(dl => {
        const isError = ['error', 'dead', 'virus', 'magnet_error'].includes((dl.status || '').toLowerCase());
        return {
          id: `${dl.id}-${Date.now()}`,
          title: isError ? browser.i18n.getMessage('dlFailedTitle') : browser.i18n.getMessage('dlAvailable'),
          message: dl.name || (isError ? browser.i18n.getMessage('dlFailedMessage') : browser.i18n.getMessage('dlCompletedMsg')),
          type: dl.type,
          created_at: getFranceISOString(),
          read: false,
        };
      }),
      ...existing,
    ].slice(0, 99);
    
    await rdStorage.set({ rd_local_notifications: merged });
    await updateBadgeCount();

  } catch (err) {
    console.warn('RD Manager: Falha no completion check', err);
  } finally {
    isCheckingCompletion = false;
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

  const isTorrentFile = url.endsWith('.torrent') || url.includes('.torrent?');
  const isMagnet = url.startsWith('magnet:');
  const isHttp = url.startsWith('http://') || url.startsWith('https://');

  if (!info.linkUrl && !isMagnet && !isHttp) {
    showBadge(false); return;
  }

  if (isTorrentFile) {
    try {
      const granted = await browser.permissions.request({ origins: ['<all_urls>'] });
      if (!granted) {
        showBadge(false);
        return;
      }
    } catch (err) {
      console.warn('RD Manager: Erro ao solicitar permissão:', err);
      showBadge(false);
      return;
    }
  }

  const token = await getValidToken();
  if (!token) { showBadge(false); return; }

  let workFn;
  if (isMagnet) {
    workFn = () => addMagnet(url);
  } else if (isTorrentFile) {
    workFn = () => addTorrentFile(url);
  } else {
    workFn = () => unrestrictLink(url);
  }

  try {
    await withPendingBadge(workFn);
    showBadge(true);
    setTimeout(checkForCompletedDownloads, 1000);
  } catch (err) {
    console.warn('RD Manager: Context menu add failed:', err);
    showBadge(false);
  }
});

async function addMagnet(magnet) {
  const data = await apiPost('/torrents/addMagnet', { magnet });
  if (data && data.id) await trackId(String(data.id));
}

async function addTorrentFile(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 15000);
  try {
    const fileRes = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!fileRes.ok) throw new Error('Failed to fetch .torrent file');
    const blob = await fileRes.blob();
    const data = await apiPut('/torrents/addTorrent', blob);
    if (data && data.id) await trackId(String(data.id));
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function unrestrictLink(link) {
  const data = await apiPost('/unrestrict/link', { link });
  if (data && data.download) {
    const entry = {
      id: data.id || `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: data.filename || browser.i18n.getMessage('unnamedDownload'),
      size: data.filesize || 0,
      progress: 1,
      download_state: 'completed',
      created_at: getFranceISOString(),
      _type: 'web',
      _rd_download: data.download,
      _rd_link: data.link,
      _rd_host: data.host,
      files: [{
        id: 0,
        name: data.filename || browser.i18n.getMessage('downloadNameFallback'),
        size: data.filesize || 0,
        short_name: data.filename || browser.i18n.getMessage('downloadNameFallback'),
      }],
    };
    const { rd_local_downloads } = await rdStorage.get('rd_local_downloads');
    const existing = rd_local_downloads || [];
    const merged = [entry, ...existing].slice(0, 99);
    await rdStorage.set({ rd_local_downloads: merged });
    await trackId(String(entry.id));
  }
}

function isReady(dl) {
  const s = (dl.status || '').toLowerCase();
  return ['downloaded', 'error', 'dead', 'virus', 'magnet_error'].includes(s);
}

async function updateBadgeCount() {
  const { rd_local_notifications } = await rdStorage.get('rd_local_notifications');
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
