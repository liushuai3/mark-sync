<template>
  <n-card :bordered="false">
    <n-data-table
      remote
      :columns="columns"
      :data="items"
      :loading="loading"
      :pagination="pagination"
      :bordered="false"
      size="small"
      striped
      @update:page="load"
      @update:page-size="onPageSize"
    />
  </n-card>
</template>

<script setup>
import { ref, onMounted, h } from 'vue';
import { NTag } from 'naive-ui';
import { useMessage } from '../lib/naive-api.js';
import { statsApi } from '../api/index.js';

const message = useMessage();
const items = ref([]);
const loading = ref(false);
const pagination = ref({
  page: 1,
  pageSize: 20,
  itemCount: 0,
  pageCount: 1,
  showSizePicker: true,
  pageSizes: [10, 20, 50, 100],
});

const columns = [
  {
    title: '时间',
    key: 'created_at',
    width: 180,
    render: (row) => new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }),
  },
  {
    title: '动作',
    key: 'action',
    width: 100,
    render: (row) => {
      const map = { push: ['info', '推送'], pull: ['success', '拉取'], force_push: ['warning', '强制推送'] };
      const [type, text] = map[row.action] || ['default', row.action];
      return h(NTag, { type, size: 'small' }, { default: () => text });
    },
  },
  {
    title: '新增',
    key: 'added_count',
    width: 80,
    render: (row) => (row.added_count > 0 ? `+${row.added_count}` : '-'),
  },
  {
    title: '修改',
    key: 'modified_count',
    width: 80,
    render: (row) => (row.modified_count > 0 ? `~${row.modified_count}` : '-'),
  },
  {
    title: '删除',
    key: 'removed_count',
    width: 80,
    render: (row) => (row.removed_count > 0 ? `-${row.removed_count}` : '-'),
  },
  { title: '设备 UA', key: 'device_info', ellipsis: { tooltip: true } },
  { title: 'IP', key: 'ip', width: 140 },
  { title: '耗时(ms)', key: 'duration_ms', width: 100 },
];

async function load(page = pagination.value.page) {
  loading.value = true;
  try {
    const data = await statsApi.syncLogs({ page, page_size: pagination.value.pageSize });
    items.value = data.items;
    pagination.value.itemCount = data.total;
    pagination.value.page = data.page;
    pagination.value.pageCount = Math.ceil(data.total / data.page_size);
  } catch (err) {
    message.error(err.message);
  } finally {
    loading.value = false;
  }
}

function onPageSize(size) {
  pagination.value.pageSize = size;
  load(1);
}

onMounted(() => load(1));
</script>
