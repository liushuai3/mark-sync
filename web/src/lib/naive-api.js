// Discrete API: works outside n-*-provider trees.
// This is the recommended approach for cases where the message/dialog usage
// races with async route components. See:
// https://www.naiveui.com/en-US/os-theme/components/discrete
import { createDiscreteApi, darkTheme } from 'naive-ui';
import { computed, ref } from 'vue';

// Reactive theme reference for the discrete instance
const isDark = ref(localStorage.getItem('theme_dark') === '1');

const configProviderPropsRef = computed(() => ({
  theme: isDark.value ? darkTheme : null,
}));

const { message, dialog, notification, loadingBar } = createDiscreteApi(
  ['message', 'dialog', 'notification', 'loadingBar'],
  {
    configProviderProps: configProviderPropsRef,
  }
);

export function useMessage() {
  return message;
}

export function useDialog() {
  return dialog;
}

export function useNotification() {
  return notification;
}

export function useLoadingBar() {
  return loadingBar;
}

export function setDiscreteThemeDark(dark) {
  isDark.value = dark;
}
