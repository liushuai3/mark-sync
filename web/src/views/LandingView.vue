<template>
  <div class="landing">
    <!-- 顶栏 -->
    <header class="topbar">
      <div class="topbar-inner">
        <div class="logo">
          <img src="/logo.png" alt="MarkSync" />
          <span>MarkSync</span>
        </div>
        <nav class="nav">
          <a href="#features">功能</a>
          <a href="#deploy">自部署</a>
          <a href="#source">源码</a>
          <a :href="extDownloadUrl" download>下载插件</a>
          <n-button size="small" type="primary" @click="goLogin">登录</n-button>
        </nav>
      </div>
    </header>

    <!-- Hero -->
    <section class="hero">
      <div class="hero-inner">
        <h1>你的书签，你做主</h1>
        <p class="lead">
          MarkSync 是一款<strong>自建后端</strong>的浏览器书签同步工具，跨设备双向同步，
          数据完全存储在你自己的服务器上，不经过任何第三方。
        </p>
        <div class="cta">
          <n-button type="primary" size="large" @click="goLogin">立即登录 / 注册</n-button>
          <n-button size="large" tag="a" :href="extDownloadUrl" download>
            <template #icon><n-icon><DownloadOutline /></n-icon></template>
            下载插件 v{{ extVersion }}
          </n-button>
          <n-button size="large" tag="a" href="#deploy" quaternary>
            <template #icon><n-icon><ServerOutline /></n-icon></template>
            自己部署一份
          </n-button>
        </div>
        <div class="badges">
          <span :class="['dot', healthy ? 'ok' : 'err']"></span>
          <span>{{ healthy ? '公共实例在线' : '公共实例离线' }}</span>
          <span class="sep">·</span>
          <span>开源 · MIT</span>
          <span class="sep">·</span>
          <span>Chrome / Edge / Firefox</span>
        </div>
      </div>
    </section>

    <!-- 功能 -->
    <section id="features" class="section">
      <h2>核心能力</h2>
      <div class="grid">
        <div class="card" v-for="f in features" :key="f.title">
          <div class="card-icon"><n-icon size="28"><component :is="f.icon" /></n-icon></div>
          <h3>{{ f.title }}</h3>
          <p>{{ f.desc }}</p>
        </div>
      </div>
    </section>

    <!-- 自部署 -->
    <section id="deploy" class="section alt">
      <h2>三方自部署</h2>
      <p class="section-lead">
        MarkSync 完全开源，一条 <code>docker compose</code> 命令即可拥有一套只属于你的书签同步服务。
      </p>
      <div class="deploy-grid">
        <div class="deploy-card">
          <h3>1️⃣ 拉取源码</h3>
<pre><code>git clone https://gitee.com/zcoolq/mark-sync.git
cd mark-sync</code></pre>
        </div>
        <div class="deploy-card">
          <h3>2️⃣ 一键部署</h3>
<pre><code>./deploy.sh
# 或手动
docker compose -f deploy/docker-compose.yml up -d</code></pre>
        </div>
        <div class="deploy-card">
          <h3>3️⃣ 访问后台</h3>
<pre><code># 默认端口 8888
http://your-server:8888
# 首次访问会引导创建管理员账户</code></pre>
        </div>
        <div class="deploy-card">
          <h3>4️⃣ 连接扩展</h3>
