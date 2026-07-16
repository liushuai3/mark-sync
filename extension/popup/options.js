/**
 * MarkSync options page (v3)
 *
 * 存储 key:
 *   chrome.storage.sync : marksync_api_url, marksync_token, autoSync, backend_type
 *
 * Legacy v2 keys to clean:
 *   sync   : accessToken, encryptionKey, gistDescription
 *   local  : accessToken, encryptionKey, gistDescription (若曾误写)
 */

const DEFAULT_API_URL = 'https://marksync.zcoolq.cn/api';
const DEFAULT_HOST = 'https://marksync.zcoolq.cn/*';
const STORAGE_KEYS = ['marksync_api_url', 'marksync_token', 'autoSync'];
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
 * Ensure host permission for the given API URL.
 * SRS §11.3: `https://marksync.zcoolq.cn/*` is a granted default; skip prompt when covered.
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
  btn.disabled = true;
  result.className = 'test-result';
  result.textContent = '测试中...';
  result.style.display = 'block';

  const apiUrl = normalizeApiUrl(document.getElementById('marksyncApiUrl').value);
  const token = document.getElementById('marksyncToken').value.trim();

  if (!apiUrl || !token) {
    result.className = 'test-result err';
    result.textContent = '请先填写 API URL 和 Token';
    btn.disabled = false;
    return;
  }

  try {
    const resp = await fetch(`${apiUrl}/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
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

  if (!apiUrl) return showStatus('请输入 API URL', 'error');
  if (!token) return showStatus('请输入 API Token', 'error');
  if (!token.startsWith('mks_')) return showStatus('Token 格式错误，应以 mks_ 开头', 'error');

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
      backend_type: 'marksync',
    });

    // 3. Clean legacy
    await cleanupLegacyKeys();

    // 4. Trigger initial merge and show its result
    showStatus('正在合并书签…', 'success', 60_000);
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
        // Initial merge already ran before — do a regular sync instead.
        showStatus('配置已保存，正在同步…', 'success', 60_000);
        const syncResp = await sendMessage({ type: 'SYNC_NOW' });
        const s = syncResp?.summary || syncResp?.stats || syncResp || {};
        const added = s.added ?? 0;
        const modified = s.modified ?? 0;
        const removed = s.removed ?? 0;
        const remoteApplied = s.remoteApplied ?? 0;
        const conflicts = s.conflicts ?? 0;
        if (added || modified || removed || remoteApplied) {
          showStatus(`✅ 同步完成：新增 ${added} · 修改 ${modified} · 删除 ${removed} · 远程 ${remoteApplied}`, conflicts > 0 ? 'warn' : 'success', 5000);
        } else {
          showStatus('✅ 已是最新', 'success', 3000);
        }
      } else if (mergeResp && mergeResp.error) {
        showStatus(`❌ 合并失败：${mergeResp.error}`, 'error', 5000);
      } else if (mergeResp && mergeResp.skipped) {
        showStatus('⚠️ 合并被跳过（可能是背景任务冲突）', 'warn', 5000);
      } else {
        showStatus('✅ 配置已保存', 'success', 3000);
      }
    } catch (err) {
      console.warn('INITIAL_MERGE 触发失败', err);
      showStatus(`❌ 合并请求失败：${err.message}`, 'error', 5000);
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

  // Eye toggle
  document.getElementById('toggleTokenBtn').addEventListener('click', () => {
    const input = document.getElementById('marksyncToken');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('testConnBtn').addEventListener('click', handleTestConnection);
  document.getElementById('saveButton').addEventListener('click', handleSave);
});
