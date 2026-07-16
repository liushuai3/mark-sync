<template>
  <n-space vertical size="large">
    <!-- 自动备份配置 -->
    <n-card title="自动备份设置" :bordered="false">
      <n-form label-placement="left" label-width="140" :model="config">
        <n-form-item label="启用自动备份">
          <n-switch v-model:value="config.enabled" />
        </n-form-item>
        <n-form-item label="备份间隔">
          <n-input-number
            v-model:value="config.interval_hours"
            :min="1"
            :max="720"
            :disabled="!config.enabled"
            style="width: 200px"
          >
            <template #suffix>小时</template>
          </n-input-number>
          <span class="hint">（1 ~ 720 小时）</span>
        </n-form-item>
        <n-form-item label="每日锚点时刻">
          <n-input-number
            v-model:value="config.hour_of_day"
            :min="0"
            :max="23"
            :disabled="!config.enabled"
            style="width: 200px"
          >
            <template #suffix>时</template>
          </n-input-number>
          <span class="hint">（0 ~ 23，从此小时开始按间隔滚动）</span>
        </n-form-item>
        <n-form-item label="保留最近">
          <n-input-number
            v-model:value="config.keep_count"
            :min="1"
            :max="100"
            style="width: 200px"
          >
            <template #suffix>份</template>
          </n-input-number>
          <span class="hint">（超出会自动删除最旧的）</span>
        </n-form-item>
        <n-form-item label="下次自动备份">
          <span>{{ config.next_run_at && config.enabled ? formatDate(config.next_run_at) : '—' }}</span>
          <span class="hint">（服务器时区 UTC+8）</span>
        </n-form-item>
        <n-form-item label="上次自动备份">
          <span>{{ config.last_run_at ? formatDate(config.last_run_at) : '—' }}</span>
          <span class="hint">（服务器时区 UTC+8）</span>
        </n-form-item>
        <n-space>
          <n-button type="primary" :loading="saving" @click="onSaveConfig">保存配置</n-button>
          <n-button :loading="creating" @click="onCreateBackup">
            <template #icon>
              <n-icon><CloudUploadOutline /></n-icon>
            </template>
            立即手动备份
          </n-button>
          <n-upload
            :show-file-list="false"
            :custom-request="onUploadRestore"
            accept=".gz,.json"
            v-if="false"
          >
            <n-button>上传恢复</n-button>
          </n-upload>
        </n-space>
      </n-form>
    </n-card>

    <!-- 备份列表 -->
    <n-card title="备份历史" :bordered="false">
      <n-data-table
        :columns="columns"
        :data="backups"
        :loading="loading"
        :bordered="false"
        size="small"
      />
    </n-card>
  </n-space>
</template>

<script setup>
import { ref, onMounted, h } from 'vue';
import { NButton, NIcon, NTag, NSpace } from 'naive-ui';
import { useMessage, useDialog } from '../lib/naive-api.js';
import { CloudUploadOutline, TrashOutline, DownloadOutline, ArrowUndoOutline } from '@vicons/ionicons5';
import { backupsApi } from '../api/index.js';

const message = useMessage();
const dialog = useDialog();

const backups = ref([]);
const loading = ref(false);
const saving = ref(false);
const creating = ref(false);

const config = ref({
  enabled: false,
  interval_hours: 24,
  hour_of_day: 3,
  keep_count: 10,
  last_run_at: null,
  next_run_at: null,
});

const columns = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '名称', key: 'name' },
  {
    title: '类型',
    key: 'kind',
    render: (row) =>
      h(
        NTag,
        { size: 'small', type: row.kind === 'scheduled' ? 'info' : 'success' },
        { default: () => (row.kind === 'scheduled' ? '自动' : '手动') }
      ),
  },
  {
    title: '书签数',
    key: 'bookmark_count',
    render: (row) => row.bookmark_count,
  },
  {
    title: '大小',
    key: 'size',
    render: (row) => formatSize(row.size),
  },
  {
    title: '创建时间',
    key: 'created_at',
    render: (row) => formatDate(row.created_at),
  },
  {
    title: '操作',
    key: 'actions',
    width: 260,
    render: (row) =>
      h(NSpace, { size: 4 }, {
        default: () => [
          h(
            NButton,
            {
              size: 'tiny',
              quaternary: true,
              onClick: () => onDownload(row),
            },
            {
              icon: () => h(NIcon, null, { default: () => h(DownloadOutline) }),
              default: () => '下载',
            }
          ),
          h(
            NButton,
            {
              size: 'tiny',
              type: 'warning',
              quaternary: true,
              onClick: () => onRestore(row),
            },
            {
              icon: () => h(NIcon, null, { default: () => h(ArrowUndoOutline) }),
              default: () => '恢复',
            }
          ),
          h(
            NButton,
            {
              size: 'tiny',
              type: 'error',
              quaternary: true,
              onClick: () => onDelete(row),
            },
            {
              icon: () => h(NIcon, null, { default: () => h(TrashOutline) }),
              default: () => '删除',
            }
          ),
        ],
      }),
  },
];

async function loadAll() {
  loading.value = true;
  try {
    const [list, cfg] = await Promise.all([backupsApi.list(), backupsApi.getConfig()]);
    backups.value = list;
    config.value = {
      enabled: Boolean(cfg.enabled),
      interval_hours: cfg.interval_hours,
      hour_of_day: cfg.hour_of_day,
      keep_count: cfg.keep_count,
      last_run_at: cfg.last_run_at,
      next_run_at: cfg.next_run_at,
    };
  } catch (err) {
    message.error(err.message);
  } finally {
    loading.value = false;
  }
}

async function onSaveConfig() {
  saving.value = true;
  try {
    const cfg = await backupsApi.updateConfig({
      enabled: config.value.enabled,
      interval_hours: config.value.interval_hours,
      hour_of_day: config.value.hour_of_day,
      keep_count: config.value.keep_count,
    });
    config.value.last_run_at = cfg.last_run_at;
    config.value.next_run_at = cfg.next_run_at;
    message.success('配置已保存');
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

async function onCreateBackup() {
  creating.value = true;
  try {
    await backupsApi.create({});
    message.success('已创建备份');
    await loadAll();
  } catch (err) {
    message.error(err.message);
  } finally {
    creating.value = false;
  }
}

async function onDownload(row) {
  try {
    const token = localStorage.getItem('jwt');
    const res = await fetch(backupsApi.downloadUrl(row.id), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `marksync-backup-${row.id}.json.gz`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    message.error('下载失败：' + err.message);
  }
}

function onDelete(row) {
  dialog.warning({
    title: '删除备份',
    content: `确定删除备份 #${row.id}（${row.name}）吗？此操作不可撤销。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await backupsApi.remove(row.id);
        message.success('已删除');
        await loadAll();
      } catch (err) {
        message.error(err.message);
      }
    },
  });
}

function onRestore(row) {
  dialog.warning({
    title: '恢复备份',
    content: `将从备份 #${row.id}（${formatDate(row.created_at)}）恢复。当前所有书签将被覆盖，无法撤销。是否继续？`,
    positiveText: '确认恢复',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const res = await backupsApi.restore(row.id);
        message.success(`已恢复 ${res.restored} 条书签`);
        await loadAll();
      } catch (err) {
        message.error(err.message);
      }
    },
  });
}

// Placeholder for future upload-based restore
function onUploadRestore() {
  message.info('上传恢复功能开发中');
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  // Force Asia/Shanghai timezone regardless of browser locale
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

onMounted(loadAll);
</script>

<style scoped>
.hint {
  color: #999;
  font-size: 12px;
  margin-left: 8px;
}
</style>
