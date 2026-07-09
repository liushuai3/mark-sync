// Unified sync service backed by the MarkSync self-hosted API.
// (Gitee Gist mode was removed in v1.2.0.)

import { MarkSyncBackend, getMarkSyncConfig } from './marksync.js';

async function getClient() {
  const cfg = await getMarkSyncConfig();
  return new MarkSyncBackend({ apiUrl: cfg.apiUrl, token: cfg.token });
}

function countUrls(tree) {
  let n = 0;
  const walk = (children) => {
    if (!Array.isArray(children)) return;
    for (const c of children) {
      if (c.type === 'url') n++;
      else if (c.type === 'folder') walk(c.children);
    }
  };
  if (tree?.roots) {
    walk(tree.roots.bookmark_bar?.children);
    walk(tree.roots.other?.children);
    walk(tree.roots.mobile?.children);
  }
  return n;
}

/**
 * Upload local bookmarks to the cloud (incremental).
 */
export async function syncLocalToCloud() {
  const { BookmarkManager } = await import('./bookmarkManager.js');
  const localBookmarks = await BookmarkManager.getAllBookmarks();
  const client = await getClient();
  const res = await client.push(localBookmarks);
  return {
    added: res.added_count || 0,
    skipped: res.skipped_count || 0,
    message: `本地同步到云端完成：新增 ${res.added_count || 0}，跳过 ${res.skipped_count || 0}`,
  };
}

/**
 * Download cloud bookmarks and merge into local.
 */
export async function syncCloudToLocal() {
  const { BookmarkManager } = await import('./bookmarkManager.js');
  const client = await getClient();
  const { tree } = await client.pull();
  await BookmarkManager.saveBookmarksToLocal(tree);
  return { message: `云端同步到本地完成，共 ${countUrls(tree)} 项` };
}

/**
 * Force upload: overwrite cloud with local.
 */
export async function forceSyncLocalToCloud() {
  const { BookmarkManager } = await import('./bookmarkManager.js');
  const localBookmarks = await BookmarkManager.getAllBookmarks();
  const client = await getClient();
  const res = await client.force(localBookmarks);
  return { message: `强制同步完成：总计 ${res.total} 项` };
}

/**
 * Test whether current backend config is usable.
 */
export async function testConnection() {
  const client = await getClient();
  const me = await client.testConnection();
  return { ok: true, message: `连接成功，用户：${me.username}` };
}

// Backwards compatibility constants (extension code may still import these).
export const BACKEND_MARKSYNC = 'marksync';
export async function getBackendType() { return BACKEND_MARKSYNC; }
export async function setBackendType() { /* no-op */ }
