import { syncLocalToCloud } from '../utils/syncService.js';

// Auto sync config
const AUTO_SYNC_INTERVAL = 30 * 60 * 1000; // 30 min
const MIN_SYNC_INTERVAL = 5 * 60 * 1000; // 5 min minimum between syncs
const DEBOUNCE_MS = 3000; // 3s debounce after last event

let syncTimeout = null;
let lastSyncTime = 0;

const getBrowser = () => {
  if (typeof chrome !== 'undefined') {
    if (typeof browser !== 'undefined') return 'firefox';
    return 'chrome';
  }
  return 'other';
};

const browserAPI = getBrowser() === 'firefox' ? browser : chrome;

browserAPI.bookmarks.onCreated.addListener(handleBookmarkChange);
browserAPI.bookmarks.onChanged.addListener(handleBookmarkChange);
browserAPI.bookmarks.onMoved.addListener(handleBookmarkChange);
browserAPI.bookmarks.onRemoved.addListener(handleBookmarkChange);

async function handleBookmarkChange() {
  try {
    if (syncTimeout) clearTimeout(syncTimeout);

    const { autoSync } = await browserAPI.storage.sync.get({ autoSync: false });
    if (!autoSync) return;

    const now = Date.now();
    if (now - lastSyncTime < MIN_SYNC_INTERVAL) return;

    syncTimeout = setTimeout(async () => {
      try {
        const result = await syncLocalToCloud();
        lastSyncTime = Date.now();

        if (result.added > 0) {
          try {
            await browserAPI.notifications.create({
              type: 'basic',
              iconUrl: browserAPI.runtime.getURL('icons/icon128.png'),
              title: 'MarkSync 书签同步',
              message: `自动同步完成，新增 ${result.added} 个书签`,
            });
          } catch (err) {
            console.log('通知显示失败:', err);
          }
        }
      } catch (error) {
        console.error('自动同步执行失败:', error);
      }
    }, DEBOUNCE_MS);
  } catch (error) {
    console.error('处理书签变化失败:', error);
  }
}

async function periodicSync() {
  try {
    const { autoSync } = await browserAPI.storage.sync.get({ autoSync: false });
    if (autoSync) await handleBookmarkChange();
  } catch (error) {
    console.error('定期同步检查失败:', error);
  } finally {
    setTimeout(periodicSync, AUTO_SYNC_INTERVAL);
  }
}
periodicSync();

browserAPI.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') console.log('MarkSync 已安装');
  else if (details.reason === 'update') console.log('MarkSync 已更新');
});

browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'authenticate') {
    sendResponse({ success: true });
  }
  return true;
});
