<template>
  <n-modal
    :show="show"
    @update:show="(v) => emit('update:show', v)"
    preset="card"
    style="width: 460px"
    :title="title"
    size="small"
    :bordered="false"
    :segmented="{ content: 'soft' }"
    :mask-closable="!busy"
    :close-on-esc="!busy"
  >
    <!-- 我的信息 -->
    <n-descriptions v-if="mode === 'info'" :column="1" bordered label-placement="left">
      <n-descriptions-item label="用户名">{{ auth.user?.username || '-' }}</n-descriptions-item>
      <n-descriptions-item label="邮箱">{{ auth.user?.email || '（未绑定）' }}</n-descriptions-item>
      <n-descriptions-item label="角色">
        <n-tag :type="auth.user?.is_admin ? 'success' : 'default'" size="small">
          {{ auth.user?.is_admin ? '管理员' : '普通用户' }}
        </n-tag>
      </n-descriptions-item>
      <n-descriptions-item label="注册时间">{{ formatDate(auth.user?.created_at) }}</n-descriptions-item>
    </n-descriptions>

    <!-- 修改邮箱 -->
    <n-form v-else-if="mode === 'email'" :model="emailForm" label-placement="left" label-width="90">
      <p style="margin-top:0;color:#999;font-size:13px">
        验证码将发送到<b>新邮箱</b>，填入验证码后完成绑定。
      </p>
      <n-form-item label="当前邮箱">
        <n-input :value="auth.user?.email || '（未绑定）'" readonly />
      </n-form-item>
      <n-form-item label="新邮箱">
        <n-input v-model:value="emailForm.email" placeholder="new@example.com" />
      </n-form-item>
      <n-form-item label="验证码">
        <n-input-group>
          <n-input v-model:value="emailForm.code" placeholder="6 位验证码" maxlength="6" />
          <n-button
            :disabled="emailCooldown > 0 || emailSending"
            :loading="emailSending"
            @click="onSendEmailCode"
          >
            {{ emailCooldown > 0 ? `${emailCooldown}s` : '获取验证码' }}
          </n-button>
        </n-input-group>
      </n-form-item>
    </n-form>

    <!-- 修改密码 -->
    <n-form v-else :model="pwdForm" label-placement="left" label-width="90">
      <p v-if="auth.user?.email" style="margin-top:0;color:#999;font-size:13px">
        账号已绑定邮箱（{{ auth.user.email }}），修改密码需要邮箱验证。
      </p>
      <p v-else style="margin-top:0;color:#f0a020;font-size:13px">
        账号未绑定邮箱，将不进行邮箱验证。建议先绑定邮箱以增强账号安全。
      </p>
      <n-form-item label="当前密码">
        <n-input v-model:value="pwdForm.old_password" type="password" show-password-on="click" />
      </n-form-item>
      <n-form-item label="新密码">
        <n-input v-model:value="pwdForm.new_password" type="password" show-password-on="click" placeholder="至少 6 位" />
      </n-form-item>
      <n-form-item label="确认新密码">
        <n-input v-model:value="pwdForm.confirm" type="password" show-password-on="click" />
      </n-form-item>
      <n-form-item v-if="auth.user?.email" label="邮箱验证码">
        <n-input-group>
          <n-input v-model:value="pwdForm.code" placeholder="6 位验证码" maxlength="6" />
          <n-button
            :disabled="pwdCooldown > 0 || pwdSending"
            :loading="pwdSending"
            @click="onSendPwdCode"
          >
            {{ pwdCooldown > 0 ? `${pwdCooldown}s` : '获取验证码' }}
          </n-button>
        </n-input-group>
      </n-form-item>
    </n-form>

    <template #footer>
      <n-space justify="end">
        <n-button v-if="mode === 'info'" @click="close">关闭</n-button>
        <template v-else>
          <n-button @click="close" :disabled="busy">取消</n-button>
          <n-button
            v-if="mode === 'email'"
            type="primary"
            :loading="emailChanging"
            @click="onChangeEmail"
          >
            确认修改
          </n-button>
          <n-button v-else type="primary" :loading="changing" @click="onChangePassword">
            确认修改
          </n-button>
        </template>
      </n-space>
    </template>
  </n-modal>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { useMessage } from '../lib/naive-api.js';
