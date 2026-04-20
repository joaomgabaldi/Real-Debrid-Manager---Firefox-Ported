import { getValidToken, apiGet, apiPost, apiPut, trackId, onAuthFailure } from './api.js';
import { i18n, localizeHtmlPage, el, makeSvg, formatBytes, toast, initFixedTooltips } from './utils.js';
import { rdStorage } from './storage.js';

const $ = (sel) => document.querySelector(sel);

document.addEventListener('DOMContentLoaded', async () => {
  localizeHtmlPage();
  const { rd_theme } = await rdStorage.get('rd_theme');
  document.documentElement.setAttribute('data-theme', rd_theme || 'dark');

  onAuthFailure(() => {
    $('#content').replaceChildren(el('div', {className: 'state-message'}, i18n('accessRevoked')));
    setTimeout(() => window.close(), 2500);
  });

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
      el('button', {className: 'form-file-btn', id: 'btn-select-torrent', 'aria-label': i18n('selectTorrentFile')}, btnSvg.cloneNode(true), i18n('selectTorrentFile')),
      el('div', {className: 'form-file-name', id: 'selected-file-name'})
    ),
    el('button', {className: 'form-submit', id: 'submit-torrent'}, i18n('addBtn'), el('span', {className: 'btn-spinner'}))
  );

  $('#content').replaceChildren(form);
  
  initFixedTooltips();

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
        const data = await apiPut('/torrents/addTorrent', file);
        torrentId = data?.id;
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
      console.warn('RD Manager: Falha ao adicionar torrent/magnet', err);
      if (err.message === 'Unauthenticated') return;
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

  let isCancelled = false;
  window.addEventListener('pagehide', () => { isCancelled = true; });
  window.addEventListener('beforeunload', () => { isCancelled = true; });

  let info;
  let attempts = 0;
  while (attempts < 60) {
    if (isCancelled) return;
    try {
      info = await apiGet(`/torrents/info/${torrentId}`);
      if (info && info.status !== 'magnet_conversion') break;
    } catch (err) {
      if (err.message === 'Unauthenticated') return;
      console.debug('RD Manager: Polling falhou ao aguardar seleção de ficheiros.', err);
    }
    await new Promise(r => setTimeout(r, 1000));
    attempts++;
  }

  if (isCancelled) return;

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
      if (err.message === 'Unauthenticated') return;
      console.warn('RD Manager: Falha ao despachar selecção de ficheiros', err);
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
  
  setTimeout(() => selectAllBtn.focus(), 100);
}
