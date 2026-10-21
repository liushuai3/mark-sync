import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { authApi } from '../api/index.js';
import { setUnauthorizedHandler } from '../api/client.js';

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null);
  const jwt = ref(localStorage.getItem('jwt'));
  const hydrated = ref(false);

  const isAuthenticated = computed(() => !!jwt.value && !!user.value);

  async function hydrate() {
    if (hydrated.value) return;
    if (!jwt.value) {
      hydrated.value = true;
      return;
    }
    try {
      user.value = await authApi.me();
    } catch {
      jwt.value = null;
      localStorage.removeItem('jwt');
    } finally {
      hydrated.value = true;
    }
  }

  async function login(username, password) {
    const data = await authApi.login({ username, password });
    setSession(data.token, data.user);
    return data.user;
  }

  async function register(username, password, email, code) {
    const data = await authApi.register({ username, password, email: email || undefined, code: code || undefined });
    setSession(data.token, data.user);
    return data.user;
  }

  function setSession(token, u) {
    jwt.value = token;
    localStorage.setItem('jwt', token);
    user.value = u;
  }

  function setUser(u) {
    user.value = u;
  }

  function logout() {
    jwt.value = null;
    user.value = null;
    localStorage.removeItem('jwt');
  }

  // Global 401 handler
  setUnauthorizedHandler(() => {
    logout();
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  });

  return { user, jwt, isAuthenticated, hydrated, hydrate, login, register, logout, setUser };
});
