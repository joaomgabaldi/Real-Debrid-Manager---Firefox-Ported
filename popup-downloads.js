import { state, globals, DOM } from './popup-state.js';
import { apiGet, apiPost, apiDelete, trackId, getValidToken } from './api.js';
import { rdStorage } from './storage.js';
import { i18n, formatBytes, toast, el, makeSvg, formatTimeAgo } from './utils.js';
import { openModalWithNode, closeModal } from './popup-modals.js';
import { updateBellFromDownloads } from './popup-notifications.js';

export function addIgnoreLock(id) {
  state.ignoreAutoLockIds.add(String(id));
  browser.storage.local.set({ rd_ignore_locks: Array.from(state.ignoreAutoLockIds) });
}

export function cacheData(downloads) {
  const thirtyDaysAgo = Date.now() - (30 * 86400000);
  let cleaned = downloads.filter(d => {
    if (d._type === 'web') return false;
    if (isCompleted(d) && d.created_at) {
      return new Date(d.created_at).getTime() > thirtyDaysAgo;
    }
    return true;
  });

  cleaned.sort((a, b) => {
    const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
    const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
    return dateB - dateA;
  });

  if (cleaned.length > 1000) {
    cleaned = cleaned.slice(0, 1000);
  }

  const storageOptimized = cleaned.map(dl => {
    const copy = { ...dl };
    if (copy.links && copy.links.length > 2) {
      copy.links = copy.links.slice(0, 2);
    }
    if (copy.files && copy.files.length > 50) {
      copy.files = copy.files.slice(0, 50);
    }
    return copy;
  });

  rdStorage.saveCachedDownloads(storageOptimized);
}

export function refreshInBackground() {
  const btn = DOM.$('#btn-refresh');
  if (btn.classList.contains('syncing')) return Promise.resolve();
  
  btn.classList.add('syncing');
  return fetchAll(true).finally(() => {
    btn.classList.remove('syncing');
    btn.classList.add('synced');
    setTimeout(() => btn.classList.remove('synced'), 1500);
  });
}

const BASE_REFRESH_MS = 5000;
const MAX_REFRESH_MS = 60000;

export function startAutoRefresh() {
  if (globals.autoRefreshTimer) return;
  scheduleNextRefresh();
}

export function stopAutoRefresh() {
  if (globals.autoRefreshTimer) {
    clearTimeout(globals.autoRefreshTimer);
    globals.autoRefreshTimer = null;
  }
  globals.refreshDecayCount = 0;
}

function scheduleNextRefresh() {
  let delay = Math.min(MAX_REFRESH_MS, BASE_REFRESH_MS * Math.pow(1.5, globals.refreshDecayCount));
  if (state.allDownloads.some(d => d.download_state === 'processing' || d.download_state === 'waiting_selection')) {
    if (globals.refreshDecayCount < 20) {
      delay = Math.min(delay, 5000);
    }
  }

  globals.autoRefreshTimer = setTimeout(async () => {
    if (!state.allDownloads.some(d => !isCompleted(d))) {
      stopAutoRefresh();
      return;
    }

    const btn = DOM.$('#btn-refresh');
    if (btn && btn.classList.contains('syncing')) {
      scheduleNextRefresh();
      return;
    }

    const oldHash = state.allDownloads.map(d => `${d.progress}_${d.download_state}`).join(',');
    await fetchAll(true);
    const newHash = state.allDownloads.map(d => `${d.progress}_${d.download_state}`).join(',');

    if (oldHash === newHash) globals.refreshDecayCount++;
    else globals.refreshDecayCount = 0;

    if (state.allDownloads.some(d => !isCompleted(d))) scheduleNextRefresh();
    else stopAutoRefresh();
  }, delay);
}

export function enforceSelectionLock() {
  const pending = state.allDownloads.find(d => d.download_state === 'waiting_selection' && !state.ignoreAutoLockIds.has(String(d.id)));
  if (pending && !state.currentlyLockedTorrentId) {
    openFileSelectionModal(pending.id);
  }
}

