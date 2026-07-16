import { createApp } from 'vue';
import { createPinia } from 'pinia';
import naive from 'naive-ui';
import App from './App.vue';
import router from './router.js';

async function bootstrap() {
  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.use(naive);
  await router.isReady();
  app.mount('#app');
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
  document.getElementById('app').innerHTML =
    '<div style="padding:40px;font-family:sans-serif"><h2>启动失败</h2><pre>' +
    (err?.message || err) +
    '</pre></div>';
});
