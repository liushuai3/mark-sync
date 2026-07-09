import {
  syncLocalToCloud,
  syncCloudToLocal,
  forceSyncLocalToCloud,
} from '../utils/syncService.js';
import { BookmarkManager } from '../utils/bookmarkManager.js';

document.addEventListener('DOMContentLoaded', async () => {
  const statusDiv = document.getElementById('status');

  statusDiv.textContent = 'MarkSync 已就绪';

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
    chrome.tabs.create({ url: 'https://marksync.zcoolq.cn/help.html' });
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
      const cfg = await chrome.storage.sync.get(['marksync_api_url']);
      const base = (cfg.marksync_api_url || 'https://marksync.zcoolq.cn/api').replace(/\/api\/?$/, '');
      chrome.tabs.create({ url: base + '/bookmarks' });
    });
  }
});
