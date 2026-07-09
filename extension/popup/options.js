import { testConnection } from '../utils/syncService.js';

const STORAGE_KEYS = ['marksync_api_url', 'marksync_token', 'autoSync'];

document.addEventListener('DOMContentLoaded', async () => {
  const state = await new Promise((r) => chrome.storage.sync.get(STORAGE_KEYS, r));

  document.getElementById('marksyncApiUrl').value = state.marksync_api_url || '';
  document.getElementById('marksyncToken').value = state.marksync_token || '';
  document.getElementById('autoSync').checked = state.autoSync || false;

  // Save
  document.getElementById('saveButton').addEventListener('click', async () => {
    const apiUrl = document.getElementById('marksyncApiUrl').value.trim();
    const token = document.getElementById('marksyncToken').value.trim();
    if (!apiUrl) return showStatus('请输入 API URL', 'error');
    if (!token) return showStatus('请输入 API Token', 'error');
    if (!token.startsWith('mks_')) return showStatus('Token 格式错误，应以 mks_ 开头', 'error');

    chrome.storage.sync.set(
      {
        marksync_api_url: apiUrl.replace(/\/$/, ''),
        marksync_token: token,
        autoSync: document.getElementById('autoSync').checked,
        backend_type: 'marksync', // legacy compatibility
      },
      () => showStatus('设置已保存', 'success')
    );
  });

  // Test connection
  document.getElementById('testConnBtn').addEventListener('click', async () => {
    const btn = document.getElementById('testConnBtn');
    const result = document.getElementById('testResult');
    btn.disabled = true;
    result.className = 'test-result';
    result.textContent = '测试中...';
    result.style.display = 'block';

    const apiUrl = document.getElementById('marksyncApiUrl').value.trim();
    const token = document.getElementById('marksyncToken').value.trim();

    if (!apiUrl || !token) {
      result.className = 'test-result err';
      result.textContent = '请先填写 API URL 和 Token';
      btn.disabled = false;
      return;
    }

    await new Promise((r) =>
      chrome.storage.sync.set(
        {
          marksync_api_url: apiUrl.replace(/\/$/, ''),
          marksync_token: token,
          backend_type: 'marksync',
        },
        r
      )
    );

    try {
      const res = await testConnection();
      result.className = 'test-result ok';
      result.textContent = '✅ ' + res.message;
    } catch (err) {
      result.className = 'test-result err';
      result.textContent = '❌ ' + (err.message || '连接失败');
    } finally {
      btn.disabled = false;
    }
  });
});

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = type;
  setTimeout(() => {
    status.textContent = '';
    status.className = '';
  }, 3000);
}
