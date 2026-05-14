import { rdStorage } from './storage.js';

const API_BASE = 'https://api.real-debrid.com/rest/1.0';
export const OAUTH_BASE = 'https://api.real-debrid.com/oauth/v2';
export const OAUTH_CLIENT_ID = 'X245A4XAIBGVM';

const authFailureCallbacks = new Set();

export async function logDebug(event, data = {}) {
  try {
    const { rd_debug_logs } = await rdStorage.get('rd_debug_logs');
    const logs = rd_debug_logs || [];
    logs.unshift({ timestamp: new Date().toISOString(), event, data });
    await rdStorage.set({ rd_debug_logs: logs.slice(0, 30) });
  } catch (e) {
  }
}

export function onAuthFailure(cb) {
  authFailureCallbacks.add(cb);
}

function triggerAuthFailure() {
  authFailureCallbacks.forEach(cb => cb());
}

function handleUnauth(res, endpoint) {
  if (res.status === 401) {
    logDebug('401_UNAUTHENTICATED_FATAL', { endpoint });
    throw new Error('Unauthenticated');
  }
  if (res.status === 403) {
    throw new Error('Forbidden');
  }
}

async function fetchWithRateLimitRetry(url, options, maxRetries = 3, baseDelayMs = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    
    if (res.status === 429) {
      if (attempt < maxRetries) {
        const retryAfter = res.headers.get('Retry-After');
        let delay = baseDelayMs * Math.pow(2, attempt);
        
        if (retryAfter) {
          const parsedInt = parseInt(retryAfter, 10);
          if (!isNaN(parsedInt) && String(parsedInt) === retryAfter.trim()) {
            delay = parsedInt * 1000;
          } else {
            const parsedDate = Date.parse(retryAfter);
            if (!isNaN(parsedDate)) {
              delay = Math.max(0, parsedDate - Date.now());
            }
          }
        }
        
        console.warn(`RD Manager: HTTP 429 Too Many Requests. Retrying in ${delay}ms (Attempt ${attempt + 1}/${maxRetries}).`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      } else {
        throw new Error('Max retries exceeded: HTTP 429');
      }
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
      await logDebug('REFRESH_FAILED_NO_TOKEN', {});
      triggerAuthFailure();
      return null;
    }
    
    return await navigator.locks.request('rd_token_refresh', async () => {
      const freshData = await rdStorage.get(['rd_access_token', 'rd_token_expires_at']);
      if (freshData.rd_access_token && Date.now() < (freshData.rd_token_expires_at - bufferMs)) {
        await logDebug('REFRESH_SKIPPED_LOCK_WON', { message: 'Token atualizado por execução concorrente.' });
        return freshData.rd_access_token;
      }

      await logDebug('REFRESH_START', { expired_at: data.rd_token_expires_at, now: Date.now() });

      return await refreshAccessToken(data.rd_refresh_token, data.rd_oauth_client_id, data.rd_oauth_client_secret)
        .catch(async err => {
          await logDebug('REFRESH_EXCEPTION', { error: err.message });
          console.warn('RD Manager: Falha temporária ao atualizar token.', err);
          return null; 
        });
    });
  }
  return data.rd_access_token;
}

async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const payload = {
    client_id: clientId,
    client_secret: clientSecret,
    code: refreshToken,
    grant_type: 'http://oauth.net/grant_type/device/1.0'
  };

  await logDebug('REFRESH_PAYLOAD_CHECK', { 
    has_client_id: !!clientId, 
    has_client_secret: !!clientSecret, 
    has_refresh_token: !!refreshToken,
    grant_type_sent: payload.grant_type
  });

  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString()
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => 'No body text');
    await logDebug('REFRESH_HTTP_ERROR', { status: res.status, body: errorText });
    
    if (res.status === 401 || res.status === 400 || res.status === 403) {
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

  await logDebug('REFRESH_SUCCESS', { 
    expires_in: tokenData.expires_in, 
    new_refresh_token_provided: !!tokenData.refresh_token 
  });

  return tokenData.access_token;
}

