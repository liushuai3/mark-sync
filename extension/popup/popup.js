/**
 * MarkSync popup (v3)
 *
 * UI 侧只通过 chrome.runtime.sendMessage 与 background 通信。
 * 支持消息：SYNC_NOW / FORCE_UPLOAD / GET_STATE / INITIAL_MERGE
 */

const DEFAULT_API_URL = 'https://marksync.zcoolq.cn/api';

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['marksync_api_url', 'marksync_token'], (r) => resolve(r || {}));
  });
}

function formatRelativeTime(ts) {
  if (!ts) return '从未同步';
  const diff = Date.now() - Number(ts);
  // 超过 24h 直接显示完整日期
  if (diff > 24 * 60 * 60 * 1000) {
    const d = new Date(Number(ts));
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(Number(ts)).toISOString().slice(0, 19).replace('T', ' ');
}

function showToast(msg, kind = 'info', durationMs = 3500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.className = 'toast';
  }, durationMs);
}

function setLoading(button, on) {
  if (!button) return;
  if (on) {
    button.classList.add('loading');
    button.disabled = true;
  } else {
    button.classList.remove('loading');
    button.disabled = false;
  }
}

function renderState(payload) {
  const state = (payload && payload.state) || payload || {};
  const lastSync =
    state.last_sync_at ||
    state.lastSyncAt ||
    state.lastSyncTime ||
    state.last_pulled_at ||
    0;
  const bookmarkCount =
    (payload && (payload.idMapSize ?? payload.bookmarkCount)) ??
    state.idMapSize ??
    state.bookmarkCount ??
    0;
  const conflicts =
    state.last_conflicts ??
    state.conflicts ??
    state.conflictCount ??
    0;

  document.getElementById('lastSyncLabel').textContent = formatRelativeTime(lastSync);
  document.getElementById('bookmarkCountLabel').textContent = String(bookmarkCount);

  const row = document.getElementById('conflictsRow');
  const lbl = document.getElementById('conflictsLabel');
  if (Number(conflicts) > 0) {
    row.style.display = '';
    lbl.textContent = String(conflicts);
  } else {
    row.style.display = 'none';
  }
}

async function refreshState() {
  try {
    const resp = await sendMessage({ type: 'GET_STATE' });
    if (resp && resp.ok !== false) {
      renderState(resp);
    }
  } catch (err) {
    console.warn('GET_STATE 失败', err);
  }
}

async function handleSyncNow() {
  const btn = document.getElementById('syncNowBtn');
  setLoading(btn, true);
  showToast('正在同步...', 'info', 60_000);
  try {
    const resp = await sendMessage({ type: 'SYNC_NOW' });
    if (!resp || resp.ok === false) {
      throw new Error((resp && resp.error) || '同步失败');
    }
    const s = resp.summary || resp.stats || resp;
    const added = s.added ?? s.created ?? 0;
    const modified = s.modified ?? s.updated ?? 0;
    const deleted = s.deleted ?? s.removed ?? 0;
    const remoteApplied = s.remoteApplied ?? 0;
    const conflicts = s.conflicts ?? s.conflictCount ?? 0;
    const isInitial = !!(resp.initialMerge || s.initialMerge);

    if (isInitial) {
      const pulled = remoteApplied;
      const pushed = added;
      const matched = s.matched || 0;
      showToast(`首次合并完成：拉取 ${pulled} · 上传 ${pushed} · 匹配 ${matched}`, 'success', 5000);
    } else if (added === 0 && modified === 0 && deleted === 0 && remoteApplied === 0 && conflicts === 0) {
      showToast('已是最新', 'success');
    } else if (conflicts > 0) {
      showToast(`新增 ${added} · 修改 ${modified} · 删除 ${deleted} · ⚠️ ${conflicts} 冲突`, 'warn', 5000);
    } else {
      showToast(`新增 ${added} · 修改 ${modified} · 删除 ${deleted}`, 'success');
    }
    await refreshState();
  } catch (err) {
    showToast(`错误：${err.message || err}`, 'err', 5000);
  } finally {
    setLoading(btn, false);
  }
}

async function handleForceUpload() {
  if (!confirm('云端所有数据将被本地覆盖，确定？')) return;
  const btn = document.getElementById('forceUploadBtn');
  setLoading(btn, true);
  showToast('正在强制上传...', 'info', 60_000);
  try {
    const resp = await sendMessage({ type: 'FORCE_UPLOAD' });
    if (!resp || resp.ok === false) {
      throw new Error((resp && resp.error) || '强制上传失败');
    }
    const s = resp.summary || resp.stats || resp;
    const uploaded = s.uploaded ?? s.count ?? 0;
    showToast(`已上传 ${uploaded} 条书签`, 'success');
    await refreshState();
  } catch (err) {
    showToast(`错误：${err.message || err}`, 'err', 5000);
  } finally {
    setLoading(btn, false);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const cfg = await getConfig();
  const apiUrl = (cfg.marksync_api_url || '').trim();
  const token = (cfg.marksync_token || '').trim();
  const configured = Boolean(apiUrl && token);

  document.getElementById('mainPanel').style.display = configured ? '' : 'none';
  document.getElementById('unconfiguredPanel').style.display = configured ? 'none' : '';

  document.getElementById('settingsButton').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  const goSettings = document.getElementById('goSettingsButton');
  if (goSettings) {
    goSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
  }

  document.getElementById('helpButton').addEventListener('click', () => {
    const base = (apiUrl || DEFAULT_API_URL).replace(/\/api\/?$/, '');
    chrome.tabs.create({ url: base + '/help.html' });
  });

  document.getElementById('remoteBookmarkButton').addEventListener('click', () => {
    const base = (apiUrl || DEFAULT_API_URL).replace(/\/api\/?$/, '');
    chrome.tabs.create({ url: base + '/bookmarks' });
  });

  if (!configured) return;

  document.getElementById('syncNowBtn').addEventListener('click', handleSyncNow);
  document.getElementById('forceUploadBtn').addEventListener('click', handleForceUpload);

  await refreshState();
});
