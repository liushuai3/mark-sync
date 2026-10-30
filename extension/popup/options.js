/**
 * MarkSync options page (v3)
 *
 * 存储 key:
 *   chrome.storage.sync : marksync_api_url, marksync_token, autoSync, backend_type,
 *                         sync_interval_minutes (v4.1, 自动同步间隔)
 *
 * Legacy v2 keys to clean:
 *   sync   : accessToken, encryptionKey, gistDescription
 *   local  : accessToken, encryptionKey, gistDescription (若曾误写)
 */

const DEFAULT_API_URL = 'https://marksync.zcoolq.cn/api';
const DEFAULT_SYNC_INTERVAL_MINUTES = 30;
const SYNC_INTERVAL_MIN = 1;
const SYNC_INTERVAL_MAX = 1440; // 24 h
const STORAGE_KEYS = ['marksync_api_url', 'marksync_token', 'autoSync', 'sync_interval_minutes'];
const LEGACY_SYNC_KEYS = ['accessToken', 'encryptionKey', 'gistDescription'];
const LEGACY_LOCAL_KEYS = ['accessToken', 'encryptionKey', 'gistDescription'];

function storageSyncGet(keys) {
  return new Promise((r) => chrome.storage.sync.get(keys, (v) => r(v || {})));
}

function storageSyncSet(obj) {
  return new Promise((r) => chrome.storage.sync.set(obj, () => r()));
}

function storageSyncRemove(keys) {
  return new Promise((r) => chrome.storage.sync.remove(keys, () => r()));
}

function storageLocalRemove(keys) {
  return new Promise((r) => chrome.storage.local.remove(keys, () => r()));
}

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

function normalizeApiUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

/**
 * Read + validate the interval input. Returns an integer in
 * [SYNC_INTERVAL_MIN, SYNC_INTERVAL_MAX], or null when invalid — the
 * caller surfaces a status message instead of saving.
 */
function readSyncInterval() {
  const raw = document.getElementById('syncInterval').value.trim();
  if (raw === '') return DEFAULT_SYNC_INTERVAL_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < SYNC_INTERVAL_MIN || n > SYNC_INTERVAL_MAX) return null;
  return n;
}

/**
 * Ensure host permission for the given API URL.
 *
 * MV3: `chrome.permissions.request()` may only ask for origins declared in
 * the manifest — `optional_host_permissions` now covers all https/http
 * origins, so ANY self-hosted address can be authorized at runtime.
 * Chrome then shows its native "允许 MarkSync 访问 …" prompt; already-granted
 * origins (e.g. after a previous save) resolve silently.
 */
async function ensureHostPermission(apiUrl) {
  let originPattern;
  try {
    const u = new URL(apiUrl);
    originPattern = `${u.protocol}//${u.host}/*`;
  } catch {
    throw new Error('API URL 格式不合法');
  }

  const already = await new Promise((r) =>
    chrome.permissions.contains({ origins: [originPattern] }, (b) => r(Boolean(b)))
  );
  if (already) return true;

  return await new Promise((resolve, reject) => {
    try {
      chrome.permissions.request({ origins: [originPattern] }, (granted) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(Boolean(granted));
      });
    } catch (err) {
      reject(err);
    }
  });
}

function showStatus(message, kind = 'success', durationMs = 3500) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = kind;
  clearTimeout(showStatus._t);
  showStatus._t = setTimeout(() => {
    status.textContent = '';
    status.className = '';
  }, durationMs);
}

async function handleTestConnection() {
  const btn = document.getElementById('testConnBtn');
  const result = document.getElementById('testResult');
  const testApiUrl = normalizeApiUrl(document.getElementById('marksyncApiUrl').value);
  const testToken = document.getElementById('marksyncToken').value.trim();

  if (!testApiUrl || !testToken) {
    result.className = 'test-result err';
    result.textContent = '请先填写 API URL 和 Token';
    btn.disabled = false;
    return;
  }

  btn.disabled = true;
  result.className = 'test-result';
  result.textContent = '测试中...';
  result.style.display = 'block';

  // New origins must be authorized BEFORE the fetch — without host
  // permission the request is subject to CORS and fails confusingly.
  // Inside the click gesture, so Chrome can show its native prompt.
  try {
    const granted = await ensureHostPermission(testApiUrl);
    if (!granted) {
      result.className = 'test-result err';
      result.textContent = '❌ 未授权访问该域名，无法测试（可在保存时再次授权）';
      btn.disabled = false;
      return;
    }
  } catch (err) {
    result.className = 'test-result err';
    result.textContent = `❌ 授权失败：${err.message || err}`;
    btn.disabled = false;
    return;
  }

  try {
    const resp = await fetch(`${testApiUrl}/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${testToken}` },
    });
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try {
        const data = await resp.json();
        if (data && (data.message || data.error)) msg = data.message || data.error;
      } catch {}
      throw new Error(msg);
    }
    let user = null;
    try {
      user = await resp.json();
    } catch {}
    result.className = 'test-result ok';
    result.textContent = user && (user.username || user.email)
      ? `✅ 连接成功，用户：${user.username || user.email}`
      : '✅ 连接成功';
  } catch (err) {
    result.className = 'test-result err';
    result.textContent = `❌ ${err.message || '连接失败'}`;
  } finally {
    btn.disabled = false;
  }
}

