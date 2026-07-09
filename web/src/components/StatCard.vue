<template>
  <n-card :bordered="false" :class="['stat-card', { small }]">
    <div class="content">
      <div>
        <div class="title">{{ title }}</div>
        <div class="value">{{ value }}</div>
      </div>
      <div class="icon-wrap" :style="{ background: color + '22' }">
        <n-icon :size="28" :color="color">
          <component :is="icon" />
        </n-icon>
      </div>
    </div>
  </n-card>
</template>

<script setup>
defineProps({
  title: { type: String, required: true },
  value: { type: [Number, String], required: true },
  icon: { type: [Function, Object], required: true },
  color: { type: String, default: '#2196F3' },
  small: { type: Boolean, default: false },
});
</script>

<style scoped>
.stat-card { border-radius: 10px; }
.content { display: flex; justify-content: space-between; align-items: center; }
.title { color: #999; font-size: 13px; margin-bottom: 6px; }
.value { font-size: 28px; font-weight: 600; }
.stat-card.small .value { font-size: 18px; }
.icon-wrap { width: 52px; height: 52px; border-radius: 12px; display: flex; align-items: center; justify-content: center; }
</style>
