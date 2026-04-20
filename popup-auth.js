import { state, globals, DOM } from './popup-state.js';
import { openModalWithNode, closeModal } from './popup-modals.js';
import { OAUTH_BASE, OAUTH_CLIENT_ID } from './api.js';
import { i18n, el, toast, makeSvg } from './utils.js';
import { stopAutoRefresh, fetchAll, showState } from './popup-downloads.js';
import { rdStorage } from './storage.js';

export function showAuthModal(autoStartOauth = false) {
  const autoStart = autoStartOauth === true;
  browser.storage.local.get(['rd_context_menu', 'rd_notifications_enabled', 'rd_hover_lift', 'rd_cached_user', 'rd_use_jdownloader', 'rd_jd_port', 'rd_oauth_pending']).then((data) => {
    const contextMenuEnabled = data.rd_context_menu !== false;
    const notificationsEnabled = data.rd_notifications_enabled !== false;
    const hoverLiftEnabled = data.rd_hover_lift !== false;
    const jd2Enabled = data.rd_use_jdownloader === true;
    const jdPortValue = data.rd_jd_port || '9666';
    const cachedUser = data.rd_cached_user;
    const userPoints = cachedUser?.points != null ? cachedUser.points.toLocaleString() : '—';
    const username = cachedUser?.username || cachedUser?.email || '—';

    const infoIconSvg = makeSvg([['circle',{cx:'12',cy:'12',r:'10'}],['line',{x1:'12',y1:'16',x2:'12',y2:'12'}],['line',{x1:'12',y1:'8',x2:'12.01',y2:'8'}]]);

    let authSection;
    if (state.hasValidToken) {
      authSection = el('div', {className: 'settings-account-footer', style: 'display: flex; align-items: center; justify-content: space-between; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-color);'},
        el('div', {style: 'display: flex; align-items: center; gap: 8px;'},
          makeSvg([['path',{d:'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'}],['circle',{cx:'12',cy:'7',r:'4'}]]),
          el('div', {style: 'display: flex; flex-direction: column; text-align: left; line-height: 1.2;'},
            el('span', {className: 'settings-account-name', style: 'font-weight: 600;'}, username),
            el('span', {className: 'settings-account-points', style: 'font-size: 11px; color: var(--text-muted); margin-top: 2px;'}, `${userPoints} ${i18n('points')}`)
          )
        ),
        el('button', {id: 'btn-logout', className: 'action-btn ghost', style: 'color: #f46878;', 'aria-label': i18n('logout')}, i18n('logout'))
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
        ),
        el('div', {id: 'jd-port-container', style: jd2Enabled ? 'margin-top: 10px; display: block;' : 'display: none;'},
          el('label', {className: 'form-label', style: 'margin-bottom:2px; font-size: 12px;'}, i18n('jdPortLabel')),
          el('input', {type: 'number', id: 'input-jd-port', className: 'form-input', value: jdPortValue, style: 'margin-top: 5px;'})
        )
      ),
      el('div', {className: 'settings-account-section', id: 'settings-account-area'}, authSection)
    );

    openModalWithNode(i18n('settings'), body);

    DOM.$('#toggle-context-menu').addEventListener('change', (e) => browser.storage.local.set({ rd_context_menu: e.target.checked }));
    DOM.$('#toggle-notifications').addEventListener('change', (e) => {
      browser.storage.local.set({ rd_notifications_enabled: e.target.checked });
      if (!e.target.checked) {
        state.notifications = [];
        import('./popup-notifications.js').then(m => m.updateNotificationBadge());
      }
    });
    DOM.$('#toggle-hover-lift').addEventListener('change', (e) => {
      browser.storage.local.set({ rd_hover_lift: e.target.checked });
      document.documentElement.setAttribute('data-hover-lift', e.target.checked ? 'on' : 'off');
    });
    DOM.$('#toggle-jd2').addEventListener('change', (e) => {
      state.useJDownloader = e.target.checked;
      browser.storage.local.set({ rd_use_jdownloader: state.useJDownloader });
      const portContainer = DOM.$('#jd-port-container');
      if (portContainer) {
        portContainer.style.display = state.useJDownloader ? 'block' : 'none';
      }
    });

    const jdPortInput = DOM.$('#input-jd-port');
    if (jdPortInput) {
      jdPortInput.addEventListener('change', (e) => {
        state.jdPort = e.target.value.trim() || '9666';
        browser.storage.local.set({ rd_jd_port: state.jdPort });
      });
    }

    const startOauthBtn = DOM.$('#btn-start-oauth');
    if (startOauthBtn) {
      startOauthBtn.addEventListener('click', startOAuthFlow);
    }

    if (!state.hasValidToken && data.rd_oauth_pending) {
      if (data.rd_oauth_pending.expires_at > Date.now()) {
        renderOAuthPending(data.rd_oauth_pending);
      } else {
        browser.storage.local.remove('rd_oauth_pending');
        if (autoStart) startOAuthFlow();
      }
    } else if (!state.hasValidToken && autoStart) {
      startOAuthFlow();
    }

    const logoutBtn = DOM.$('#btn-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', forceLogout);
    }
  });
}

