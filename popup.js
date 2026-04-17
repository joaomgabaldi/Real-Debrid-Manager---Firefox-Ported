import { OAUTH_BASE, getValidToken, apiGet, apiPost, apiDelete, trackId, onAuthFailure } from './api.js';

const OPENSOURCE_CLIENT_ID = 'X245A4XAIBGVM';
const i18n = (key) => browser.i18n.getMessage(key) || key;

function localizeHtmlPage() {
  document.querySelectorAll('[data-i18n]').forEach(elem => {
    const msg = browser.i18n.getMessage(elem.dataset.i18n);
    if (msg) elem.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-title]').forEach(elem => {
    const msg = browser.i18n.getMessage(elem.dataset.i18nTitle);
    if (msg) elem.title = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(elem => {
    const msg = browser.i18n.getMessage(elem.dataset.i18nPlaceholder);
    if (msg) elem.placeholder = msg;
  });
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  }
  children.forEach(c => {
    if (c === null || c === undefined) return;
    e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  });
  return e;
}

let hasValidToken = false;
let currentTab = 'all';
let currentTypeFilter = null;
let searchQuery = '';
let ageFilterDays = null;
let allDownloads = [];
let notifications = [];
let visibleCount = 50;
let currentFiltered = [];
let cachedNotificationsEnabled = true;
let useJDownloader = false;

let currentlyLockedTorrentId = null;
let ignoreAutoLockIds = new Set();
let oauthPollingInterval = null;

const dlElementMap = new Map();
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

document.addEventListener('DOMContentLoaded', async () => {
  localizeHtmlPage();
  await loadSettings();
  await loadCachedStorageValues();
  bindEvents();
  
  onAuthFailure(() => forceLogout());
  
  // Escutar eventos de falha de autenticação emitidos pelo background.js
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'force_logout') {
      forceLogout();
    }
  });
  
  const token = await getValidToken();
  if (token) {
    hasValidToken = true;
    await loadCachedData();
    await loadLocalNotifications();
    refreshInBackground();
    fetchUserInfo();
  } else {
    showState('no-api');
    
    const data = await browser.storage.local.get('rd_oauth_pending');
    if (data.rd_oauth_pending && data.rd_oauth_pending.expires_at > Date.now()) {
      const btn = $('#btn-login-api');
      if (btn) btn.textContent = i18n('verifyingAuth');
      
      pollDeviceCredentials(data.rd_oauth_pending.device_code);
      oauthPollingInterval = setInterval(() => pollDeviceCredentials(data.rd_oauth_pending.device_code), 5000);
    } else if (data.rd_oauth_pending) {
      browser.storage.local.remove('rd_oauth_pending');
    }
  }
});

window.addEventListener('pagehide', () => stopAutoRefresh());

async function loadCachedStorageValues() {
  return browser.storage.local.get(['rd_notifications_enabled', 'rd_ignore_locks']).then((data) => {
    cachedNotificationsEnabled = data.rd_notifications_enabled !== false;
    if (data.rd_ignore_locks && Array.isArray(data.rd_ignore_locks)) {
      ignoreAutoLockIds = new Set(data.rd_ignore_locks);
    }
  });
}

function addIgnoreLock(id) {
  ignoreAutoLockIds.add(String(id));
  browser.storage.local.set({ rd_ignore_locks: Array.from(ignoreAutoLockIds) });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('rd_notifications_enabled' in changes) {
    cachedNotificationsEnabled = changes.rd_notifications_enabled.newValue !== false;
  }
  if ('rd_local_notifications' in changes) {
    loadLocalNotifications();
  }
});

async function loadCachedData() {
  return browser.storage.local.get(['rd_cached_downloads', 'rd_cached_user']).then((data) => {
    if (data.rd_cached_downloads && data.rd_cached_downloads.length > 0) {
      allDownloads = data.rd_cached_downloads;
      renderDownloads();
      enforceSelectionLock();
    }
    if (data.rd_cached_user) {
      showUserBar(data.rd_cached_user);
    }
    if (!data.rd_cached_downloads || data.rd_cached_downloads.length === 0) {
      showState('loading');
    }
  });
}

function cacheData(downloads) {
  const thirtyDaysAgo = Date.now() - (30 * 86400000);
  let cleaned = downloads.filter(d => {
    if (isCompleted(d) && d.created_at) {
      return new Date(d.created_at).getTime() > thirtyDaysAgo;
    }
    return true;
  });
  if (cleaned.length > 1000) {
    cleaned = cleaned.slice(0, 1000);
  }
  browser.storage.local.set({ rd_cached_downloads: cleaned });
}

function refreshInBackground() {
  const btn = $('#btn-refresh');
  if (btn.classList.contains('syncing')) return Promise.resolve();
  
  btn.classList.add('syncing');
  return fetchAll(true).finally(() => {
    btn.classList.remove('syncing');
    btn.classList.add('synced');
    setTimeout(() => btn.classList.remove('synced'), 1500);
  });
}

let autoRefreshTimer = null;
let refreshDecayCount = 0;
const BASE_REFRESH_MS = 5000;
const MAX_REFRESH_MS = 60000;

function startAutoRefresh() {
  if (autoRefreshTimer) return;
  scheduleNextRefresh();
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  refreshDecayCount = 0;
}

function scheduleNextRefresh() {
  let delay = Math.min(MAX_REFRESH_MS, BASE_REFRESH_MS * Math.pow(1.5, refreshDecayCount));
  if (allDownloads.some(d => d.download_state === 'processing' || d.download_state === 'waiting_selection')) {
    delay = Math.min(delay, 5000);
  }

  autoRefreshTimer = setTimeout(async () => {
    if (!allDownloads.some(d => !isCompleted(d))) {
      stopAutoRefresh();
      return;
    }

    const btn = $('#btn-refresh');
    if (btn && btn.classList.contains('syncing')) {
      scheduleNextRefresh();
      return;
    }

    const oldHash = allDownloads.map(d => `${d.progress}_${d.download_state}`).join(',');
    await fetchAll(true);
    const newHash = allDownloads.map(d => `${d.progress}_${d.download_state}`).join(',');

    if (oldHash === newHash) refreshDecayCount++;
    else refreshDecayCount = 0;

    if (allDownloads.some(d => !isCompleted(d))) scheduleNextRefresh();
    else stopAutoRefresh();
  }, delay);
}

function enforceSelectionLock() {
  const pending = allDownloads.find(d => d.download_state === 'waiting_selection' && !ignoreAutoLockIds.has(String(d.id)));
  if (pending && !currentlyLockedTorrentId) {
    openFileSelectionModal(pending.id);
  }
}

async function loadSettings() {
  return browser.storage.local.get(['rd_theme', 'rd_hover_lift', 'rd_use_jdownloader']).then((data) => {
    const theme = data.rd_theme || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    const hoverLift = data.rd_hover_lift !== false ? 'on' : 'off';
    document.documentElement.setAttribute('data-hover-lift', hoverLift);
    useJDownloader = data.rd_use_jdownloader === true;
  });
}

function saveTheme(theme) {
  browser.storage.local.set({ rd_theme: theme });
}

let deleteAllHoldTimer = null;

