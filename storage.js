export const rdStorage = {
  get: (keys) => browser.storage.local.get(keys),
  set: (data) => browser.storage.local.set(data),
  remove: (keys) => browser.storage.local.remove(keys),
  
  saveCachedDownloads: (downloads) => browser.storage.local.set({ rd_cached_downloads: downloads }),
  
  getLocalDownloads: async () => {
    const res = await browser.storage.local.get('rd_local_downloads');
    return res.rd_local_downloads || [];
  },
  
  saveLocalDownloads: (downloads) => browser.storage.local.set({ rd_local_downloads: downloads }),

  getLocalNotifications: async () => {
    const res = await browser.storage.local.get('rd_local_notifications');
    return res.rd_local_notifications || [];
  },

  saveLocalNotifications: (notifications) => browser.storage.local.set({ rd_local_notifications: notifications }),

  saveOAuthPending: (data) => browser.storage.local.set({ rd_oauth_pending: data }),
  removeOAuthPending: () => browser.storage.local.remove('rd_oauth_pending'),

  saveAuthData: (data) => browser.storage.local.set({
    rd_access_token: data.access_token,
    rd_refresh_token: data.refresh_token,
    rd_oauth_client_id: data.client_id,
    rd_oauth_client_secret: data.client_secret,
    rd_token_expires_at: data.expires_at
  }),

  clearAuthData: () => browser.storage.local.remove([
    'rd_access_token', 'rd_refresh_token', 'rd_oauth_client_id', 
    'rd_oauth_client_secret', 'rd_token_expires_at', 'rd_cached_user', 
    'rd_cached_downloads', 'rd_oauth_pending', 'rd_ignore_locks',
    'rd_tracked_ids', 'rd_local_notifications', 'rd_local_downloads',
    'rd_use_vlc'
  ])
};
