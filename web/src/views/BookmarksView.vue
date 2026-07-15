<template>
  <div>
    <n-card :bordered="false" style="margin-bottom: 16px">
      <n-space justify="space-between" align="center">
        <n-input
          v-model:value="search"
          placeholder="搜索名称或 URL"
          clearable
          style="width: 320px"
          @keyup.enter="load(1)"
        >
          <template #prefix>
            <n-icon><SearchOutline /></n-icon>
          </template>
        </n-input>
        <n-space>
          <n-select
            v-model:value="root"
            :options="rootOptions"
            style="width: 140px"
            placeholder="所有根"
            clearable
            @update:value="load(1)"
          />
          <n-select
            v-model:value="type"
            :options="typeOptions"
            style="width: 120px"
            placeholder="所有类型"
            clearable
            @update:value="load(1)"
          />
          <n-button @click="load(1)" :loading="loading">刷新</n-button>
          <n-button type="error" :disabled="!checkedRowKeys.length" @click="onBatchDelete">
            批量删除 ({{ checkedRowKeys.length }})
          </n-button>
          <n-button @click="exportJson">导出 JSON</n-button>
          <n-button @click="exportHtml">导出 HTML</n-button>
        </n-space>
      </n-space>
    </n-card>

    <n-card :bordered="false">
      <n-data-table
        remote
        :columns="columns"
        :data="items"
        :loading="loading"
        :pagination="pagination"
        :row-key="(row) => row.id"
        v-model:checked-row-keys="checkedRowKeys"
        @update:page="load"
        @update:page-size="onPageSize"
        :bordered="false"
        size="small"
        striped
      />
    </n-card>

    <n-modal v-model:show="editModal" preset="card" title="编辑书签" style="width: 480px">
      <n-form>
        <n-form-item label="名称">
          <n-input v-model:value="editForm.name" />
        </n-form-item>
        <n-form-item v-if="editForm.type === 'url'" label="URL">
          <n-input v-model:value="editForm.url" />
        </n-form-item>
      </n-form>
      <n-space justify="end">
        <n-button @click="editModal = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="onSave">保存</n-button>
      </n-space>
    </n-modal>
  </div>
</template>

<script setup>
import { ref, onMounted, h } from 'vue';
import { NButton, NIcon, NTag, NSpace } from 'naive-ui';
import { useMessage, useDialog } from '../lib/naive-api.js';
import { SearchOutline, PencilOutline, TrashOutline, OpenOutline, FolderOutline } from '@vicons/ionicons5';
import { bookmarksApi } from '../api/index.js';

const message = useMessage();
const dialog = useDialog();

const items = ref([]);
const loading = ref(false);
const search = ref('');
const root = ref(null);
const type = ref(null);
const checkedRowKeys = ref([]);
const editModal = ref(false);
const saving = ref(false);
const editForm = ref({ id: '', name: '', url: '', root: 'bookmark_bar', type: 'url' });

const rootLabel = (r) =>
  r === 'bookmark_bar' ? '书签栏' : r === 'other' ? '其他书签' : r === 'mobile' ? '移动书签' : '-';

const pagination = ref({ page: 1, pageSize: 50, pageCount: 1, itemCount: 0, showSizePicker: true, pageSizes: [20, 50, 100, 200] });

const rootOptions = [
  { label: '书签栏', value: 'bookmark_bar' },
  { label: '其他书签', value: 'other' },
  { label: '移动书签', value: 'mobile' },
];
const typeOptions = [
  { label: '文件夹', value: 'folder' },
  { label: '书签', value: 'url' },
];

