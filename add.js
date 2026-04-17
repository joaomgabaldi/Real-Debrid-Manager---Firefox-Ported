const API_BASE = 'https://api.real-debrid.com/rest/1.0';
const OAUTH_BASE = 'https://api.real-debrid.com/oauth/v2';
const TIMEOUT_DEFAULT_MS = 10_000;

const i18n = (key) => browser.i18n.getMessage(key) || key;

function localizeHtmlPage() {
  document.querySelectorAll('[data-i18n]').forEach(elem => {
    const msg = browser.i18n.getMessage(elem.dataset.i18n);
    if (msg) elem.textContent = msg;
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

const $ = (sel) => document.querySelector(sel);

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

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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

function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_DEFAULT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function getValidToken() {
  const data = await browser.storage.local.get(['rd_access_token', 'rd_refresh_token', 'rd_oauth_client_id', 'rd_oauth_client_secret', 'rd_token_expires_at']);
  if (!data.rd_access_token) return null;

  if (Date.now() > data.rd_token_expires_at - 60000) {
    try {
      const res = await fetch(`${OAUTH_BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: data.rd_oauth_client_id,
          client_secret: data.rd_oauth_client_secret,
          code: data.rd_refresh_token,
          grant_type: 'http://oauth.net/grant_type/device/1.0'
        }).toString()
      });
      if (!res.ok) return null;
      const tokenData = await res.json();
      const newExpiry = Date.now() + (tokenData.expires_in * 1000);
      await browser.storage.local.set({
        rd_access_token: tokenData.access_token,
        rd_refresh_token: tokenData.refresh_token,
        rd_token_expires_at: newExpiry
      });
      return tokenData.access_token;
    } catch (_) {
      return null;
    }
  }
  return data.rd_access_token;
}

async function apiGet(path) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`API error (${res.status})`);
  if (res.status === 204) return null;
  return res.json();
}

async function apiPost(path, body) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  });
  if (!res.ok) throw new Error(`API error (${res.status})`);
  if (res.status === 204) return null;
  return res.json();
}

async function trackId(id) {
  const { rd_tracked_ids } = await browser.storage.local.get('rd_tracked_ids');
  const tracked = new Set(rd_tracked_ids || []);
  tracked.add(String(id));
  await browser.storage.local.set({ rd_tracked_ids: [...tracked] });
}

document.addEventListener('DOMContentLoaded', async () => {
  localizeHtmlPage();
  const { rd_theme } = await browser.storage.local.get('rd_theme');
  document.documentElement.setAttribute('data-theme', rd_theme || 'dark');

  const token = await getValidToken();
  if (!token) {
    $('#content').replaceChildren(el('div', {className: 'state-message'}, i18n('authFirst')));
    return;
  }
  renderAddForm();
});

function renderAddForm() {
  const infoIconSvg = makeSvg([['circle',{cx:'12',cy:'12',r:'10'}],['line',{x1:'12',y1:'16',x2:'12',y2:'12'}],['line',{x1:'12',y1:'8',x2:'12.01',y2:'8'}]]);
  const btnSvg = makeSvg([['path',{d:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'}],['polyline',{points:'14 2 14 8 20 8'}]]);

  const form = el('div', {},
    el('div', {className: 'form-group'},
      el('div', {className: 'form-label-row'},
        el('div', {className: 'form-label-left'},
          el('label', {className: 'form-label'}, i18n('magnetLabel')),
          el('span', {className: 'info-icon'}, infoIconSvg.cloneNode(true), el('span', {className: 'info-tooltip'}, i18n('magnetTooltip')))
        )
      ),
      el('textarea', {className: 'form-input', id: 'input-magnet', placeholder: 'magnet:?xt=urn:btih:...', rows: '5', spellcheck: 'false'})
    ),
    el('div', {className: 'form-divider'}, el('span', {}, i18n('or'))),
    el('div', {className: 'form-group'},
      el('input', {type: 'file', id: 'input-torrent-file', accept: '.torrent', style: 'display:none'}),
      el('button', {className: 'form-file-btn', id: 'btn-select-torrent'}, btnSvg.cloneNode(true), i18n('selectTorrentFile')),
      el('div', {className: 'form-file-name', id: 'selected-file-name'})
    ),
    el('button', {className: 'form-submit', id: 'submit-torrent'}, i18n('addBtn'), el('span', {className: 'btn-spinner'}))
  );

  $('#content').replaceChildren(form);

  const magnetInput = $('#input-magnet');
  const fileInput = $('#input-torrent-file');
  const fileBtn = $('#btn-select-torrent');
  const fileName = $('#selected-file-name');
  const submitBtn = $('#submit-torrent');
  let selectedFile = null;

  fileBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      selectedFile = fileInput.files[0];
      fileName.textContent = selectedFile.name;
      magnetInput.value = '';
      magnetInput.disabled = true;
    } else {
      selectedFile = null;
      fileName.textContent = '';
      magnetInput.disabled = false;
    }
  });

  magnetInput.addEventListener('input', () => {
    if (magnetInput.value.trim()) {
      fileInput.value = '';
      selectedFile = null;
      fileName.textContent = '';
    } else {
       magnetInput.disabled = false;
    }
  });

  submitBtn.addEventListener('click', async () => {
    const magnet = magnetInput.value.trim();
    const file = selectedFile;

    if (!magnet && !file) return toast(i18n('insertMagnetOrFile'), 'error');

    submitBtn.disabled = true;
    submitBtn.classList.add('loading');
    submitBtn.replaceChildren(i18n('adding'), el('span', {className: 'btn-spinner'}));

    try {
      let torrentId = null;
      if (file) {
        const token = await getValidToken();
        const res = await fetch(`${API_BASE}/torrents/addTorrent`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
          body: file
        });
        if (!res.ok) throw new Error(`API error`);
        const data = await res.json();
        torrentId = data.id;
      } else {
        const data = await apiPost('/torrents/addMagnet', { magnet: magnet });
        torrentId = data?.id;
      }

      if (torrentId) {
        await trackId(String(torrentId));
        toast(i18n('addedVerifying'), 'success');
        await handleFileSelection(torrentId);
      }
    } catch (err) {
      toast(i18n('failedAdd'), 'error');
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
      submitBtn.replaceChildren(i18n('addBtn'), el('span', {className: 'btn-spinner'}));
    }
  });

  setTimeout(() => magnetInput.focus(), 100);
}

async function handleFileSelection(torrentId) {
  $('#content').replaceChildren(el('div', {className: 'state-message', style: 'padding: 40px 0;'},
    el('div', {className: 'spinner'}),
    el('span', {style: 'margin-top: 10px; display: block;'}, i18n('waitingConversion'))
  ));

  let info;
  let attempts = 0;
  while (attempts < 60) {
    try {
      info = await apiGet(`/torrents/info/${torrentId}`);
      if (info && info.status !== 'magnet_conversion') break;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
    attempts++;
  }

  if (!info || info.status === 'error' || info.status === 'dead') {
    toast(i18n('errorProcessClose'), 'error');
    setTimeout(() => window.close(), 2500);
    return;
  }

  if (info.status !== 'waiting_files_selection') {
    toast(i18n('addedSuccess'), 'success');
    browser.runtime.sendMessage('rd-check-now');
    setTimeout(() => window.close(), 1500);
    return;
  }

  if (!info.files || info.files.length === 0) {
    toast(i18n('noFiles'), 'error');
    setTimeout(() => window.close(), 2500);
    return;
  }

  const fileList = el('ul', {className: 'dl-files-list', style: 'max-height: 250px; overflow-y: auto; overflow-x: hidden; margin: 10px 0; background: var(--bg-hover, rgba(0,0,0,0.1)); border-radius: 6px; padding: 5px; list-style: none;'});
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

  const confirmBtn = el('button', {className: 'form-submit', style: 'width: 100%; margin-top: 10px;'}, i18n('startDownload'));

  confirmBtn.addEventListener('click', async () => {
    const selected = checkboxes.filter(c => c.checked).map(c => c.value);
    if (selected.length === 0) return toast(i18n('selectAtLeastOne'), 'error');

    confirmBtn.disabled = true;
    confirmBtn.textContent = i18n('starting');
    try {
      await apiPost(`/torrents/selectFiles/${torrentId}`, { files: selected.join(',') });
      toast(i18n('filesSelectedClose'), 'success');
      browser.runtime.sendMessage('rd-check-now');
      setTimeout(() => window.close(), 1500); 
    } catch (err) {
      toast(i18n('failedStart'), 'error');
      confirmBtn.disabled = false;
      confirmBtn.textContent = i18n('startDownload');
    }
  });

  $('#content').replaceChildren(el('div', {},
    el('div', {style: 'font-weight: 600; margin-bottom: 10px;'}, i18n('selectFilesToDl')),
    selectAllBtn,
    fileList,
    confirmBtn
  ));
}