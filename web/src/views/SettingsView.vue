<template>
  <n-space vertical size="large">
    <!-- 注册开关 -->
    <n-card title="注册设置" :bordered="false">
      <n-space align="center">
        <span>允许新用户注册：</span>
        <n-switch :value="regEnabled" :disabled="regLoading" @update:value="onToggleReg" />
        <n-tag v-if="regSource === 'database'" type="info" size="small">数据库配置</n-tag>
        <n-tag v-else type="default" size="small">环境变量</n-tag>
      </n-space>
    </n-card>

    <n-card title="账号信息" :bordered="false">
      <n-descriptions :column="1" bordered>
        <n-descriptions-item label="用户名">{{ auth.user?.username }}</n-descriptions-item>
        <n-descriptions-item label="邮箱">{{ auth.user?.email || '-' }}</n-descriptions-item>
        <n-descriptions-item label="角色">{{ auth.user?.is_admin ? '管理员' : '普通用户' }}</n-descriptions-item>
      </n-descriptions>
    </n-card>

    <n-card title="修改密码" :bordered="false">
      <n-form :model="pwdForm" style="max-width: 400px">
        <n-form-item label="当前密码">
          <n-input v-model:value="pwdForm.old_password" type="password" show-password-on="click" />
        </n-form-item>
        <n-form-item label="新密码">
          <n-input v-model:value="pwdForm.new_password" type="password" show-password-on="click" placeholder="至少 6 位" />
        </n-form-item>
        <n-form-item label="确认新密码">
          <n-input v-model:value="pwdForm.confirm" type="password" show-password-on="click" />
        </n-form-item>
        <n-button type="primary" :loading="changing" @click="onChangePassword">修改密码</n-button>
      </n-form>
    </n-card>

    <n-card title="服务信息" :bordered="false">
      <n-descriptions :column="1" bordered>
        <n-descriptions-item label="服务">{{ serverInfo?.service || '-' }}</n-descriptions-item>
        <n-descriptions-item label="版本">{{ serverInfo?.version || '-' }}</n-descriptions-item>
        <n-descriptions-item label="Uptime">{{ serverInfo ? formatUptime(serverInfo.uptime) : '-' }}</n-descriptions-item>
      </n-descriptions>
    </n-card>

    <n-card title="浏览器插件" :bordered="false">
      <n-space vertical>
        <n-alert type="info" :show-icon="false">
          <p><strong>安装方式（Chrome/Edge）：</strong></p>
          <p>1. 下载插件 zip 包并解压</p>
          <p>2. 浏览器访问 <code>chrome://extensions</code></p>
          <p>3. 打开“开发者模式” → “加载已解压的扩展” → 选择解压后的目录</p>
          <p>4. 在插件设置页面填入下方的 API URL 和 API Token</p>
        </n-alert>
        <n-space>
          <n-button type="primary" tag="a" :href="extDownloadUrl" download>
            <template #icon><n-icon><DownloadOutline /></n-icon></template>
            下载插件 v{{ extMeta.version }} (.zip)
          </n-button>
          <n-button tag="a" href="/downloads/marksync-extension-latest.zip" download>
            <template #icon><n-icon><DownloadOutline /></n-icon></template>
            最新版（固定名）
          </n-button>
        </n-space>
      </n-space>
    </n-card>

    <n-card title="扩展配置信息" :bordered="false">
      <n-alert type="info" :show-icon="false">
        <p><strong>在扩展的“设置”页面填入：</strong></p>
        <p>API URL: <code>{{ apiUrl }}</code></p>
        <p>API Token: 在“API Token”页面创建后填入</p>
      </n-alert>
    </n-card>
  </n-space>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import { DownloadOutline } from '@vicons/ionicons5';
import { useMessage } from '../lib/naive-api.js';
import { useAuthStore } from '../stores/auth.js';
import { authApi } from '../api/index.js';
import { health } from '../api/client.js';
import { settingsApi } from '../api/index.js';
import { EXTENSION_META } from '../lib/extension-meta.js';

const extMeta = EXTENSION_META;
const extDownloadUrl = `/downloads/marksync-extension-${extMeta.version}.zip`;

const auth = useAuthStore();
const message = useMessage();

const pwdForm = ref({ old_password: '', new_password: '', confirm: '' });
const changing = ref(false);
const serverInfo = ref(null);
const regEnabled = ref(false);
const regLoading = ref(false);
const regSource = ref('');

const apiUrl = computed(() => `${window.location.origin}/api`);

async function onChangePassword() {
  if (!pwdForm.value.old_password || !pwdForm.value.new_password) {
    return message.warning('请填写完整');
  }
  if (pwdForm.value.new_password.length < 6) {
    return message.warning('新密码至少 6 位');
  }
  if (pwdForm.value.new_password !== pwdForm.value.confirm) {
    return message.warning('两次输入的新密码不一致');
  }
  changing.value = true;
  try {
    await authApi.changePassword({
      old_password: pwdForm.value.old_password,
      new_password: pwdForm.value.new_password,
    });
    message.success('密码已修改');
    pwdForm.value = { old_password: '', new_password: '', confirm: '' };
  } catch (err) {
    message.error(err.message);
  } finally {
    changing.value = false;
  }
}

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
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}

onMounted(async () => {
  try {
    serverInfo.value = await health();
  } catch {}
  await loadRegistrationSetting();
});
</script>
