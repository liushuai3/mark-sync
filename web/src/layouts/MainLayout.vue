<template>
  <n-layout has-sider style="height: 100vh">
    <n-layout-sider
      :collapsed="collapsed"
      collapse-mode="width"
      :collapsed-width="64"
      :width="220"
      show-trigger
      @collapse="collapsed = true"
      @expand="collapsed = false"
      bordered
    >
      <div class="brand">
        <img src="/logo.png" alt="MarkSync" class="brand-logo" />
        <span v-if="!collapsed" class="brand-name">MarkSync</span>
      </div>
      <n-menu
        :collapsed="collapsed"
        :collapsed-width="64"
        :collapsed-icon-size="22"
        :options="visibleMenuOptions"
        :value="activeKey"
        @update:value="onMenuClick"
      />
    </n-layout-sider>

    <n-layout>
      <n-layout-header bordered class="header">
        <n-space justify="space-between" align="center" style="width: 100%">
          <div class="page-title">{{ pageTitle }}</div>
          <n-space align="center">
            <n-tag :type="healthy ? 'success' : 'error'" size="small">
              {{ healthy ? '● 后端在线' : '○ 后端离线' }}
            </n-tag>
            <n-button size="small" quaternary circle @click="themeStore.toggle()">
              <template #icon>
                <n-icon><SunnyOutline v-if="themeStore.dark" /><MoonOutline v-else /></n-icon>
              </template>
            </n-button>
            <n-dropdown :options="userMenu" @select="onUserMenu">
              <n-button quaternary>
                <template #icon>
                  <n-icon><PersonCircleOutline /></n-icon>
                </template>
                {{ auth.user?.username || '未登录' }}
              </n-button>
            </n-dropdown>
            <AccountModal v-model:show="accountModal.show" :mode="accountModal.mode" />
          </n-space>
        </n-space>
      </n-layout-header>

      <n-layout-content class="content">
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>

<script setup>
import { ref, computed, h, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { NIcon } from 'naive-ui';
import {
  BookmarkOutline,
  HomeOutline,
  KeyOutline,
  ListOutline,
  SettingsOutline,
  MoonOutline,
  SunnyOutline,
  PersonCircleOutline,
  LogOutOutline,
  BookmarksOutline,
  CloudUploadOutline,
  PeopleOutline,
  ExtensionPuzzleOutline,
  ShieldCheckmarkOutline,
  MailOutline,
  LockClosedOutline,
} from '@vicons/ionicons5';
import { useAuthStore } from '../stores/auth.js';
import { useThemeStore } from '../stores/theme.js';
import { health } from '../api/client.js';
import AccountModal from '../components/AccountModal.vue';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const themeStore = useThemeStore();

const collapsed = ref(false);
const healthy = ref(false);

const renderIcon = (icon) => () => h(NIcon, null, { default: () => h(icon) });

const menuOptions = [
  { label: '仪表盘', key: 'dashboard', icon: renderIcon(HomeOutline) },
  { label: '书签管理', key: 'bookmarks', icon: renderIcon(BookmarksOutline) },
  { label: '备份与恢复', key: 'backups', icon: renderIcon(CloudUploadOutline) },
  { label: '浏览器插件', key: 'extension', icon: renderIcon(ExtensionPuzzleOutline) },
  { label: '用户管理', key: 'users', icon: renderIcon(PeopleOutline), show: () => auth.user?.is_admin },
  { label: 'API Token', key: 'tokens', icon: renderIcon(KeyOutline) },
  { label: '同步日志', key: 'sync-logs', icon: renderIcon(ListOutline) },
  { label: '设置', key: 'settings', icon: renderIcon(SettingsOutline) },
  { label: '安全中心', key: 'security', icon: renderIcon(ShieldCheckmarkOutline), show: () => auth.user?.is_admin },
];

const userMenu = [
  { label: '我的信息', key: 'my-info', icon: renderIcon(PersonCircleOutline) },
  { type: 'divider', key: 'd0' },
  { label: '修改邮箱', key: 'change-email', icon: renderIcon(MailOutline) },
  { label: '修改密码', key: 'change-password', icon: renderIcon(LockClosedOutline) },
  { type: 'divider', key: 'd1' },
  { label: '退出登录', key: 'logout', icon: renderIcon(LogOutOutline) },
];

const accountModal = ref({ show: false, mode: 'info' });

const activeKey = computed(() => route.name || 'dashboard');
const visibleMenuOptions = computed(() =>
  menuOptions.filter((o) => !o.show || o.show())
);
const pageTitle = computed(() => {
  const found = menuOptions.find((m) => m.key === activeKey.value);
  return found?.label || 'MarkSync';
});

function onMenuClick(key) {
  router.push({ name: key });
}

function onUserMenu(key) {
  if (key === 'logout') {
    auth.logout();
    router.replace('/login');
  } else if (key === 'my-info') {
    accountModal.value = { show: true, mode: 'info' };
  } else if (key === 'change-email') {
    accountModal.value = { show: true, mode: 'email' };
  } else if (key === 'change-password') {
    accountModal.value = { show: true, mode: 'password' };
  }
}

onMounted(async () => {
  try {
    await health();
    healthy.value = true;
  } catch {
    healthy.value = false;
  }
  setInterval(async () => {
    try {
      await health();
      healthy.value = true;
    } catch {
      healthy.value = false;
    }
  }, 30_000);
});
</script>

<style scoped>
.brand {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 20px;
  border-bottom: 1px solid var(--n-border-color);
  font-weight: 600;
}
.brand-logo {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  flex-shrink: 0;
  object-fit: contain;
}
.brand-name { font-size: 18px; }
.header {
  height: 56px;
  padding: 0 24px;
  display: flex;
  align-items: center;
}
.page-title { font-size: 18px; font-weight: 600; }
.content { padding: 24px; overflow: auto; }
</style>
