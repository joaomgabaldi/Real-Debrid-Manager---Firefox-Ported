import { getValidToken, apiGet, apiPost, apiPut, apiDelete, trackId, onAuthFailure } from './api.js';

const ALARM_NAME = 'rd-completion-check';
const POLL_INTERVAL_MINUTES = 1;
const DEFAULT_BADGE_COLOR = '#1a9c4a';

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
  browser.storage.local.get('rd_context_menu').then((data) => {
    const enabled = data.rd_context_menu !== false;
    browser.contextMenus.remove('send-to-rd').catch(() => {}).finally(() => {
      if (enabled) {
        browser.contextMenus.create({
          id: 'send-to-rd',
          title: browser.i18n.getMessage('contextMenuTitle') || 'Enviar para o RD Manager',
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

browser.runtime.onMessage.addListener((msg) => {
  if (msg === 'rd-check-now') {
    scheduleAlarm();
    setTimeout(checkForCompletedDownloads, 1000);
  }
  if (msg?.action === 'delete-torrents' && Array.isArray(msg.ids)) {
    deleteTorrentsSequentially(msg.ids);
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
    }
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

    const current = [];
    let changedTracked = false;

    const { rd_local_downloads } = await browser.storage.local.get('rd_local_downloads');
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
        await browser.storage.local.set({ rd_tracked_ids: [...trackedIds] });
      }
      return;
    }

    justCompleted.forEach(dl => trackedIds.delete(dl.id));
    await browser.storage.local.set({ rd_tracked_ids: [...trackedIds] });

    const { rd_local_notifications } = await browser.storage.local.get('rd_local_notifications');
    const existing = rd_local_notifications || [];
    
    const merged = [
      ...justCompleted.map(dl => {
        const isError = ['error', 'dead', 'virus', 'magnet_error'].includes((dl.status || '').toLowerCase());
        return {
          id: `${dl.id}-${Date.now()}`,
          title: isError ? (browser.i18n.getMessage('dlFailedTitle') || 'Falha no Download') : (browser.i18n.getMessage('dlAvailable') || 'Download Disponível'),
          message: dl.name || (isError ? (browser.i18n.getMessage('dlFailedMessage') || 'Ocorreu um erro no arquivo.') : (browser.i18n.getMessage('dlCompletedMsg') || 'Um download foi concluído')),
          type: dl.type,
          created_at: new Date().toISOString(),
          read: false,
        };
      }),
      ...existing,
    ].slice(0, 99);
    
    await browser.storage.local.set({ rd_local_notifications: merged });
    await updateBadgeCount();

  } catch (err) {
    console.warn('RD Manager: Falha no completion check', err);
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
    const urlObj = new URL(url);
    const targetOrigin = `${urlObj.protocol}//${urlObj.host}/*`;
    
    try {
      const granted = await browser.permissions.request({ origins: [targetOrigin] });
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
  const fileRes = await fetch(url);
  if (!fileRes.ok) throw new Error('Failed to fetch .torrent file');
  const blob = await fileRes.blob();
  const data = await apiPut('/torrents/addTorrent', blob);
  if (data && data.id) await trackId(String(data.id));
}

async function unrestrictLink(link) {
  const data = await apiPost('/unrestrict/link', { link });
  if (data && data.download) {
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
  const s = (dl.status || '').toLowerCase();
  return ['downloaded', 'error', 'dead', 'virus', 'magnet_error'].includes(s);
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
