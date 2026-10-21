<template>
  <n-space vertical size="large">
    <!-- 注册开关（仅管理员可见） -->
    <n-card v-if="auth.user?.is_admin" title="注册设置" :bordered="false">
      <n-space align="center">
        <span>允许新用户注册：</span>
        <n-switch :value="regEnabled" :disabled="regLoading" @update:value="onToggleReg" />
        <n-tag v-if="regSource === 'database'" type="info" size="small">数据库配置</n-tag>
        <n-tag v-else type="default" size="small">环境变量</n-tag>
      </n-space>
    </n-card>

    <n-card title="服务信息" :bordered="false">
      <n-descriptions :column="1" bordered>
        <n-descriptions-item label="服务名称">{{ serverInfo?.service || '-' }}</n-descriptions-item>
        <n-descriptions-item label="版本号">{{ serverInfo?.version || '-' }}</n-descriptions-item>
        <n-descriptions-item label="运行时长">{{ serverInfo ? formatUptime(serverInfo.uptime) : '-' }}</n-descriptions-item>
      </n-descriptions>
      <p style="margin-top:12px;color:#999;font-size:13px">
        查看账号信息、修改邮箱或密码请点击右上角头像菜单。
      </p>
    </n-card>
  </n-space>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useMessage } from '../lib/naive-api.js';
import { useAuthStore } from '../stores/auth.js';
import { health } from '../api/client.js';
import { settingsApi } from '../api/index.js';

const auth = useAuthStore();
const message = useMessage();

const serverInfo = ref(null);
const regEnabled = ref(false);
const regLoading = ref(false);
const regSource = ref('');

async function loadRegistrationSetting() {
  try {
    const res = await settingsApi.getRegistration();
    regEnabled.value = res.enabled;
    regSource.value = res.source;
  } catch (err) {
    message.error('获取注册设置失败: ' + err.message);
  }
}

async function onToggleReg(value) {
  regLoading.value = true;
  try {
    await settingsApi.setRegistration(value);
    regEnabled.value = value;
    message.success(value ? '已开启注册' : '已关闭注册');
  } catch (err) {
    message.error(err.message);
    regEnabled.value = !value;
  } finally {
    regLoading.value = false;
  }
}

function formatUptime(sec) {
  if (!sec || sec < 0) return '-';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const parts = [];
  if (d > 0) parts.push(`${d} 天`);
  if (h > 0 || d > 0) parts.push(`${h} 小时`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m} 分钟`);
  parts.push(`${s} 秒`);
  return parts.join(' ');
}

onMounted(async () => {
  try {
    serverInfo.value = await health();
  } catch {}
  if (auth.user?.is_admin) {
    await loadRegistrationSetting();
  }
});
</script>
