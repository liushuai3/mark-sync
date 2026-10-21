<template>
  <div class="reset-container">
    <n-card class="reset-card" :bordered="false">
      <div class="brand">
        <img src="/logo.png" alt="MarkSync" style="width:48px;height:48px;border-radius:8px">
        <h1>重置密码</h1>
        <p class="tagline">通过邮箱验证码找回账号</p>
      </div>

      <n-form ref="formRef" :model="form" @submit.prevent="onSubmit">
        <n-form-item path="email" label="账号邮箱">
          <n-input v-model:value="form.email" placeholder="注册时使用的邮箱" />
        </n-form-item>
        <n-form-item path="code" label="邮箱验证码">
          <n-input-group>
            <n-input v-model:value="form.code" placeholder="6 位验证码" maxlength="6" />
            <n-button
              :disabled="cooldownLeft > 0 || sending"
              :loading="sending"
              @click="onSendCode"
            >
              {{ cooldownLeft > 0 ? `${cooldownLeft}s 后重发` : '发送验证码' }}
            </n-button>
          </n-input-group>
        </n-form-item>
        <n-form-item path="new_password" label="新密码">
          <n-input
            v-model:value="form.new_password"
            type="password"
            show-password-on="click"
            placeholder="至少 6 个字符"
          />
        </n-form-item>
        <n-form-item path="confirm" label="确认新密码">
          <n-input
            v-model:value="form.confirm"
            type="password"
            show-password-on="click"
            @keydown.enter.prevent="onSubmit"
          />
        </n-form-item>
        <n-button type="primary" block :loading="loading" @click="onSubmit">
          重置密码
        </n-button>
        <div class="footer">
          <n-button text @click="$router.push('/login')">← 返回登录</n-button>
        </div>
      </n-form>
    </n-card>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage } from '../lib/naive-api.js';
import { authApi } from '../api/index.js';

const router = useRouter();
const message = useMessage();

const form = ref({ email: '', code: '', new_password: '', confirm: '' });
const loading = ref(false);
const sending = ref(false);
const cooldownLeft = ref(0);
let cooldownTimer = null;

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
  const email = (form.value.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return message.error('请填写有效邮箱');
  }
  sending.value = true;
  try {
    await authApi.sendCode(email, 'reset_password');
    message.success('如果邮箱已注册，验证码将发送到您的邮箱（5 分钟内有效）');
    startCooldown(60);
  } catch (err) {
    const retry = err?.data?.retry_after;
    if (retry) startCooldown(retry);
    message.error(err.message || '发送失败');
  } finally {
    sending.value = false;
  }
}

async function onSubmit() {
  const email = (form.value.email || '').trim();
  if (!email) return message.warning('请填写邮箱');
  if (!/^\d{6}$/.test(form.value.code || '')) {
    return message.warning('请输入 6 位邮箱验证码');
  }
  if (!form.value.new_password || form.value.new_password.length < 6) {
    return message.warning('新密码至少 6 位');
  }
  if (form.value.new_password !== form.value.confirm) {
    return message.warning('两次输入的新密码不一致');
  }
  loading.value = true;
  try {
    await authApi.resetPassword({
      email,
      code: form.value.code,
      new_password: form.value.new_password,
    });
    message.success('密码已重置，请使用新密码登录');
    router.replace('/login');
  } catch (err) {
    message.error(err.message || '重置失败');
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.reset-container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 20px;
}
.reset-card {
  width: 100%;
  max-width: 420px;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}
.brand { text-align: center; margin-bottom: 24px; }
.brand h1 { margin: 12px 0 4px; font-size: 24px; }
.tagline { color: #999; font-size: 14px; margin: 0; }
.footer { margin-top: 12px; text-align: center; font-size: 12px; }
</style>