<pre><code># 在浏览器中安装 MarkSync 扩展
# 打开扩展设置，填入你的后端地址
https://your-domain.com</code></pre>
        </div>
      </div>
      <div class="deploy-tip">
        <strong>💡 提示：</strong>
        推荐使用 HTTPS（如 Caddy / Nginx + Let's Encrypt 反代到 <code>8888</code>），扩展要求后端为安全上下文。
      </div>
    </section>

    <!-- 源码 -->
    <section id="source" class="section">
      <h2>开源与源码</h2>
      <p class="section-lead">
        MarkSync 采用 <strong>MIT 协议</strong>开源，欢迎 Star / Fork / PR。
      </p>
      <div class="source-links">
        <a class="src-card" href="https://gitee.com/zcoolq/mark-sync" target="_blank" rel="noopener">
          <div class="src-title">🇨🇳 Gitee 仓库</div>
          <div class="src-url">gitee.com/zcoolq/mark-sync</div>
          <div class="src-desc">主仓库，国内访问快</div>
        </a>
        <a class="src-card" :href="extDownloadUrl" download>
          <div class="src-title">📦 扩展 zip 包</div>
          <div class="src-url">marksync-extension-v{{ extVersion }}.zip</div>
          <div class="src-desc">Chrome / Edge 手动安装</div>
        </a>
        <a class="src-card" href="/api/health" target="_blank" rel="noopener">
          <div class="src-title">❤️ 后端健康检查</div>
          <div class="src-url">/api/health</div>
          <div class="src-desc">查看当前实例版本与状态</div>
        </a>
      </div>
    </section>

    <!-- 底部 CTA -->
    <section class="cta-bottom">
      <h2>准备好把书签放回自己家了吗？</h2>
      <div class="cta">
        <n-button type="primary" size="large" @click="goLogin">进入管理台</n-button>
        <n-button size="large" tag="a" href="https://gitee.com/zcoolq/mark-sync" target="_blank">
          查看源码
        </n-button>
      </div>
    </section>

    <footer class="footer">
      <div>MarkSync · v{{ extVersion }} · 轻量级书签同步系统</div>
      <div class="mini">
        <a href="https://gitee.com/zcoolq/mark-sync" target="_blank" rel="noopener">Gitee</a>
        <span>·</span>
        <a href="/api/health" target="_blank" rel="noopener">状态</a>
        <span>·</span>
        <a href="#" @click.prevent="goLogin">登录</a>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { ref, onMounted, markRaw } from 'vue';
import { useRouter } from 'vue-router';
import {
  DownloadOutline,
  ServerOutline,
  SyncOutline,
  LockClosedOutline,
  CloudDoneOutline,
  ExtensionPuzzleOutline,
  PeopleOutline,
  FlashOutline,
} from '@vicons/ionicons5';
import { health } from '../api/client.js';
import { EXTENSION_META } from '../lib/extension-meta.js';

const router = useRouter();
const extVersion = EXTENSION_META.version;
const extDownloadUrl = `/downloads/marksync-extension-v${extVersion}.zip`;
const healthy = ref(false);

const features = [
  { icon: markRaw(SyncOutline), title: '双向增量同步', desc: '本地与云端书签双向合并，仅传输变化，秒级同步。' },
  { icon: markRaw(LockClosedOutline), title: '自主可控', desc: '数据全部存在你自己的服务器，密码 bcrypt 加密，无第三方追踪。' },
  { icon: markRaw(CloudDoneOutline), title: '跨设备无缝', desc: '一个账号，多个浏览器多台设备共享同一份书签树。' },
  { icon: markRaw(ExtensionPuzzleOutline), title: '兼容主流浏览器', desc: 'Chrome / Edge / Firefox 全部支持，Manifest V3 现代架构。' },
  { icon: markRaw(PeopleOutline), title: '多用户支持', desc: '一套服务多个账号，管理员可分配 Token、查看日志。' },
  { icon: markRaw(FlashOutline), title: '轻量高效', desc: '单容器部署，SQLite 存储，几十兆内存即可运行。' },
];

function goLogin() {
  router.push('/login');
}

onMounted(async () => {
  try {
    await health();
    healthy.value = true;
  } catch {
    healthy.value = false;
  }
});
</script>

<style scoped>
.landing {
  min-height: 100vh;
  background: #f7f9fc;
  color: #1f2937;
}

