import {
  syncLocalToCloud,
  syncCloudToLocal,
  forceSyncLocalToCloud,
  getBackendType,
  BACKEND_MARKSYNC,
} from '../utils/syncService.js';
import { BookmarkManager } from '../utils/bookmarkManager.js';

document.addEventListener('DOMContentLoaded', async () => {
  const statusDiv = document.getElementById('status');

  // Show current backend in status area
  try {
    const type = await getBackendType();
    statusDiv.textContent = `当前后端: ${type === BACKEND_MARKSYNC ? 'MarkSync 自建后端' : 'Gitee Gist'}`;
  } catch {
    /* ignore */
  }

  document.getElementById('uploadBookmarks').addEventListener('click', async () => {
    try {
      statusDiv.textContent = '正在同步本地到云端...';
      const res = await syncLocalToCloud();
      statusDiv.textContent = res.message;
    } catch (error) {
      console.error('同步错误:', error);
      statusDiv.textContent = `错误: ${error.message}`;
    }
  });

  document.getElementById('downloadBookmarks').addEventListener('click', async () => {
    try {
      statusDiv.textContent = '正在从云端同步到本地...';
      const res = await syncCloudToLocal();
      statusDiv.textContent = res.message;
    } catch (error) {
      console.error('下载错误:', error);
      statusDiv.textContent = `错误: ${error.message}`;
    }
  });

  document.getElementById('clearLocal').addEventListener('click', async () => {
    try {
      if (confirm('确定要清除所有本地书签吗？此操作不可恢复！')) {
        statusDiv.textContent = '正在清除...';
        await BookmarkManager.clearLocalBookmarks();
        statusDiv.textContent = '清除成功！';
      }
    } catch (error) {
      statusDiv.textContent = `错误: ${error.message}`;
    }
  });

  document.getElementById('settingsButton').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('helpButton').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/help.html') });
  });

  document.getElementById('forceUpload').addEventListener('click', async () => {
    try {
      if (confirm('强制同步将完全覆盖云端书签，确定要继续吗？')) {
        statusDiv.textContent = '强制同步中...';
        const res = await forceSyncLocalToCloud();
        statusDiv.textContent = res.message;
      }
    } catch (error) {
      console.error('强制同步错误:', error);
      statusDiv.textContent = `错误: ${error.message}`;
    }
  });

  const remoteBookmarkButton = document.getElementById('remoteBookmarkButton');
  if (remoteBookmarkButton) {
    remoteBookmarkButton.addEventListener('click', async () => {
      const type = await getBackendType();
      if (type === BACKEND_MARKSYNC) {
        // Remote management for MarkSync is done on the web dashboard
        const cfg = await chrome.storage.sync.get(['marksync_api_url']);
        let dashboardUrl = cfg.marksync_api_url || '';
        dashboardUrl = dashboardUrl.replace(/\/api\/?$/, '') || 'https://bookmark.zcoolq.cn';
        chrome.tabs.create({ url: dashboardUrl });
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('popup/remote-bookmark.html') });
      }
    });
  }
});
