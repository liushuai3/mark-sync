<template>
  <div>
    <n-card title="🔒 安全中心" v-if="auth.user?.is_admin">
      <!-- Login Attempts -->
      <n-grid :cols="2" :x-gap="16" style="margin-bottom: 20px">
        <n-grid-item>
          <n-statistic label="总失败尝试" :value="stats.totalAttempts" />
        </n-grid-item>
        <n-grid-item>
          <n-statistic label="被锁定账户" :value="lockedUsers.length" />
        </n-grid-item>
      </n-grid>

      <!-- Locked Users -->
      <n-collapse>
        <n-collapse-item title="🔐 被锁定账户" name="locked">
          <n-empty v-if="lockedUsers.length === 0" description="当前没有锁定的账户" />
          <n-data-table v-else :columns="lockedColumns" :data="lockedUsers" :pagination="false" />
        </n-collapse-item>

        <n-collapse-item title="⚠️ 可疑 IP" name="ips">
          <n-empty v-if="suspiciousIps.length === 0" description="没有检测到可疑 IP" />
          <n-data-table v-else :columns="ipColumns" :data="suspiciousIps" :pagination="false" />
        </n-collapse-item>
      </n-collapse>

      <n-space style="margin-top: 20px">
        <n-button type="primary" @click="refreshStats" :loading="loading">
          <template #icon><n-icon><RefreshOutline /></n-icon></template>
          刷新
        </n-button>
        <n-button @click="resetStats">重置计数器</n-button>
      </n-space>
    </n-card>

    <!-- Non-admin sees a simplified view -->
    <n-card v-else title="🔒 安全中心">
      <n-descriptions bordered :column="1">
        <n-descriptions-item label="密码加密">
          <n-tag type="success">Argon2id ✅</n-tag>
        </n-descriptions-item>
        <n-descriptions-item label="登录保护">
          <n-tag type="success">暴力破解防护开启 ✅</n-tag>
        </n-descriptions-item>
        <n-descriptions-item label="请求限流">
          <n-tag type="success">已启用 ✅</n-tag>
        </n-descriptions-item>
        <n-descriptions-item label="安全响应头">
          <n-tag type="success">已配置 ✅</n-tag>
        </n-descriptions-item>
      </n-descriptions>
    </n-card>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import { NIcon } from 'naive-ui';
import { RefreshOutline } from '@vicons/ionicons5';
import { useAuthStore } from '../stores/auth.js';
import { request } from '../api/client.js';

const auth = useAuthStore();
const stats = ref({ totalAttempts: 0, lockedUsers: [], suspiciousIps: [] });
const loading = ref(false);

const lockedUsers = computed(() => {
  const seen = new Set();
  return (stats.value.lockedUsers || []).filter(u => {
    if (seen.has(u.username)) return false;
    seen.add(u.username);
    return true;
  });
});

const suspiciousIps = computed(() => {
  const seen = new Set();
  return (stats.value.suspiciousIps || []).filter(i => {
    if (seen.has(i.ip)) return false;
    seen.add(i.ip);
    return true;
  });
});

const lockedColumns = [
  { title: '用户名', key: 'username' },
  {
    title: '锁定截止时间',
    key: 'lockedUntil',
    render(row) {
      if (!row.lockedUntil) return '—';
      const d = new Date(row.lockedUntil);
      const remaining = Math.max(0, Math.round((row.lockedUntil - Date.now()) / 1000 / 60));
      return `${d.toLocaleTimeString()} (剩余 ${remaining} 分钟)`;
    },
  },
];

const ipColumns = [
  { title: 'IP 地址', key: 'ip' },
  { title: '失败次数', key: 'failedCount' },
];

async function refreshStats() {
  loading.value = true;
  try {
    const res = await request('/security/status');
    stats.value = res;
  } catch (e) {
    console.error('Failed to fetch security stats:', e);
  } finally {
    loading.value = false;
  }
}

async function resetStats() {
  try {
    await request('/security/reset', { method: 'POST' });
    await refreshStats();
  } catch (e) {
    console.error('Failed to reset stats:', e);
  }
}

onMounted(refreshStats);
</script>
