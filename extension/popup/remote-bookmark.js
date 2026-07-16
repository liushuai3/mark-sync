import { BookmarkManager } from '../utils/bookmarkManager.js';

document.addEventListener('DOMContentLoaded', () => {
  const remoteBookmarkList = document.getElementById('remoteBookmarkList');
const remoteBookmarkEmpty = document.getElementById('remoteBookmarkEmpty');
const searchInput = document.getElementById('searchInput');
const searchButton = document.getElementById('searchButton');
const pathFilter = document.getElementById('pathFilter');
const deleteSelectedButton = document.getElementById('deleteSelected');
const refreshButton = document.getElementById('refreshButton');
const backButton = document.getElementById('backButton');
const statusDiv = document.getElementById('status');
const prevPageButton = document.getElementById('prevPage');
const nextPageButton = document.getElementById('nextPage');
const pageInfoSpan = document.getElementById('pageInfo');
const totalBookmarksSpan = document.getElementById('totalBookmarks');
const currentRangeSpan = document.getElementById('currentRange');

// 编辑对话框元素
const editBookmarkDialog = document.getElementById('editBookmarkDialog');
const closeEditDialogButton = document.getElementById('closeEditDialog');
const saveBookmarkButton = document.getElementById('saveBookmark');
const editBookmarkTitleInput = document.getElementById('editBookmarkTitle');
const editBookmarkUrlInput = document.getElementById('editBookmarkUrl');
      const editBookmarkPathInput = document.getElementById('editBookmarkPath');
      
      // 编辑文件夹对话框元素
      const editFolderDialog = document.getElementById('editFolderDialog');
      const closeEditFolderDialogButton = document.getElementById('closeEditFolderDialog');
      const saveFolderButton = document.getElementById('saveFolder');
      const editFolderNameInput = document.getElementById('editFolderName');
      const editFolderPathInput = document.getElementById('editFolderPath');
      
      // 当前正在编辑的文件夹
      let currentEditingFolder = null;
  
  let allBookmarks = [];
  let filteredBookmarks = [];
  let uniquePaths = new Set();
  
  // 分页相关变量
  const ITEMS_PER_PAGE = 10;
  let currentPage = 1;
  let totalPages = 1;

  // 返回按钮事件
  backButton.addEventListener('click', () => {
    window.close();
  });

  // 刷新按钮事件
  refreshButton.addEventListener('click', async () => {
    await loadRemoteBookmarks();
  });

  // 搜索按钮事件
  searchButton.addEventListener('click', () => {
    currentPage = 1; // 重置为第一页
    filterBookmarks();
  });

  // 按Enter键触发搜索
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      currentPage = 1; // 重置为第一页
      filterBookmarks();
    }
  });

  // 路径筛选变化事件
  pathFilter.addEventListener('change', () => {
    currentPage = 1; // 重置为第一页
    filterBookmarks();
  });
  
  // 上一页按钮事件
  prevPageButton.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderBookmarks();
      updatePaginationControls();
    }
  });
  
  // 下一页按钮事件
  nextPageButton.addEventListener('click', () => {
    if (currentPage < totalPages) {
      currentPage++;
      renderBookmarks();
      updatePaginationControls();
    }
  });

  // 删除选中按钮事件
  deleteSelectedButton.addEventListener('click', async () => {
    // 获取当前页面上选中的书签
    const selectedCheckboxes = remoteBookmarkList.querySelectorAll('.bookmark-checkbox:checked');
    if (selectedCheckboxes.length === 0) {
      showStatus('请先选择要删除的书签', 'warning');
      return;
    }

    if (!confirm(`确定要删除选中的 ${selectedCheckboxes.length} 个项目吗？`)) {
      return;
    }

    try {
      deleteSelectedButton.disabled = true;
      deleteSelectedButton.textContent = '删除中...';
      showStatus('正在删除项目...');

      const bookmarksToDelete = Array.from(selectedCheckboxes).map(checkbox => {
        return JSON.parse(checkbox.dataset.bookmark);
      });

      await BookmarkManager.deleteRemoteBookmarks(bookmarksToDelete);
      
      // 重新加载书签并重置分页
      await loadRemoteBookmarks();
      
      // 如果删除后当前页没有内容且不是第一页，则回到上一页
      const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
      if (startIndex >= filteredBookmarks.length && currentPage > 1) {
        currentPage--;
        renderBookmarks();
        updatePaginationControls();
      }
      
      showStatus(`成功删除 ${selectedCheckboxes.length} 个项目`, 'success');
    } catch (error) {
      // 检查是否是密钥相关的错误
      let errorMessage = error.message;
      if (error.message.includes('加密密钥') || error.message.includes('解密失败') || error.message.includes('JSON解析失败')) {
        errorMessage += '。请检查设置页面中的加密密钥是否正确，如果更改了密钥，可能需要重新同步数据。';
      }
      showStatus(`删除失败: ${errorMessage}`, 'error');
    } finally {
      deleteSelectedButton.disabled = false;
      deleteSelectedButton.textContent = '删除选中';
    }
  });
  
  // 删除远程书签
      async function deleteRemoteBookmark(bookmark) {
        // 确认删除
        if (!confirm(`确定要删除书签 "${bookmark.name}" 吗？此操作不可撤销。`)) {
          return;
        }
        
        try {
          // 显示状态信息
          statusDiv.textContent = `正在删除书签 "${bookmark.name}"...`;
          statusDiv.style.display = 'block';
          
          // 调用删除函数
          await BookmarkManager.deleteRemoteBookmarks([bookmark]);
          
          // 更新状态信息
          statusDiv.textContent = `书签 "${bookmark.name}" 删除成功！`;
          setTimeout(() => {
            statusDiv.textContent = '';
            statusDiv.style.display = 'none';
          }, 3000);
          
          // 重新加载书签列表
          loadRemoteBookmarks();
        } catch (error) {
          console.error('删除书签失败:', error);
          // 检查是否是密钥相关的错误
          let errorMessage = error.message;
          if (error.message.includes('加密密钥') || error.message.includes('解密失败') || error.message.includes('JSON解析失败')) {
            errorMessage += '。请检查设置页面中的加密密钥是否正确，如果更改了密钥，可能需要重新同步数据。';
          }
          statusDiv.textContent = `删除失败: ${errorMessage}`;
          setTimeout(() => {
            statusDiv.textContent = '';
            statusDiv.style.display = 'none';
          }, 3000);
        }
      }
  
  // 删除远程文件夹
      async function deleteRemoteFolder(folder) {
        // 确认删除
        if (!confirm(`确定要删除文件夹 "${folder.name}" 吗？此操作将同时删除该文件夹下的所有内容，且不可撤销。`)) {
          return;
        }
        
        try {
          // 显示状态信息
          statusDiv.textContent = `正在删除文件夹 "${folder.name}"...`;
          statusDiv.style.display = 'block';
          
          // 调用删除函数
          await BookmarkManager.deleteRemoteBookmarks([folder]);
          
          // 更新状态信息
          statusDiv.textContent = `文件夹 "${folder.name}" 删除成功！`;
          setTimeout(() => {
            statusDiv.textContent = '';
            statusDiv.style.display = 'none';
          }, 3000);
          
          // 重新加载项目列表
          loadRemoteBookmarks();
        } catch (error) {
          console.error('删除远程文件夹失败:', error);
          // 检查是否是密钥相关的错误
          let errorMessage = error.message;
          if (error.message.includes('加密密钥') || error.message.includes('解密失败') || error.message.includes('JSON解析失败')) {
            errorMessage += '。请检查设置页面中的加密密钥是否正确，如果更改了密钥，可能需要重新同步数据。';
          }
          statusDiv.textContent = `删除失败: ${errorMessage}`;
          setTimeout(() => {
            statusDiv.textContent = '';
            statusDiv.style.display = 'none';
          }, 3000);
        }
      }

  // 加载远程书签和文件夹
  async function loadRemoteBookmarks() {
    remoteBookmarkList.innerHTML = '<div class="loading">加载中...</div>';
    remoteBookmarkEmpty.style.display = 'none';
    uniquePaths.clear();
    
    // 重置分页
    currentPage = 1;
    totalPages = 1;
    
    // 重置统计信息
    totalBookmarksSpan.textContent = '总计: 0 个项目';
    currentRangeSpan.textContent = '当前显示: 0-0';
    pageInfoSpan.textContent = '第 1 页 / 共 1 页';

    try {
      // 获取远程书签和文件夹列表
      allBookmarks = await BookmarkManager.getRemoteBookmarkList();
      
      // 收集所有唯一路径
      allBookmarks.forEach(item => {
        const pathStr = item.path.join('/');
        if (pathStr) {
          uniquePaths.add(pathStr);
        }
      });

      // 更新路径筛选下拉菜单
      updatePathFilter();
      // 初始筛选显示所有项目
      filterBookmarks();
    } catch (error) {
      // 检查是否是密钥相关的错误
      let errorMessage = error.message;
      if (error.message.includes('加密密钥') || error.message.includes('解密失败') || error.message.includes('JSON解析失败')) {
        errorMessage += '。请检查设置页面中的加密密钥是否正确，如果更改了密钥，可能需要重新同步数据。';
      }
      
      remoteBookmarkList.innerHTML = `<div class="error">加载失败: ${errorMessage}</div>`;
      // 出错时更新统计信息
      totalBookmarksSpan.textContent = '总计: 0 个项目';
      currentRangeSpan.textContent = '当前显示: 0-0';
      updatePaginationControls();
    }
  }

  // 更新路径筛选下拉菜单
  function updatePathFilter() {
    // 保存当前选中值
    const currentValue = pathFilter.value;
    
    // 清空现有选项（保留第一个“所有路径”选项）
    while (pathFilter.options.length > 1) {
      pathFilter.remove(1);
    }

    // 添加唯一路径选项
    Array.from(uniquePaths).sort().forEach(path => {
      const option = document.createElement('option');
      option.value = path;
      option.textContent = path;
      pathFilter.appendChild(option);
    });

    // 恢复选中值
    if (currentValue && pathFilter.querySelector(`option[value="${currentValue}"]`)) {
      pathFilter.value = currentValue;
    }
  }

  // 筛选书签
  function filterBookmarks() {
    const searchTerm = searchInput.value.toLowerCase();
    const selectedPath = pathFilter.value;

    filteredBookmarks = allBookmarks;

    // 应用路径筛选
    if (selectedPath !== 'all') {
      filteredBookmarks = filteredBookmarks.filter(bookmark => {
        return bookmark.path.join('/') === selectedPath;
      });
    }

    // 应用搜索词筛选
    if (searchTerm) {
      filteredBookmarks = filteredBookmarks.filter(bookmark => {
        const titleMatch = bookmark.name.toLowerCase().includes(searchTerm);
        const urlMatch = bookmark.url && bookmark.url.toLowerCase().includes(searchTerm);
        const pathMatch = bookmark.path.join('/').toLowerCase().includes(searchTerm);
        return titleMatch || urlMatch || pathMatch;
      });
    }
    
    // 分别统计文件夹和书签数量
    const folderCount = filteredBookmarks.filter(item => item.type === 'folder').length;
    const bookmarkCount = filteredBookmarks.length - folderCount;
    
    // 更新总条数显示
    totalBookmarksSpan.textContent = `总计: ${bookmarkCount} 个书签, ${folderCount} 个文件夹`;
    
    // 计算总页数
    totalPages = Math.max(1, Math.ceil(filteredBookmarks.length / ITEMS_PER_PAGE));
    
    // 确保当前页在有效范围内
    if (currentPage > totalPages) {
      currentPage = totalPages;
    }
    
    // 更新分页控件
    updatePaginationControls();
    
    // 渲染当前页的书签
    renderBookmarks();
  }

  // 渲染书签和文件夹列表
  function renderBookmarks() {
    if (filteredBookmarks.length === 0) {
      remoteBookmarkList.innerHTML = '';
      remoteBookmarkEmpty.style.display = 'block';
      currentRangeSpan.textContent = '当前显示: 0-0';
      return;
    }

    remoteBookmarkEmpty.style.display = 'none';
    remoteBookmarkList.innerHTML = '';
    
    // 计算当前页的起始和结束索引
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, filteredBookmarks.length);
    
    // 更新当前显示范围
    currentRangeSpan.textContent = `当前显示: ${startIndex + 1}-${endIndex}`;
    
    // 获取当前页的书签
    const currentPageBookmarks = filteredBookmarks.slice(startIndex, endIndex);

    // 渲染当前页的书签和文件夹
      currentPageBookmarks.forEach(item => {
        if (item.type === 'folder') {
          // 渲染文件夹
          const folderItem = document.createElement('div');
          folderItem.className = 'folder-item';

          folderItem.innerHTML = `
            <div class="folder-icon">📁</div>
            <div class="folder-name">${item.name}</div>
            <div class="folder-path">路径: ${item.path.join('/')}</div>
            <div class="folder-actions">
              <button class="edit-button" title="编辑文件夹">编辑</button>
              <button class="delete-button" title="删除文件夹">删除</button>
            </div>
          `;

          remoteBookmarkList.appendChild(folderItem);
          
          // 为编辑按钮添加事件监听器
          const editButton = folderItem.querySelector('.edit-button');
          editButton.addEventListener('click', (event) => {
            event.stopPropagation(); // 阻止事件冒泡
            openEditFolderDialog(item);
          });
          
          // 为删除按钮添加事件监听器
          const deleteButton = folderItem.querySelector('.delete-button');
          deleteButton.addEventListener('click', (event) => {
            event.stopPropagation(); // 阻止事件冒泡
            deleteRemoteFolder(item);
          });
        } else if (item.type === 'bookmark') {
          // 渲染书签
          const bookmarkItem = document.createElement('div');
          bookmarkItem.className = 'bookmark-list-item';

          bookmarkItem.innerHTML = `
            <input type="checkbox" class="bookmark-checkbox" data-bookmark='${JSON.stringify(item)}'>
            <div class="bookmark-details">
              <div class="bookmark-title">${item.name}</div>
              <div class="bookmark-url">${item.url}</div>
              <div class="bookmark-path">路径: ${item.path.join('/')}</div>
            </div>
            <div class="bookmark-actions">
              <button class="edit-button" title="编辑书签">编辑</button>
              <button class="delete-button" title="删除书签">删除</button>
            </div>
          `;

          remoteBookmarkList.appendChild(bookmarkItem);
          
          // 为编辑按钮添加事件监听器
          const editButton = bookmarkItem.querySelector('.edit-button');
          editButton.addEventListener('click', (event) => {
            event.stopPropagation(); // 阻止事件冒泡
            openEditDialog(item);
          });
          
          // 为删除按钮添加事件监听器
          const deleteButton = bookmarkItem.querySelector('.delete-button');
          deleteButton.addEventListener('click', (event) => {
            event.stopPropagation(); // 阻止事件冒泡
            deleteRemoteBookmark(item);
          });
        }
      });
  }
  
  // 更新分页控件
  function updatePaginationControls() {
    // 更新页码信息
    pageInfoSpan.textContent = `第 ${currentPage} 页 / 共 ${totalPages} 页`;
    
    // 更新按钮状态
    prevPageButton.disabled = currentPage <= 1;
    nextPageButton.disabled = currentPage >= totalPages;
  }

  // 显示状态消息
  function showStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
  }

  // 初始加载书签
  loadRemoteBookmarks();
  
  // 当前正在编辑的书签
  let currentEditingBookmark = null;
  
  // 打开编辑书签对话框
  function openEditDialog(bookmark) {
    currentEditingBookmark = bookmark;
    
    // 填充表单
    editBookmarkTitleInput.value = bookmark.name;
    editBookmarkUrlInput.value = bookmark.url;
    editBookmarkPathInput.value = bookmark.path.join('/');
    
    // 显示对话框
    editBookmarkDialog.classList.add('show');
    
    // 聚焦到标题输入框
    setTimeout(() => {
      editBookmarkTitleInput.focus();
      editBookmarkTitleInput.select();
    }, 100);
  }
  
  // 打开编辑文件夹对话框
  function openEditFolderDialog(folder) {
    currentEditingFolder = folder;
    
    // 填充表单
    editFolderNameInput.value = folder.name;
    editFolderPathInput.value = folder.path.join('/');
    
    // 显示对话框
    editFolderDialog.classList.add('show');
    
    // 聚焦到名称输入框
    setTimeout(() => {
      editFolderNameInput.focus();
      editFolderNameInput.select();
    }, 100);
  }
  
  // 关闭编辑书签对话框
  closeEditDialogButton.addEventListener('click', () => {
    editBookmarkDialog.classList.remove('show');
    currentEditingBookmark = null;
  });
  
  // 关闭编辑文件夹对话框
  closeEditFolderDialogButton.addEventListener('click', () => {
    editFolderDialog.classList.remove('show');
    currentEditingFolder = null;
  });
  
  // 添加键盘事件处理
  editBookmarkDialog.addEventListener('keydown', (event) => {
    // 按下Escape键关闭对话框
    if (event.key === 'Escape') {
      editBookmarkDialog.classList.remove('show');
      currentEditingBookmark = null;
    }
    
    // 按下Enter键保存
    if (event.key === 'Enter') {
      saveBookmarkButton.click();
    }
  });
  
  // 添加文件夹对话框键盘事件处理
  editFolderDialog.addEventListener('keydown', (event) => {
    // 按下Escape键关闭对话框
    if (event.key === 'Escape') {
      editFolderDialog.classList.remove('show');
      currentEditingFolder = null;
    }
    
    // 按下Enter键保存
    if (event.key === 'Enter') {
      saveFolderButton.click();
    }
  });
  
  // 点击对话框外部关闭对话框
  editBookmarkDialog.addEventListener('click', (event) => {
    // 如果点击的是对话框本身（而不是内容区域），则关闭对话框
    if (event.target === editBookmarkDialog) {
      editBookmarkDialog.classList.remove('show');
      currentEditingBookmark = null;
    }
  });
  
  // 点击文件夹对话框外部关闭对话框
  editFolderDialog.addEventListener('click', (event) => {
    // 如果点击的是对话框本身（而不是内容区域），则关闭对话框
    if (event.target === editFolderDialog) {
      editFolderDialog.classList.remove('show');
      currentEditingFolder = null;
    }
  });
  
  // 保存编辑后的书签
  saveBookmarkButton.addEventListener('click', async () => {
    if (!currentEditingBookmark) return;
    
    const newTitle = editBookmarkTitleInput.value.trim();
    const newUrl = editBookmarkUrlInput.value.trim();
    
    // 验证输入
    if (!newTitle) {
      alert('书签标题不能为空');
      editBookmarkTitleInput.focus();
      return;
    }
    
    if (!newUrl) {
      alert('书签URL不能为空');
      editBookmarkUrlInput.focus();
      return;
    }
    
    // 验证URL格式
    try {
      new URL(newUrl);
    } catch (e) {
      alert('请输入有效的URL地址');
      editBookmarkUrlInput.focus();
      return;
    }
    
    try {
      // 更新书签
      await updateRemoteBookmark(currentEditingBookmark, newTitle, newUrl);
      
      // 关闭对话框
      editBookmarkDialog.classList.remove('show');
      currentEditingBookmark = null;
      
      // 重新加载书签列表
      loadRemoteBookmarks();
    } catch (error) {
      console.error('更新书签失败:', error);
      alert(`更新书签失败: ${error.message}`);
    }
  });
  
  // 保存编辑后的文件夹
  saveFolderButton.addEventListener('click', async () => {
    if (!currentEditingFolder) return;
    
    const newFolderName = editFolderNameInput.value.trim();
    
    // 验证输入
    if (!newFolderName) {
      alert('文件夹名称不能为空');
      editFolderNameInput.focus();
      return;
    }
    
    try {
      // 更新文件夹
      await updateRemoteFolder(currentEditingFolder, newFolderName);
      
      // 关闭对话框
      editFolderDialog.classList.remove('show');
      currentEditingFolder = null;
      
      // 重新加载项目列表
      loadRemoteBookmarks();
    } catch (error) {
      console.error('更新文件夹失败:', error);
      alert(`更新文件夹失败: ${error.message}`);
    }
  });
  
  // 更新远程书签
  async function updateRemoteBookmark(bookmark, newTitle, newUrl) {
    try {
      // 显示状态信息
      statusDiv.textContent = '正在更新书签...';
      statusDiv.style.display = 'block';
      
      // 获取当前的远程书签数据
      const cloudBookmarks = await BookmarkManager.downloadBookmarks();
      
      // 查找并更新目标书签
      let updated = false;
      
      // 移除了URL重复性检查逻辑，允许修改时使用重复的URL
      
      // 递归查找并更新书签
      const updateBookmarkInFolder = (bookmarks, path = []) => {
        if (!bookmarks || !Array.isArray(bookmarks)) return;
        
        for (let i = 0; i < bookmarks.length; i++) {
          const child = bookmarks[i];
          
          if (child.type === 'folder') {
            // 递归处理子文件夹
            const safeChildren = child.children && Array.isArray(child.children) ? child.children : [];
            updateBookmarkInFolder(safeChildren, [...path, child.name]);
          } else if (child.type === 'url') {
            // 检查是否为目标书签
            // 使用正确的ID格式进行比较
            if (`bookmark_${child.id}` === bookmark.id) {
              child.name = newTitle;
              child.url = newUrl;
              updated = true;
              console.log('已更新书签:', child);
            }
          }
        }
      };
      
      // 遍历所有根文件夹查找书签
      for (const root in cloudBookmarks.roots) {
        const safeChildren = cloudBookmarks.roots[root].children && Array.isArray(cloudBookmarks.roots[root].children) ? cloudBookmarks.roots[root].children : [];
        updateBookmarkInFolder(safeChildren);
      }
      
      if (!updated) {
        statusDiv.textContent = '';
        statusDiv.style.display = 'none';
        throw new Error('未找到要更新的书签');
      }
      
      // 上传更新后的书签数据
      await BookmarkManager.uploadBookmarks(cloudBookmarks);
      
      // 更新状态信息
      statusDiv.textContent = '书签更新成功！';
      setTimeout(() => {
        statusDiv.textContent = '';
        statusDiv.style.display = 'none';
      }, 3000);
      
      return true;
    } catch (error) {
      console.error('更新远程书签失败:', error);
      statusDiv.textContent = `更新失败: ${error.message}`;
      setTimeout(() => {
        statusDiv.textContent = '';
        statusDiv.style.display = 'none';
      }, 3000);
      throw error;
    }
  }
  
  // 更新远程文件夹
  async function updateRemoteFolder(folder, newFolderName) {
    try {
      // 显示状态信息
      statusDiv.textContent = '正在更新文件夹...';
      statusDiv.style.display = 'block';
      
      // 获取当前的远程书签数据
      const cloudBookmarks = await BookmarkManager.downloadBookmarks();
      
      // 查找并更新目标文件夹
      let updated = false;
      
      // 检查是否已存在同名文件夹
      const checkFolderExists = (bookmarks, folderName, excludePath) => {
        if (!bookmarks || !Array.isArray(bookmarks)) return false;
        
        for (const child of bookmarks) {
          if (child.type === 'folder') {
            const currentPath = excludePath.length > 0 ? [...excludePath, child.name].join('/') : child.name;
            
            // 检查是否是目标文件夹
            const targetPath = folder.path.join('/');
            if (currentPath === targetPath) {
              continue; // 跳过正在编辑的文件夹
            }
            
            // 检查是否有同名文件夹
            if (child.name === folderName) {
              return true;
            }
            
            // 递归检查子文件夹
            const safeChildren = child.children && Array.isArray(child.children) ? child.children : [];
            if (checkFolderExists(safeChildren, folderName, excludePath)) {
              return true;
            }
          }
        }
        return false;
      };
      
      // 检查新文件夹名是否已存在
      const parentPath = folder.path.slice(0, -1); // 获取父路径
      let parentFolder = null;
      
      // 找到父文件夹
      if (parentPath.length === 0) {
        // 父文件夹是根文件夹
        const rootName = folder.path[0];
        if (rootName === '书签栏') {
          parentFolder = cloudBookmarks.roots.bookmark_bar;
        } else if (rootName === '其他书签') {
          parentFolder = cloudBookmarks.roots.other;
        } else if (rootName === '移动书签') {
          parentFolder = cloudBookmarks.roots.mobile;
        }
      } else {
        // 在子文件夹中查找父文件夹
        const findParentFolder = (bookmarks, path) => {
          if (!bookmarks || !Array.isArray(bookmarks) || path.length === 0) return null;
          
          for (const child of bookmarks) {
            if (child.type === 'folder') {
              const currentPath = path.slice(0, 1).join('/');
              if (child.name === path[0]) {
                if (path.length === 1) {
                  return child; // 找到父文件夹
                } else {
                  const safeChildren = child.children && Array.isArray(child.children) ? child.children : [];
                  return findParentFolder(safeChildren, path.slice(1));
                }
              }
            }
          }
          return null;
        };
        
        parentFolder = findParentFolder(
          Object.values(cloudBookmarks.roots).flatMap(root => root.children || []), 
          parentPath
        );
      }
      
      // 检查同名文件夹
      if (parentFolder && parentFolder.children) {
        const excludePath = folder.path.slice(0, -1); // 排除正在编辑的文件夹
        if (checkFolderExists(parentFolder.children, newFolderName, excludePath)) {
          throw new Error(`文件夹 "${newFolderName}" 已存在`);
        }
      }
      
      // 递归查找并更新文件夹
      const updateFolderInFolder = (bookmarks, path = []) => {
        if (!bookmarks || !Array.isArray(bookmarks)) return;
        
        for (let i = 0; i < bookmarks.length; i++) {
          const child = bookmarks[i];
          
          if (child.type === 'folder') {
            // 检查是否为目标文件夹
            // 使用正确的ID格式进行比较
            if (`folder_${child.id}` === folder.id) {
              child.name = newFolderName;
              updated = true;
              console.log('已更新文件夹:', child);
            } else {
              // 递归处理子文件夹
              const safeChildren = child.children && Array.isArray(child.children) ? child.children : [];
              updateFolderInFolder(safeChildren, [...path, child.name]);
            }
          }
        }
      };
      
      // 遍历所有根文件夹查找文件夹
      for (const root in cloudBookmarks.roots) {
        const safeChildren = cloudBookmarks.roots[root].children && Array.isArray(cloudBookmarks.roots[root].children) ? cloudBookmarks.roots[root].children : [];
        updateFolderInFolder(safeChildren, [cloudBookmarks.roots[root].name]);
      }
      
      if (!updated) {
        statusDiv.textContent = '';
        statusDiv.style.display = 'none';
        throw new Error('未找到要更新的文件夹');
      }
      
      // 上传更新后的书签数据
      await BookmarkManager.uploadBookmarks(cloudBookmarks);
      
      // 更新状态信息
      statusDiv.textContent = '文件夹更新成功！';
      setTimeout(() => {
        statusDiv.textContent = '';
        statusDiv.style.display = 'none';
      }, 3000);
      
      return true;
    } catch (error) {
      console.error('更新远程文件夹失败:', error);
      statusDiv.textContent = `更新失败: ${error.message}`;
      setTimeout(() => {
        statusDiv.textContent = '';
        statusDiv.style.display = 'none';
      }, 3000);
      throw error;
    }
  }
});
