// 将 Markdown 转换为 HTML 的函数
function markdownToHtml(markdown) {
  // 简单的 Markdown 转换规则
  return markdown
    // 标题
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    // 列表
    .replace(/^\s*[-*+]\s(.*)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)\n/g, '<ul>$1</ul>')
    // 代码块
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // 链接
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // 段落
    .replace(/\n\n/g, '</p><p>')
    // 清理多余的标签
    .replace(/<\/ul>\s*<ul>/g, '');
}

// 加载并显示 README 内容
async function loadReadme() {
  try {
    const response = await fetch('../docs/README.md');
    if (!response.ok) throw new Error('Failed to load README');
    
    const markdown = await response.text();
    const html = markdownToHtml(markdown);
    
    const helpContent = document.getElementById('helpContent');
    helpContent.innerHTML = `<div class="markdown-body">${html}</div>`;
  } catch (error) {
    console.error('Error loading README:', error);
    document.getElementById('helpContent').innerHTML = `
      <div class="error">
        加载失败：${error.message}
        <button onclick="loadReadme()">重试</button>
      </div>
    `;
  }
}

// 关闭帮助窗口
document.getElementById('closeHelp').addEventListener('click', () => {
  window.close();
});

// 初始加载
loadReadme(); 