export async function startOAuthFlow() {
  const container = DOM.$('#settings-account-area');
  container.replaceChildren(el('div', {style: 'text-align:center; padding:10px;'}, el('div', {className: 'spinner'}), i18n('requestingCode')));
  
  try {
    const res = await fetch(`${OAUTH_BASE}/device/code?client_id=${OAUTH_CLIENT_ID}&new_credentials=yes`);
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
    console.warn('RD Manager: Erro no start OAuth flow', err);
    container.replaceChildren(el('div', {style: 'color: #f46878;'}, i18n('authError')));
    setTimeout(() => showAuthModal(false), 2000);
  }
}

export function renderOAuthPending(data) {
  const container = DOM.$('#settings-account-area');
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

  DOM.$('#btn-cancel-oauth').addEventListener('click', async () => {
    if (globals.oauthPollingInterval) { clearInterval(globals.oauthPollingInterval); globals.oauthPollingInterval = null; }
    await browser.storage.local.remove('rd_oauth_pending');
    const btn = DOM.$('#btn-login-api');
    if (btn) btn.textContent = i18n('connectRd');
    showAuthModal(false);
  });

  if (globals.oauthPollingInterval) clearInterval(globals.oauthPollingInterval);
  pollDeviceCredentials(data.device_code);
  globals.oauthPollingInterval = setInterval(() => pollDeviceCredentials(data.device_code), 5000);
}

export async function pollDeviceCredentials(deviceCode) {
  try {
    const res = await fetch(`${OAUTH_BASE}/device/credentials?client_id=${OAUTH_CLIENT_ID}&code=${deviceCode}`);
    if (res.status === 403) return; 
    if (!res.ok) throw new Error('Polling failed');
    
    const creds = await res.json();
    if (creds.client_id && creds.client_secret) {
      if (globals.oauthPollingInterval) { clearInterval(globals.oauthPollingInterval); globals.oauthPollingInterval = null; }
      await exchangeDeviceToken(creds.client_id, creds.client_secret, deviceCode);
    }
  } catch (err) {
    console.debug('RD Manager: Poll device credentials fallback', err);
    if (globals.oauthPollingInterval) { clearInterval(globals.oauthPollingInterval); globals.oauthPollingInterval = null; }
    const statusEl = DOM.$('#oauth-status');
    if (statusEl) statusEl.textContent = i18n('authError');
    await browser.storage.local.remove('rd_oauth_pending');
    const btn = DOM.$('#btn-login-api');
    if (btn) btn.textContent = i18n('connectRd');
  }
}

export async function exchangeDeviceToken(clientId, clientSecret, deviceCode) {
  try {
    const statusEl = DOM.$('#oauth-status');
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
      const btn = DOM.$('#btn-login-api');
      if (btn) btn.textContent = i18n('connectRd');
      state.hasValidToken = true;
      toast(i18n('loginComplete'), 'success');
      closeModal();
      import('./popup-downloads.js').then(m => { m.fetchAll(); m.fetchUserInfo(); });
    }
  } catch (err) {
    console.warn('RD Manager: Erro exchange device token', err);
    const statusEl = DOM.$('#oauth-status');
    if (statusEl) statusEl.textContent = i18n('failedToken');
  }
}

export async function forceLogout(msg = null) {
  if (!msg) msg = i18n('accessRevoked');
  state.hasValidToken = false;
  stopAutoRefresh();
  await browser.storage.local.remove([
    'rd_access_token', 'rd_refresh_token', 'rd_oauth_client_id', 
    'rd_oauth_client_secret', 'rd_token_expires_at', 'rd_cached_user', 
    'rd_cached_downloads', 'rd_oauth_pending'
  ]);
  state.allDownloads = [];
  
  const tile = DOM.$('#header-plan-tile');
  if (tile) tile.style.display = 'none';
  
  const btn = DOM.$('#btn-login-api');
  if (btn) btn.textContent = i18n('connectRd');
  
  closeModal(true);
  showState('no-api');
  if (msg) toast(msg, 'error');
}
