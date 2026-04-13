const API_BASE = 'https://api.real-debrid.com/rest/1.0';

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

let apiKey = '';
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

const dlElementMap = new Map();
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadCachedStorageValues();
  bindEvents();
  if (apiKey) {
    await loadCachedData();
    await loadLocalNotifications();
    refreshInBackground();
    fetchUserInfo();
  } else {
    showState('no-api');
  }
});

window.addEventListener('pagehide', () => stopAutoRefresh());

async function loadCachedStorageValues() {
  return browser.storage.local.get(['rd_notifications_enabled']).then((data) => {
    cachedNotificationsEnabled = data.rd_notifications_enabled !== false;
  });
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
  browser.storage.local.set({ rd_cached_downloads: downloads });
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

async function loadSettings() {
  return browser.storage.local.get(['rd_api_key', 'rd_theme', 'rd_hover_lift', 'rd_accent_color', 'rd_max_height', 'rd_use_jdownloader']).then((data) => {
    apiKey = data.rd_api_key || '';
    const theme = data.rd_theme || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    const hoverLift = data.rd_hover_lift !== false ? 'on' : 'off';
    document.documentElement.setAttribute('data-hover-lift', hoverLift);
    useJDownloader = data.rd_use_jdownloader === true;
    if (data.rd_accent_color) applyAccentColor(data.rd_accent_color);
    applyMaxHeight(data.rd_max_height || 400);
  });
}

function applyMaxHeight(px) {
  document.body.style.maxHeight = px + 'px';
}

function saveApiKey(key) {
  apiKey = key;
  browser.storage.local.set({ rd_api_key: key });
}

function saveTheme(theme) {
  browser.storage.local.set({ rd_theme: theme });
}

async function trackId(id) {
  const { rd_tracked_ids } = await browser.storage.local.get('rd_tracked_ids');
  const tracked = new Set(rd_tracked_ids || []);
  tracked.add(String(id));
  await browser.storage.local.set({ rd_tracked_ids: [...tracked] });
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function darkenHex(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const clamp = v => Math.max(0, Math.min(255, Math.round(v * (1 - amount))));
  return `#${[clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function lightenHex(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const clamp = v => Math.max(0, Math.min(255, Math.round(v + (255 - v) * amount)));
  return `#${[clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function applyAccentColor(hex) {
  if (!hex) return;
  const [r, g, b] = hexToRgb(hex);
  const lum = luminance(r, g, b);
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  const hover = isDark ? lightenHex(hex, 0.15) : darkenHex(hex, 0.15);
  const dimAlpha = isDark ? 0.13 : 0.12;
  const textColor = lum > 0.4 ? '#101114' : '#ffffff';

  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-hover', hover);
  root.style.setProperty('--accent-dim', `rgba(${r}, ${g}, ${b}, ${dimAlpha})`);
  root.style.setProperty('--accent-scroll', `rgba(${r}, ${g}, ${b}, 0.45)`);
  root.style.setProperty('--accent-scroll-hover', `rgba(${r}, ${g}, ${b}, 0.60)`);
  root.style.setProperty('--accent-text', textColor);
  root.style.setProperty('--border-focus', hex);
}

function clearAccentColor() {
  const root = document.documentElement;
  ['--accent', '--accent-hover', '--accent-dim', '--accent-scroll', '--accent-scroll-hover', '--accent-text', '--border-focus'].forEach(p => root.style.removeProperty(p));
}

let deleteAllHoldTimer = null;

function bindEvents() {
  $('#btn-theme').addEventListener('click', () => {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    saveTheme(next);
    browser.storage.local.get('rd_accent_color').then((data) => {
      if (data.rd_accent_color) applyAccentColor(data.rd_accent_color);
    });
  });

  $('.logo-icon').addEventListener('click', () => {
    browser.tabs.create({ url: 'https://real-debrid.com/torrents', active: true });
  });

  $('#btn-settings').addEventListener('click', showApiKeyModal);
  $('#btn-setup-api').addEventListener('click', showApiKeyModal);
  $('#btn-notifications').addEventListener('click', showNotificationsModal);
  $('#btn-add-torrent').addEventListener('click', showTorrentModal);
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
      cycleBtn.textContent = 'Tipo';
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
    if (!apiKey || allDownloads.length === 0) return;
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

  $('#modal-close').addEventListener('click', closeModal);
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
      name: f.path ? f.path.replace(/^\//, '') : `Arquivo ${idx + 1}`,
      short_name: f.path ? f.path.split('/').pop() : `Arquivo ${idx + 1}`,
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
    console.error('Falha ao buscar torrent files:', err);
  }
}

async function preloadTorrentFiles() {
  const visibleIds = new Set(currentFiltered.slice(0, visibleCount).map(d => String(d.id)));
  const needsInfo = allDownloads.filter(dl => visibleIds.has(String(dl.id)) && dl._type === 'torrent' && isCompleted(dl) && ((dl.files || []).length === 0 || (dl.links || []).length === 0));
  
  if (needsInfo.length === 0) return;
  let changed = false;

  for (const dl of needsInfo) {
    try {
      const info = await apiGet(`/torrents/info/${dl.id}`);
      if (info) {
        const parsed = parseTorrentInfo(info);
        dl.links = parsed.links;
        dl.files = parsed.files;
        changed = true;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    } catch (err) {
      if (err.message && err.message.includes('429')) break;
    }
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
      toast('Excluindo...', 'success');
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
    toast('Removido', 'success');
  } catch (err) {
    toast('Falha ao excluir', 'error');
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

  toast('Excluindo...', 'success');

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
      toast('Iniciando download...', 'success');
      let links = dl?.links || [];
      if (links.length === 0) {
        const info = await apiGet(`/torrents/info/${id}`);
        links = info?.links || [];
      }

      if (links.length > 0) {
        const unrestricted = await apiPost('/unrestrict/link', { link: links[0] }, false, TIMEOUT_DOWNLOAD_MS);
        if (unrestricted?.download) triggerDownload(unrestricted.download, dl.name);
        else toast('Falha ao obter link de download', 'error');
      } else {
        toast('Nenhum link de download disponível', 'error');
      }
      return;
    }

    toast('Tipo de download desconhecido', 'error');
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'O pedido de download expirou' : 'Falha ao baixar';
    toast(msg, 'error');
  }
}

async function triggerDownload(url, filename = '') {
  if (!String(url).startsWith('https://') && !String(url).startsWith('http://')) {
    toast('Link de download inválido', 'error');
    return;
  }

  if (useJDownloader) {
    try {
      toast('Enviando para o JDownloader...', 'success');
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
        toast('Adicionado ao JDownloader!', 'success');
      } else {
        throw new Error('JD2 Error');
      }
    } catch (err) {
      toast('JDownloader não responde (porta 9666)', 'error');
    }
    return;
  }

  toast('Iniciando download...', 'success');
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const TIMEOUT_DEFAULT_MS  = 10_000;
const TIMEOUT_VALIDATE_MS = 10_000;
const TIMEOUT_DOWNLOAD_MS = 10_000;

function fetchWithTimeout(url, options = {}, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function apiGet(path, timeoutMs = TIMEOUT_DEFAULT_MS) {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } }, timeoutMs);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`API error (${res.status})`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function apiPost(path, body, isForm = false, timeoutMs = null) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  let fetchBody;

  if (isForm) fetchBody = body;
  else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    fetchBody = new URLSearchParams(body).toString();
  }

  const fetchFn = timeoutMs
    ? fetchWithTimeout(`${API_BASE}${path}`, { method: 'POST', headers, body: fetchBody }, timeoutMs)
    : fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: fetchBody });

  const res = await fetchFn;
  if (!res.ok) throw new Error(`API error (${res.status})`);
  if (res.status === 204) return null;
  return res.json();
}