async function cleanupLegacyKeys() {
  try {
    await storageSyncRemove(LEGACY_SYNC_KEYS);
    await storageLocalRemove(LEGACY_LOCAL_KEYS);
  } catch (err) {
    console.warn('legacy cleanup 失败', err);
  }
}

async function handleSave() {
  const btn = document.getElementById('saveButton');
  const apiUrl = normalizeApiUrl(document.getElementById('marksyncApiUrl').value);
  const token = document.getElementById('marksyncToken').value.trim();
  const autoSync = document.getElementById('autoSync').checked;
  const syncInterval = readSyncInterval();

  if (!apiUrl) return showStatus('请输入 API URL', 'error');
  if (!token) return showStatus('请输入 API Token', 'error');
  if (!token.startsWith('mks_')) return showStatus('Token 格式错误，应以 mks_ 开头', 'error');
  if (syncInterval === null) {
    return showStatus(
      `自动同步间隔需为 ${SYNC_INTERVAL_MIN}–${SYNC_INTERVAL_MAX} 的整数（分钟）`,
      'error'
    );
  }

  btn.disabled = true;
  try {
    // 1. Host permission
    const granted = await ensureHostPermission(apiUrl);
    if (!granted) {
      showStatus('未授权域名访问，无法保存', 'error');
      return;
    }

    // 2. Save
    await storageSyncSet({
      marksync_api_url: apiUrl,
      marksync_token: token,
      autoSync,
      sync_interval_minutes: syncInterval,
      backend_type: 'marksync',
    });

    // 3. Clean legacy
    await cleanupLegacyKeys();

    // 4. Initial merge or sync, depending on whether already done
    showStatus('正在同步…', 'success', 60_000);
    try {
      const mergeResp = await sendMessage({ type: 'INITIAL_MERGE' });
      if (mergeResp && mergeResp.ok && !mergeResp.skipped) {
        const a = mergeResp.added || 0;
        const created = mergeResp.createdLocally ?? 0;
        const m = mergeResp.matched || 0;
        const errors = mergeResp.createErrors ?? 0;
        const msg = [`拉取（在本地创建）${created} 条`, `上传 ${a} 条`, `匹配 ${m} 条`];
        if (errors > 0) msg.push(`⚠️ ${errors} 条创建失败`);
        showStatus(`✅ 合并完成：${msg.join(' · ')}`, errors > 0 ? 'warn' : 'success', 6000);
      } else if (mergeResp && mergeResp.reason === 'already_done') {
        // Already merged before — do a normal sync instead.
        const syncResp = await sendMessage({ type: 'SYNC_NOW' });
        if (syncResp && syncResp.ok) {
          const added = syncResp.added ?? 0;
          const modified = syncResp.modified ?? 0;
          const removed = syncResp.removed ?? 0;
          const remote = syncResp.remoteApplied ?? 0;
          if (added || modified || removed || remote) {
            showStatus(`✅ 同步完成：新增 ${added} · 修改 ${modified} · 删除 ${removed} · 远程 ${remote}`, 'success', 5000);
          } else {
            showStatus('✅ 已是最新', 'success', 3000);
          }
        } else {
          showStatus(`❌ 同步失败：${(syncResp && syncResp.error) || '未知错误'}`, 'error', 5000);
        }
      } else if (mergeResp && mergeResp.error) {
        showStatus(`❌ 同步失败：${mergeResp.error}`, 'error', 5000);
      } else if (mergeResp && mergeResp.skipped) {
        showStatus('⚠️ 同步被跳过（背景任务冲突）', 'warn', 5000);
      } else {
        showStatus('✅ 配置已保存', 'success', 3000);
      }
    } catch (err) {
      console.warn('INITIAL_MERGE 触发失败', err);
      showStatus(`❌ 同步请求失败：${err.message}`, 'error', 5000);
    }
  } catch (err) {
    showStatus(`保存失败：${err.message || err}`, 'error', 5000);
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const state = await storageSyncGet(STORAGE_KEYS);
  document.getElementById('marksyncApiUrl').value = state.marksync_api_url || DEFAULT_API_URL;
  document.getElementById('marksyncToken').value = state.marksync_token || '';
  document.getElementById('autoSync').checked = state.autoSync || false;
  document.getElementById('syncInterval').value =
    state.sync_interval_minutes || DEFAULT_SYNC_INTERVAL_MINUTES;

  // Eye toggle
  document.getElementById('toggleTokenBtn').addEventListener('click', () => {
    const input = document.getElementById('marksyncToken');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('testConnBtn').addEventListener('click', handleTestConnection);
  document.getElementById('saveButton').addEventListener('click', handleSave);
});