/* 顶栏 */
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: saturate(180%) blur(10px);
  border-bottom: 1px solid #e5e7eb;
}
.topbar-inner {
  max-width: 1080px;
  margin: 0 auto;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 18px;
}
.logo img { width: 32px; height: 32px; border-radius: 6px; }
.nav {
  display: flex;
  align-items: center;
  gap: 24px;
}
.nav a {
  color: #4b5563;
  text-decoration: none;
  font-size: 14px;
  transition: color 0.2s;
}
.nav a:hover { color: #667eea; }

/* Hero */
.hero {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
  padding: 88px 24px 96px;
}
.hero-inner {
  max-width: 900px;
  margin: 0 auto;
  text-align: center;
}
.hero h1 {
  font-size: 46px;
  margin: 0 0 16px;
  letter-spacing: -0.02em;
}
.lead {
  font-size: 18px;
  line-height: 1.7;
  opacity: 0.95;
  max-width: 720px;
  margin: 0 auto 32px;
}
.lead strong { color: #ffe082; font-weight: 600; }
.cta {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
}
.badges {
  margin-top: 28px;
  font-size: 13px;
  opacity: 0.85;
  display: flex;
  gap: 10px;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
}
.badges .sep { opacity: 0.5; }
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.dot.ok { background: #52c41a; box-shadow: 0 0 8px #52c41a; }
.dot.err { background: #f5222d; }

/* Sections */
.section {
  max-width: 1080px;
  margin: 0 auto;
  padding: 72px 24px;
}
.section.alt {
  background: #fff;
  max-width: none;
  padding: 72px 24px;
}
.section.alt > * {
  max-width: 1080px;
  margin-left: auto;
  margin-right: auto;
}
.section h2 {
  font-size: 30px;
  margin: 0 0 12px;
  text-align: center;
}
.section-lead {
  text-align: center;
  color: #6b7280;
  font-size: 15px;
  max-width: 640px;
  margin: 0 auto 40px;
}
.section-lead code {
  background: #f3f4f6;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 13px;
  color: #764ba2;
}

/* 功能卡片 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 20px;
  margin-top: 32px;
}
.card {
  background: #fff;
  border-radius: 12px;
  padding: 24px;
  border: 1px solid #e5e7eb;
  transition: transform 0.2s, box-shadow 0.2s;
}
.card:hover {
  transform: translateY(-3px);
  box-shadow: 0 12px 24px rgba(102, 126, 234, 0.12);
}
.card-icon {
  color: #667eea;
  margin-bottom: 12px;
}
.card h3 {
  margin: 0 0 8px;
  font-size: 17px;
}
.card p {
  margin: 0;
  color: #6b7280;
  font-size: 14px;
  line-height: 1.6;
}

/* 部署 */
.deploy-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  margin-top: 8px;
}
.deploy-card {
  background: #fafbfd;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 20px;
}
.deploy-card h3 {
  margin: 0 0 12px;
  font-size: 15px;
  color: #374151;
}
.deploy-card pre {
  margin: 0;
  background: #1f2937;
  color: #e5e7eb;
  padding: 14px 16px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
}
.deploy-card code { font-family: 'SF Mono', Menlo, Consolas, monospace; }
.deploy-tip {
  margin-top: 20px;
  padding: 14px 18px;
  background: #fff8e6;
  border-left: 4px solid #f59e0b;
  border-radius: 6px;
  font-size: 14px;
  color: #78350f;
}
.deploy-tip code {
  background: #fef3c7;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 12.5px;
}

/* 源码 */
.source-links {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin-top: 32px;
}
.src-card {
  display: block;
  text-decoration: none;
  color: inherit;
  background: #fff;
  padding: 20px;
  border-radius: 10px;
  border: 1px solid #e5e7eb;
  transition: all 0.2s;
}
.src-card:hover {
  border-color: #667eea;
  transform: translateY(-2px);
  box-shadow: 0 8px 16px rgba(102, 126, 234, 0.1);
}
.src-title { font-weight: 600; font-size: 16px; margin-bottom: 4px; }
.src-url {
  font-family: monospace;
  font-size: 13px;
  color: #667eea;
  margin-bottom: 6px;
  word-break: break-all;
}
.src-desc { font-size: 13px; color: #6b7280; }

/* 底部 CTA */
.cta-bottom {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
  text-align: center;
  padding: 72px 24px;
}
.cta-bottom h2 {
  font-size: 28px;
  margin: 0 0 24px;
}

/* footer */
.footer {
  padding: 28px 24px;
  text-align: center;
  color: #6b7280;
  font-size: 13px;
  background: #fff;
  border-top: 1px solid #e5e7eb;
}
.footer .mini {
  margin-top: 6px;
  display: flex;
  gap: 8px;
  justify-content: center;
  color: #9ca3af;
}
.footer a { color: #667eea; text-decoration: none; }
.footer a:hover { text-decoration: underline; }

@media (max-width: 640px) {
  .hero { padding: 60px 20px 72px; }
  .hero h1 { font-size: 32px; }
  .lead { font-size: 15px; }
  .section { padding: 48px 20px; }
  .section h2 { font-size: 24px; }
  .nav { gap: 12px; }
  .nav a:not(.n-button) { display: none; }
}
</style>
