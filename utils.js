export function i18n(key, ...args) {
  let msg = browser.i18n.getMessage(key, args);
  if (!msg) {
    const defaults = {
      points: 'Points',
      dayRemaining: 'day',
      daysRemaining: 'days',
      noDaysRemaining: 'Expired',
      logout: 'Logout',
      connectRd: 'Connect to Real-Debrid',
      contextMenuToggleLabel: 'Context Menu',
      contextMenuDesc: 'Add links/magnets from right-click',
      dlNotificationsLabel: 'Download Notifications',
      dlNotificationsDesc: 'Notify when downloads finish',
      dlNotificationsInfo: 'Requires tracking to be enabled.',
      hoverLiftLabel: 'Hover Lift Effect',
      hoverLiftDesc: 'Slightly lift items on hover',
      jd2Label: 'Send to JDownloader',
      jd2Desc: 'Requires JD2 running with FlashGot enabled',
      jdPortLabel: 'JDownloader Port:',
      requestingCode: 'Requesting code...',
      authError: 'Authentication failed',
      accessUrl: 'Access this URL:',
      waitingAuth: 'Waiting for authentication...',
      cancel: 'Cancel',
      finishingLogin: 'Completing login...',
      loginComplete: 'Login successful!',
      failedToken: 'Failed to get token',
      accessRevoked: 'Access revoked. Please log in again.',
      unnamedDownload: 'Unnamed Download',
      fileX: 'File',
      addedAt: 'Added:',
      predicted: 'ETA',
      noPrediction: 'No ETA',
      statusError: 'Error',
      statusProcessing: 'Processing',
      statusWaiting: 'Waiting',
      statusQueued: 'Queued',
      statusDownloading: 'Downloading',
      statusCompleted: 'Completed',
      statusUploading: 'Uploading',
      statusUnknown: 'Unknown',
      justNow: 'Just now',
      agoDays: '$1 ago',
      fetchingDownloadsFailed: 'Failed to fetch downloads',
      deleting: 'Deleting...',
      removed: 'Removed successfully',
      deleteFailed: 'Failed to delete',
      startingDownload: 'Starting download...',
      failedDlLink: 'Failed to unrestrict link',
      noDlLink: 'No links available to download',
      unknownDlType: 'Unknown download type',
      dlTimeout: 'Download request timed out',
      dlFailed: 'Download failed',
      invalidDlLink: 'Invalid download link',
      sendingToJd: 'Sending to JDownloader...',
      addedToJd: 'Added to JDownloader',
      jdFailedAskBrowser: 'JDownloader not responding. Download via browser?',
      no: 'No',
      yes: 'Yes',
      jdUnresponsive: 'JD2 Unresponsive',
      torrentCanceled: 'Torrent canceled',
      errorRemove: 'Error removing torrent',
      cancelTorrent: 'Cancel Torrent',
      waitingMagnet: 'Converting magnet...',
      selectFiles: 'Select Files',
      errorGetFiles: 'Error getting files',
      noFilesFound: 'No files found to select',
      selectAll: 'Select All',
      startDownload: 'Start Download',
      selectAtLeastOne: 'Select at least one file',
      starting: 'Starting...',
      filesSelected: 'Files selected!',
      failedStart: 'Failed to start download',
      urlLabel: 'Links',
      urlTooltip: 'Paste one or more links here',
      supportedHosters: 'Supported Hosters',
      unlock: 'Unlock',
      unlockLink: 'Unlock Link',
      insertValidUrl: 'Insert a valid URL',
      unlocking: 'Unlocking...',
      linksUnlocked: 'links unlocked',
      linkUnlocked: 'Link unlocked',
      allFailed: 'Failed to unlock all links',
      someFailed: 'failed',
      failedUnlock: 'Unlock failed',
      dlAvailable: 'Download Available',
      dlCompletedMsg: 'A download has completed',
      noNotifications: 'No notifications',
      clearAll: 'Clear All',
      allCleared: 'Notifications cleared',
      settings: 'Settings',
      notifications: 'Notifications',
      moreThan1Day: 'older than 1 day',
      moreThan1Week: 'older than 1 week',
      moreThan1Month: 'older than 1 month',
      olderThan: 'Older than...',
      resultsLabel: 'results',
      tabType: 'Type',
      authFirst: 'Please authenticate first.',
      magnetLabel: 'Magnet Link',
      magnetTooltip: 'Paste a magnet link',
      or: 'OR',
      selectTorrentFile: 'Select .torrent file',
      addBtn: 'Add',
      insertMagnetOrFile: 'Insert a magnet link or select a file.',
      adding: 'Adding...',
      addedVerifying: 'Added! Verifying...',
      failedAdd: 'Failed to add',
      waitingConversion: 'Waiting for conversion...',
      errorProcessClose: 'Error processing. Closing...',
      addedSuccess: 'Added successfully!',
      noFiles: 'No files found.',
      selectFilesToDl: 'Select files to download:',
      filesSelectedClose: 'Files selected! Closing...',
      unnamedTorrent: 'Unnamed Torrent',
      fileInfoMissing: 'File info missing.',
      filesAvailableLater: 'Files will be available when completed.',
      verifyingAuth: 'Verifying auth...',
      multipleLinksExpand: 'Multiple files. Expand the item to download.',
      extName: 'RD Manager',
      extDesc: 'Manage all your Real-Debrid downloads in a simple window.',
      panelTitle: 'Go to real-debrid.com',
      toggleTheme: 'Toggle theme',
      addTorrent: 'Add Torrent',
      refresh: 'Refresh',
      searchPlaceholder: 'Search downloads...',
      clearFilter: 'Clear filter',
      tabAll: 'All',
      tabActive: 'Active',
      tabCompleted: 'Completed',
      deleteAll: 'Delete all',
      deleteAllTooltip: 'Hold to delete all visible results (respects filters and search)',
      loadingDownloads: 'Loading downloads...',
      noDownloads: 'No downloads found',
      loginToStart: 'Login to Real-Debrid to start',
      download: 'Download',
      delete: 'Delete',
      contextMenuTitle: 'Send to RD Manager'
    };
    msg = defaults[key] || key;
  }
  return msg;
}

