import { request } from './client.js';

export const authApi = {
  status: () => request('/auth/status'),
  register: (body) => request('/auth/register', { method: 'POST', body }),
  login: (body) => request('/auth/login', { method: 'POST', body }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),
  changePassword: (body) => request('/auth/password', { method: 'PUT', body }),
};

export const tokensApi = {
  list: () => request('/tokens'),
  create: (body) => request('/tokens', { method: 'POST', body }),
  revoke: (id) => request(`/tokens/${id}`, { method: 'DELETE' }),
  reveal: (id) => request(`/tokens/${id}/reveal`, { method: 'POST' }),
};

export const bookmarksApi = {
  list: (params) => {
    const qs = new URLSearchParams(
      Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
    );
    return request(`/bookmarks?${qs}`);
  },
  tree: () => request('/bookmarks/tree'),
  update: (id, body) => request(`/bookmarks/${id}`, { method: 'PUT', body }),
  delete: (id) => request(`/bookmarks/${id}`, { method: 'DELETE' }),
  batchDelete: (ids) => request('/bookmarks/batch-delete', { method: 'POST', body: { ids } }),
};

export const statsApi = {
  stats: () => request('/stats'),
  syncLogs: (params) => {
    const qs = new URLSearchParams(params || {});
    return request(`/sync-logs?${qs}`);
  },
};

export const settingsApi = {
  getRegistration: () => request('/settings/registration'),
  setRegistration: (enabled) => request('/settings/registration', { method: 'PUT', body: { enabled } }),
};

export const backupsApi = {
  list: () => request('/backups'),
  create: (body) => request('/backups', { method: 'POST', body }),
  remove: (id) => request(`/backups/${id}`, { method: 'DELETE' }),
  restore: (id) => request(`/backups/${id}/restore`, { method: 'POST' }),
  downloadUrl: (id) => `/api/backups/${id}/download`,
  getConfig: () => request('/backups/config'),
  updateConfig: (body) => request('/backups/config', { method: 'PUT', body }),
};