function bindEvents() {
  $('#btn-theme').addEventListener('click', () => {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    saveTheme(next);
  });

  $('.logo-icon').addEventListener('click', () => {
    browser.tabs.create({ url: 'https://real-debrid.com/torrents', active: true });
  });

  $('#btn-settings').addEventListener('click', () => showAuthModal(false));
  $('#btn-login-api').addEventListener('click', () => showAuthModal(true));
  $('#btn-notifications').addEventListener('click', showNotificationsModal);
  
  $('#btn-add-torrent').addEventListener('click', () => {
    if (!hasValidToken) {
      showAuthModal(true);
      return;
    }
    browser.windows.create({
      url: 'add.html',
      type: 'popup',
      width: 420,
      height: 550
    });
    window.close();
  });

  $('#btn-add-webdl').addEventListener('click', showWebLinkModal);

  $('#btn-refresh').addEventListener('click', () => {
    if ($('#btn-refresh').classList.contains('syncing')) return;
    refreshInBackground();
  });

  const cycleBtn = $('#tab-type-cycle');
  const cycleStates = [ { type: 'torrent', label: 'TOR ↻' }, { type: 'web', label: 'WEB ↻' } ];
  let cycleIndex = -1;

  cycleBtn.addEventListener('click', () => {
    cycleIndex = (cycleIndex + 1) % (cycleStates.length + 1);
    if (cycleIndex === cycleStates.length) {
      cycleIndex = -1;
      cycleBtn.textContent = i18n('tabType');
      cycleBtn.dataset.cycleState = 'none';
      delete cycleBtn.dataset.cycleType;
      cycleBtn.classList.remove('active');
      currentTypeFilter = null;
      visibleCount = 50;
      renderDownloads();
      return;
    }
    const state = cycleStates[cycleIndex];
    cycleBtn.classList.add('active');
    cycleBtn.dataset.cycleState = 'active';
    cycleBtn.dataset.cycleType = state.type;
    cycleBtn.textContent = state.label;
    currentTypeFilter = state.type;
    visibleCount = 50;
    renderDownloads();
  });

  $$('.tab:not(#tab-type-cycle):not(#btn-delete-all)').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab:not(#tab-type-cycle):not(#btn-delete-all)').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      visibleCount = 50;
      renderDownloads();
    });
  });

  const deleteAllBtn = $('#btn-delete-all');
  deleteAllBtn.addEventListener('mousedown', () => {
    if (!hasValidToken || allDownloads.length === 0) return;
    deleteAllBtn.classList.remove('no-transition');
    deleteAllBtn.classList.add('holding');
    deleteAllHoldTimer = setTimeout(() => {
      deleteAllBtn.classList.add('no-transition');
      deleteAllBtn.classList.remove('holding');
      deleteAllVisible();
    }, 1500);
  });
  const cancelDeleteAll = () => {
    deleteAllBtn.classList.add('no-transition');
    deleteAllBtn.classList.remove('holding');
    if (deleteAllHoldTimer) {
      clearTimeout(deleteAllHoldTimer);
      deleteAllHoldTimer = null;
    }
  };
  deleteAllBtn.addEventListener('mouseup', cancelDeleteAll);
  deleteAllBtn.addEventListener('mouseleave', cancelDeleteAll);

  $('#search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    visibleCount = 50;
    renderDownloads();
  });

  const ageBtn = $('#btn-age-filter');
  const ageMenu = $('#age-filter-menu');

  ageBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !ageMenu.classList.contains('hidden');
    ageMenu.classList.toggle('hidden');
    ageBtn.classList.toggle('open', !isOpen);
  });

  document.addEventListener('click', () => {
    ageMenu.classList.add('hidden');
    ageBtn.classList.remove('open');
  });

  ageMenu.addEventListener('click', (e) => e.stopPropagation());

  $$('.age-filter-option').forEach(opt => {
    opt.addEventListener('click', () => {
      ageFilterDays = opt.dataset.age ? parseInt(opt.dataset.age) : null;
      updateAgeFilterUI();
      ageMenu.classList.add('hidden');
      ageBtn.classList.remove('open');
      visibleCount = 50;
      renderDownloads();
    });
  });

  $('#modal-close').addEventListener('click', () => closeModal());
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('#modal-overlay')) closeModal();
  });

  $('#download-list').addEventListener('click', handleListClick);

  $('#downloads-container').addEventListener('scroll', (e) => {
    const el = e.target;
    if (el.scrollHeight - el.scrollTop <= el.clientHeight + 100) {
      if (visibleCount < currentFiltered.length) {
        visibleCount += 50;
        renderDownloads();
      }
    }
  });
}

function handleListClick(e) {
  const dlBtn = e.target.closest('.dl-download-btn');
  if (dlBtn) {
    if (dlBtn.dataset.action === 'select-files') {
      openFileSelectionModal(dlBtn.dataset.id);
    } else {
      downloadFile(dlBtn.dataset.type, dlBtn.dataset.id);
    }
    return;
  }

  const deleteBtn = e.target.closest('.dl-delete-btn');
  if (deleteBtn) {
    deleteDownload(deleteBtn.dataset.type, deleteBtn.dataset.id);
    return;
  }

  const fileItem = e.target.closest('.dl-file-item:not(.dl-file-info)');
  if (fileItem) {
    const btn = fileItem.querySelector('.dl-file-download');
    if (btn) downloadFile(btn.dataset.type, btn.dataset.id);
    return;
  }

  const item = e.target.closest('.dl-item');
  if (item && !e.target.closest('.dl-expanded-content')) {
    const isExpanding = !item.classList.contains('expanded');
    item.classList.toggle('expanded');
    if (isExpanding) {
      const dlId = item.dataset.id;
      const dl = allDownloads.find(d => String(d.id) === dlId);
      if (dl && dl._type === 'torrent' && isCompleted(dl) && ((dl.files || []).length === 0 || (dl.links || []).length === 0)) {
        fetchTorrentFiles(dl, item);
      }
    }
  }
}

