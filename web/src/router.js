import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth.js';

const routes = [
  { path: '/', name: 'landing', component: () => import('./views/LandingView.vue'), meta: { public: true } },
  { path: '/login', component: () => import('./views/LoginView.vue'), meta: { guest: true } },
  {
    path: '/app',
    component: () => import('./layouts/MainLayout.vue'),
    redirect: '/app/dashboard',
    children: [
      { path: 'dashboard', name: 'dashboard', component: () => import('./views/DashboardView.vue') },
      { path: 'bookmarks', name: 'bookmarks', component: () => import('./views/BookmarksView.vue') },
      { path: 'tokens', name: 'tokens', component: () => import('./views/TokensView.vue') },
      { path: 'sync-logs', name: 'sync-logs', component: () => import('./views/SyncLogsView.vue') },
      { path: 'backups', name: 'backups', component: () => import('./views/BackupsView.vue') },
      { path: 'extension', name: 'extension', component: () => import('./views/ExtensionView.vue') },
      { path: 'users', name: 'users', component: () => import('./views/UsersView.vue') },
      { path: 'settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
      { path: 'security', name: 'security', component: () => import('./views/SecurityView.vue'), meta: { admin: true } },
    ],
  },
  // 兼容旧链接
  { path: '/dashboard', redirect: '/app/dashboard' },
  { path: '/bookmarks', redirect: '/app/bookmarks' },
  { path: '/tokens', redirect: '/app/tokens' },
  { path: '/sync-logs', redirect: '/app/sync-logs' },
  { path: '/backups', redirect: '/app/backups' },
  { path: '/extension', redirect: '/app/extension' },
  { path: '/users', redirect: '/app/users' },
  { path: '/settings', redirect: '/app/settings' },
  { path: '/security', redirect: '/app/security' },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.hydrate();
  // 落地页：所有人都能访问，不做跳转
  if (to.meta.public) return true;
  // 登录页：已登录用户跳到管理台
  if (to.meta.guest) {
    if (auth.isAuthenticated) return { path: '/app/dashboard' };
    return true;
  }
  // 其余为受保护页面
  if (!auth.isAuthenticated) return { path: '/login' };
  return true;
});

export default router;
