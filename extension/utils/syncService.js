// Unified sync service.
// Dispatches to either the existing Gitee-based BookmarkManager pipeline or the new MarkSync backend.

import { BookmarkManager } from './bookmarkManager.js';
import { MarkSyncBackend, getMarkSyncConfig } from './marksync.js';

export const BACKEND_GITEE = 'gitee';
export const BACKEND_MARKSYNC = 'marksync';

export async function getBackendType() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['backend_type'], (r) => {
      resolve(r.backend_type || BACKEND_GITEE);
    });
  });
}

export async function setBackendType(type) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ backend_type: type }, resolve);
  });
}

async function getMarkSyncClient() {
  const cfg = await getMarkSyncConfig();
  return new MarkSyncBackend({ apiUrl: cfg.apiUrl, token: cfg.token });
}

/**
 * Upload local bookmarks to the cloud (incremental).
 * Returns { added: number, message: string }
 */
export async function syncLocalToCloud() {
  const type = await getBackendType();
  const localBookmarks = await BookmarkManager.getAllBookmarks();

  if (type === BACKEND_MARKSYNC) {
    const client = await getMarkSyncClient();
    const res = await client.push(localBookmarks);
    return {
      added: res.added_count || 0,
      skipped: res.skipped_count || 0,
      message: `本地同步到云端完成：新增 ${res.added_count || 0}，跳过 ${res.skipped_count || 0}`,
    };
  }

  // Gitee path: find or create gist, merge new bookmarks in.
  let cloudBookmarks = null;
  try {
    cloudBookmarks = await BookmarkManager.downloadBookmarks();
  } catch {
    cloudBookmarks = null;
  }

  if (!cloudBookmarks) {
    // First upload: push everything
    await BookmarkManager.uploadBookmarks(localBookmarks);
    return { added: countUrls(localBookmarks), message: '首次同步完成' };
  }

  const newOnes = await BookmarkManager.findNewBookmarks(localBookmarks, cloudBookmarks);
  if (!newOnes || newOnes.length === 0) {
    return { added: 0, message: '没有新增书签' };
  }
  const merged = await BookmarkManager.mergeBookmarks(cloudBookmarks, newOnes);
  await BookmarkManager.uploadBookmarks(merged);
  return { added: newOnes.length, message: `本地同步到云端完成：新增 ${newOnes.length}` };
}

/**
 * Download cloud bookmarks and merge into local.
 */
export async function syncCloudToLocal() {
  const type = await getBackendType();

  let cloudBookmarks;
  if (type === BACKEND_MARKSYNC) {
    const client = await getMarkSyncClient();
    const { tree } = await client.pull();
    cloudBookmarks = tree;
  } else {
    cloudBookmarks = await BookmarkManager.downloadBookmarks();
    if (!cloudBookmarks) throw new Error('云端还没有书签数据');
  }

  await BookmarkManager.saveBookmarksToLocal(cloudBookmarks);
  return { message: '云端同步到本地完成' };
}

/**
 * Force upload: overwrite cloud with local.
 */
export async function forceSyncLocalToCloud() {
  const type = await getBackendType();
  const localBookmarks = await BookmarkManager.getAllBookmarks();

  if (type === BACKEND_MARKSYNC) {
    const client = await getMarkSyncClient();
    const res = await client.force(localBookmarks);
    return { message: `强制同步完成：总计 ${res.total} 项` };
  }

  await BookmarkManager.uploadBookmarks(localBookmarks);
  return { message: '强制同步完成' };
}

/**
 * Test whether current backend config is usable.
 */
export async function testConnection() {
  const type = await getBackendType();
  if (type === BACKEND_MARKSYNC) {
    const client = await getMarkSyncClient();
    const me = await client.testConnection();
    return { ok: true, message: `连接成功，用户：${me.username}` };
  }
  // Gitee: try listing gists.
  const gist = await BookmarkManager.findBookmarkGist();
  return {
    ok: true,
    message: gist ? `已找到云端 Gist (${gist.id.slice(0, 8)})` : '连接成功，云端暂无 Gist',
  };
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
