import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

export const useThemeStore = defineStore('theme', () => {
  const dark = ref(localStorage.getItem('theme_dark') === '1');

  function toggle() {
    dark.value = !dark.value;
  }

  watch(dark, (v) => {
    localStorage.setItem('theme_dark', v ? '1' : '0');
  });

  return { dark, toggle };
});
