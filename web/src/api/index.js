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
