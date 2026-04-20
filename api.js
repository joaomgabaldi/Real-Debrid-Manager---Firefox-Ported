export const API_BASE = 'https://api.real-debrid.com/rest/1.0';
export const OAUTH_BASE = 'https://api.real-debrid.com/oauth/v2';
export const OAUTH_CLIENT_ID = 'X245A4XAIBGVM';

const authFailureCallbacks = new Set();
let refreshPromise = null;
let trackQueue = Promise.resolve();

export function onAuthFailure(cb) {
  authFailureCallbacks.add(cb);
}

function triggerAuthFailure() {
  authFailureCallbacks.forEach(cb => cb());
}

function handleUnauth(res) {
  if (res.status === 401 || res.status === 403) {
    browser.storage.local.remove(['rd_access_token', 'rd_refresh_token', 'rd_token_expires_at']);
    triggerAuthFailure();
    throw new Error('Unauthenticated');
  }
}

export async function getValidToken() {
  const data = await browser.storage.local.get(['rd_access_token', 'rd_refresh_token', 'rd_oauth_client_id', 'rd_oauth_client_secret', 'rd_token_expires_at']);
  if (!data.rd_access_token) return null;

  const bufferMs = 300000;
  if (Date.now() >= (data.rd_token_expires_at - bufferMs)) {
    if (!data.rd_refresh_token) {
      triggerAuthFailure();
      return null;
    }
    
    if (refreshPromise) {
      return refreshPromise.catch(() => null);
    }
    
    refreshPromise = refreshAccessToken(data.rd_refresh_token, data.rd_oauth_client_id, data.rd_oauth_client_secret)
      .catch(err => {
        console.warn('RD Manager: Falha temporária ao atualizar token (rede/servidor).', err);
        return null; 
      })
      .finally(() => { refreshPromise = null; });
      
    return refreshPromise;
  }
  return data.rd_access_token;
}

async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'http://oauth.net/grant_type/device/1.0'
    }).toString()
  });

  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) {
      await browser.storage.local.remove(['rd_access_token', 'rd_refresh_token', 'rd_token_expires_at']);
      triggerAuthFailure();
      return null;
    }
    throw new Error(`HTTP Error: ${res.status}`);
  }

  const tokenData = await res.json();
  const expiry = Date.now() + (tokenData.expires_in * 1000);
  await browser.storage.local.set({
    rd_access_token: tokenData.access_token,
    rd_refresh_token: tokenData.refresh_token || refreshToken,
    rd_token_expires_at: expiry
  });

  return tokenData.access_token;
}

export async function apiGet(endpoint, timeoutMs = 0) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');

  const fetchOptions = {
    headers: { 'Authorization': `Bearer ${token}` }
  };

  if (timeoutMs > 0) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    fetchOptions.signal = controller.signal;
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, fetchOptions);
      clearTimeout(id);
      handleUnauth(res);
      if (!res.ok) throw new Error(`API GET Error: ${res.status}`);
      return res.json();
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  } else {
    const res = await fetch(`${API_BASE}${endpoint}`, fetchOptions);
    handleUnauth(res);
    if (!res.ok) throw new Error(`API GET Error: ${res.status}`);
    return res.json();
  }
}

export async function apiPost(endpoint, bodyData, isFormUrlEncoded = true, timeoutMs = 0) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');

  let body = bodyData;
  let headers = { 'Authorization': `Bearer ${token}` };

  if (isFormUrlEncoded) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(bodyData).toString();
  }

  const fetchOptions = { method: 'POST', headers, body };

  if (timeoutMs > 0) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    fetchOptions.signal = controller.signal;
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, fetchOptions);
      clearTimeout(id);
      handleUnauth(res);
      if (!res.ok) throw new Error(`API POST Error: ${res.status}`);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  } else {
    const res = await fetch(`${API_BASE}${endpoint}`, fetchOptions);
    handleUnauth(res);
    if (!res.ok) throw new Error(`API POST Error: ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

export async function apiPut(endpoint, blobData) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');

  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}` },
    body: blobData
  });

  handleUnauth(res);

  if (!res.ok) throw new Error(`API PUT Error: ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function apiDelete(endpoint) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');

  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  handleUnauth(res);

  if (!res.ok) throw new Error(`API DELETE Error: ${res.status}`);
  return true;
}

export function trackId(id) {
  const operation = trackQueue.then(async () => {
    const { rd_tracked_ids } = await browser.storage.local.get('rd_tracked_ids');
    const set = new Set(rd_tracked_ids || []);
    set.add(id);
    await browser.storage.local.set({ rd_tracked_ids: [...set] });
  });

  trackQueue = operation.catch((err) => {
    console.error('RD Manager: Falha ao rastrear ID', err);
  });

  return operation;
}
