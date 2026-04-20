import { state, globals, DOM } from './popup-state.js';
import { getValidToken, onAuthFailure } from './api.js';
import { rdStorage } from './storage.js';
import { i18n, localizeHtmlPage } from './utils.js';
import { showAuthModal, forceLogout, pollDeviceCredentials } from './popup-auth.js';
import { loadLocalNotifications, showNotificationsModal } from './popup-notifications.js';
import { fetchAll, fetchUserInfo, renderDownloads, refreshInBackground, enforceSelectionLock, stopAutoRefresh, showState, deleteSelected, showWebLinkModal, downloadFile, playFile, deleteDownload, fetchTorrentFiles, openFileSelectionModal, isCompleted, showUserBar, updateAgeFilterUI } from './popup-downloads.js';
import { closeModal } from './popup-modals.js';

document.addEventListener('DOMContentLoaded', async () => {
  localizeHtmlPage();
  await bootExtension();
  bindEvents();
  
  onAuthFailure(() => forceLogout());
  
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'force_logout') {
      forceLogout();
    }
  });
});

window.addEventListener('pagehide', () => stopAutoRefresh());

export function toggleSelectionMode(force) {
    state.selectionMode = force !== undefined ? force : !state.selectionMode;
    document.body.classList.toggle('selection-mode', state.selectionMode);

    const delSpan = DOM.$('#delete-btn-text');
    if (state.selectionMode) {
        if(delSpan) {
            delSpan.removeAttribute('data-i18n');
            delSpan.textContent = i18n('holdToDelete');
        }
        DOM.$('#btn-delete-all').classList.add('active-mode');
        DOM.$$('.tab[data-tab]').forEach(t => t.classList.add('hidden'));
        DOM.$('#btn-select-all').classList.remove('hidden');
        DOM.$('#btn-cancel-select').classList.remove('hidden');
    } else {
        if(delSpan) {
            delSpan.textContent = i18n('delete') || 'Excluir';
        }
        DOM.$('#btn-delete-all').classList.remove('active-mode');
        DOM.$$('.tab[data-tab]').forEach(t => t.classList.remove('hidden'));
        DOM.$('#btn-select-all').classList.add('hidden');
        DOM.$('#btn-cancel-select').classList.add('hidden');
        DOM.$$('.dl-select-cb').forEach(cb => cb.checked = false);
    }
}

document.addEventListener('exit-selection-mode', () => toggleSelectionMode(false));

async function bootExtension() {
  const data = await rdStorage.get([
    'rd_theme', 'rd_hover_lift', 'rd_use_jdownloader', 'rd_jd_port', 
    'rd_notifications_enabled', 'rd_ignore_locks', 'rd_cached_downloads', 
    'rd_cached_user', 'rd_oauth_pending', 'rd_use_vlc'
  ]);

  const theme = data.rd_theme || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  const hoverLift = data.rd_hover_lift !== false ? 'on' : 'off';
  document.documentElement.setAttribute('data-hover-lift', hoverLift);
  state.useJDownloader = data.rd_use_jdownloader === true;
  state.jdPort = data.rd_jd_port || '9666';
  state.useVlc = data.rd_use_vlc === true;
  
  state.cachedNotificationsEnabled = data.rd_notifications_enabled !== false;
  state.selectionMode = false;
  
  if (data.rd_ignore_locks && Array.isArray(data.rd_ignore_locks)) {
    state.ignoreAutoLockIds = new Set(data.rd_ignore_locks);
  }

  const token = await getValidToken();
  if (token) {
    state.hasValidToken = true;
    
    if (data.rd_cached_downloads && data.rd_cached_downloads.length > 0) {
      state.allDownloads = data.rd_cached_downloads;
      renderDownloads();
      enforceSelectionLock();
    } else {
      showState('loading');
    }
    
    if (data.rd_cached_user) {
      showUserBar(data.rd_cached_user);
    }
    
    await loadLocalNotifications();
    refreshInBackground();
    fetchUserInfo();
  } else {
    showState('no-api');
    
    if (data.rd_oauth_pending && data.rd_oauth_pending.expires_at > Date.now()) {
      const btn = DOM.$('#btn-login-api');
      if (btn) btn.textContent = i18n('verifyingAuth');
      
      pollDeviceCredentials(data.rd_oauth_pending.device_code);
      globals.oauthPollingInterval = setInterval(() => pollDeviceCredentials(data.rd_oauth_pending.device_code), 5000);
    } else if (data.rd_oauth_pending) {
      browser.storage.local.remove('rd_oauth_pending');
    }
  }
}