const columns = [
  { type: 'selection' },
  {
    title: '类型',
    key: 'type',
    width: 80,
    render: (row) => {
      if (row.type === 'folder') {
        return h(NIcon, { color: '#FF9800' }, { default: () => h(FolderOutline) });
      }
      return row.url
        ? h('img', {
            src: `https://www.google.com/s2/favicons?domain=${new URL(row.url).hostname}&sz=32`,
            style: 'width:16px;height:16px;vertical-align:middle',
            onError: (e) => (e.target.style.display = 'none'),
          })
        : '';
    },
  },
  { title: '名称', key: 'name', ellipsis: { tooltip: true } },
  {
    title: 'URL',
    key: 'url',
    ellipsis: { tooltip: true },
    render: (row) =>
      row.url
        ? h(
            'a',
            { href: row.url, target: '_blank', style: 'color: var(--primary); text-decoration: none' },
            row.url
          )
        : '-',
  },
  {
    title: '所在根',
    key: 'root',
    width: 120,
    render: (row) => rootLabel(row.root),
  },
  {
    title: '添加时间',
    key: 'date_added',
    width: 160,
    render: (row) => (row.date_added ? new Date(row.date_added).toLocaleString('zh-CN', { hour12: false }) : '-'),
  },
  {
    title: '操作',
    key: 'actions',
    width: 160,
    render: (row) =>
      h(NSpace, { size: 'small' }, {
        default: () => [
          row.url
            ? h(
                NButton,
                { size: 'tiny', quaternary: true, onClick: () => window.open(row.url, '_blank') },
                {
                  icon: () => h(NIcon, null, { default: () => h(OpenOutline) }),
                }
              )
            : null,
          h(
            NButton,
            { size: 'tiny', quaternary: true, onClick: () => onEdit(row) },
            { icon: () => h(NIcon, null, { default: () => h(PencilOutline) }) }
          ),
          h(
            NButton,
            { size: 'tiny', quaternary: true, type: 'error', onClick: () => onDelete(row) },
            { icon: () => h(NIcon, null, { default: () => h(TrashOutline) }) }
          ),
        ],
      }),
  },
];

async function load(page = pagination.value.page) {
  loading.value = true;
  try {
    const data = await bookmarksApi.list({
      page,
      page_size: pagination.value.pageSize,
      search: search.value,
      root: root.value,
      type: type.value,
    });
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

function onEdit(row) {
  editForm.value = {
    id: row.id,
    name: row.name,
    url: row.url || '',
    root: row.root,
    type: row.type,
  };
  editModal.value = true;
}

async function onSave() {
  saving.value = true;
  try {
    await bookmarksApi.update(editForm.value.id, {
      name: editForm.value.name,
      url: editForm.value.url || undefined,
    });
    message.success('已保存');
    editModal.value = false;
    load();
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

function onDelete(row) {
  dialog.warning({
    title: '确认删除',
    content: `确定删除 "${row.name}" 吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await bookmarksApi.delete(row.id);
        message.success('已删除');
        load();
      } catch (err) {
        message.error(err.message);
      }
    },
  });
}

function onBatchDelete() {
  dialog.warning({
    title: '确认批量删除',
    content: `确定删除选中的 ${checkedRowKeys.value.length} 项吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const data = await bookmarksApi.batchDelete(checkedRowKeys.value);
        message.success(`已删除 ${data.deleted} 项`);
        checkedRowKeys.value = [];
        load();
      } catch (err) {
        message.error(err.message);
      }
    },
  });
}

async function exportJson() {
  try {
    const tree = await bookmarksApi.tree();
    downloadFile('bookmarks.json', JSON.stringify(tree, null, 2), 'application/json');
  } catch (err) {
    message.error(err.message);
  }
}

async function exportHtml() {
  try {
    const tree = await bookmarksApi.tree();
    const html = treeToNetscape(tree);
    downloadFile('bookmarks.html', html, 'text/html');
  } catch (err) {
    message.error(err.message);
  }
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function treeToNetscape(tree) {
  const escape = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const renderNode = (node, indent = '    ') => {
    let out = '';
    for (const child of node.children || []) {
      if (child.type === 'folder') {
        out += `${indent}<DT><H3>${escape(child.name)}</H3>\n`;
        out += `${indent}<DL><p>\n`;
        out += renderNode(child, indent + '    ');
        out += `${indent}</DL><p>\n`;
      } else if (child.type === 'url') {
        out += `${indent}<DT><A HREF="${escape(child.url)}">${escape(child.name)}</A>\n`;
      }
    }
    return out;
  };
  let html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n';
  html += '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n';
  html += '<TITLE>MarkSync Bookmarks</TITLE>\n';
  html += '<H1>Bookmarks</H1>\n<DL><p>\n';
  for (const root of ['bookmark_bar', 'other', 'mobile']) {
    const rootNode = tree[root];
    if (!rootNode?.children?.length) continue;
    html += `    <DT><H3>${escape(rootNode.name)}</H3>\n`;
    html += '    <DL><p>\n';
    html += renderNode(rootNode, '        ');
    html += '    </DL><p>\n';
  }
  html += '</DL><p>\n';
  return html;
}

onMounted(() => load(1));
</script>