export async function fetchAll(isBackgroundSync = false) {
  if (state.isFetchingAll) {
    state.pendingFetch = true;
    return;
  }
  state.isFetchingAll = true;
  
  const token = await getValidToken();
  if (!token) {
    state.isFetchingAll = false;
    return showState('no-api');
  }
  if (state.allDownloads.length === 0) showState('loading');

  try {
    let torrentsRes = [];
    let page = 1;
    const limit = 100;
    let hasMore = true;
    let latestCachedDate = 0;
    const MAX_PAGES = 10;
    
    if (isBackgroundSync && state.allDownloads.length > 0) {
      latestCachedDate = new Date(state.allDownloads[0].created_at || 0).getTime();
    }

    while (hasMore && page <= MAX_PAGES) {
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

    if (isBackgroundSync && state.allDownloads.length > 0) {
      const freshData = new Map();
      torrentsRes.forEach(t => freshData.set(String(t.id), normalizeTorrent(t)));

      state.allDownloads = state.allDownloads.map(dl => {
        if (state.currentlyLockedTorrentId === String(dl.id)) return dl;
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
      state.allDownloads = [...newItems, ...state.allDownloads];
    } else {
      state.allDownloads = [];
      if (Array.isArray(torrentsRes)) {
        torrentsRes.forEach((t) => state.allDownloads.push(normalizeTorrent(t)));
      }
    }

    const { rd_local_downloads, rd_cached_downloads } = await rdStorage.get(['rd_local_downloads', 'rd_cached_downloads']);
    
    if (rd_local_downloads && rd_local_downloads.length > 0) {
      const expiryCutoff = Date.now() - 7 * 86400000;
      const valid = rd_local_downloads.filter(d => new Date(d.created_at).getTime() > expiryCutoff);
      
      if (valid.length !== rd_local_downloads.length) {
        browser.storage.local.set({ rd_local_downloads: valid });
      }

      state.allDownloads = state.allDownloads.filter(d => d._type !== 'web');
      
      valid.forEach(d => {
        state.allDownloads.push({ ...d, _type: 'web' });
      });
    }
    
    state.allDownloads.sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateB - dateA;
    });

    if (rd_cached_downloads) {
      const cachedById = new Map();
      rd_cached_downloads.forEach(d => { if (d.files && d.files.length > 0) cachedById.set(String(d.id), d); });
      state.allDownloads.forEach(dl => {
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
    const currentIds = new Set(state.allDownloads.map(d => String(d.id)));
    for (const id of state.ignoreAutoLockIds) {
      if (!currentIds.has(id)) {
        state.ignoreAutoLockIds.delete(id);
        changedLocks = true;
      }
    }
    if (changedLocks) {
      browser.storage.local.set({ rd_ignore_locks: Array.from(state.ignoreAutoLockIds) });
    }

    cacheData(state.allDownloads);

    if (!isBackgroundSync) state.visibleCount = 50;
    
    renderDownloads();
    preloadTorrentFiles();
    await updateBellFromDownloads(state.allDownloads);

    enforceSelectionLock();

    if (state.allDownloads.some(d => !isCompleted(d))) startAutoRefresh();
    else stopAutoRefresh();

  } catch (err) {
    if (err.message === 'Unauthenticated') return;
    if (state.allDownloads.length === 0) showState('empty');
    if (state.hasValidToken) toast(i18n('fetchingDownloadsFailed'), 'error');
  } finally {
    state.isFetchingAll = false;
    if (state.pendingFetch) {
      state.pendingFetch = false;
      fetchAll(isBackgroundSync);
    }
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
  let s = ts.trim().replace(' ', 'T');
  let cleanStr = s.replace('Z', '');
  if (cleanStr.match(/[+-]\d{2}:?\d{2}$/)) {
    let d = new Date(cleanStr);
    if (!isNaN(d)) return d.toISOString();
    return null;
  }
  let tempDate = new Date(cleanStr + 'Z');
  if (isNaN(tempDate)) return null;
  const year = tempDate.getUTCFullYear();
  const march = new Date(Date.UTC(year, 2, 31));
  const dstStart = new Date(Date.UTC(year, 2, 31 - march.getUTCDay(), 1));
  const october = new Date(Date.UTC(year, 9, 31));
  const dstEnd = new Date(Date.UTC(year, 9, 31 - october.getUTCDay(), 1));
  const isDST = tempDate >= dstStart && tempDate < dstEnd;
  const offset = isDST ? '+02:00' : '+01:00';
  let finalDate = new Date(cleanStr + offset);
  if (!isNaN(finalDate)) return finalDate.toISOString();
  return null;
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

export async function fetchUserInfo() {
  try {
    const res = await apiGet('/user');
    if (res) {
      showUserBar(res);
      browser.storage.local.set({ rd_cached_user: res });
    }
  } catch (err) {
    if (err.message === 'Unauthenticated') return;
    console.debug('RD Manager: Falha ao buscar dados do usuário.', err);
  }
}

export function showState(stateType) {
  DOM.$('#loading').classList.toggle('hidden', stateType !== 'loading');
  DOM.$('#empty').classList.toggle('hidden', stateType !== 'empty');
  DOM.$('#no-api').classList.toggle('hidden', stateType !== 'no-api');
  DOM.$('#download-list').replaceChildren();
  globals.dlElementMap.clear();
}

export function showUserBar(data) {
  const planType = (data.type || 'free').charAt(0).toUpperCase() + (data.type || 'free').slice(1);
  const daysRemaining = calculateDaysRemaining(data.expiration);

  const tile = DOM.$('#header-plan-tile');
  if (tile) {
    DOM.$('#header-plan-name').textContent = planType;
    DOM.$('#header-plan-expiry').textContent = daysRemaining;
    tile.style.display = 'flex';
  }
}

function calculateDaysRemaining(expiresAt) {
  if (!expiresAt) return i18n('noDaysRemaining');
  const [y, m, d] = expiresAt.slice(0, 10).split('-').map(Number);
  const now = new Date();
  const diffDays = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  return `${diffDays} ${diffDays === 1 ? i18n('dayRemaining') : i18n('daysRemaining')}`;
}

export function filterByAge(downloads, days) {
  if (!days) return downloads;
  const cutoff = Date.now() - days * 86400000;
  return downloads.filter(d => new Date(d.created_at || 0).getTime() < cutoff);
}

export function updateAgeFilterUI() {
  const btn = DOM.$('#btn-age-filter');
  const label = DOM.$('#age-filter-label');
  const clearOpt = DOM.$('.age-filter-clear');

  DOM.$$('.age-filter-option:not(.age-filter-clear)').forEach(opt => {
    opt.classList.toggle('selected', state.ageFilterDays === parseInt(opt.dataset.age));
  });

  if (state.ageFilterDays) {
    const labels = { 1: `> 1 ${i18n('moreThan1Day').replace('Mais de 1 ', '')}`, 7: `> 1 ${i18n('moreThan1Week').replace('Mais de 1 ', '')}`, 30: `> 1 ${i18n('moreThan1Month').replace('Mais de 1 ', '')}` };
    label.textContent = labels[state.ageFilterDays] || i18n('olderThan');
    btn.classList.add('active');
    clearOpt.classList.remove('hidden');
  } else {
    label.textContent = i18n('olderThan');
    btn.classList.remove('active');
    clearOpt.classList.add('hidden');
  }
}

export function renderDownloads() {
  const list = DOM.$('#download-list');
  const activeTab = DOM.$('[data-tab="downloading"]');
  activeTab.classList.toggle('has-active-downloads', state.allDownloads.some(d => !isCompleted(d)));

  state.currentFiltered = state.allDownloads;

  switch (state.currentTab) {
    case 'downloading': state.currentFiltered = state.currentFiltered.filter(d => !isCompleted(d)); break;
    case 'completed': state.currentFiltered = state.currentFiltered.filter(d => isCompleted(d)); break;
  }

  if (state.searchQuery) {
    state.currentFiltered = state.currentFiltered.filter(d => (d.name || '').toLowerCase().includes(state.searchQuery));
  }
  state.currentFiltered = filterByAge(state.currentFiltered, state.ageFilterDays);
  updateAgeFilterUI();

  if (state.currentTypeFilter) state.currentFiltered = state.currentFiltered.filter(d => d._type === state.currentTypeFilter);

  const searchCountEl = DOM.$('#search-count');
  if (searchCountEl) {
    if (state.searchQuery || state.ageFilterDays) {
      searchCountEl.textContent = `${state.currentFiltered.length} ${i18n('resultsLabel')}`;
      searchCountEl.classList.remove('hidden');
    } else {
      searchCountEl.textContent = '';
      searchCountEl.classList.add('hidden');
    }
  }

  if (state.currentFiltered.length === 0) {
    showState('empty');
    return;
  }

  DOM.$('#loading').classList.add('hidden');
  DOM.$('#empty').classList.add('hidden');
  DOM.$('#no-api').classList.add('hidden');

  const toRender = state.currentFiltered.slice(0, state.visibleCount);
  const filteredIds = new Set(toRender.map(d => String(d.id)));

  for (const [id, elem] of globals.dlElementMap) {
    if (!filteredIds.has(id)) {
      elem.remove();
      globals.dlElementMap.delete(id);
    }
  }

  toRender.forEach((dl, index) => {
    const id = String(dl.id);
    let li = globals.dlElementMap.get(id);

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
          dlBtn.setAttribute('aria-label', i18n('download'));
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
          selectBtn.setAttribute('aria-label', i18n('selectFiles'));
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
      globals.dlElementMap.set(id, li);
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
  statusSpan.appendChild(document.createTextNode((status.charAt(0).toUpperCase() + status.slice(1))));
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
    const eta = (dl.eta && dl.eta < 864000) ? `${formatETA(dl.eta)} ${i18n('timeRemaining')}` : (dl.eta ? i18n('noPrediction') : '');
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

export function renderExpandedContent(dl) {
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

export function renderItem(dl) {
  const name = dl.name || i18n('unnamedDownload');
  const type = dl._type;
  const completed = isCompleted(dl);

  const header = document.createElement('div');
  header.className = 'dl-item-header';
  header.title = name;

  const cbWrap = document.createElement('div');
  cbWrap.className = 'dl-select-cb-wrap';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'dl-select-cb';
  cb.value = String(dl.id);
  cbWrap.appendChild(cb);
  header.appendChild(cbWrap);

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
    dlBtn.setAttribute('aria-label', i18n('download'));
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
    selectBtn.setAttribute('aria-label', i18n('selectFiles'));
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
  deleteBtn.setAttribute('aria-label', i18n('delete'));
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

export function isCompleted(dl) {
  const s = (dl.download_state || '').toLowerCase();
  if (s === 'processing' || s === 'waiting_selection' || s.includes('queue')) return false;
  return s === 'completed' || (dl.progress != null && dl.progress >= 1);
}

export function canDownload(dl) {
  if (dl._type === 'web' && dl._rd_download) return true;
  if (dl._type === 'torrent' && (dl.links || []).length > 0) return true;
  return false;
}

export function getStatus(dl) {
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

export function getStatusClass(dl) {
  const s = dl.download_state || '';
  if (s === 'completed' || s === 'downloaded') return 'completed';
  if (['downloading', 'uploading', 'compressing', 'processing'].includes(s)) return 'downloading';
  if (['queued', 'waiting_files_selection', 'magnet_conversion'].includes(s)) return 'queued';
  if (['error', 'dead', 'virus', 'magnet_error'].includes(s)) return 'error';
  return 'unknown';
}

function formatETA(seconds) {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m}m`;
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

export function parseTorrentInfo(info) {
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

export async function fetchTorrentFiles(dl, itemEl) {
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
    cacheData(state.allDownloads);
  } catch (err) {
    if (err.message === 'Unauthenticated') return;
    console.debug('RD Manager: Falha ao buscar torrent files:', err);
  }
}

export async function preloadTorrentFiles() {
  const visibleIds = new Set(state.currentFiltered.slice(0, state.visibleCount).map(d => String(d.id)));
  const needsInfo = state.allDownloads.filter(dl => visibleIds.has(String(dl.id)) && dl._type === 'torrent' && isCompleted(dl) && ((dl.files || []).length === 0 || (dl.links || []).length === 0));
  
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
      } catch (err) {
        console.debug(`RD Manager: Preload torrent file infos falhou no ID ${dl.id}.`, err);
      }
    }));
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (changed) {
    cacheData(state.allDownloads);
    renderDownloads();
  }
}

export async function deleteDownload(type, id) {
  const itemElement = globals.dlElementMap.get(String(id)) || document.querySelector(`.dl-delete-btn[data-id="${id}"]`)?.closest('.dl-item');
  if (itemElement) {
    itemElement.style.opacity = '0.5';
    itemElement.style.pointerEvents = 'none';
  }

  try {
    if (type === 'torrent') {
      toast(i18n('deleting') || 'Excluindo', 'success');
      await apiDelete(`/torrents/delete/${id}`);
    } else if (type === 'web') {
      const rd_local_downloads = await rdStorage.getLocalDownloads();
      if (rd_local_downloads) {
        const updated = rd_local_downloads.filter(d => String(d.id) !== String(id));
        await rdStorage.saveLocalDownloads(updated);
      }
    }

    if (itemElement) {
      itemElement.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
      itemElement.style.opacity = '0';
      itemElement.style.transform = 'translateX(-10px)';
      setTimeout(() => itemElement.remove(), 150);
    }
    globals.dlElementMap.delete(String(id));
    
    state.allDownloads = state.allDownloads.filter(dl => String(dl.id) !== String(id));
    cacheData(state.allDownloads);

    if (state.allDownloads.length === 0) showState('empty');
    toast(i18n('removed') || 'Removido', 'success');
  } catch (err) {
    if (err.message === 'Unauthenticated') return;
    toast(i18n('deleteFailed') || 'Falha ao remover', 'error');
    if (itemElement) {
      itemElement.style.opacity = '1';
      itemElement.style.pointerEvents = 'auto';
    }
  }
}

export async function deleteSelected() {
  const selectedCbs = document.querySelectorAll('.dl-select-cb:checked');
  if (selectedCbs.length === 0) return;
  const idsToDelete = new Set(Array.from(selectedCbs).map(cb => cb.value));
  const targets = state.allDownloads.filter(d => idsToDelete.has(String(d.id)));

  document.querySelectorAll('.dl-item').forEach(e => {
    if (idsToDelete.has(e.dataset.id)) {
      e.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
      e.style.opacity = '0';
      e.style.transform = 'translateX(-10px)';
    }
  });

  setTimeout(async () => {
    state.allDownloads = state.allDownloads.filter(d => !idsToDelete.has(String(d.id)));
    cacheData(state.allDownloads);
    renderDownloads();
    document.dispatchEvent(new CustomEvent('exit-selection-mode'));
  }, 150);

  toast(`${idsToDelete.size} ${i18n('itemsDeleted')}`, 'success');

  const webTargets = targets.filter(dl => dl._type === 'web');
  const torrentTargets = targets.filter(dl => dl._type === 'torrent');

  if (webTargets.length > 0) {
    const webIds = new Set(webTargets.map(d => String(d.id)));
    const rd_local_downloads = await rdStorage.getLocalDownloads();
    if (rd_local_downloads) {
      const updated = rd_local_downloads.filter(d => !webIds.has(String(d.id)));
      await rdStorage.saveLocalDownloads(updated);
    }
  }

  if (torrentTargets.length > 0) {
    browser.runtime.sendMessage({
      action: 'delete-torrents',
      ids: torrentTargets.map(dl => dl.id),
    });
  }
}

export async function downloadFile(type, id) {
  try {
    const dl = state.allDownloads.find(d => String(d.id) === String(id));

    if (type === 'web' && dl?._rd_download) {
      triggerDownload(dl._rd_download, dl.name);
      return;
    }

    if (type === 'torrent') {
      let links = dl?.links || [];
      if (links.length === 0) {
        const info = await apiGet(`/torrents/info/${id}`);
        links = info?.links || [];
      }

      if (links.length > 1) {
        toast(i18n('multipleLinksExpand'), 'info');
        const itemElement = globals.dlElementMap.get(String(id));
        if (itemElement && !itemElement.classList.contains('expanded')) {
          itemElement.classList.add('expanded');
          if ((dl.files || []).length === 0 || (dl.links || []).length === 0) {
            fetchTorrentFiles(dl, itemElement);
          }
        }
        return;
      }

      if (links.length > 0) {
        toast(i18n('startingDownload'), 'success');
        const unrestricted = await apiPost('/unrestrict/link', { link: links[0] });
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

export async function triggerDownload(url, filename = '') {
  if (!String(url).startsWith('https://') && !String(url).startsWith('http://')) {
    toast(i18n('invalidDlLink'), 'error');
    return;
  }

  if (state.useJDownloader) {
    try {
      toast(i18n('sendingToJd'), 'success');
      const formData = new URLSearchParams();
      formData.append('urls', url);
      formData.append('autostart', '1');
      if (filename) formData.append('package', filename);

      const res = await fetch(`http://127.0.0.1:${state.jdPort}/flashgot`, {
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
      const body = el('div', {style: 'text-align: center; padding: 10px;'},
        el('div', {style: 'margin-bottom: 20px; font-size: 14px;'}, i18n('jdFailedAskBrowser')),
        el('div', {style: 'display: flex; gap: 10px; justify-content: center;'},
          el('button', {id: 'btn-jd-no', className: 'form-submit', style: 'flex: 1; background: #f46878 !important; color: #fff !important; border: none !important;'}, i18n('no')),
          el('button', {id: 'btn-jd-yes', className: 'form-submit', style: 'flex: 1;'}, i18n('yes'))
        )
      );

      openModalWithNode(i18n('jdUnresponsive'), body);

      document.getElementById('btn-jd-no').addEventListener('click', () => closeModal());
      document.getElementById('btn-jd-yes').addEventListener('click', () => {
        closeModal();
        executeBrowserDownload(url);
      });
    }
    return;
  }

  executeBrowserDownload(url);
}

function executeBrowserDownload(url) {
  toast(i18n('startingDownload'), 'success');
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function openFileSelectionModal(torrentId) {
  state.currentlyLockedTorrentId = String(torrentId);
  let isCancelled = false;

  const handleCancel = async (btn) => {
    isCancelled = true;
    if (btn) btn.disabled = true;
    try {
      await apiDelete(`/torrents/delete/${torrentId}`);
      toast(i18n('torrentCanceled'), 'success');

      state.allDownloads = state.allDownloads.filter(dl => String(dl.id) !== String(torrentId));
      cacheData(state.allDownloads);
      
      const itemElement = globals.dlElementMap.get(String(torrentId));
      if (itemElement) {
        itemElement.remove();
      }
      globals.dlElementMap.delete(String(torrentId));
      renderDownloads();
    } catch (err) {
      if (err.message === 'Unauthenticated') return;
      toast(i18n('errorRemove'), 'error');
    }
    addIgnoreLock(torrentId);
    closeModal(true);
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
    if (isCancelled || DOM.$('#modal-overlay').classList.contains('hidden')) {
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

  const newBody = el('div', {}, selectAllBtn, fileList, btnRow);
  
  const modalTitle = document.getElementById('modal-title');
  if (modalTitle) modalTitle.textContent = i18n('selectFiles');
  const mBody = document.getElementById('modal-body');
  if (mBody) mBody.replaceChildren(newBody);
}

let storageQueue = Promise.resolve();

export function saveLocalDownloadsArray(unrestrictResults) {
  return new Promise((resolve) => {
    storageQueue = storageQueue.then(async () => {
      const existing = await rdStorage.getLocalDownloads();
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
      await rdStorage.saveLocalDownloads(merged);
      for (const e of newEntries) await trackId(String(e.id));
      resolve();
    }).catch(console.error);
  });
}

export function showWebLinkModal() {
  if (!state.hasValidToken) return import('./popup-auth.js').then(m => m.showAuthModal(true));

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

  const urlInput = DOM.$('#input-weblink');
  const submitBtn = DOM.$('#submit-weblink');

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

      if (succeeded.length > 0) await saveLocalDownloadsArray(succeeded);

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
}