export function localizeHtmlPage() {
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

export function el(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const key in attributes) {
    if (key === 'className') {
      element.className = attributes[key];
    } else if (key === 'style') {
      element.style.cssText = attributes[key];
    } else if (key.startsWith('on') && typeof attributes[key] === 'function') {
      element.addEventListener(key.toLowerCase().substring(2), attributes[key]);
    } else if (attributes[key] !== null && attributes[key] !== undefined) {
      element.setAttribute(key, attributes[key]);
    }
  }
  for (const child of children) {
    if (typeof child === 'string' || typeof child === 'number') {
      element.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      element.appendChild(child);
    }
  }
  return element;
}

export function makeSvg(paths, { viewBox = '0 0 24 24', width = '14', height = '14' } = {}) {
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
    const elem = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) elem.setAttribute(k, v);
    svg.appendChild(elem);
  }
  return svg;
}

export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function toast(msg, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const tEl = document.createElement('div');
  tEl.className = `toast ${type}`;
  tEl.textContent = msg;
  document.body.appendChild(tEl);
  setTimeout(() => tEl.remove(), 2500);
}

export function formatTimeAgo(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date)) return null;

  const diffMs = Date.now() - date.getTime();
  if (diffMs <= 0) return i18n('justNow');

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return i18n('justNow');
  if (diffHours < 1) return i18n('agoDays', `${diffMins}m`);
  if (diffDays < 1) return i18n('agoDays', `${diffHours}h`);
  if (diffDays === 1) return i18n('agoDays', '1d');
  return i18n('agoDays', `${diffDays}d`);
}

export function initFixedTooltips() {
  document.querySelectorAll('.info-icon:not(.tooltip-inited)').forEach(icon => {
    icon.classList.add('tooltip-inited');
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
      tip.style.left = `${(modal ? modalRect.left : 0) + ((modal ? modalRect.width : document.body.clientWidth) - tipWidth) / 2}px`;
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
