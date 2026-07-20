<template>
  <div class="login-container">
    <n-card class="login-card" :bordered="false">
      <div class="brand">
        <img src="/logo.png" alt="MarkSync" style="width:48px;height:48px;border-radius:8px">
        <h1>MarkSync</h1>
        <p class="tagline">轻量级书签同步系统</p>
      </div>

      <n-tabs v-if="canRegister" v-model:value="mode" type="segment" animated>
        <n-tab-pane name="login" tab="登录">
          <n-form ref="loginRef" :model="loginForm" @submit.prevent="onLogin">
            <n-form-item path="username" label="用户名">
              <n-input v-model:value="loginForm.username" placeholder="用户名" />
            </n-form-item>
            <n-form-item path="password" label="密码">
              <n-input v-model:value="loginForm.password" type="password" show-password-on="click" placeholder="密码" @keydown.enter.prevent="onLogin" />
            </n-form-item>
            <n-button type="primary" block :loading="loading" @click="onLogin">登录</n-button>
          </n-form>
        </n-tab-pane>
        <n-tab-pane name="register" tab="注册">
          <n-form ref="registerRef" :model="registerForm" @submit.prevent="onRegister">
            <n-form-item path="username" label="用户名">
              <n-input v-model:value="registerForm.username" placeholder="至少 3 个字符" />
            </n-form-item>
            <n-form-item path="email" :label="emailRequired ? '邮箱' : '邮箱（可选）'">
              <n-input v-model:value="registerForm.email" placeholder="a@b.com" />
            </n-form-item>
            <n-form-item v-if="emailRequired" path="code" label="邮箱验证码">
              <n-input-group>
                <n-input v-model:value="registerForm.code" placeholder="6 位验证码" maxlength="6" />
                <n-button
                  :disabled="cooldownLeft > 0 || sending"
                  :loading="sending"
                  @click="onSendCode"
                >
                  {{ cooldownLeft > 0 ? `${cooldownLeft}s 后重发` : '发送验证码' }}
                </n-button>
              </n-input-group>
            </n-form-item>
            <n-form-item path="password" label="密码">
              <n-input v-model:value="registerForm.password" type="password" show-password-on="click" placeholder="至少 6 个字符" />
            </n-form-item>
            <n-button type="primary" block :loading="loading" @click="onRegister">注册并登录</n-button>
          </n-form>
        </n-tab-pane>
      </n-tabs>

      <!-- 注册关闭时只显示登录表单，避免 segment 只剩一个 tab 时样式异常 -->
      <template v-else>
        <n-form ref="loginRef" :model="loginForm" @submit.prevent="onLogin">
          <n-form-item path="username" label="用户名">
            <n-input v-model:value="loginForm.username" placeholder="用户名" />
          </n-form-item>
          <n-form-item path="password" label="密码">
            <n-input v-model:value="loginForm.password" type="password" show-password-on="click" placeholder="密码" @keydown.enter.prevent="onLogin" />
          </n-form-item>
          <n-button type="primary" block :loading="loading" @click="onLogin">登录</n-button>
        </n-form>
      </template>

      <div class="footer">
        <n-space vertical size="small">
          <n-space justify="space-between" align="center">
            <span class="version">v1.0</span>
            <span :class="['health', healthy ? 'ok' : 'err']">
              {{ healthy ? '● 服务在线' : '○ 服务离线' }}
            </span>
          </n-space>
          <n-button size="small" tertiary block tag="a" :href="extDownloadUrl" download>
            <template #icon><n-icon><DownloadOutline /></n-icon></template>
            下载浏览器插件 (.zip)
          </n-button>
        </n-space>
      </div>
    </n-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage } from '../lib/naive-api.js';
import { BookmarkOutline, DownloadOutline } from '@vicons/ionicons5';
import { useAuthStore } from '../stores/auth.js';
import { authApi } from '../api/index.js';
import { health } from '../api/client.js';
import { EXTENSION_META } from '../lib/extension-meta.js';

const extDownloadUrl = `/downloads/marksync-extension-v${EXTENSION_META.version}.zip`;

const router = useRouter();
const auth = useAuthStore();
const message = useMessage();

const mode = ref('login');
const loading = ref(false);
const sending = ref(false);
const cooldownLeft = ref(0);
let cooldownTimer = null;
const canRegister = ref(true);
const emailRequired = ref(false);
const healthy = ref(false);

const loginForm = ref({ username: '', password: '' });
const registerForm = ref({ username: '', password: '', email: '', code: '' });

onMounted(async () => {
  try {
    const status = await authApi.status();
    canRegister.value = status.can_register;
    emailRequired.value = !!status.email_verification && status.has_users;
    if (!status.has_users) mode.value = 'register';
  } catch {}

  try {
    await health();
    healthy.value = true;
  } catch {
    healthy.value = false;
  }
});

function startCooldown(sec) {
  cooldownLeft.value = sec;
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    cooldownLeft.value -= 1;
    if (cooldownLeft.value <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }, 1000);
}

async function onSendCode() {
  const email = (registerForm.value.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    message.error('请先输入有效邮箱');
    return;
  }
  sending.value = true;
  try {
    await authApi.sendCode(email, 'register');
    message.success('验证码已发送，请查看邮箱（5 分钟内有效）');
    startCooldown(60);
  } catch (err) {
    const retry = err?.data?.retry_after;
    if (retry) startCooldown(retry);
    message.error(err.message || '发送失败');
  } finally {
    sending.value = false;
  }
}

async function onLogin() {
  if (!loginForm.value.username || !loginForm.value.password) {
    message.error('请填写用户名和密码');
    return;
  }
  loading.value = true;
  try {
    await auth.login(loginForm.value.username, loginForm.value.password);
    router.replace('/app/dashboard');
    message.success('登录成功');
  } catch (err) {
    message.error(err.message || '登录失败');
  } finally {
    loading.value = false;
  }
}

async function onRegister() {
  if (!registerForm.value.username || !registerForm.value.password) {
    message.error('请填写用户名和密码');
    return;
  }
  if (registerForm.value.password.length < 6) {
    message.error('密码至少 6 位');
    return;
  }
  if (emailRequired.value) {
    if (!registerForm.value.email) {
      message.error('请填写邮箱');
      return;
    }
    if (!/^\d{6}$/.test(registerForm.value.code || '')) {
      message.error('请输入 6 位邮箱验证码');
      return;
    }
  }
  loading.value = true;
  try {
    await auth.register(
      registerForm.value.username,
      registerForm.value.password,
      registerForm.value.email,
      registerForm.value.code
    );
    router.replace('/app/dashboard');
    message.success('注册成功');
  } catch (err) {
    message.error(err.message || '注册失败');
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 20px;
}
.login-card {
  width: 100%;
  max-width: 420px;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}
.brand { text-align: center; margin-bottom: 24px; }
.brand h1 { margin: 12px 0 4px; font-size: 28px; }
.tagline { color: #999; font-size: 14px; margin: 0; }
.footer { margin-top: 20px; font-size: 12px; color: #999; }
.health.ok { color: #52c41a; }
.health.err { color: #f5222d; }
</style>
