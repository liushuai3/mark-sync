import { testConnection, setBackendType, BACKEND_MARKSYNC } from '../utils/syncService.js';

const STORAGE_KEYS = [
  'backend_type',
  'accessToken',
  'gistDescription',
  'encryptionKey',
  'marksync_api_url',
  'marksync_token',
  'autoSync',
];

document.addEventListener('DOMContentLoaded', async () => {
  const state = await new Promise((r) => chrome.storage.sync.get(STORAGE_KEYS, r));
  const backendType = state.backend_type || 'gitee';

  // Populate fields
  document.querySelector(`input[name="backend_type"][value="${backendType}"]`).checked = true;
  document.getElementById('accessToken').value = state.accessToken || '';
  document.getElementById('gistDescription').value = state.gistDescription || 'MarkSync';
  document.getElementById('encryptionKey').value = state.encryptionKey || '';
  document.getElementById('marksyncApiUrl').value = state.marksync_api_url || '';
  document.getElementById('marksyncToken').value = state.marksync_token || '';
  document.getElementById('autoSync').checked = state.autoSync || false;

  updatePanels(backendType);

  // Radio changes
  document.querySelectorAll('input[name="backend_type"]').forEach((radio) => {
    radio.addEventListener('change', (e) => updatePanels(e.target.value));
  });

  // Save
  document.getElementById('saveButton').addEventListener('click', async () => {
    const type = document.querySelector('input[name="backend_type"]:checked').value;
    const payload = {
      backend_type: type,
      autoSync: document.getElementById('autoSync').checked,
    };

    if (type === 'gitee') {
      const accessToken = document.getElementById('accessToken').value.trim();
      if (!accessToken) return showStatus('请输入 Gitee 访问令牌', 'error');
      payload.accessToken = accessToken;
      payload.gistDescription = document.getElementById('gistDescription').value.trim() || 'MarkSync';
      payload.encryptionKey = document.getElementById('encryptionKey').value;
    } else {
      const apiUrl = document.getElementById('marksyncApiUrl').value.trim();
      const token = document.getElementById('marksyncToken').value.trim();
      if (!apiUrl) return showStatus('请输入 API URL', 'error');
      if (!token) return showStatus('请输入 API Token', 'error');
      if (!token.startsWith('mks_')) return showStatus('Token 格式错误，应以 mks_ 开头', 'error');
      payload.marksync_api_url = apiUrl.replace(/\/$/, '');
      payload.marksync_token = token;
    }

    chrome.storage.sync.set(payload, () => {
      showStatus('设置已保存', 'success');
    });
  });

  // Test connection (MarkSync)
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

    // Temporarily persist so testConnection() picks them up
    await new Promise((r) =>
      chrome.storage.sync.set(
        {
          backend_type: BACKEND_MARKSYNC,
          marksync_api_url: apiUrl.replace(/\/$/, ''),
          marksync_token: token,
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

function updatePanels(type) {
  document.querySelectorAll('.backend-option').forEach((el) => {
    el.classList.toggle('active', el.dataset.value === type);
  });
  document.getElementById('gitee-panel').classList.toggle('active', type === 'gitee');
  document.getElementById('marksync-panel').classList.toggle('active', type === 'marksync');
}

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = type;
  setTimeout(() => {
    status.textContent = '';
    status.className = '';
  }, 3000);
}
