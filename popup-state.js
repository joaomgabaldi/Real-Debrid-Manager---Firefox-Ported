export const state = {
  hasValidToken: false,
  currentTab: 'all',
  currentTypeFilter: null,
  searchQuery: '',
  ageFilterDays: null,
  allDownloads: [],
  notifications: [],
  visibleCount: 50,
  currentFiltered: [],
  cachedNotificationsEnabled: true,
  useJDownloader: false,
  jdPort: '9666',
  currentlyLockedTorrentId: null,
  ignoreAutoLockIds: new Set(),
  isFetchingAll: false,
  pendingFetch: false
};

export const globals = {
  oauthPollingInterval: null,
  autoRefreshTimer: null,
  deleteAllHoldTimer: null,
  refreshDecayCount: 0,
  dlElementMap: new Map()
};

export const DOM = {
  $: (sel) => document.querySelector(sel),
  $$: (sel) => document.querySelectorAll(sel)
};
