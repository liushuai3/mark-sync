<template>
  <n-card :bordered="false">
    <n-data-table
      :columns="columns"
      :data="users"
      :loading="loading"
      :bordered="false"
      size="small"
    />
  </n-card>
</template>

<script setup>
import { ref, onMounted, h } from 'vue';
import { NButton, NIcon, NTag, NSpace, NSwitch } from 'naive-ui';
import { useMessage, useDialog } from '../lib/naive-api.js';
import { TrashOutline, RemoveRedEyeOutline } from '@vicons/ionicons5';
import { usersApi } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';

const auth = useAuthStore();
const message = useMessage();
const dialog = useDialog();

const users = ref([]);
const loading = ref(false);

const columns = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '用户名', key: 'username' },
  { title: '邮箱', key: 'email', render: (r) => r.email || '-' },
  {
    title: '角色',
    key: 'is_admin',
    width: 120,
    render: (row) =>
      h(NTag, { size: 'small', type: row.is_admin ? 'success' : 'default' }, () =>
        row.is_admin ? '管理员' : '普通用户'
      ),
  },
  { title: '注册时间', key: 'created_at', render: (r) => formatDate(r.created_at) },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    render: (row) =>
      h(
        NButton,
        {
          size: 'tiny',
          type: 'error',
          quaternary: true,
          disabled: row.is_admin || row.id === auth.user?.id,
          onClick: () => onDelete(row),
        },
        {
          icon: () => h(NIcon, null, { default: () => h(TrashOutline) }),
          default: () => '删除',
        }
      ),
  },
];

async function load() {
  loading.value = true;
  try {
    users.value = await usersApi.list();
  } catch (err) {
    message.error(err.message);
  } finally {
    loading.value = false;
  }
}

function onDelete(row) {
  dialog.warning({
    title: '删除用户',
    content: `确定删除用户 "${row.username}"（ID: ${row.id}）吗？该用户的书签数据也会一并删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await usersApi.remove(row.id);
        message.success('已删除');
        load();
      } catch (err) {
        message.error(err.message);
      }
    },
  });
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

onMounted(load);
</script>
