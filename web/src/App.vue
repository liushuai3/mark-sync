<template>
  <n-config-provider :theme="themeStore.dark ? darkTheme : null" :locale="zhCN" :date-locale="dateZhCN">
    <router-view />
  </n-config-provider>
</template>

<script setup>
import { watch } from 'vue';
import { darkTheme, zhCN, dateZhCN } from 'naive-ui';
import { useThemeStore } from './stores/theme.js';
import { setDiscreteThemeDark } from './lib/naive-api.js';

const themeStore = useThemeStore();

// Sync theme with discrete API so message/dialog match dark mode
watch(
  () => themeStore.dark,
  (v) => setDiscreteThemeDark(v),
  { immediate: true }
);
</script>

<style>
html, body, #app {
  height: 100%;
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Ubuntu, sans-serif;
}
</style>
