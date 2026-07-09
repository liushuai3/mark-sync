// MarkSync backend integration.
// Adapts the local bookmark tree (v2.0 format) to the flat-array API used by the MarkSync backend.

// UUID v4 generator (Web Crypto if available, else fallback).
function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class MarkSyncBackend {
  constructor({ apiUrl, token }) {
    this.apiUrl = (apiUrl || '').replace(/\/$/, '');
    this.token = token || '';
  }

  async request(path, opts = {}) {
    if (!this.apiUrl) throw new Error('API URL 未配置');
    if (!this.token) throw new Error('API Token 未配置');
    const res = await fetch(this.apiUrl + path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!json.ok) {
      const err = new Error(json.error || `HTTP ${res.status}`);
      err.code = json.code;
      err.status = res.status;
      throw err;
    }
    return json.data;
  }

  async testConnection() {
    return this.request('/auth/me');
  }

  // Flatten a v2.0 tree to backend flat array.
  // Root keys: bookmark_bar / other / mobile.
  flatten(tree) {
    const flat = [];
    const roots = ['bookmark_bar', 'other', 'mobile'];
    for (const root of roots) {
      const rootNode = tree.roots?.[root];
      if (!rootNode || !Array.isArray(rootNode.children)) continue;
      this._walk(rootNode.children, null, '', root, flat);
    }
    return flat;
  }

  _walk(nodes, parentId, parentPath, root, out) {
    let pos = 0;
    for (const node of nodes) {
      const id = uuid();
      const path = parentPath + '/' + (node.name || '');
      if (node.type === 'folder') {
        out.push({
          id,
          type: 'folder',
          parent_id: parentId,
          root,
          name: node.name || '未命名文件夹',
          url: null,
          path,
          position: pos++,
          date_added: node.dateAdded || Date.now(),
          date_modified: node.dateModified || null,
        });
        if (Array.isArray(node.children)) {
          this._walk(node.children, id, path, root, out);
        }
      } else {
        out.push({
          id,
          type: 'url',
          parent_id: parentId,
          root,
          name: node.name || node.url,
          url: node.url,
          path,
          position: pos++,
          date_added: node.dateAdded || Date.now(),
          date_modified: node.dateModified || null,
        });
      }
    }
  }

  // Convert flat array back to v2.0 tree format.
  unflatten(flatArray) {
    const roots = {
      bookmark_bar: { id: '1', name: '书签栏', type: 'folder', children: [], dateAdded: Date.now() },
      other: { id: '2', name: '其他书签', type: 'folder', children: [], dateAdded: Date.now() },
      mobile: { id: '3', name: '移动书签', type: 'folder', children: [], dateAdded: Date.now() },
    };
    const nodeMap = new Map();
    const rootsMap = { bookmark_bar: roots.bookmark_bar, other: roots.other, mobile: roots.mobile };

    // Skip tombstones (deleted_at != null)
    const active = flatArray.filter((b) => !b.deleted_at);

    // First pass: create nodes
    for (const b of active) {
      nodeMap.set(b.id, {
        id: b.id,
        name: b.name,
        type: b.type,
        ...(b.type === 'url' ? { url: b.url } : { children: [] }),
        dateAdded: b.date_added || Date.now(),
        dateModified: b.date_modified || undefined,
      });
    }

    // Sort by position for deterministic order
    active.sort((a, b) => (a.position || 0) - (b.position || 0));

    // Second pass: link parents
    for (const b of active) {
      const node = nodeMap.get(b.id);
      if (!node) continue;
      if (b.parent_id && nodeMap.has(b.parent_id)) {
        const parent = nodeMap.get(b.parent_id);
        if (parent.type === 'folder') {
          parent.children = parent.children || [];
          parent.children.push(node);
        }
      } else {
        const rootNode = rootsMap[b.root];
        if (rootNode) rootNode.children.push(node);
      }
    }

    return {
      version: '2.0',
      lastSync: new Date().toISOString(),
      roots,
      meta: { generator: 'MarkSync v1.0' },
    };
  }

  async pull() {
    const data = await this.request('/sync/pull');
    return {
      tree: this.unflatten(data.bookmarks || []),
      raw: data.bookmarks,
      serverTime: data.server_time,
    };
  }

  async push(tree) {
    const flat = this.flatten(tree);
    // Increment sync: send all as added; server dedupes.
    return this.request('/sync/push', {
      method: 'POST',
      body: { added: flat, modified: [], removed: [] },
    });
  }

  async force(tree) {
    const flat = this.flatten(tree);
    return this.request('/sync/force', {
      method: 'POST',
      body: { bookmarks: flat },
    });
  }
}

// Storage helpers for MarkSync config
export async function getMarkSyncConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['marksync_api_url', 'marksync_token', 'backend_type'], (r) => {
      resolve({
        apiUrl: r.marksync_api_url || '',
        token: r.marksync_token || '',
        backendType: r.backend_type || 'gitee',
      });
    });
  });
}

export async function createMarkSyncClient() {
  const cfg = await getMarkSyncConfig();
  return new MarkSyncBackend({ apiUrl: cfg.apiUrl, token: cfg.token });
}
