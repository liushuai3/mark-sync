<template>
  <div>
    <n-grid :cols="4" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
      <n-gi :span="4" :md="1">
        <StatCard title="书签总数" :value="stats?.total_bookmarks ?? '-'" :icon="BookmarksOutline" color="#2196F3" />
      </n-gi>
      <n-gi :span="4" :md="1">
        <StatCard title="文件夹" :value="stats?.total_folders ?? '-'" :icon="FolderOutline" color="#FF9800" />
      </n-gi>
      <n-gi :span="4" :md="1">
        <StatCard title="API Token" :value="stats?.total_tokens ?? '-'" :icon="KeyOutline" color="#4CAF50" />
      </n-gi>
      <n-gi :span="4" :md="1">
        <StatCard title="最近同步" :value="lastSync" :icon="TimeOutline" color="#9C27B0" small />
      </n-gi>
    </n-grid>

    <n-card title="最近同步记录" style="margin-top: 24px">
      <template #header-extra>
        <n-button size="small" @click="load" :loading="loading">刷新</n-button>
      </template>
      <n-empty v-if="!stats?.recent_syncs?.length" description="暂无同步记录" />
      <n-data-table
        v-else
        :columns="cols"
        :data="stats.recent_syncs"
        :pagination="false"
        :bordered="false"
        size="small"
      />
    </n-card>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, h } from 'vue';
import { NTag } from 'naive-ui';
import { useMessage } from '../lib/naive-api.js';
import { BookmarksOutline, FolderOutline, KeyOutline, TimeOutline } from '@vicons/ionicons5';
import { statsApi } from '../api/index.js';
import StatCard from '../components/StatCard.vue';

const message = useMessage();
const stats = ref(null);
const loading = ref(false);

const lastSync = computed(() => {
  if (!stats.value?.last_sync_at) return '未同步';
  return formatRelative(stats.value.last_sync_at);
});

const cols = [
  {
    title: '动作',
    key: 'action',
    render: (row) => {
      const map = { push: ['info', '推送'], pull: ['success', '拉取'], force_push: ['warning', '强制推送'] };
      const [type, text] = map[row.action] || ['default', row.action];
      return h(NTag, { type, size: 'small' }, { default: () => text });
    },
  },
  {
    title: '新增',
    key: 'added_count',
    render: (row) => (row.added_count > 0 ? `+${row.added_count}` : '-'),
  },
  {
    title: '修改',
    key: 'modified_count',
    render: (row) => (row.modified_count > 0 ? `~${row.modified_count}` : '-'),
  },
  {
    title: '删除',
    key: 'removed_count',
    render: (row) => (row.removed_count > 0 ? `-${row.removed_count}` : '-'),
  },
  { title: '设备', key: 'device_info', ellipsis: { tooltip: true } },
  { title: 'IP', key: 'ip' },
  {
    title: '时间',
    key: 'created_at',
    render: (row) => formatDate(row.created_at),
  },
];

async function load() {
  loading.value = true;
  try {
    stats.value = await statsApi.stats();
  } catch (err) {
    message.error(err.message);
  } finally {
    loading.value = false;
  }
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function formatRelative(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  return `${day} 天前`;
}

onMounted(load);
</script>