function bindEvents() {
  document.addEventListener('keydown', (e) => {
    const overlay = DOM.$('#modal-overlay');
    const isModalOpen = overlay && !overlay.classList.contains('hidden');

    if (e.key === 'Escape' && isModalOpen) {
      if (overlay.dataset.locked !== 'true') closeModal();
    }

    if (e.key === 'Enter' && isModalOpen) {
      if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
      const submitBtn = DOM.$('#modal-body').querySelector('.form-submit:not([disabled])');
      if (submitBtn) {
        e.preventDefault();
        submitBtn.click();
      }
    }
  });

  DOM.$('#btn-theme').addEventListener('click', () => {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    rdStorage.set({ rd_theme: next });
  });

  DOM.$('.logo-icon').addEventListener('click', () => {
    browser.tabs.create({ url: 'https://real-debrid.com/torrents', active: true });
  });

  DOM.$('#btn-settings').addEventListener('click', () => showAuthModal(false));
  DOM.$('#btn-login-api').addEventListener('click', () => showAuthModal(true));
  DOM.$('#btn-notifications').addEventListener('click', showNotificationsModal);
  
  DOM.$('#btn-add-torrent').addEventListener('click', () => {
    if (!state.hasValidToken) {
      showAuthModal(true);
      return;
    }
    browser.windows.create({ url: 'add.html', type: 'popup', width: 430, height: 550 });
    window.close();
  });

  DOM.$('#btn-add-webdl').addEventListener('click', showWebLinkModal);

  DOM.$('#btn-refresh').addEventListener('click', () => {
    if (DOM.$('#btn-refresh').classList.contains('syncing')) return;
    refreshInBackground();
  });

  const cycleBtn = DOM.$('#tab-type-cycle');
  const cycleStates = [ 
    { type: 'torrent', label: i18n('filterTorrent') }, 
    { type: 'web', label: i18n('filterWeb') } 
  ];
  let cycleIndex = -1;

  cycleBtn.addEventListener('click', () => {
    cycleIndex = (cycleIndex + 1) % (cycleStates.length + 1);
    if (cycleIndex === cycleStates.length) {
      cycleIndex = -1;
      cycleBtn.textContent = i18n('tabType');
      cycleBtn.dataset.cycleState = 'none';
      delete cycleBtn.dataset.cycleType;
      cycleBtn.classList.remove('active');
      state.currentTypeFilter = null;
      state.visibleCount = 50;
      renderDownloads();
      return;
    }
    const st = cycleStates[cycleIndex];
    cycleBtn.classList.add('active');
    cycleBtn.dataset.cycleState = 'active';
    cycleBtn.dataset.cycleType = st.type;
    cycleBtn.textContent = st.label;
    state.currentTypeFilter = st.type;
    state.visibleCount = 50;
    renderDownloads();
  });

  DOM.$$('.tab:not(#tab-type-cycle):not(#btn-delete-all):not(#btn-select-all):not(#btn-cancel-select)').forEach((tab) => {
    tab.addEventListener('click', () => {
      DOM.$$('.tab:not(#tab-type-cycle):not(#btn-delete-all)').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.currentTab = tab.dataset.tab;
      state.visibleCount = 50;
      renderDownloads();
    });
  });

  const deleteAllBtn = DOM.$('#btn-delete-all');
  
  deleteAllBtn.addEventListener('click', (e) => {
    if (globals.ignoreNextClick) return;
    if (!state.hasValidToken || state.allDownloads.length === 0) return;
    if (!state.selectionMode) {
      toggleSelectionMode(true);
    }
  });

  deleteAllBtn.addEventListener('mousedown', () => {
    if (!state.hasValidToken || state.allDownloads.length === 0) return;
    if (!state.selectionMode) return;

    const selectedCount = document.querySelectorAll('.dl-select-cb:checked').length;
    if (selectedCount === 0) return;

    deleteAllBtn.classList.remove('no-transition');
    deleteAllBtn.classList.add('holding');
    globals.deleteAllHoldTimer = setTimeout(() => {
      deleteAllBtn.classList.add('no-transition');
      deleteAllBtn.classList.remove('holding');
      
      globals.ignoreNextClick = true;
      setTimeout(() => { globals.ignoreNextClick = false; }, 1000);

      import('./popup-downloads.js').then(m => m.deleteSelected());
    }, 1500);
  });
  
  const cancelDeleteAll = () => {
    deleteAllBtn.classList.add('no-transition');
    deleteAllBtn.classList.remove('holding');
    if (globals.deleteAllHoldTimer) {
      clearTimeout(globals.deleteAllHoldTimer);
      globals.deleteAllHoldTimer = null;
    }
  };
  deleteAllBtn.addEventListener('mouseup', cancelDeleteAll);
  deleteAllBtn.addEventListener('mouseleave', cancelDeleteAll);

  DOM.$('#btn-select-all').addEventListener('click', () => {
    const cbs = DOM.$$('.dl-select-cb');
    const allChecked = Array.from(cbs).every(cb => cb.checked);
    cbs.forEach(cb => cb.checked = !allChecked);
  });

  DOM.$('#btn-cancel-select').addEventListener('click', () => {
    toggleSelectionMode(false);
  });

  DOM.$('#search-input').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    state.visibleCount = 50;
    renderDownloads();
  });

  const ageBtn = DOM.$('#btn-age-filter');
  const ageMenu = DOM.$('#age-filter-menu');

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

  DOM.$$('.age-filter-option').forEach(opt => {
    opt.addEventListener('click', () => {
      state.ageFilterDays = opt.dataset.age ? parseInt(opt.dataset.age) : null;
      updateAgeFilterUI();
      ageMenu.classList.add('hidden');
      ageBtn.classList.remove('open');
      state.visibleCount = 50;
      renderDownloads();
    });
  });

  DOM.$('#modal-close').addEventListener('click', () => closeModal());
  DOM.$('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === DOM.$('#modal-overlay')) closeModal();
  });

  DOM.$('#download-list').addEventListener('click', handleListClick);

  DOM.$('#downloads-container').addEventListener('scroll', (e) => {
    const el = e.target;
    if (el.scrollHeight - el.scrollTop <= el.clientHeight + 100) {
      if (state.visibleCount < state.currentFiltered.length) {
        state.visibleCount += 50;
        renderDownloads();
      }
    }
  });
}

function handleListClick(e) {
  if (state.selectionMode) {
    const item = e.target.closest('.dl-item');
    if (item) {
        if (e.target.tagName !== 'INPUT' && !e.target.closest('button')) {
            const cb = item.querySelector('.dl-select-cb');
            if (cb) cb.checked = !cb.checked;
        }
    }
    return;
  }

  const dlBtn = e.target.closest('.dl-download-btn');
  if (dlBtn) {
    if (dlBtn.dataset.action === 'select-files') {
      openFileSelectionModal(dlBtn.dataset.id);
    } else if (dlBtn.dataset.action === 'play') {
      playFile(dlBtn.dataset.type, dlBtn.dataset.id);
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
      const dl = state.allDownloads.find(d => String(d.id) === dlId);
      if (dl && dl._type === 'torrent' && isCompleted(dl) && ((dl.files || []).length === 0 || (dl.links || []).length === 0)) {
        fetchTorrentFiles(dl, item);
      }
    }
  }
}
