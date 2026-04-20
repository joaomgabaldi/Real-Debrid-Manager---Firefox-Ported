import { rdStorage } from './storage.js';

const API_BASE = 'https://api.real-debrid.com/rest/1.0';
export const OAUTH_BASE = 'https://api.real-debrid.com/oauth/v2';
export const OAUTH_CLIENT_ID = 'X245A4XAIBGVM';

const authFailureCallbacks = new Set();
let trackQueue = Promise.resolve();

export function onAuthFailure(cb) {
  authFailureCallbacks.add(cb);
}

function triggerAuthFailure() {
  authFailureCallbacks.forEach(cb => cb());
}

function handleUnauth(res) {
  if (res.status === 401) {
    rdStorage.remove(['rd_access_token', 'rd_refresh_token', 'rd_token_expires_at']);
    triggerAuthFailure();
    throw new Error('Unauthenticated');
  }
}

async function fetchWithRateLimitRetry(url, options, maxRetries = 3, baseDelayMs = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = res.headers.get('Retry-After');
      let delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : baseDelayMs * Math.pow(2, attempt);
      if (isNaN(delay)) delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`RD Manager: HTTP 429 Too Many Requests. Retrying in ${delay}ms (Attempt ${attempt + 1}/${maxRetries}).`);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    return res;
  }
}

export async function getValidToken() {
  const data = await rdStorage.get(['rd_access_token', 'rd_refresh_token', 'rd_oauth_client_id', 'rd_oauth_client_secret', 'rd_token_expires_at']);
  if (!data.rd_access_token) return null;

  const bufferMs = 300000;
  if (Date.now() >= (data.rd_token_expires_at - bufferMs)) {
    if (!data.rd_refresh_token) {
      triggerAuthFailure();
      return null;
    }
    
    return await navigator.locks.request('rd_token_refresh', async () => {
      const freshData = await rdStorage.get(['rd_access_token', 'rd_token_expires_at']);
      if (freshData.rd_access_token && Date.now() < (freshData.rd_token_expires_at - bufferMs)) {
        return freshData.rd_access_token;
      }

      return await refreshAccessToken(data.rd_refresh_token, data.rd_oauth_client_id, data.rd_oauth_client_secret)
        .catch(err => {
          console.warn('RD Manager: Falha temporária ao atualizar token.', err);
          return null; 
        });
    });
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
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      await rdStorage.remove(['rd_access_token', 'rd_refresh_token', 'rd_token_expires_at']);
      triggerAuthFailure();
      return null;
    }
    throw new Error(`HTTP Error: ${res.status}`);
  }

  const tokenData = await res.json();
  const expiry = Date.now() + (tokenData.expires_in * 1000);
  await rdStorage.set({
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
      const res = await fetchWithRateLimitRetry(`${API_BASE}${endpoint}`, fetchOptions);
      clearTimeout(id);
      handleUnauth(res);
      if (!res.ok) throw new Error(`API GET Error: ${res.status}`);
      return res.json();
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  } else {
    const res = await fetchWithRateLimitRetry(`${API_BASE}${endpoint}`, fetchOptions);
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
      const res = await fetchWithRateLimitRetry(`${API_BASE}${endpoint}`, fetchOptions);
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
    const res = await fetchWithRateLimitRetry(`${API_BASE}${endpoint}`, fetchOptions);
    handleUnauth(res);
    if (!res.ok) throw new Error(`API POST Error: ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

export async function apiPut(endpoint, blobData, contentType = null) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');

  const headers = { 'Authorization': `Bearer ${token}` };
  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  const res = await fetchWithRateLimitRetry(`${API_BASE}${endpoint}`, {
    method: 'PUT',
    headers: headers,
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

  const res = await fetchWithRateLimitRetry(`${API_BASE}${endpoint}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  handleUnauth(res);

  if (!res.ok) throw new Error(`API DELETE Error: ${res.status}`);
  return true;
}

export function trackId(id) {
  const operation = trackQueue.then(async () => {
    const { rd_tracked_ids } = await rdStorage.get('rd_tracked_ids');
    const set = new Set(rd_tracked_ids || []);
    set.add(id);
    
    while (set.size > 100) {
      set.delete(set.values().next().value);
    }
    
    await rdStorage.set({ rd_tracked_ids: [...set] });
  });

  trackQueue = operation.catch((err) => {
    console.error('RD Manager: Falha ao rastrear ID', err);
  });

  return operation;
}
