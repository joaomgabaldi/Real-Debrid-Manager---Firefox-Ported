import { DOM, globals, state } from './popup-state.js';
import { initFixedTooltips } from './utils.js';

let lastActiveElement = null;

export function openModalWithNode(title, bodyNode, locked = false) {
  lastActiveElement = document.activeElement;
  document.querySelectorAll('.notifications-mark-all').forEach(el => el.remove());
  DOM.$('#modal-title').textContent = title;
  DOM.$('#modal-body').replaceChildren(bodyNode);
  
  const overlay = DOM.$('#modal-overlay');
  overlay.classList.remove('hidden');
  overlay.dataset.locked = locked ? 'true' : 'false';
  DOM.$('#modal-close').style.display = locked ? 'none' : '';
  
  initFixedTooltips();

  const firstInput = bodyNode.querySelector('input, textarea, button');
  if (firstInput) setTimeout(() => firstInput.focus(), 50);
}

export function closeModal(force = false) {
  const overlay = DOM.$('#modal-overlay');
  if (!force && overlay.dataset.locked === 'true') return;
  
  if (globals.oauthPollingInterval) {
    clearInterval(globals.oauthPollingInterval);
    globals.oauthPollingInterval = null;
  }
  
  overlay.classList.add('hidden');
  overlay.dataset.locked = 'false';
  DOM.$('#modal-close').style.display = '';
  
  if (force) {
    state.currentlyLockedTorrentId = null;
  }

  if (lastActiveElement) {
    lastActiveElement.focus();
    lastActiveElement = null;
  }
}