function parseTorrentInfo(info) {
  const selectedFiles = (info.files || []).filter(f => f.selected === 1);
  return {
    links: info.links || [],
    files: selectedFiles.map((f, idx) => ({
      id: idx,
      name: f.path ? f.path.replace(/^\//, '') : `${i18n('fileX')} ${idx + 1}`,
      short_name: f.path ? f.path.split('/').pop() : `${i18n('fileX')} ${idx + 1}`,
      size: f.bytes || 0,
    })),
  };
}

async function fetchTorrentFiles(dl, itemEl) {
  try {
    const info = await apiGet(`/torrents/info/${dl.id}`);
    if (!info) return;

    const parsed = parseTorrentInfo(info);
    dl.links = parsed.links;
    dl.files = parsed.files;

    const existingExpanded = itemEl.querySelector('.dl-expanded-content');
    const newExpanded = renderExpandedContent(dl);
    if (existingExpanded) {
      existingExpanded.replaceWith(newExpanded);
    }
    itemEl.dataset.fileCount = String(dl.files.length);
    cacheData(allDownloads);
  } catch (err) {
    if (err.message === 'Unauthenticated') return;
    console.error('Falha ao buscar torrent files:', err);
  }
}

async function preloadTorrentFiles() {
  const visibleIds = new Set(currentFiltered.slice(0, visibleCount).map(d => String(d.id)));
  const needsInfo = allDownloads.filter(dl => visibleIds.has(String(dl.id)) && dl._type === 'torrent' && isCompleted(dl) && ((dl.files || []).length === 0 || (dl.links || []).length === 0));
  
  if (needsInfo.length === 0) return;
  let changed = false;

  const BATCH_SIZE = 3;
  for (let i = 0; i < needsInfo.length; i += BATCH_SIZE) {
    const batch = needsInfo.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(async (dl) => {
      try {
        const info = await apiGet(`/torrents/info/${dl.id}`);
        if (info) {
          const parsed = parseTorrentInfo(info);
          dl.links = parsed.links;
          dl.files = parsed.files;
          changed = true;
        }
      } catch (err) {}
    }));
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  if (changed) {
    cacheData(allDownloads);
    renderDownloads();
  }
}

async function deleteDownload(type, id) {
  const itemElement = dlElementMap.get(String(id)) || document.querySelector(`.dl-delete-btn[data-id="${id}"]`)?.closest('.dl-item');
  if (itemElement) {
    itemElement.style.opacity = '0.5';
    itemElement.style.pointerEvents = 'none';
  }

  try {
    if (type === 'torrent') {
      toast(i18n('deleting'), 'success');
      await apiDelete(`/torrents/delete/${id}`);
    } else if (type === 'web') {
      const { rd_local_downloads } = await browser.storage.local.get('rd_local_downloads');
      if (rd_local_downloads) {
        const updated = rd_local_downloads.filter(d => String(d.id) !== String(id));
        await browser.storage.local.set({ rd_local_downloads: updated });
      }
    }

    if (itemElement) {
      itemElement.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
      itemElement.style.opacity = '0';
      itemElement.style.transform = 'translateX(-10px)';
      setTimeout(() => itemElement.remove(), 150);
    }
    dlElementMap.delete(String(id));
    
    allDownloads = allDownloads.filter(dl => String(dl.id) !== String(id));
    cacheData(allDownloads);

    if (allDownloads.length === 0) showState('empty');
    toast(i18n('removed'), 'success');
  } catch (err) {
    if (err.message === 'Unauthenticated') return;
    toast(i18n('deleteFailed'), 'error');
    if (itemElement) {
      itemElement.style.opacity = '1';
      itemElement.style.pointerEvents = 'auto';
    }
  }
}

async function deleteAllVisible() {
  let targets = allDownloads;
  switch (currentTab) {
    case 'downloading': targets = targets.filter(d => !isCompleted(d)); break;
    case 'completed':   targets = targets.filter(d => isCompleted(d)); break;
    case 'search':
      targets = searchQuery ? targets.filter(d => (d.name || '').toLowerCase().includes(searchQuery)) : targets;
      targets = filterByAge(targets, ageFilterDays);
      break;
  }
  if (currentTypeFilter) targets = targets.filter(d => d._type === currentTypeFilter);
  if (targets.length === 0) return;

  document.querySelectorAll('.dl-item').forEach(e => {
    e.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
    e.style.opacity = '0';
    e.style.transform = 'translateX(-10px)';
  });
  
  setTimeout(() => {
    const ids = new Set(targets.map(d => String(d.id)));
    allDownloads = allDownloads.filter(d => !ids.has(String(d.id)));
    cacheData(allDownloads);
    renderDownloads();
  }, 150);

  toast(i18n('deleting'), 'success');

  const webTargets = targets.filter(dl => dl._type === 'web');
  const torrentTargets = targets.filter(dl => dl._type === 'torrent');

  if (webTargets.length > 0) {
    const webIds = new Set(webTargets.map(d => String(d.id)));
    const { rd_local_downloads } = await browser.storage.local.get('rd_local_downloads');
    if (rd_local_downloads) {
      const updated = rd_local_downloads.filter(d => !webIds.has(String(d.id)));
      await browser.storage.local.set({ rd_local_downloads: updated });
    }
  }

  if (torrentTargets.length > 0) {
    browser.runtime.sendMessage({
      action: 'delete-torrents',
      ids: torrentTargets.map(dl => dl.id),
    });
  }
}

async function downloadFile(type, id) {
  try {
    const dl = allDownloads.find(d => String(d.id) === String(id));

    if (type === 'web' && dl?._rd_download) {
      triggerDownload(dl._rd_download, dl.name);
      return;
    }

    if (type === 'torrent') {
      toast(i18n('startingDownload'), 'success');
      let links = dl?.links || [];
      if (links.length === 0) {
        const info = await apiGet(`/torrents/info/${id}`);
        links = info?.links || [];
      }

      if (links.length > 0) {
        const unrestricted = await apiPost('/unrestrict/link', { link: links[0] }, false, 10000);
        if (unrestricted?.download) triggerDownload(unrestricted.download, dl.name);
        else toast(i18n('failedDlLink'), 'error');
      } else {
        toast(i18n('noDlLink'), 'error');
      }
      return;
    }

    toast(i18n('unknownDlType'), 'error');
  } catch (err) {
    if (err.message === 'Unauthenticated') return;
    const msg = err.name === 'AbortError' ? i18n('dlTimeout') : i18n('dlFailed');
    toast(msg, 'error');
  }
}

async function triggerDownload(url, filename = '') {
  if (!String(url).startsWith('https://') && !String(url).startsWith('http://')) {
    toast(i18n('invalidDlLink'), 'error');
    return;
  }

  if (useJDownloader) {
    try {
      toast(i18n('sendingToJd'), 'success');
      const formData = new URLSearchParams();
      formData.append('urls', url);
      formData.append('autostart', '1');
      if (filename) formData.append('package', filename);

      const res = await fetch('http://127.0.0.1:9666/flashgot', {
        method: 'POST',
        body: formData.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      if (res.ok) {
        toast(i18n('addedToJd'), 'success');
      } else {
        throw new Error('JD2 Error');
      }
    } catch (err) {
      toast(i18n('jdUnresponsive'), 'error');
    }
    return;
  }

  toast(i18n('startingDownload'), 'success');
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function forceLogout(msg = null) {
  if (!msg) msg = i18n('accessRevoked');
  hasValidToken = false;
  stopAutoRefresh();
  await browser.storage.local.remove([
    'rd_access_token', 'rd_refresh_token', 'rd_oauth_client_id', 
    'rd_oauth_client_secret', 'rd_token_expires_at', 'rd_cached_user', 
    'rd_cached_downloads', 'rd_oauth_pending'
  ]);
  allDownloads = [];
  
  const tile = $('#header-plan-tile');
  if (tile) tile.style.display = 'none';
  
  const btn = $('#btn-login-api');
  if (btn) btn.textContent = i18n('connectRd');
  
  closeModal(true);
  showState('no-api');
  if (msg) toast(msg, 'error');
}

async function fetchAll(isBackgroundSync = false) {
  const token = await getValidToken();
  if (!token) return showState('no-api');
  if (allDownloads.length === 0) showState('loading');

  try {
    let torrentsRes = [];
    let page = 1;
    const limit = 100;
    let hasMore = true;
    let latestCachedDate = 0;
    
    if (isBackgroundSync && allDownloads.length > 0) {
      latestCachedDate = new Date(allDownloads[0].created_at || 0).getTime();
    }

    while (hasMore) {
      const res = await apiGet(`/torrents?limit=${limit}&page=${page}`);
      if (Array.isArray(res) && res.length > 0) {
        torrentsRes.push(...res);
        if (res.length < limit) {
          hasMore = false;
        } else if (isBackgroundSync) {
          const oldestInPage = new Date(res[res.length - 1].added || 0).getTime();
          if (oldestInPage <= latestCachedDate) hasMore = false;
          else page++;
        } else {
          page++;
        }
      } else {
        hasMore = false; 
      }
    }

    if (isBackgroundSync && allDownloads.length > 0) {
      const freshData = new Map();
      torrentsRes.forEach(t => freshData.set(String(t.id), normalizeTorrent(t)));

      allDownloads = allDownloads.map(dl => {
        if (currentlyLockedTorrentId === String(dl.id)) return dl; // Mutex
        if (freshData.has(String(dl.id))) {
          const updated = freshData.get(String(dl.id));
          updated.files = dl.files;
          updated.links = dl.links;
          freshData.delete(String(dl.id));
          return updated;
        }
        return dl;
      });

      const newItems = Array.from(freshData.values());
      allDownloads = [...newItems, ...allDownloads];
    } else {
      allDownloads = [];
      if (Array.isArray(torrentsRes)) {
        torrentsRes.forEach((t) => allDownloads.push(normalizeTorrent(t)));
      }
    }

    const { rd_local_downloads } = await browser.storage.local.get('rd_local_downloads');
    if (rd_local_downloads && rd_local_downloads.length > 0) {
      const expiryCutoff = Date.now() - 7 * 86400000;
      const valid = rd_local_downloads.filter(d => new Date(d.created_at).getTime() > expiryCutoff);
      if (valid.length !== rd_local_downloads.length) {
        browser.storage.local.set({ rd_local_downloads: valid });
      }
      allDownloads = allDownloads.filter(d => d._type !== 'web');
      valid.forEach(d => allDownloads.push(d));
    }
    
    allDownloads.sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateB - dateA;
    });

    const { rd_cached_downloads } = await browser.storage.local.get('rd_cached_downloads');
    if (rd_cached_downloads) {
      const cachedById = new Map();
      rd_cached_downloads.forEach(d => { if (d.files && d.files.length > 0) cachedById.set(String(d.id), d); });
      allDownloads.forEach(dl => {
        if (dl._type === 'torrent' && (dl.files || []).length === 0) {
          const cached = cachedById.get(String(dl.id));
          if (cached) {
            dl.files = cached.files;
            dl.links = cached.links || dl.links;
          }
        }
      });
    }

    let changedLocks = false;
    const currentIds = new Set(allDownloads.map(d => String(d.id)));
    for (const id of ignoreAutoLockIds) {
      if (!currentIds.has(id)) {
        ignoreAutoLockIds.delete(id);
        changedLocks = true;
      }
    }
    if (changedLocks) {
      browser.storage.local.set({ rd_ignore_locks: Array.from(ignoreAutoLockIds) });
    }

    cacheData(allDownloads);

    if (!isBackgroundSync) visibleCount = 50;
    
    renderDownloads();
    preloadTorrentFiles();
    await updateBellFromDownloads(allDownloads);

    enforceSelectionLock();

    if (allDownloads.some(d => !isCompleted(d))) startAutoRefresh();
    else stopAutoRefresh();

  } catch (err) {
    if (err.message === 'Unauthenticated') return;
    if (allDownloads.length === 0) showState('empty');
    if (hasValidToken) toast(i18n('fetchingDownloadsFailed'), 'error');
  }
}

function normalizeTorrent(t) {
  return {
    id: t.id,
    name: t.filename || i18n('unnamedTorrent'),
    size: t.bytes || 0,
    progress: (t.progress || 0) / 100,
    download_state: mapRdStatus(t.status),
    download_speed: t.speed || 0,
    seeds: t.seeders,
    created_at: normalizeRdTimestamp(t.added),
    completed_at: normalizeRdTimestamp(t.ended),
    links: t.links || [],
    _type: 'torrent',
    _rd_id: t.id,
    _rd_status: t.status,
    files: [],
  };
}

function normalizeRdTimestamp(ts) {
  if (!ts) return null;
  let d = new Date(ts);
  if (!isNaN(d)) return d.toISOString();
  let s = ts.trim().replace(' ', 'T');
  if (!s.endsWith('Z')) s += 'Z';
  d = new Date(s);
  if (!isNaN(d)) return d.toISOString();
  return null;
}

let storageQueue = Promise.resolve();

function saveLocalDownloads(unrestrictResults) {
  return new Promise((resolve) => {
    storageQueue = storageQueue.then(async () => {
      const data = await browser.storage.local.get('rd_local_downloads');
      const existing = data.rd_local_downloads || [];
      const newEntries = unrestrictResults.map(d => ({
        id: d.id || `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: d.filename || i18n('unnamedDownload'),
        size: d.filesize || 0,
        progress: 1,
        download_state: 'completed',
        created_at: new Date().toISOString(),
        _type: 'web',
        _rd_download: d.download,
        _rd_link: d.link,
        _rd_host: d.host,
        files: d.download ? [{
          id: 0,
          name: d.filename || 'Download',
          size: d.filesize || 0,
          short_name: d.filename || 'Download',
        }] : [],
      }));

      const merged = [...newEntries, ...existing].slice(0, 99);
      await browser.storage.local.set({ rd_local_downloads: merged });
      for (const e of newEntries) await trackId(String(e.id));
      resolve();
    }).catch(console.error);
  });
}

function mapRdStatus(status) {
  const s = (status || '').toLowerCase();
  const map = {
    'magnet_error': 'error',
    'magnet_conversion': 'waiting_selection',
    'waiting_files_selection': 'waiting_selection',
    'queued': 'queued',
    'downloading': 'downloading',
    'downloaded': 'completed',
    'error': 'error',
    'virus': 'error',
    'compressing': 'processing',
    'uploading': 'uploading',
    'dead': 'error',
  };
  return map[s] || s || 'unknown';
}

async function fetchUserInfo() {
  try {
    const res = await apiGet('/user');
    if (res) {
      showUserBar(res);
      browser.storage.local.set({ rd_cached_user: res });
    }
  } catch (err) {
    if (err.message === 'Unauthenticated') return;
  }
}

function showState(state) {
  $('#loading').classList.toggle('hidden', state !== 'loading');
  $('#empty').classList.toggle('hidden', state !== 'empty');
  $('#no-api').classList.toggle('hidden', state !== 'no-api');
  $('#download-list').replaceChildren();
  dlElementMap.clear();
}

function showUserBar(data) {
  const planType = capitalize(data.type || 'free');
  const daysRemaining = calculateDaysRemaining(data.expiration);

  const tile = $('#header-plan-tile');
  if (tile) {
    $('#header-plan-name').textContent = planType;
    $('#header-plan-expiry').textContent = daysRemaining;
    tile.style.display = 'flex';
  }
}

function calculateDaysRemaining(expiresAt) {
  if (!expiresAt) return i18n('noDaysRemaining');
  const [y, m, d] = expiresAt.slice(0, 10).split('-').map(Number);
  const now = new Date();
  const diffDays = Math.round(
    (Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000
  );
  return `${diffDays} ${diffDays === 1 ? i18n('dayRemaining') : i18n('daysRemaining')}`;
}

function filterByAge(downloads, days) {
  if (!days) return downloads;
  const cutoff = Date.now() - days * 86400000;
  return downloads.filter(d => new Date(d.created_at || 0).getTime() < cutoff);
}

function updateAgeFilterUI() {
  const btn = $('#btn-age-filter');
  const label = $('#age-filter-label');
  const clearOpt = $('.age-filter-clear');

  $$('.age-filter-option:not(.age-filter-clear)').forEach(opt => {
    opt.classList.toggle('selected', ageFilterDays === parseInt(opt.dataset.age));
  });

  if (ageFilterDays) {
    const labels = { 1: `> 1 ${i18n('moreThan1Day').replace('Mais de 1 ', '')}`, 7: `> 1 ${i18n('moreThan1Week').replace('Mais de 1 ', '')}`, 30: `> 1 ${i18n('moreThan1Month').replace('Mais de 1 ', '')}` };
    label.textContent = labels[ageFilterDays] || i18n('olderThan');
    btn.classList.add('active');
    clearOpt.classList.remove('hidden');
  } else {
    label.textContent = i18n('olderThan');
    btn.classList.remove('active');
    clearOpt.classList.add('hidden');
  }
}

function renderDownloads() {
  const list = $('#download-list');
  const activeTab = $('[data-tab="downloading"]');
  activeTab.classList.toggle('has-active-downloads', allDownloads.some(d => !isCompleted(d)));

  currentFiltered = allDownloads;

  switch (currentTab) {
    case 'downloading': currentFiltered = currentFiltered.filter(d => !isCompleted(d)); break;
    case 'completed': currentFiltered = currentFiltered.filter(d => isCompleted(d)); break;
  }

  if (searchQuery) {
    currentFiltered = currentFiltered.filter(d => (d.name || '').toLowerCase().includes(searchQuery));
  }
  currentFiltered = filterByAge(currentFiltered, ageFilterDays);
  updateAgeFilterUI();

  if (currentTypeFilter) currentFiltered = currentFiltered.filter(d => d._type === currentTypeFilter);

  const searchCountEl = $('#search-count');
  if (searchCountEl) {
    if (searchQuery || ageFilterDays) {
      searchCountEl.textContent = `${currentFiltered.length} ${i18n('resultsLabel')}`;
      searchCountEl.classList.remove('hidden');
    } else {
      searchCountEl.textContent = '';
      searchCountEl.classList.add('hidden');
    }
  }

  if (currentFiltered.length === 0) {
    showState('empty');
    return;
  }

  $('#loading').classList.add('hidden');
  $('#empty').classList.add('hidden');
  $('#no-api').classList.add('hidden');

  const toRender = currentFiltered.slice(0, visibleCount);
  const filteredIds = new Set(toRender.map(d => String(d.id)));

  for (const [id, elem] of dlElementMap) {
    if (!filteredIds.has(id)) {
      elem.remove();
      dlElementMap.delete(id);
    }
  }

  toRender.forEach((dl, index) => {
    const id = String(dl.id);
    let li = dlElementMap.get(id);

    if (li) {
      const newMeta = renderItemMeta(dl);
      const metaEl = li.querySelector('.dl-meta');
      if (metaEl) metaEl.replaceWith(newMeta.metaEl);

      const progressEl = li.querySelector('.dl-progress-wrap');
      if (newMeta.progressPct != null) {
        if (progressEl) {
          const fill = progressEl.querySelector('.dl-progress-fill');
          if (fill) fill.style.width = newMeta.progressPct + '%';
        } else {
          const expandedContent = li.querySelector('.dl-expanded-content');
          if (expandedContent && newMeta.progressEl) li.insertBefore(newMeta.progressEl, expandedContent);
        }
      } else if (progressEl) {
        progressEl.remove();
      }

      const completed = isCompleted(dl);
      const header = li.querySelector('.dl-item-header');
      const delBtn = li.querySelector('.dl-delete-btn');
      
      const existingDlBtn = li.querySelector('.dl-download-btn');
      
      if (completed && canDownload(dl) && header && delBtn) {
        if (!existingDlBtn || existingDlBtn.dataset.action === 'select-files') {
          if (existingDlBtn) existingDlBtn.remove();
          const dlBtn = document.createElement('button');
          dlBtn.className = 'dl-download-btn';
          dlBtn.dataset.type = dl._type;
          dlBtn.dataset.id = String(dl.id);
          dlBtn.title = i18n('download');
          const dlBtnIcon = makeDownloadSvg();
          dlBtnIcon.style.cssText = 'position:relative;z-index:1;';
          dlBtn.appendChild(dlBtnIcon);
          header.insertBefore(dlBtn, delBtn);
        }
      } else if (dl.download_state === 'waiting_selection' && header && delBtn) {
        if (!existingDlBtn || existingDlBtn.dataset.action !== 'select-files') {
          if (existingDlBtn) existingDlBtn.remove();
          const selectBtn = document.createElement('button');
          selectBtn.className = 'dl-download-btn';
          selectBtn.dataset.action = 'select-files';
          selectBtn.dataset.id = String(dl.id);
          selectBtn.title = i18n('selectFiles');
          const selectIcon = makeSvg([
            ['polyline', {points: '9 11 12 14 22 4'}],
            ['path', {d: 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'}]
          ]);
          selectIcon.style.cssText = 'position:relative;z-index:1;';
          selectBtn.appendChild(selectIcon);
          header.insertBefore(selectBtn, delBtn);
        }
      } else if (!completed && dl.download_state !== 'waiting_selection' && existingDlBtn) {
        existingDlBtn.remove();
      }

      const currentFileCount = (dl.files || []).length;
      const knownFileCount = parseInt(li.dataset.fileCount ?? '-1', 10);
      if (currentFileCount !== knownFileCount) {
        const existingExpanded = li.querySelector('.dl-expanded-content');
        const newExpanded = renderExpandedContent(dl);
        if (existingExpanded) {
          if (li.classList.contains('expanded')) newExpanded.style.display = '';
          existingExpanded.replaceWith(newExpanded);
        } else {
          li.appendChild(newExpanded);
        }
        li.dataset.fileCount = String(currentFileCount);
      }
    } else {
      li = document.createElement('li');
      li.className = 'dl-item';
      li.dataset.id = id;
      li.dataset.fileCount = String((dl.files || []).length);
      li.appendChild(renderItem(dl));
      dlElementMap.set(id, li);
    }

    const currentAtIndex = list.children[index];
    if (currentAtIndex !== li) {
      list.insertBefore(li, currentAtIndex || null);
    }
  });
}

function renderItemMeta(dl) {
  const status = getStatus(dl);
  const statusClass = getStatusClass(dl);
  const progress = dl.progress != null ? Math.round(dl.progress * 100) : (isCompleted(dl) ? 100 : 0);
  const size = dl.size ? formatBytes(dl.size) : '—';
  const completed = isCompleted(dl);

  const metaEl = document.createElement('div');
  metaEl.className = 'dl-meta';
  metaEl.title = dl.name || i18n('unnamedDownload');

  const statusSpan = document.createElement('span');
  statusSpan.className = 'dl-status';

  const dot = document.createElement('span');
  dot.className = `dl-status-dot ${statusClass}`;
  statusSpan.appendChild(dot);
  statusSpan.appendChild(document.createTextNode(capitalize(status)));
  metaEl.appendChild(statusSpan);

  const infoSpan = document.createElement('span');

  if (completed) {
    const files = dl.files || [];
    const fileCount = files.length;
    const metaParts = [size];
    if (fileCount > 0) {
      const largest = files.reduce((a, b) => (b.size || 0) > (a.size || 0) ? b : a, files[0]);
      const name = largest.short_name || largest.name || '';
      const dotIdx = name.lastIndexOf('.');
      if (dotIdx > 0) metaParts.push(name.slice(dotIdx + 1).toUpperCase());
      metaParts.push(`${fileCount} ${i18n('fileX').toLowerCase()}${fileCount !== 1 ? 's' : ''}`);
    }
    const addedTime = dl.created_at ? formatTimeAgo(dl.created_at) : null;
    if (addedTime) metaParts.push(`${i18n('addedAt')} ${addedTime}`);
    infoSpan.textContent = metaParts.join(' • ');
  } else {
    const speed = dl.download_speed ? `${formatBytes(dl.download_speed)}/s` : '';
    const seeds = dl.seeds != null ? `${dl.seeds} Seeds` : '';
    const eta = (dl.eta && dl.eta < 864000) ? `${formatETA(dl.eta)} ${i18n('predicted')}` : (dl.eta ? i18n('noPrediction') : '');
    infoSpan.textContent = [size, seeds, speed, eta].filter(Boolean).join(' • ');
  }

  metaEl.appendChild(infoSpan);

  let progressEl = null;
  if (!completed) {
    progressEl = document.createElement('div');
    progressEl.className = 'dl-progress-wrap';
    const bar = document.createElement('div');
    bar.className = 'dl-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'dl-progress-fill';
    fill.style.width = progress + '%';
    bar.appendChild(fill);
    progressEl.appendChild(bar);
  }

  return { metaEl, progressEl: progressEl || null, progressPct: completed ? null : progress };
}

function renderExpandedContent(dl) {
  const type = dl._type;
  const size = dl.size ? formatBytes(dl.size) : '—';
  const files = dl.files || [];
  const links = dl.links || [];

  const expandedContent = document.createElement('div');
  expandedContent.className = 'dl-expanded-content';

  if (type === 'torrent' && isCompleted(dl) && links.length > 0) {
    if (files.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'dl-files-list';
      files.forEach((f, idx) => {
        const li = document.createElement('li');
        li.className = 'dl-file-item dl-file-info';
        li.title = fileBaseName(f.name || f.short_name || `${i18n('fileX')} ${idx + 1}`);
        li.style.cursor = 'default';
        const fnameEl = document.createElement('span');
        fnameEl.className = 'dl-file-name';
        fnameEl.textContent = f.short_name || f.name || `${i18n('fileX')} ${idx + 1}`;
        fnameEl.style.opacity = '0.7';
        const fsize = document.createElement('span');
        fsize.className = 'dl-file-size';
        fsize.textContent = f.size ? formatBytes(f.size) : '—';
        fsize.style.opacity = '0.7';
        li.appendChild(fnameEl);
        li.appendChild(fsize);
        ul.appendChild(li);
      });
      expandedContent.appendChild(ul);
    } else {
      const noFiles = document.createElement('div');
      noFiles.className = 'dl-no-files';
      noFiles.textContent = i18n('fileInfoMissing');
      expandedContent.appendChild(noFiles);
    }
  } else if (type === 'web' && dl._rd_download) {
    const ul = document.createElement('ul');
    ul.className = 'dl-files-list';
    const li = document.createElement('li');
    li.className = 'dl-file-item dl-file-info';
    li.style.cursor = 'default';
    const fnameEl = document.createElement('span');
    fnameEl.className = 'dl-file-name';
    fnameEl.textContent = dl.name || 'Download';
    fnameEl.style.opacity = '0.7';
    const fsize = document.createElement('span');
    fsize.className = 'dl-file-size';
    fsize.textContent = size;
    fsize.style.opacity = '0.7';
    li.appendChild(fnameEl);
    li.appendChild(fsize);
    ul.appendChild(li);
    expandedContent.appendChild(ul);
  } else {
    const noFiles = document.createElement('div');
    noFiles.className = 'dl-no-files';
    noFiles.textContent = i18n('filesAvailableLater');
    expandedContent.appendChild(noFiles);
  }

  return expandedContent;
}

function renderItem(dl) {
  const name = dl.name || i18n('unnamedDownload');
  const type = dl._type;
  const completed = isCompleted(dl);

  const header = document.createElement('div');
  header.className = 'dl-item-header';
  header.title = name;

  const typeBadge = document.createElement('span');
  typeBadge.className = `dl-type-badge ${type}`;
  typeBadge.textContent = type === 'web' ? 'WEB' : type.slice(0, 3).toUpperCase();
  header.appendChild(typeBadge);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'dl-name';
  nameSpan.textContent = name;
  header.appendChild(nameSpan);

  if (completed && canDownload(dl)) {
    const dlBtn = document.createElement('button');
    dlBtn.className = 'dl-download-btn';
    dlBtn.dataset.type = type;
    dlBtn.dataset.id = String(dl.id);
    dlBtn.title = i18n('download');
    const dlBtnIcon = makeDownloadSvg();
    dlBtnIcon.style.cssText = 'position:relative;z-index:1;';
    dlBtn.appendChild(dlBtnIcon);
    header.appendChild(dlBtn);
  } else if (dl.download_state === 'waiting_selection') {
    const selectBtn = document.createElement('button');
    selectBtn.className = 'dl-download-btn';
    selectBtn.dataset.action = 'select-files';
    selectBtn.dataset.id = String(dl.id);
    selectBtn.title = i18n('selectFiles');
    const selectIcon = makeSvg([
      ['polyline', {points: '9 11 12 14 22 4'}],
      ['path', {d: 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'}]
    ]);
    selectIcon.style.cssText = 'position:relative;z-index:1;';
    selectBtn.appendChild(selectIcon);
    header.appendChild(selectBtn);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'dl-delete-btn';
  deleteBtn.dataset.type = type;
  deleteBtn.dataset.id = String(dl.id);
  deleteBtn.title = i18n('delete');
  const deleteBtnIcon = makeTrashSvg();
  deleteBtnIcon.style.cssText = 'position:relative;z-index:1;';
  deleteBtn.appendChild(deleteBtnIcon);
  header.appendChild(deleteBtn);

  const { metaEl, progressEl } = renderItemMeta(dl);
  const expandedContent = renderExpandedContent(dl);

  const frag = document.createDocumentFragment();
  frag.appendChild(header);
  frag.appendChild(metaEl);
  if (progressEl) frag.appendChild(progressEl);
  frag.appendChild(expandedContent);

  return frag;
}

function isCompleted(dl) {
  const s = (dl.download_state || '').toLowerCase();
  if (s === 'processing' || s === 'waiting_selection' || s.includes('queue')) return false;
  return s === 'completed' || (dl.progress != null && dl.progress >= 1);
}

function isReady(dl) {
  const s = (dl.download_state || '').toLowerCase();
  return s === 'completed';
}

function canDownload(dl) {
  if (dl._type === 'web' && dl._rd_download) return true;
  if (dl._type === 'torrent' && (dl.links || []).length > 0) return true;
  return false;
}

function getStatus(dl) {
  const s = dl.download_state || '';
  if (!s) return dl.progress >= 1 ? i18n('statusCompleted') : i18n('statusUnknown');
  
  const stateMap = {
    'error': i18n('statusError'),
    'magnet_error': i18n('statusError'),
    'virus': i18n('statusError'),
    'dead': i18n('statusError'),
    'processing': i18n('statusProcessing'),
    'compressing': i18n('statusProcessing'),
    'magnet_conversion': i18n('statusWaiting'),
    'waiting_selection': i18n('statusWaiting'),
    'waiting_files_selection': i18n('statusWaiting'),
    'queued': i18n('statusQueued'),
    'downloading': i18n('statusDownloading'),
    'completed': i18n('statusCompleted'),
    'downloaded': i18n('statusCompleted'),
    'uploading': i18n('statusUploading'),
    'unknown': i18n('statusUnknown')
  };
  
  return stateMap[s] || s.replace(/_/g, ' ');
}

function getStatusClass(dl) {
  const s = dl.download_state || '';
  if (s === 'completed' || s === 'downloaded') return 'completed';
  if (['downloading', 'uploading', 'compressing', 'processing'].includes(s)) return 'downloading';
  if (['queued', 'waiting_files_selection', 'magnet_conversion'].includes(s)) return 'queued';
  if (['error', 'dead', 'virus', 'magnet_error'].includes(s)) return 'error';
  return 'unknown';
}

function openModalWithNode(title, bodyNode, locked = false) {
  document.querySelectorAll('.notifications-mark-all').forEach(el => el.remove());
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(bodyNode);
  const overlay = $('#modal-overlay');
  overlay.classList.remove('hidden');
  overlay.dataset.locked = locked ? 'true' : 'false';
  $('#modal-close').style.display = locked ? 'none' : '';
  initFixedTooltips();
}

function initFixedTooltips() {
  document.querySelectorAll('.info-icon').forEach(icon => {
    const tip = icon.querySelector('.info-tooltip');
    if (!tip) return;
    icon.addEventListener('mouseenter', () => {
      const modal = document.querySelector('#modal');
      const iconRect = icon.getBoundingClientRect();
      const modalRect = modal ? modal.getBoundingClientRect() : document.body.getBoundingClientRect();
      tip.style.position = 'fixed';
      tip.style.visibility = 'hidden';
      tip.classList.add('visible');
      const tipWidth = tip.offsetWidth;
      tip.style.visibility = '';
      tip.style.left = `${modalRect.left + (modalRect.width - tipWidth) / 2}px`;
      tip.style.top = `${iconRect.bottom + 6}px`;
    });
    icon.addEventListener('mouseleave', () => {
      tip.classList.remove('visible');
      tip.style.position = '';
      tip.style.left = '';
      tip.style.top = '';
    });
  });
}

function closeModal(force = false) {
  const overlay = $('#modal-overlay');
  if (!force && overlay.dataset.locked === 'true') return;
  if (oauthPollingInterval) { clearInterval(oauthPollingInterval); oauthPollingInterval = null; }
  overlay.classList.add('hidden');
  overlay.dataset.locked = 'false';
  $('#modal-close').style.display = '';
  if (force) currentlyLockedTorrentId = null;
}

function showAuthModal(autoStartOauth = false) {
  const autoStart = autoStartOauth === true;
  browser.storage.local.get(['rd_context_menu', 'rd_notifications_enabled', 'rd_hover_lift', 'rd_cached_user', 'rd_use_jdownloader', 'rd_oauth_pending']).then((data) => {
    const contextMenuEnabled = data.rd_context_menu !== false;
    const notificationsEnabled = data.rd_notifications_enabled !== false;
    const hoverLiftEnabled = data.rd_hover_lift !== false;
    const jd2Enabled = data.rd_use_jdownloader === true;
    const cachedUser = data.rd_cached_user;
    const userPoints = cachedUser?.points != null ? cachedUser.points.toLocaleString() : '—';
    const username = cachedUser?.username || cachedUser?.email || '—';

    const infoIconSvg = makeSvg([['circle',{cx:'12',cy:'12',r:'10'}],['line',{x1:'12',y1:'16',x2:'12',y2:'12'}],['line',{x1:'12',y1:'8',x2:'12.01',y2:'8'}]]);

    let authSection;
    if (hasValidToken) {
      authSection = el('div', {className: 'settings-account-footer', style: 'display: flex; align-items: center; justify-content: space-between; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-color);'},
        el('div', {style: 'display: flex; align-items: center; gap: 8px;'},
          makeSvg([['path',{d:'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'}],['circle',{cx:'12',cy:'7',r:'4'}]]),
          el('div', {style: 'display: flex; flex-direction: column; text-align: left; line-height: 1.2;'},
            el('span', {className: 'settings-account-name', style: 'font-weight: 600;'}, username),
            el('span', {className: 'settings-account-points', style: 'font-size: 11px; color: var(--text-muted); margin-top: 2px;'}, userPoints + i18n('points'))
          )
        ),
        el('button', {id: 'btn-logout', className: 'action-btn ghost', style: 'color: #f46878;'}, i18n('logout'))
      );
    } else {
      authSection = el('div', {style: 'text-align:center; padding: 10px;'},
        el('button', {id: 'btn-start-oauth', className: 'action-btn primary'}, i18n('connectRd'))
      );
    }

    const body = el('div', {},
      el('div', {className: 'form-group'},
        el('div', {className: 'toggle-row'},
          el('div', {},
            el('div', {className: 'form-label', style: 'margin-bottom:2px;'}, i18n('contextMenuLabel')),
            el('div', {className: 'form-hint'}, i18n('contextMenuDesc'))
          ),
          el('label', {className: 'toggle-switch'},
            el('input', {type: 'checkbox', id: 'toggle-context-menu', checked: contextMenuEnabled ? 'checked' : null}),
            el('span', {className: 'toggle-slider'})
          )
        )
      ),
      el('div', {className: 'form-group'},
        el('div', {className: 'toggle-row'},
          el('div', {},
            el('div', {style: 'display:flex;align-items:center;gap:5px;margin-bottom:2px;'},
              el('div', {className: 'form-label', style: 'margin-bottom:0;'}, i18n('dlNotificationsLabel')),
              el('span', {className: 'info-icon'}, infoIconSvg.cloneNode(true), el('span', {className: 'info-tooltip'}, i18n('dlNotificationsInfo')))
            ),
            el('div', {className: 'form-hint'}, i18n('dlNotificationsDesc'))
          ),
          el('label', {className: 'toggle-switch'},
            el('input', {type: 'checkbox', id: 'toggle-notifications', checked: notificationsEnabled ? 'checked' : null}),
            el('span', {className: 'toggle-slider'})
          )
        )
      ),
      el('div', {className: 'form-group'},
        el('div', {className: 'toggle-row'},
          el('div', {},
            el('div', {className: 'form-label', style: 'margin-bottom:2px;'}, i18n('hoverLiftLabel')),
            el('div', {className: 'form-hint'}, i18n('hoverLiftDesc'))
          ),
          el('label', {className: 'toggle-switch'},
            el('input', {type: 'checkbox', id: 'toggle-hover-lift', checked: hoverLiftEnabled ? 'checked' : null}),
            el('span', {className: 'toggle-slider'})
          )
        )
      ),
      el('div', {className: 'form-group'},
        el('div', {className: 'toggle-row'},
          el('div', {},
            el('div', {className: 'form-label', style: 'margin-bottom:2px;'}, i18n('jd2Label')),
            el('div', {className: 'form-hint'}, i18n('jd2Desc'))
          ),
          el('label', {className: 'toggle-switch'},
            el('input', {type: 'checkbox', id: 'toggle-jd2', checked: jd2Enabled ? 'checked' : null}),
            el('span', {className: 'toggle-slider'})
          )
        )
      ),
      el('div', {className: 'settings-account-section', id: 'settings-account-area'}, authSection)
    );

    openModalWithNode(i18n('settings'), body);

    $('#toggle-context-menu').addEventListener('change', (e) => browser.storage.local.set({ rd_context_menu: e.target.checked }));
    $('#toggle-notifications').addEventListener('change', (e) => {
      browser.storage.local.set({ rd_notifications_enabled: e.target.checked });
      if (!e.target.checked) {
        notifications = [];
        updateNotificationBadge();
      }
    });
    $('#toggle-hover-lift').addEventListener('change', (e) => {
      browser.storage.local.set({ rd_hover_lift: e.target.checked });
      document.documentElement.setAttribute('data-hover-lift', e.target.checked ? 'on' : 'off');
    });
    $('#toggle-jd2').addEventListener('change', (e) => {
      useJDownloader = e.target.checked;
      browser.storage.local.set({ rd_use_jdownloader: useJDownloader });
    });

    const startOauthBtn = $('#btn-start-oauth');
    if (startOauthBtn) {
      startOauthBtn.addEventListener('click', startOAuthFlow);
    }

    if (!hasValidToken && data.rd_oauth_pending) {
      if (data.rd_oauth_pending.expires_at > Date.now()) {
        renderOAuthPending(data.rd_oauth_pending);
      } else {
        browser.storage.local.remove('rd_oauth_pending');
        if (autoStart) startOAuthFlow();
      }
    } else if (!hasValidToken && autoStart) {
      startOAuthFlow();
    }

    const logoutBtn = $('#btn-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        forceLogout();
      });
    }
  });
}

async function startOAuthFlow() {
  const container = $('#settings-account-area');
  container.replaceChildren(el('div', {style: 'text-align:center; padding:10px;'}, el('div', {className: 'spinner'}), i18n('requestingCode')));
  
  try {
    const res = await fetch(`${OAUTH_BASE}/device/code?client_id=${OPENSOURCE_CLIENT_ID}&new_credentials=yes`);
    const data = await res.json();
    
    if (!data.device_code) throw new Error('No device code received');

    const pendingData = {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_url: data.verification_url,
      expires_at: Date.now() + (data.expires_in * 1000)
    };
    
    await browser.storage.local.set({ rd_oauth_pending: pendingData });
    renderOAuthPending(pendingData);
  } catch (err) {
    container.replaceChildren(el('div', {style: 'color: #f46878;'}, i18n('authError')));
    setTimeout(() => showAuthModal(false), 2000);
  }
}

function renderOAuthPending(data) {
  const container = $('#settings-account-area');
  if (!container) return;

  container.replaceChildren(
    el('div', {style: 'text-align:center; padding: 10px;'},
      el('h4', {style: 'margin-bottom: 5px;'}, i18n('accessUrl')),
      el('a', {href: data.verification_url, target: '_blank', style: 'color: var(--accent); font-weight: bold; font-size: 16px;'}, data.verification_url),
      el('div', {style: 'font-size: 24px; font-weight: bold; letter-spacing: 2px; margin: 15px 0; user-select: all;'}, data.user_code),
      el('div', {id: 'oauth-status', style: 'color: var(--text-muted); font-size: 12px; margin-bottom: 10px;'}, i18n('waitingAuth')),
      el('button', {id: 'btn-cancel-oauth', className: 'action-btn ghost', style: 'color: #f46878; margin: 0 auto;'}, i18n('cancel'))
    )
  );

  $('#btn-cancel-oauth').addEventListener('click', async () => {
    if (oauthPollingInterval) { clearInterval(oauthPollingInterval); oauthPollingInterval = null; }
    await browser.storage.local.remove('rd_oauth_pending');
    const btn = $('#btn-login-api');
    if (btn) btn.textContent = i18n('connectRd');
    showAuthModal(false);
  });

  if (oauthPollingInterval) clearInterval(oauthPollingInterval);
  pollDeviceCredentials(data.device_code);
  oauthPollingInterval = setInterval(() => pollDeviceCredentials(data.device_code), 5000);
}

async function pollDeviceCredentials(deviceCode) {
  try {
    const res = await fetch(`${OAUTH_BASE}/device/credentials?client_id=${OPENSOURCE_CLIENT_ID}&code=${deviceCode}`);
    if (res.status === 403) return; 
    if (!res.ok) throw new Error('Polling failed');
    
    const creds = await res.json();
    if (creds.client_id && creds.client_secret) {
      if (oauthPollingInterval) { clearInterval(oauthPollingInterval); oauthPollingInterval = null; }
      await exchangeDeviceToken(creds.client_id, creds.client_secret, deviceCode);
    }
  } catch (err) {
    if (oauthPollingInterval) { clearInterval(oauthPollingInterval); oauthPollingInterval = null; }
    const statusEl = $('#oauth-status');
    if (statusEl) statusEl.textContent = i18n('authError');
    await browser.storage.local.remove('rd_oauth_pending');
    const btn = $('#btn-login-api');
    if (btn) btn.textContent = i18n('connectRd');
  }
}

async function exchangeDeviceToken(clientId, clientSecret, deviceCode) {
  try {
    const statusEl = $('#oauth-status');
    if (statusEl) statusEl.textContent = i18n('finishingLogin');
    
    const res = await fetch(`${OAUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: deviceCode,
        grant_type: 'http://oauth.net/grant_type/device/1.0'
      }).toString()
    });
    
    const tokenData = await res.json();
    if (tokenData.access_token) {
      const expiry = Date.now() + (tokenData.expires_in * 1000);
      await browser.storage.local.set({
        rd_access_token: tokenData.access_token,
        rd_refresh_token: tokenData.refresh_token,
        rd_oauth_client_id: clientId,
        rd_oauth_client_secret: clientSecret,
        rd_token_expires_at: expiry
      });
      await browser.storage.local.remove('rd_oauth_pending');
      const btn = $('#btn-login-api');
      if (btn) btn.textContent = i18n('connectRd');
      hasValidToken = true;
      toast(i18n('loginComplete'), 'success');
      closeModal();
      fetchAll();
      fetchUserInfo();
    }
  } catch (err) {
    const statusEl = $('#oauth-status');
    if (statusEl) statusEl.textContent = i18n('failedToken');
  }
}

async function openFileSelectionModal(torrentId) {
  currentlyLockedTorrentId = String(torrentId);
  let isCancelled = false;

  const handleCancel = async (btn) => {
    isCancelled = true;
    if (btn) btn.disabled = true;
    try {
      await apiDelete(`/torrents/delete/${torrentId}`);
      toast(i18n('torrentCanceled'), 'success');
    } catch (err) {
      if (err.message === 'Unauthenticated') return;
      toast(i18n('errorRemove'), 'error');
    }
    addIgnoreLock(torrentId);
    closeModal(true);
    fetchAll();
  };

  const cancelLoadingBtn = el('button', {className: 'form-submit', style: 'margin-top: 15px; width: 100%; justify-content: center; background: #f46878 !important; color: #fff !important; border: none !important;'}, i18n('cancelTorrent'));
  cancelLoadingBtn.addEventListener('click', () => handleCancel(cancelLoadingBtn));

  const modalBody = el('div', {className: 'state-message', style: 'padding: 20px 0;'},
    el('div', {className: 'spinner'}),
    el('span', {style: 'margin-top: 10px; display: block;'}, i18n('waitingMagnet')),
    cancelLoadingBtn
  );

  openModalWithNode(i18n('selectFiles'), modalBody, true);

  let info;
  let attempts = 0;
  while (attempts < 60) {
    if (isCancelled || $('#modal-overlay').classList.contains('hidden')) {
      isCancelled = true;
      return;
    }
    try {
      info = await apiGet(`/torrents/info/${torrentId}`);
      if (info && info.status !== 'magnet_conversion') break;
    } catch (err) {
      if (err.message === 'Unauthenticated') return;
    }
    await new Promise(r => setTimeout(r, 1000));
    attempts++;
  }

  if (isCancelled) return;

  if (!info || info.status === 'error' || info.status === 'dead') {
    toast(i18n('errorGetFiles'), 'error');
    addIgnoreLock(torrentId);
    closeModal(true);
    fetchAll();
    return;
  }

  if (info.status !== 'waiting_files_selection') {
    addIgnoreLock(torrentId);
    closeModal(true);
    fetchAll();
    return;
  }

  if (!info.files || info.files.length === 0) {
    toast(i18n('noFilesFound'), 'error');
    addIgnoreLock(torrentId);
    closeModal(true);
    fetchAll();
    return;
  }

  const fileList = el('ul', {className: 'dl-files-list', style: 'max-height: 200px; overflow-y: auto; overflow-x: hidden; margin: 10px 0; background: var(--bg-hover, rgba(0,0,0,0.1)); border-radius: 6px; padding: 5px; list-style: none;'});
  const checkboxes = [];

  info.files.forEach(f => {
    const cb = el('input', {type: 'checkbox', checked: 'checked', value: String(f.id), style: 'margin-right: 10px; cursor: pointer; flex-shrink: 0;'});
    const li = el('li', {className: 'dl-file-item', style: 'display: flex; align-items: center; padding: 8px 5px; cursor: pointer; border-bottom: 1px solid var(--border-color, #333);'},
      cb,
      el('span', {className: 'dl-file-name', style: 'flex: 1; word-break: break-all; font-size: 13px;'}, f.path.replace(/^\//, '')),
      el('span', {className: 'dl-file-size', style: 'white-space: nowrap; margin-left: 10px; color: var(--text-muted, #888); font-size: 12px;'}, formatBytes(f.bytes))
    );
    li.addEventListener('click', (e) => {
      if (e.target !== cb) cb.checked = !cb.checked;
    });
    fileList.appendChild(li);
    checkboxes.push(cb);
  });

  if (fileList.lastChild) fileList.lastChild.style.borderBottom = 'none';

  const selectAllBtn = el('button', {className: 'action-btn ghost', style: 'margin-bottom: 10px; width: 100%; justify-content: center;'}, i18n('selectAll'));
  selectAllBtn.addEventListener('click', () => {
    const allChecked = checkboxes.every(c => c.checked);
    checkboxes.forEach(c => c.checked = !allChecked);
  });

  const cancelBtn = el('button', {className: 'form-submit', style: 'flex: 1; margin-right: 5px; background: #f46878 !important; color: #fff !important; border: none !important;'}, i18n('cancel'));
  const confirmBtn = el('button', {className: 'form-submit', style: 'flex: 1; margin-left: 5px;'}, i18n('startDownload'));

  cancelBtn.addEventListener('click', () => {
    confirmBtn.disabled = true;
    handleCancel(cancelBtn);
  });

  confirmBtn.addEventListener('click', async () => {
    const selected = checkboxes.filter(c => c.checked).map(c => c.value);
    if (selected.length === 0) return toast(i18n('selectAtLeastOne'), 'error');

    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = i18n('starting');
    try {
      await apiPost(`/torrents/selectFiles/${torrentId}`, { files: selected.join(',') });
      toast(i18n('filesSelected'), 'success');
      addIgnoreLock(torrentId);
      closeModal(true);
      fetchAll();
      browser.runtime.sendMessage('rd-check-now');
    } catch (err) {
      if (err.message === 'Unauthenticated') return;
      toast(i18n('failedStart'), 'error');
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      confirmBtn.textContent = i18n('startDownload');
    }
  });

  const btnRow = el('div', {style: 'display: flex; margin-top: 10px; justify-content: space-between;'}, cancelBtn, confirmBtn);

  const newBody = el('div', {},
    selectAllBtn,
    fileList,
    btnRow
  );
  
  const modalTitle = document.getElementById('modal-title');
  if (modalTitle) modalTitle.textContent = i18n('selectFiles');
  const mBody = document.getElementById('modal-body');
  if (mBody) mBody.replaceChildren(newBody);
}

function showWebLinkModal() {
  if (!hasValidToken) return showAuthModal(true);

  const infoIconSvg = makeSvg([['circle',{cx:'12',cy:'12',r:'10'}],['line',{x1:'12',y1:'16',x2:'12',y2:'12'}],['line',{x1:'12',y1:'8',x2:'12.01',y2:'8'}]]);
  const compareSvg = makeSvg([['path',{d:'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'}],['polyline',{points:'15 3 21 3 21 9'}],['line',{x1:'10',y1:'14',x2:'21',y2:'3'}]]);

  const body = el('div', {},
    el('div', {className: 'form-group'},
      el('div', {className: 'form-label-row'},
        el('div', {className: 'form-label-left'},
          el('label', {className: 'form-label'}, i18n('urlLabel')),
          el('span', {className: 'info-icon'}, infoIconSvg.cloneNode(true), el('span', {className: 'info-tooltip'}, i18n('urlTooltip')))
        ),
        el('div', {className: 'form-label-icons'},
          el('a', {href: 'https://real-debrid.com/compare', target: '_blank', className: 'hosters-link', title: i18n('supportedHosters')}, compareSvg.cloneNode(true), i18n('supportedHosters'))
        )
      ),
      el('textarea', {className: 'form-input', id: 'input-weblink', placeholder: 'https://1fichier.com/...\nhttps://rapidgator.net/...', rows: '5', spellcheck: 'false'})
    ),
    el('button', {className: 'form-submit', id: 'submit-weblink'}, i18n('unlock'), el('span', {className: 'btn-spinner'}))
  );

  openModalWithNode(i18n('unlockLink'), body);

  const urlInput = $('#input-weblink');
  const submitBtn = $('#submit-weblink');

  submitBtn.addEventListener('click', async () => {
    const urls = urlInput.value.split('\n').map(l => l.trim()).filter(l => l.startsWith('http://') || l.startsWith('https://'));
    if (urls.length === 0) return toast(i18n('insertValidUrl'), 'error');

    submitBtn.disabled = true;
    submitBtn.classList.add('loading');
    submitBtn.replaceChildren(i18n('unlocking'), el('span', {className: 'btn-spinner'}));

    try {
      const results = await Promise.allSettled(urls.map(url => apiPost('/unrestrict/link', { link: url })));
      const succeeded = [];
      let failed = 0;
      results.forEach(r => {
        if (r.status === 'fulfilled' && r.value) succeeded.push(r.value);
        else failed++;
      });

      if (succeeded.length > 0) await saveLocalDownloads(succeeded);

      if (failed === 0) {
        toast(urls.length > 1 ? `${succeeded.length} ${i18n('linksUnlocked')}` : i18n('linkUnlocked'), 'success');
        closeModal();
        fetchAll();
      } else if (succeeded.length === 0) {
        toast(i18n('allFailed'), 'error');
        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
        submitBtn.replaceChildren(i18n('unlock'), el('span', {className: 'btn-spinner'}));
      } else {
        toast(`${succeeded.length} ${i18n('linksUnlocked').replace('!', '')}, ${failed} ${i18n('someFailed')}`, 'error');
        closeModal();
        fetchAll();
      }
    } catch (err) {
      if (err.message === 'Unauthenticated') return;
      toast(i18n('failedUnlock'), 'error');
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
      submitBtn.replaceChildren(i18n('unlock'), el('span', {className: 'btn-spinner'}));
    }
  });

  setTimeout(() => urlInput.focus(), 100);
}

function toast(msg, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const tEl = document.createElement('div');
  tEl.className = `toast ${type}`;
  tEl.textContent = msg;
  document.body.appendChild(tEl);
  setTimeout(() => tEl.remove(), 2500);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatETA(seconds) {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m}m`;
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date)) return null;
  const diffDays = Math.floor(Math.abs(Date.now() - date.getTime()) / 86400000);
  if (diffDays === 0) return i18n('justNow');
  if (diffDays === 1) return `${i18n('agoDays')} 1d`;
  return `${i18n('agoDays')} ${diffDays}d`;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function makeSvg(paths, { viewBox = '0 0 24 24', width = '14', height = '14' } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [tag, attrs] of paths) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

function makeTrashSvg() {
  return makeSvg([
    ['polyline', { points: '3 6 5 6 21 6' }],
    ['path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }],
    ['path', { d: 'M10 11v6' }],
    ['path', { d: 'M14 11v6' }],
    ['path', { d: 'M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }],
  ]);
}

function makeDownloadSvg() {
  return makeSvg([
    ['path', { d: 'M12 3v10' }],
    ['polyline', { points: '8 9 12 14 16 9' }],
    ['path', { d: 'M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2' }],
  ]);
}

function fileBaseName(str) {
  if (!str) return str;
  const idx = str.lastIndexOf('/');
  return idx >= 0 ? str.slice(idx + 1) : str;
}

async function updateBellFromDownloads(downloads) {
  if (!cachedNotificationsEnabled) return;
  const { rd_tracked_ids } = await browser.storage.local.get('rd_tracked_ids');
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
  await browser.storage.local.set({ rd_tracked_ids: [...trackedIds] });
  const { rd_local_notifications } = await browser.storage.local.get('rd_local_notifications');
  const existing = rd_local_notifications || [];
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
  await browser.storage.local.set({ rd_local_notifications: merged });
  await loadLocalNotifications();
}

async function loadLocalNotifications() {
  if (!cachedNotificationsEnabled) {
    notifications = [];
    updateNotificationBadge();
    return;
  }
  const { rd_local_notifications } = await browser.storage.local.get('rd_local_notifications');
  notifications = (rd_local_notifications || []).filter(n => !n.read);
  updateNotificationBadge();
}

function showNotificationsModal() {
  const hasNotifications = notifications.length > 0;
  const bodyEl = document.createElement('div');

  if (hasNotifications) {
    const listEl = document.createElement('div');
    listEl.className = 'notifications-list';
    listEl.id = 'notifications-list';

    notifications.forEach(n => {
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
          if (notifications.length === 0) {
            const list = $('#notifications-list');
            if (list) list.replaceChildren(el('div', {className: 'notifications-empty'}, i18n('noNotifications')));
            $('#btn-mark-all-read')?.remove();
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
    const modalHeader = $('.modal-header');
    const markAllBtn = document.createElement('button');
    markAllBtn.className = 'notifications-mark-all';
    markAllBtn.id = 'btn-mark-all-read';
    markAllBtn.textContent = i18n('clearAll');
    modalHeader.insertBefore(markAllBtn, $('#modal-close'));

    markAllBtn.addEventListener('click', async () => {
      await clearAllNotifications();
      closeModal();
    });
  }
}

async function updateNotificationBadge() {
  const badge = $('#notification-badge');
  const count = notifications.length;
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
  const { rd_local_notifications } = await browser.storage.local.get('rd_local_notifications');
  const updated = (rd_local_notifications || []).map(n => n.id === id ? { ...n, read: true } : n);
  await browser.storage.local.set({ rd_local_notifications: updated });
  notifications = notifications.filter(n => n.id !== id);
  updateNotificationBadge();
}

async function clearAllNotifications() {
  const { rd_local_notifications } = await browser.storage.local.get('rd_local_notifications');
  const updated = (rd_local_notifications || []).map(n => ({ ...n, read: true }));
  await browser.storage.local.set({ rd_local_notifications: updated });
  notifications = [];
  updateNotificationBadge();
  toast(i18n('allCleared'), 'success');
}
