import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth.js';

const routes = [
  { path: '/login', component: () => import('./views/LoginView.vue'), meta: { guest: true } },
  {
    path: '/',
    component: () => import('./layouts/MainLayout.vue'),
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', name: 'dashboard', component: () => import('./views/DashboardView.vue') },
      { path: 'bookmarks', name: 'bookmarks', component: () => import('./views/BookmarksView.vue') },
      { path: 'tokens', name: 'tokens', component: () => import('./views/TokensView.vue') },
      { path: 'sync-logs', name: 'sync-logs', component: () => import('./views/SyncLogsView.vue') },
      { path: 'backups', name: 'backups', component: () => import('./views/BackupsView.vue') },
      { path: 'settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.hydrate();
  if (to.meta.guest) {
    if (auth.isAuthenticated) return { name: 'dashboard' };
    return true;
  }
  if (!auth.isAuthenticated) return { path: '/login' };
  return true;
});

export default router;
