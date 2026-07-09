<template>
  <n-space vertical size="large">
    <n-card title="下载浏览器插件" :bordered="false">
      <n-alert type="success" :show-icon="false" style="margin-bottom: 16px">
        <strong>MarkSync 浏览器插件 v{{ extMeta.version }}</strong> — 支持 Chrome / Edge / Firefox
      </n-alert>
      <n-space>
        <n-button type="primary" size="large" tag="a" :href="extDownloadUrl" download>
          <template #icon><n-icon><DownloadOutline /></n-icon></template>
          下载插件 (.zip)
        </n-button>
        <n-button size="large" tag="a" href="/downloads/marksync-extension-latest.zip" download>
          <template #icon><n-icon><DownloadOutline /></n-icon></template>
          最新版（固定名）
        </n-button>
      </n-space>
    </n-card>

    <n-card title="安装指南" :bordered="false">
      <n-steps :current="-1">
        <n-step title="下载并解压">
          <template #description>
            点击上方按钮下载 <code>marksync-extension-{{ extMeta.version }}.zip</code>，解压到任意目录。
          </template>
        </n-step>
        <n-step title="打开浏览器扩展管理页">
          <template #description>
            <n-space vertical>
              <n-button size="tiny" @click="openUrl('chrome://extensions')">Chrome / Edge</n-button>
              <span>地址栏输入 <code>chrome://extensions</code> 或 <code>edge://extensions</code></span>
              <n-button size="tiny" @click="openUrl('about:debugging#/runtime/this-firefox')">Firefox</n-button>
              <span>输入 <code>about:debugging#/runtime/this-firefox</code> → 临时加载附加组件</span>
            </n-space>
          </template>
        </n-step>
        <n-step title="加载扩展">
          <template #description>
            <p>打开右上角 <strong>「开发者模式」</strong> 开关。</p>
            <p>点击 <strong>「加载已解压的扩展」</strong>，选择刚才解压的文件夹。</p>
          </template>
        </n-step>
        <n-step title="配置 API 连接">
          <template #description>
            右键扩展图标 → 「选项」或「设置」，填入下方的 API URL 和 Token。
          </template>
        </n-step>
      </n-steps>
    </n-card>

    <n-card title="配置信息" :bordered="false">
      <n-descriptions :column="1" label-placement="left" bordered>
        <n-descriptions-item label="API URL">
          <n-code>{{ apiUrl }}</n-code>
          <n-button size="tiny" quaternary style="margin-left: 8px" @click="copy(apiUrl)">
            <n-icon><CopyOutline /></n-icon>
          </n-button>
        </n-descriptions-item>
        <n-descriptions-item label="插件版本">
          v{{ extMeta.version }}
        </n-descriptions-item>
        <n-descriptions-item label="如何获取 Token">
          创建后可在「API Token」页面随时查看。
        </n-descriptions-item>
      </n-descriptions>
    </n-card>

    <n-card title="常见问题" :bordered="false">
      <n-collapse>
        <n-collapse-item title="插件无法连接？">
          <ul>
            <li>确认 API URL 以 <code>/api</code> 结尾</li>
            <li>确认 Token 未过期且在「API Token」页面未撤销</li>
            <li>如果使用 HTTPS，确保证书有效</li>
          </ul>
        </n-collapse-item>
        <n-collapse-item title="如何开启自动同步？">
          在扩展的「设置」页面勾选「启用自动同步」即可。书签变更后几秒内自动同步。
        </n-collapse-item>
        <n-collapse-item title="数据安全性？">
          所有数据通过 HTTPS 加密传输，Token 在服务端使用 AES-256 加密存储。
        </n-collapse-item>
      </n-collapse>
    </n-card>
  </n-space>
</template>

<script setup>
import { computed } from 'vue';
import { useMessage } from '../lib/naive-api.js';
import { DownloadOutline, CopyOutline } from '@vicons/ionicons5';
import { EXTENSION_META } from '../lib/extension-meta.js';

const message = useMessage();
const extMeta = EXTENSION_META;
const apiUrl = computed(() => `${window.location.origin}/api`);
const extDownloadUrl = `/downloads/marksync-extension-${extMeta.version}.zip`;

function openUrl(url) {
  window.open(url, '_blank');
}

function copy(text) {
  navigator.clipboard.writeText(text).then(
    () => message.success('已复制'),
    () => message.warning('复制失败')
  );
}
</script>