export async function apiGet(endpoint, timeoutMs = 0, _isRetry = false) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');

  const fetchOptions = {
    headers: { 'Authorization': `Bearer ${token}` }
  };

  let res;
  if (timeoutMs > 0) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    fetchOptions.signal = controller.signal;
    try {
      res = await fetchWithRateLimitRetry(`${API_BASE}${endpoint}`, fetchOptions);
      clearTimeout(id);
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  } else {
    res = await fetchWithRateLimitRetry(`${API_BASE}${endpoint}`, fetchOptions);
  }

  if (res.status === 401 && !_isRetry) {
    await logDebug('401_RETRY_TRIGGERED', { endpoint, method: 'GET' });
    await rdStorage.set({ rd_token_expires_at: 0 });
    return await apiGet(endpoint, timeoutMs, true);
  }

  handleUnauth(res, endpoint);
  if (!res.ok) throw new Error(`API GET Error: ${res.status}`);
  return res.json();
}

export async function apiPost(endpoint, bodyData, isFormUrlEncoded = true, timeoutMs = 0, _isRetry = false) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');

  let body = bodyData;
  let headers = { 'Authorization': `Bearer ${token}` };

  if (isFormUrlEncoded) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(bodyData).toString();
  }

  const fetchOptions = { method: 'POST', headers, body };

  let res;
  if (timeoutMs > 0) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    fetchOptions.signal = controller.signal;
    try {
      res = await fetchWithRateLimitRetry(`${API_BASE}${endpoint}`, fetchOptions);
      clearTimeout(id);
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  } else {
    res = await fetchWithRateLimitRetry(`${API_BASE}${endpoint}`, fetchOptions);
  }

  if (res.status === 401 && !_isRetry) {
    await logDebug('401_RETRY_TRIGGERED', { endpoint, method: 'POST' });
    await rdStorage.set({ rd_token_expires_at: 0 });
    return await apiPost(endpoint, bodyData, isFormUrlEncoded, timeoutMs, true);
  }

  handleUnauth(res, endpoint);
  if (!res.ok) throw new Error(`API POST Error: ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function apiPut(endpoint, blobData, contentType = null, _isRetry = false) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');

  const headers = { 'Authorization': `Bearer ${token}` };
  
  if (contentType && !(blobData instanceof FormData)) {
    headers['Content-Type'] = contentType;
  }

  const res = await fetchWithRateLimitRetry(`${API_BASE}${endpoint}`, {
    method: 'PUT',
    headers: headers,
    body: blobData
  });

  if (res.status === 401 && !_isRetry) {
    await logDebug('401_RETRY_TRIGGERED', { endpoint, method: 'PUT' });
    await rdStorage.set({ rd_token_expires_at: 0 });
    return await apiPut(endpoint, blobData, contentType, true);
  }

  handleUnauth(res, endpoint);

  if (!res.ok) throw new Error(`API PUT Error: ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function apiDelete(endpoint, _isRetry = false) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');

  const res = await fetchWithRateLimitRetry(`${API_BASE}${endpoint}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (res.status === 401 && !_isRetry) {
    await logDebug('401_RETRY_TRIGGERED', { endpoint, method: 'DELETE' });
    await rdStorage.set({ rd_token_expires_at: 0 });
    return await apiDelete(endpoint, true);
  }

  handleUnauth(res, endpoint);

  if (!res.ok) throw new Error(`API DELETE Error: ${res.status}`);
  return true;
}

export async function trackId(id) {
  try {
    await navigator.locks.request('rd_track_id_lock', async () => {
      const { rd_tracked_ids } = await rdStorage.get('rd_tracked_ids');
      const set = new Set(rd_tracked_ids || []);
      set.add(id);
      
      while (set.size > 100) {
        set.delete(set.values().next().value);
      }
      
      await rdStorage.set({ rd_tracked_ids: [...set] });
    });
  } catch (err) {
    console.error('RD Manager: Falha ao rastrear ID', err);
    throw err;
  }
}