import { useAuthStore } from '../stores/auth.js';
import { authApi } from '../api/index.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  mode: { type: String, default: 'info' }, // 'info' | 'email' | 'password'
});
const emit = defineEmits(['update:show']);

const auth = useAuthStore();
const message = useMessage();

const pwdForm = ref({ old_password: '', new_password: '', confirm: '', code: '' });
const changing = ref(false);
const pwdSending = ref(false);
const pwdCooldown = ref(0);
let pwdTimer = null;

const emailForm = ref({ email: '', code: '' });
const emailChanging = ref(false);
const emailSending = ref(false);
const emailCooldown = ref(0);
let emailTimer = null;

const busy = computed(() => changing.value || emailChanging.value);
const title = computed(() => {
  if (props.mode === 'info') return '我的信息';
  if (props.mode === 'email') return '修改绑定邮箱';
  return '修改密码';
});

function formatDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

watch(
  () => props.show,
  (v) => {
    if (v) {
      // 每次打开重置表单
      if (props.mode === 'email') {
        emailForm.value = { email: '', code: '' };
      } else {
        pwdForm.value = { old_password: '', new_password: '', confirm: '', code: '' };
      }
    }
  }
);

function close() {
  if (busy.value) return;
  emit('update:show', false);
}

function startCooldown(kind, sec) {
  if (kind === 'pwd') {
    pwdCooldown.value = sec;
    if (pwdTimer) clearInterval(pwdTimer);
    pwdTimer = setInterval(() => {
      pwdCooldown.value -= 1;
      if (pwdCooldown.value <= 0) {
        clearInterval(pwdTimer);
        pwdTimer = null;
      }
    }, 1000);
  } else {
    emailCooldown.value = sec;
    if (emailTimer) clearInterval(emailTimer);
    emailTimer = setInterval(() => {
      emailCooldown.value -= 1;
      if (emailCooldown.value <= 0) {
        clearInterval(emailTimer);
        emailTimer = null;
      }
    }, 1000);
  }
}

async function onSendPwdCode() {
  if (!auth.user?.email) return message.error('账号未绑定邮箱');
  pwdSending.value = true;
  try {
    await authApi.sendCode(auth.user.email, 'change_password');
    message.success('验证码已发送到您的邮箱（5 分钟内有效）');
    startCooldown('pwd', 60);
  } catch (err) {
    const retry = err?.data?.retry_after;
    if (retry) startCooldown('pwd', retry);
    message.error(err.message || '发送失败');
  } finally {
    pwdSending.value = false;
  }
}

async function onSendEmailCode() {
  const email = (emailForm.value.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return message.error('请填写有效的新邮箱');
  }
  if (email === auth.user?.email) {
    return message.error('新邮箱与当前邮箱相同');
  }
  emailSending.value = true;
  try {
    await authApi.sendCode(email, 'change_email');
    message.success('验证码已发送到新邮箱（5 分钟内有效）');
    startCooldown('email', 60);
  } catch (err) {
    const retry = err?.data?.retry_after;
    if (retry) startCooldown('email', retry);
    message.error(err.message || '发送失败');
  } finally {
    emailSending.value = false;
  }
}

async function onChangeEmail() {
  const email = (emailForm.value.email || '').trim();
  if (!email) return message.warning('请填写新邮箱');
  if (!/^\d{6}$/.test(emailForm.value.code || '')) {
    return message.warning('请输入 6 位邮箱验证码');
  }
  emailChanging.value = true;
  try {
    const u = await authApi.changeEmail({ email, code: emailForm.value.code });
    auth.setUser(u);
    message.success('邮箱已更新');
    emit('update:show', false);
  } catch (err) {
    message.error(err.message);
  } finally {
    emailChanging.value = false;
  }
}

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
  if (auth.user?.email && !/^\d{6}$/.test(pwdForm.value.code || '')) {
    return message.warning('请输入 6 位邮箱验证码');
  }
  changing.value = true;
  try {
    const body = {
      old_password: pwdForm.value.old_password,
      new_password: pwdForm.value.new_password,
    };
    if (auth.user?.email) body.code = pwdForm.value.code;
    await authApi.changePassword(body);
    message.success('密码已修改');
    emit('update:show', false);
  } catch (err) {
    message.error(err.message);
  } finally {
    changing.value = false;
  }
}
</script>