async function apiDelete(path, timeoutMs = TIMEOUT_DEFAULT_MS) {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` } }, timeoutMs);
  if (!res.ok && res.status !== 204) throw new Error(`API error (${res.status})`);
  return null;
}

async function fetchAll(isBackgroundSync = false) {
  if (!apiKey) return showState('no-api');
  if (allDownloads.length === 0) showState('loading');

  try {
    let torrentsRes = [];
    try {
      let page = 1;
      const limit = 100;
      let hasMore = true;
      while (hasMore) {
        const res = await apiGet(`/torrents?limit=${limit}&page=${page}`);
        if (Array.isArray(res) && res.length > 0) {
          torrentsRes.push(...res);
          if (res.length < limit || isBackgroundSync) hasMore = false;
          else page++;
        } else {
          hasMore = false; 
        }
      }
    } catch (err) {
      console.warn('Falha ao buscar torrents:', err);
    }

    if (isBackgroundSync && allDownloads.length > 0) {
      const freshData = new Map();
      torrentsRes.forEach(t => freshData.set(String(t.id), normalizeTorrent(t)));

      allDownloads = allDownloads.map(dl => {
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

    cacheData(allDownloads);

    if (!isBackgroundSync) visibleCount = 50;
    
    renderDownloads();
    preloadTorrentFiles();
    await updateBellFromDownloads(allDownloads);

    if (allDownloads.some(d => !isCompleted(d))) startAutoRefresh();
    else stopAutoRefresh();

  } catch (err) {
    if (allDownloads.length === 0) showState('empty');
    toast('Falha ao buscar downloads', 'error');
  }
}

function normalizeTorrent(t) {
  return {
    id: t.id,
    name: t.filename || 'Torrent sem nome',
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
        name: d.filename || 'Download sem nome',
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
    'magnet_conversion': 'processing',
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
  if (!apiKey) return;
  try {
    const res = await apiGet('/user');
    if (res) {
      showUserBar(res);
      browser.storage.local.set({ rd_cached_user: res });
    }
  } catch (err) {
    console.error('Falha ao buscar informações do usuário');
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
  if (!expiresAt) return '— dias restantes';
  const [y, m, d] = expiresAt.slice(0, 10).split('-').map(Number);
  const now = new Date();
  const diffDays = Math.round(
    (Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000
  );
  return `${diffDays} dia${diffDays === 1 ? '' : 's'} restante${diffDays === 1 ? '' : 's'}`;
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
    const labels = { 1: '> 1 dia', 7: '> 1 semana', 30: '> 1 mês' };
    label.textContent = labels[ageFilterDays];
    btn.classList.add('active');
    clearOpt.classList.remove('hidden');
  } else {
    label.textContent = 'Mais antigo que...';
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
      searchCountEl.textContent = `${currentFiltered.length} resultados`;
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

  $('#
