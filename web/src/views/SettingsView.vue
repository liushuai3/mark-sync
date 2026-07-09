<template>
  <n-space vertical size="large">
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

    <n-card title="扩展安装" :bordered="false">
      <n-alert type="info" :show-icon="false">
        <p><strong>1. 在扩展设置里填入：</strong></p>
        <p>API URL: <code>{{ apiUrl }}</code></p>
        <p>API Token: 在"API Token"页面创建后填入</p>
      </n-alert>
    </n-card>
  </n-space>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import { useMessage } from '../lib/naive-api.js';
import { useAuthStore } from '../stores/auth.js';
import { authApi } from '../api/index.js';
import { health } from '../api/client.js';

const auth = useAuthStore();
const message = useMessage();

const pwdForm = ref({ old_password: '', new_password: '', confirm: '' });
const changing = ref(false);
const serverInfo = ref(null);

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
});
</script>
