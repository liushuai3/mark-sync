<template>
  <div>
    <n-card :bordered="false" style="margin-bottom: 16px">
      <n-space justify="space-between" align="center">
        <n-alert type="info" :show-icon="false" style="max-width: 700px">
          用于浏览器扩展调用同步 API。<strong>Token 已加密存储，可随时通过 👁️ 按钮查看原文。</strong>
        </n-alert>
        <n-button type="primary" @click="showCreate = true">
          <template #icon>
            <n-icon><AddOutline /></n-icon>
          </template>
          创建新 Token
        </n-button>
      </n-space>
    </n-card>

    <n-card :bordered="false">
      <n-data-table
        :columns="columns"
        :data="tokens"
        :loading="loading"
        :bordered="false"
        size="small"
      />
    </n-card>

    <!-- 创建 -->
    <n-modal v-model:show="showCreate" preset="card" title="创建 API Token" style="width: 480px">
      <n-form>
        <n-form-item label="名称">
          <n-input v-model:value="newToken.name" placeholder="例：MacBook Chrome" />
        </n-form-item>
        <n-form-item label="过期时间">
          <n-select v-model:value="newToken.expires_in_days" :options="expireOptions" />
        </n-form-item>
      </n-form>
      <n-space justify="end">
        <n-button @click="showCreate = false">取消</n-button>
        <n-button type="primary" :loading="creating" @click="onCreate">创建</n-button>
      </n-space>
    </n-modal>

    <!-- 查看明文 -->
    <n-modal v-model:show="showToken" preset="card" title="API Token" style="width: 560px" :mask-closable="false">
      <n-alert type="info" style="margin-bottom: 16px">
        请复制此 Token 填入浏览器扩展。Token 已加密保管，可随时在列表中点 👁️ 查看。
      </n-alert>
      <n-input
        :value="plainToken"
        readonly
        :type="tokenVisible ? 'text' : 'password'"
        placeholder=""
      >
        <template #suffix>
          <n-button quaternary size="tiny" @click="tokenVisible = !tokenVisible">
            <template #icon>
              <n-icon><EyeOutline v-if="!tokenVisible" /><EyeOffOutline v-else /></n-icon>
            </template>
          </n-button>
        </template>
      </n-input>
      <n-space justify="end" style="margin-top: 12px">
        <n-button @click="copyToken">
          <template #icon>
            <n-icon><CopyOutline /></n-icon>
          </template>
          复制到剪贴板
        </n-button>
        <n-button type="primary" @click="closeTokenModal">关闭</n-button>
      </n-space>
    </n-modal>
  </div>
</template>

<script setup>
import { ref, onMounted, h } from 'vue';
import { NButton, NIcon, NTag, NSpace } from 'naive-ui';
import { useMessage, useDialog } from '../lib/naive-api.js';
import { AddOutline, TrashOutline, CopyOutline, EyeOutline, EyeOffOutline } from '@vicons/ionicons5';
import { tokensApi } from '../api/index.js';

const message = useMessage();
const dialog = useDialog();

const tokens = ref([]);
const loading = ref(false);
const showCreate = ref(false);
const showToken = ref(false);
const tokenVisible = ref(false);
const creating = ref(false);
const plainToken = ref('');
const newToken = ref({ name: '', expires_in_days: null });

const expireOptions = [
  { label: '永不过期', value: null },
  { label: '7 天', value: 7 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 },
  { label: '1 年', value: 365 },
];

const columns = [
  { title: '名称', key: 'name' },
  {
    title: '前缀',
    key: 'token_prefix',
    render: (row) => h('code', { style: 'background: rgba(0,0,0,0.05); padding: 2px 8px; border-radius: 4px' }, `${row.token_prefix}...`),
  },
  {
    title: '最后使用',
    key: 'last_used_at',
    render: (row) => (row.last_used_at ? formatDate(row.last_used_at) : h(NTag, { size: 'small', type: 'default' }, () => '从未使用')),
  },
  {
    title: '过期',
    key: 'expires_at',
    render: (row) => (row.expires_at ? formatDate(row.expires_at) : h(NTag, { size: 'small', type: 'info' }, () => '永不')),
  },
  { title: '创建', key: 'created_at', render: (row) => formatDate(row.created_at) },
  {
    title: '操作',
    key: 'actions',
    width: 200,
    render: (row) =>
      h(NSpace, { size: 4 }, {
        default: () => [
          h(
            NButton,
            {
              size: 'tiny',
              quaternary: true,
              disabled: !row.revealable,
              title: row.revealable ? '查看明文 Token' : '旧版 Token 无法找回',
              onClick: () => onReveal(row),
            },
            {
              icon: () => h(NIcon, null, { default: () => h(EyeOutline) }),
              default: () => '查看',
            }
          ),
          h(
            NButton,
            {
              size: 'tiny',
              type: 'error',
              quaternary: true,
              onClick: () => onRevoke(row),
            },
            {
              icon: () => h(NIcon, null, { default: () => h(TrashOutline) }),
              default: () => '撤销',
            }
          ),
        ],
      }),
  },
];

async function load() {
  loading.value = true;
  try {
    tokens.value = await tokensApi.list();
  } catch (err) {
    message.error(err.message);
  } finally {
    loading.value = false;
  }
}

async function onCreate() {
  if (!newToken.value.name.trim()) {
    message.warning('请输入名称');
    return;
  }
  creating.value = true;
  try {
    const data = await tokensApi.create({
      name: newToken.value.name.trim(),
      expires_in_days: newToken.value.expires_in_days,
    });
    plainToken.value = data.token;
    tokenVisible.value = false;
    showCreate.value = false;
    showToken.value = true;
    newToken.value = { name: '', expires_in_days: null };
    load();
  } catch (err) {
    message.error(err.message);
  } finally {
    creating.value = false;
  }
}

async function onReveal(row) {
  try {
    const data = await tokensApi.reveal(row.id);
    plainToken.value = data.token;
    tokenVisible.value = false;
    showToken.value = true;
  } catch (err) {
    message.error(err.message);
  }
}

function onRevoke(row) {
  dialog.warning({
    title: '撤销 Token',
    content: `确定撤销 "${row.name}" 吗？撤销后扩展将无法再使用此 Token 同步。`,
    positiveText: '撤销',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await tokensApi.revoke(row.id);
        message.success('已撤销');
        load();
      } catch (err) {
        message.error(err.message);
      }
    },
  });
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(plainToken.value);
    message.success('已复制到剪贴板');
  } catch {
    message.warning('复制失败，请手动复制');
  }
}

function closeTokenModal() {
  showToken.value = false;
  plainToken.value = '';
  tokenVisible.value = false;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

onMounted(load);
</script>
