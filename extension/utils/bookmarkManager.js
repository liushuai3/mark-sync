export class BookmarkManager {
  static GIST_DESCRIPTION = '书签同步助手';
  
  // 获取用户设置的Gist描述，如果未设置则使用默认值
  static async getGistDescription() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['gistDescription'], (result) => {
        resolve(result.gistDescription || this.GIST_DESCRIPTION);
      });
    });
  }
  
  // 获取所有本地书签，转换为新的存储格式
  static async getAllBookmarks() {
    return new Promise((resolve) => {
      chrome.bookmarks.getTree((bookmarkTreeNodes) => {
        // 转换为新的存储格式
        const rootNode = bookmarkTreeNodes[0];
        // 按索引获取各个根文件夹（兼容所有浏览器：Chrome/Edge/Firefox）
        // rootNode.children[0] = 书签栏, [1] = 其他书签, [2] = 移动书签
        const safeChildren = rootNode.children && Array.isArray(rootNode.children) ? rootNode.children : [];
        const bookmarkBar = safeChildren[0] || null;
        const otherBookmarks = safeChildren[1] || null;
        const mobileBookmarks = safeChildren[2] || null;
        
        const convertNode = (node) => {
          const safeChildren = node.children && Array.isArray(node.children) ? node.children : [];
          // 检查节点是否有URL，如果有URL则识别为书签，否则识别为文件夹
          if (node.url && node.url.trim() !== '') {
            return {
              id: node.id,
              name: node.title,
              type: 'url',
              url: node.url,
              dateAdded: node.dateAdded ? node.dateAdded * 1000 : Date.now(),
              dateModified: node.dateModified ? node.dateModified * 1000 : Date.now()
            };
          } else {
            return {
              id: node.id,
              name: node.title,
              type: 'folder',
              children: safeChildren.map(convertNode),
              dateAdded: node.dateAdded ? node.dateAdded * 1000 : Date.now(),
              dateModified: node.dateGroupModified ? node.dateGroupModified * 1000 : Date.now()
            };
          }
        };
        
        const result = {
          version: '2.0',
          lastSync: new Date().toISOString(),
          roots: {
            // 使用浏览器返回的真实 ID，兼容 Chrome/Firefox/Edge
            bookmark_bar: {
              id: bookmarkBar ? bookmarkBar.id : '1',
              name: '书签栏',
              type: 'folder',
              children: bookmarkBar && bookmarkBar.children && Array.isArray(bookmarkBar.children) ? bookmarkBar.children.map(convertNode) : [],
              dateAdded: bookmarkBar && bookmarkBar.dateAdded ? bookmarkBar.dateAdded * 1000 : Date.now()
            },
            other: {
              id: otherBookmarks ? otherBookmarks.id : '2',
              name: '其他书签',
              type: 'folder',
              children: otherBookmarks && otherBookmarks.children && Array.isArray(otherBookmarks.children) ? otherBookmarks.children.map(convertNode) : [],
              dateAdded: otherBookmarks && otherBookmarks.dateAdded ? otherBookmarks.dateAdded * 1000 : Date.now()
            },
            mobile: {
              id: mobileBookmarks ? mobileBookmarks.id : '3',
              name: '移动书签',
              type: 'folder',
              children: mobileBookmarks && mobileBookmarks.children && Array.isArray(mobileBookmarks.children) ? mobileBookmarks.children.map(convertNode) : [],
              dateAdded: mobileBookmarks && mobileBookmarks.dateAdded ? mobileBookmarks.dateAdded * 1000 : Date.now()
            }
          },
          meta: {
            generator: 'BookmarkSync v2.0',
            checksum: this.generateChecksum(bookmarkTreeNodes)
          }
        };
        
        resolve(result);
      });
    });
  }

  // 查找书签数据的代码片段
  static async findBookmarkGist() {
    try {
      const token = await this.getToken();
      if (!token) {
        throw new Error('请先在设置中配置访问令牌');
      }

      const gistDescription = await this.getGistDescription();
      const response = await fetch('https://gitee.com/api/v5/gists', {
        method: 'GET',
        headers: new Headers({
          'Accept': 'application/json',
          'Authorization': `token ${token}`
        })
      });

      if (!response.ok) {
        throw new Error('获取代码片段列表失败');
      }

      const gists = await response.json();
      return gists.find(gist => gist.description === gistDescription);
    } catch (error) {
      throw new Error(`查找代码片段失败: ${error.message}`);
    }
  }

  // 获取加密密钥
  static async getEncryptionKey() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['encryptionKey'], (result) => {
        // 如果用户设置了自定义密钥且不为空，则使用自定义密钥，否则使用默认密钥
        resolve(result.encryptionKey && result.encryptionKey.trim() !== '' ? result.encryptionKey : 'bookmark-sync-key');
      });
    });
  }

  // 简单的异或加密函数
  static async encryptDecrypt(text) {
    const key = await this.getEncryptionKey();
    let result = '';
    for (let i = 0; i < text.length; i++) {
      result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
  }

  // 加密并Base64编码
  static async encryptAndEncode(text) {
    const encrypted = await this.encryptDecrypt(text);
    // 使用encodeURIComponent和unescape处理Unicode字符，再进行Base64编码
    return btoa(unescape(encodeURIComponent(encrypted)));
  }

  // Base64解码并解密
  static async decodeAndDecrypt(text) {
    // 先进行Base64解码，再使用decodeURIComponent和escape处理Unicode字符
    const decoded = decodeURIComponent(escape(atob(text)));
    return await this.encryptDecrypt(decoded);
  }

  // 创建或更新Gitee代码片段
  static async uploadBookmarks(bookmarks) {
    try {
      const token = await this.getToken();
      if (!token) {
        throw new Error('请先在设置中配置访问令牌');
      }

      // 处理重复文件夹，确保上传的书签数据是干净的
      const processedBookmarks = this.deduplicateBookmarks(bookmarks);

      // 先检查是否已存在书签数据的代码片段
      const existingGist = await this.findBookmarkGist();
      const gistDescription = await this.getGistDescription();
      const bookmarkData = JSON.stringify(processedBookmarks, null, 2);
      
      // 加密书签数据
      const encryptedData = await this.encryptAndEncode(bookmarkData);
      
      if (existingGist) {
        // 更新现有代码片段
        const response = await fetch(`https://gitee.com/api/v5/gists/${existingGist.id}`, {
          method: 'PATCH',
          headers: new Headers({
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `token ${token}`
          }),
          body: JSON.stringify({
            description: gistDescription,
            files: {
              'bookmarks.json': {
                content: encryptedData
              }
            }
          })
        });

        if (!response.ok) {
          throw new Error('更新代码片段失败');
        }
      } else {
        // 创建新的代码片段
        const response = await fetch('https://gitee.com/api/v5/gists', {
          method: 'POST',
          headers: new Headers({
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `token ${token}`
          }),
          body: JSON.stringify({
            description: gistDescription,
            public: false,
            files: {
              'bookmarks.json': {
                content: encryptedData
              }
            }
          })
        });

        if (!response.ok) {
          throw new Error('创建代码片段失败');
        }
      }
      
      return { success: true };
    } catch (error) {
      throw new Error(`同步失败: ${error.message}`);
    }
  }

  // 从Gitee下载书签
  static async downloadBookmarks() {
    try {
      const gist = await this.findBookmarkGist();
      if (!gist) {
        throw new Error('未找到书签数据，请确认已先上传过书签到云端');
      }

      const token = await this.getToken();
      const response = await fetch(`https://gitee.com/api/v5/gists/${gist.id}`, {
        method: 'GET',
        headers: new Headers({
          'Accept': 'application/json',
          'Authorization': `token ${token}`
        })
      });

      if (!response.ok) {
        throw new Error(`获取代码片段失败 (HTTP ${response.status})`);
      }

      const data = await response.json();

      // 校验 Gitee 返回的数据中是否包含书签文件
      if (!data.files || !data.files['bookmarks.json']) {
        throw new Error('云端代码片段中未找到书签数据文件 (bookmarks.json)，请确认上传时使用的代码片段描述是否正确');
      }

      // 解密书签数据
      const encryptedContent = data.files['bookmarks.json'].content;
      if (!encryptedContent || typeof encryptedContent !== 'string') {
        throw new Error('云端书签数据为空，请先执行"本地同步到云端"上传数据');
      }

      const decryptedContent = await this.decodeAndDecrypt(encryptedContent);

      // 尝试解析JSON，如果失败则提示可能的密钥问题
      try {
        const parsed = JSON.parse(decryptedContent);
        // 校验数据结构是否包含 roots
        if (!parsed.roots) {
          throw new Error('云端书签数据格式异常（缺少 roots 字段），可能需要重新上传');
        }
        return parsed;
      } catch (parseError) {
        // 如果 parseError 是我们自己抛出的格式错误，直接传递
        if (parseError.message.includes('格式异常') || parseError.message.includes('roots')) {
          throw parseError;
        }
        // 检查解密后的内容是否看起来像有效的JSON
        if (decryptedContent.trim().startsWith('{') || decryptedContent.trim().startsWith('[')) {
          throw new Error(`书签数据解析失败，请检查您的加密密钥设置是否正确`);
        } else {
          throw new Error(`书签数据解密失败，请检查您的加密密钥设置是否正确。如果您更换了加密密钥，需要先在旧密钥下恢复数据再重新加密上传`);
        }
      }
    } catch (error) {
      // 避免错误消息被重复包装
      if (error.message.startsWith('下载失败:')) {
        throw error;
      }
      throw new Error(`下载失败: ${error.message}`);
    }
  }

  // 生成校验和
  static generateChecksum(bookmarkTree) {
    // 简单的校验和实现
    return 'a1b2c3d4e5f6';
  }

  // 将书签保存到本地
  // 返回 { added: number, skipped: number } 反映实际同步结果
  static async saveBookmarksToLocal(cloudBookmarks) {
    try {
      // 获取本地书签树
      const localBookmarkTree = await this.getAllBookmarks();

      // URL 规范化函数：统一处理末尾斜杠等差异
      const normalizeUrl = (url) => {
        try {
          const normalized = new URL(url);
          return normalized.href.replace(/\/$/, '');
        } catch {
          return url;
        }
      };

      // 将书签树转换为扁平化的URL映射，用于快速查找
      const getBookmarkMap = (bookmarkTree) => {
        const map = new Map();

        const traverse = (nodes) => {
          // 检查nodes是否为有效数组
          if (!nodes || !Array.isArray(nodes)) {
            return;
          }
          for (const node of nodes) {
            // 用 type 字段判断，比 node.children 更可靠（空数组也是 truthy）
            if (node.type === 'folder') {
              const safeChildren = node.children && Array.isArray(node.children) ? node.children : [];
              traverse(safeChildren);
            } else if (node.type === 'url' && node.url) {
              // 使用规范化 URL 作为 key，避免末尾斜杠等差异导致误判
              map.set(normalizeUrl(node.url), node);
            }
          }
        };

        // 从roots.bookmark_bar和roots.other开始遍历
        if (bookmarkTree.roots) {
          if (bookmarkTree.roots.bookmark_bar && bookmarkTree.roots.bookmark_bar.children) {
            traverse(bookmarkTree.roots.bookmark_bar.children);
          }
          if (bookmarkTree.roots.other && bookmarkTree.roots.other.children) {
            traverse(bookmarkTree.roots.other.children);
          }
        }
        return map;
      };

      // 获取文件夹映射，用于避免创建重复文件夹
      const getFolderMap = (bookmarkTree) => {
        const map = new Map();

        const traverse = (nodes, path = '') => {
          // 检查nodes是否为有效数组
          if (!nodes || !Array.isArray(nodes)) {
            return;
          }
          for (const node of nodes) {
            const safeChildren = node.children && Array.isArray(node.children) ? node.children : [];
            if (node.type === 'folder') {
              const folderPath = path ? `${path}/${node.name}` : node.name;
              map.set(folderPath, node);
              traverse(safeChildren, folderPath);
            }
          }
        };

        // 从roots.bookmark_bar和roots.other开始遍历
        if (bookmarkTree.roots) {
          // 添加根文件夹到映射中
          if (bookmarkTree.roots.bookmark_bar) {
            map.set('书签栏', bookmarkTree.roots.bookmark_bar);
            if (bookmarkTree.roots.bookmark_bar.children) {
              traverse(bookmarkTree.roots.bookmark_bar.children, '书签栏');
            }
          }
          if (bookmarkTree.roots.other) {
            map.set('其他书签', bookmarkTree.roots.other);
            if (bookmarkTree.roots.other.children) {
              traverse(bookmarkTree.roots.other.children, '其他书签');
            }
          }
        }
        return map;
      };

      const localBookmarks = getBookmarkMap(localBookmarkTree);
      const localFolders = getFolderMap(localBookmarkTree);

      // 统计同步结果
      let addedCount = 0;
      let skippedCount = 0;
      const errors = [];

      // 递归创建新书签，跳过已存在的
      const createBookmarkTree = async (nodes, parentId, basePath = '') => {
        // 检查nodes是否为有效数组
        if (!nodes || !Array.isArray(nodes)) {
          return;
        }

        for (const node of nodes) {
          try {
            if (node.type === 'folder') {
              // 对于文件夹，检查是否已存在
              const folderPath = basePath ? `${basePath}/${node.name}` : node.name;
              const existingFolder = localFolders.get(folderPath);

              let folderId;
              if (existingFolder) {
                // 如果文件夹已存在，使用现有文件夹的ID
                folderId = existingFolder.id;
              } else {
                // 如果文件夹不存在，创建新文件夹
                const folder = await chrome.bookmarks.create({
                  parentId: parentId,
                  title: node.name
                });
                folderId = folder.id;
                // 将新文件夹添加到映射中
                localFolders.set(folderPath, folder);
                console.log(`创建文件夹: ${folderPath}`);
              }

              // 递归处理文件夹中的内容
              const safeChildren = node.children && Array.isArray(node.children) ? node.children : [];
              await createBookmarkTree(safeChildren, folderId, folderPath);
            } else if (node.type === 'url') {
              // 对于书签，使用规范化 URL 检查是否已存在
              if (node.url && node.url.trim() !== '') {
                const normalizedUrl = normalizeUrl(node.url);
                if (!localBookmarks.has(normalizedUrl)) {
                  await chrome.bookmarks.create({
                    parentId: parentId,
                    title: node.name,
                    url: node.url
                  });
                  addedCount++;
                  // 将新添加的 URL 加入本地映射，避免同一批次内的重复添加
                  localBookmarks.set(normalizedUrl, { url: node.url });
                } else {
                  skippedCount++;
                }
              } else {
                // URL 为空的书签节点，跳过并记录
                console.warn('跳过空 URL 的书签节点:', node.name);
                skippedCount++;
              }
            } else {
              // 未知类型的节点，记录并跳过
              console.warn('跳过未知类型的节点:', node.name, 'type:', node.type);
            }
          } catch (e) {
            console.error('处理书签失败:', node.name, e);
            errors.push({ name: node.name, error: e.message });
            continue;
          }
        }
      };

      // 获取书签栏和其他书签的ID
      // localBookmarkTree是对象格式，不是数组
      const bookmarksBar = localBookmarkTree.roots ? localBookmarkTree.roots.bookmark_bar : null;
      const otherBookmarks = localBookmarkTree.roots ? localBookmarkTree.roots.other : null;

      // 分别在书签栏和其他书签下创建新书签
      if (cloudBookmarks.roots) {
        // 处理书签栏
        if (cloudBookmarks.roots.bookmark_bar) {
          const bookmarkBarChildren = cloudBookmarks.roots.bookmark_bar.children && Array.isArray(cloudBookmarks.roots.bookmark_bar.children) ? cloudBookmarks.roots.bookmark_bar.children : [];
          await createBookmarkTree(bookmarkBarChildren, bookmarksBar.id, '书签栏');
        }

        // 处理其他书签
        if (cloudBookmarks.roots.other) {
          const otherChildren = cloudBookmarks.roots.other.children && Array.isArray(cloudBookmarks.roots.other.children) ? cloudBookmarks.roots.other.children : [];
          await createBookmarkTree(otherChildren, otherBookmarks.id, '其他书签');
        }
      }

      // 输出同步统计
      console.log(`书签同步完成：新增 ${addedCount} 个，跳过 ${skippedCount} 个（已存在）`,
        errors.length > 0 ? `，${errors.length} 个失败` : '');
      if (errors.length > 0) {
        console.warn('同步失败详情:', errors);
      }

      return { added: addedCount, skipped: skippedCount, errors };
    } catch (error) {
     throw new Error(`保存到本地失败: ${error.message}`);
    }
  }
  static async getToken() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['accessToken'], (result) => {
        resolve(result.accessToken);
      });
    });
  }

  // 在 BookmarkManager 类中添加新方法
  static async clearLocalBookmarks() {
    try {
      // 获取所有书签文件夹
      const bookmarkTree = await this.getAllBookmarks();
      
      // 只清除非根节点下的书签
      // bookmarkTree是对象格式，不是数组
      const rootChildren = [];
      if (bookmarkTree.roots) {
        if (bookmarkTree.roots.bookmark_bar) {
          rootChildren.push(bookmarkTree.roots.bookmark_bar);
        }
        if (bookmarkTree.roots.other) {
          rootChildren.push(bookmarkTree.roots.other);
        }
        if (bookmarkTree.roots.mobile) {
          rootChildren.push(bookmarkTree.roots.mobile);
        }
      }
      
      for (const child of rootChildren) {
        // 删除书签栏和其他书签文件夹下的内容
        const safeChildren = child.children && Array.isArray(child.children) ? child.children : [];
        for (const bookmark of safeChildren) {
          try {
            await chrome.bookmarks.removeTree(bookmark.id);
          } catch (e) {
            console.warn('删除书签失败:', e);
          }
        }
      }
      return true;
    } catch (error) {
      throw new Error(`清除书签失败: ${error.message}`);
    }
  }

  // 查找新增的书签：比较本地和云端书签，返回本地独有的书签
  static async findNewBookmarks(localBookmarks, cloudBookmarks) {
    const cloudBookmarkMap = new Map();
    const newBookmarks = [];

    // 规范化 URL 函数
    function normalizeUrl(url) {
      try {
        const normalized = new URL(url);
        // 移除末尾的斜杠
        return normalized.href.replace(/\/$/, '');
      } catch {
        return url;
      }
    }

    // 收集云端书签信息，用 URL+标题+路径 作为唯一标识
    function collectBookmarks(bookmarks, path = []) {
      if (!bookmarks) return;
      bookmarks.forEach(bookmark => {
        if (bookmark.type === 'folder') {
          const safeChildren = bookmark.children && Array.isArray(bookmark.children) ? bookmark.children : [];
          collectBookmarks(safeChildren, [...path, bookmark.name]);
        } else if (bookmark.type === 'url') {
          const normalizedUrl = normalizeUrl(bookmark.url);
          const normalizedTitle = bookmark.name.trim();
          const key = `${normalizedUrl}|${normalizedTitle}|${path.join('/')}`;
          cloudBookmarkMap.set(key, bookmark);
        }
      });
    }

    // 在本地书签中查找云端没有的书签
    function findNew(bookmarks, path = []) {
      if (!bookmarks) return;
      bookmarks.forEach(bookmark => {
        if (bookmark.type === 'folder') {
          const safeChildren = bookmark.children && Array.isArray(bookmark.children) ? bookmark.children : [];
          findNew(safeChildren, [...path, bookmark.name]);
        } else if (bookmark.type === 'url') {
          const normalizedUrl = normalizeUrl(bookmark.url);
          const normalizedTitle = bookmark.name.trim();
          const key = `${normalizedUrl}|${normalizedTitle}|${path.join('/')}`;
          
          if (!cloudBookmarkMap.has(key)) {
            newBookmarks.push({
              ...bookmark,
              path: [...path, bookmark.name]
            });
          }
        }
      });
    }

    // 收集云端书签
    // 收集云端书签
    if (cloudBookmarks.roots) {
      // 处理书签栏
      if (cloudBookmarks.roots.bookmark_bar) {
        const safeChildren = cloudBookmarks.roots.bookmark_bar.children && Array.isArray(cloudBookmarks.roots.bookmark_bar.children) ? cloudBookmarks.roots.bookmark_bar.children : [];
        collectBookmarks(safeChildren, ['书签栏']);
      }
      
      // 处理其他书签
      if (cloudBookmarks.roots.other) {
        const safeChildren = cloudBookmarks.roots.other.children && Array.isArray(cloudBookmarks.roots.other.children) ? cloudBookmarks.roots.other.children : [];
        collectBookmarks(safeChildren, ['其他书签']);
      }
    }
    
    // 查找本地新增书签
    if (localBookmarks.roots) {
      // 处理书签栏
      if (localBookmarks.roots.bookmark_bar) {
        const safeChildren = localBookmarks.roots.bookmark_bar.children && Array.isArray(localBookmarks.roots.bookmark_bar.children) ? localBookmarks.roots.bookmark_bar.children : [];
        findNew(safeChildren, ['书签栏']);
      }
      
      // 处理其他书签
      if (localBookmarks.roots.other) {
        const safeChildren = localBookmarks.roots.other.children && Array.isArray(localBookmarks.roots.other.children) ? localBookmarks.roots.other.children : [];
        findNew(safeChildren, ['其他书签']);
      }
    }
    
    return newBookmarks;
  }

  // 去重书签数据，处理重复文件夹问题
  static deduplicateBookmarks(bookmarks) {
    // 深拷贝书签数据，避免修改原始数据
    const processedBookmarks = JSON.parse(JSON.stringify(bookmarks));
    
    // 如果没有roots节点，直接返回
    if (!processedBookmarks.roots) {
      return processedBookmarks;
    }
    
    // 处理每个根文件夹
    ['bookmark_bar', 'other', 'mobile'].forEach(rootKey => {
      if (processedBookmarks.roots[rootKey]) {
        processedBookmarks.roots[rootKey].children = this.deduplicateChildren(
          processedBookmarks.roots[rootKey].children || []
        );
      }
    });
    
    return processedBookmarks;
  }
  
  // 去重子节点数组
  static deduplicateChildren(children) {
    if (!Array.isArray(children) || children.length === 0) {
      return children;
    }
    
    const folderMap = new Map(); // 用于存储文件夹名称到文件夹对象的映射
    const result = [];
    
    // 遍历所有子节点
    for (const item of children) {
      if (item.type === 'folder') {
        // 如果是文件夹
        if (folderMap.has(item.name)) {
          // 如果已存在同名文件夹，合并其子节点
          const existingFolder = folderMap.get(item.name);
          if (item.children && Array.isArray(item.children)) {
            // 合并子节点并去重
            existingFolder.children = this.mergeChildren(
              existingFolder.children || [], 
              item.children
            );
          }
        } else {
          // 如果不存在同名文件夹，添加到结果中
          folderMap.set(item.name, item);
          result.push(item);
          
          // 递归处理子文件夹
          if (item.children && Array.isArray(item.children)) {
            item.children = this.deduplicateChildren(item.children);
          }
        }
      } else if (item.type === 'url' && item.url && item.url.trim() !== '') {
        // 如果是书签项且URL不为空，添加到结果中
        result.push(item);
      }
    }
    
    return result;
  }
  
  // 合并两个子节点数组并去重
  static mergeChildren(existingChildren, newChildren) {
    // 创建现有子节点的映射，用于快速查找
    const existingMap = new Map();
    
    // 建立现有子节点的映射
    for (const item of existingChildren) {
      if (item.type === 'folder') {
        existingMap.set(`folder:${item.name}`, item);
      } else if (item.type === 'url') {
        existingMap.set(`url:${item.name}:${item.url}`, item);
      }
    }
    
    // 遍历新子节点
    for (const item of newChildren) {
      if (item.type === 'folder') {
        const key = `folder:${item.name}`;
        if (existingMap.has(key)) {
          // 如果存在同名文件夹，合并其子节点
          const existingFolder = existingMap.get(key);
          if (item.children && Array.isArray(item.children)) {
            existingFolder.children = this.mergeChildren(
              existingFolder.children || [], 
              item.children
            );
          }
        } else {
          // 如果不存在同名文件夹，添加到现有子节点中
          existingChildren.push(item);
          existingMap.set(key, item);
          
          // 递归处理子文件夹
          if (item.children && Array.isArray(item.children)) {
            item.children = this.deduplicateChildren(item.children);
          }
        }
      } else if (item.type === 'url' && item.url && item.url.trim() !== '') {
        const key = `url:${item.name}:${item.url}`;
        if (!existingMap.has(key)) {
          // 如果不存在相同的书签项，添加到现有子节点中
          existingChildren.push(item);
          existingMap.set(key, item);
        }
      }
    }
    
    return existingChildren;
  }

  // 合并书签：将新书签合并到现有的书签树中
  static async mergeBookmarks(cloudBookmarks, newBookmarks) {
    // 创建新的书签结构
    const result = {
      version: '2.0',
      lastSync: new Date().toISOString(),
      roots: {
        bookmark_bar: {
          id: '1',
          name: '书签栏',
          type: 'folder',
          children: [],
          dateAdded: Date.now()
        },
        other: {
          id: '2',
          name: '其他书签',
          type: 'folder',
          children: [],
          dateAdded: Date.now()
        },
        mobile: {
          id: '3',
          name: '移动书签',
          type: 'folder',
          children: [],
          dateAdded: Date.now()
        }
      },
      meta: {
        generator: 'BookmarkSync v2.0',
        checksum: 'a1b2c3d4e5f6'
      }
    };

    // 如果云端书签存在，则使用其结构作为基础
    if (cloudBookmarks && cloudBookmarks.roots) {
      result.roots = JSON.parse(JSON.stringify(cloudBookmarks.roots));
    }

    // 创建文件夹映射，用于快速查找已存在的文件夹
    const folderMap = new Map();
    
    // 遍历书签树，建立文件夹路径到文件夹对象的映射
    function buildFolderMap(nodes, path = '') {
      if (!nodes || !Array.isArray(nodes)) return;
      for (const node of nodes) {
        if (node.type === 'folder') {
          const folderPath = path ? `${path}/${node.name}` : node.name;
          folderMap.set(folderPath, node);
          if (node.children) {
            buildFolderMap(node.children, folderPath);
          }
        }
      }
    }
    
    // 为根文件夹建立映射
    if (result.roots.bookmark_bar) {
      folderMap.set('书签栏', result.roots.bookmark_bar);
      buildFolderMap(result.roots.bookmark_bar.children, '书签栏');
    }
    if (result.roots.other) {
      folderMap.set('其他书签', result.roots.other);
      buildFolderMap(result.roots.other.children, '其他书签');
    }
    
    newBookmarks.forEach(newBookmark => {
      let current = null;
      
      // 根据路径确定添加到哪个根文件夹
      if (newBookmark.path[0] === '书签栏') {
        current = result.roots.bookmark_bar.children && Array.isArray(result.roots.bookmark_bar.children) ? result.roots.bookmark_bar.children : [];
      } else if (newBookmark.path[0] === '其他书签') {
        current = result.roots.other.children && Array.isArray(result.roots.other.children) ? result.roots.other.children : [];
      } else {
        // 默认添加到其他书签
        current = result.roots.other.children && Array.isArray(result.roots.other.children) ? result.roots.other.children : [];
      }

      // 检查current是否有效
      if (!current) {
        console.warn('无效的书签根路径:', newBookmark.path[0]);
        return;
      }

      // 按照路径创建或查找文件夹
    let currentPath = newBookmark.path[0];
    for (let i = 1; i < newBookmark.path.length - 1; i++) {
      const folderName = newBookmark.path[i];
      const folderPath = `${currentPath}/${folderName}`;
      let folder = folderMap.get(folderPath);

      if (!folder) {
        folder = {
          id: `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          name: folderName,
          type: 'folder',
          children: [],
          dateAdded: Date.now(),
          dateModified: Date.now()
        };
        current.push(folder);
        // 将新创建的文件夹添加到映射中
        folderMap.set(folderPath, folder);
      }

      if (!folder.children) {
        folder.children = [];
      }

      current = folder.children;
      currentPath = folderPath;
    }

    // 只有当是书签（不是空文件夹）时才添加
    if (newBookmark.url && newBookmark.url.trim() !== '') {
      // 添加新书签到对应文件夹
      current.push({
        id: `bm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: newBookmark.path[newBookmark.path.length - 1],
        type: 'url',
        url: newBookmark.url,
        dateAdded: Date.now(),
        dateModified: Date.now()
      });
    }
    });

    // 更新同步时间
    result.lastSync = new Date().toISOString();
    
    return result;
  }

  // 创建云端书签备份

  // 获取格式化的远程书签列表（包括书签和文件夹）
  static async getRemoteBookmarkList() {
    try {
      const cloudBookmarks = await this.downloadBookmarks();
      const remoteItems = [];

      // 递归收集书签和文件夹信息，包含路径
      function collectRemoteItems(bookmarks, path = []) {
        if (!bookmarks || !Array.isArray(bookmarks)) return;
        bookmarks.forEach(item => {
          if (item.type === 'folder') {
            // 添加文件夹信息
            remoteItems.push({
              id: item.id,
              name: item.name,
              type: 'folder',
              path: [...path],
              dateAdded: item.dateAdded,
              dateModified: item.dateModified
            });
            
            // 递归处理子节点
            const safeChildren = item.children && Array.isArray(item.children) ? item.children : [];
            collectRemoteItems(safeChildren, [...path, item.name]);
          } else if (item.type === 'url' && item.url && item.url.trim() !== '') {
            // 添加书签信息
            remoteItems.push({
              id: item.id,
              name: item.name,
              type: 'bookmark',
              url: item.url,
              path: [...path],
              dateAdded: item.dateAdded,
              dateModified: item.dateModified
            });
          }
        });
      }

      // 遍历所有根文件夹收集项目
      if (cloudBookmarks.roots) {
        for (const root in cloudBookmarks.roots) {
          const safeChildren = cloudBookmarks.roots[root].children && Array.isArray(cloudBookmarks.roots[root].children) ? cloudBookmarks.roots[root].children : [];
          collectRemoteItems(safeChildren, [cloudBookmarks.roots[root].name]);
        }
      }
      
      return remoteItems;
    } catch (error) {
      // 如果是密钥相关的错误，提供更具体的错误信息
      if (error.message.includes('加密密钥') || error.message.includes('解密失败') || error.message.includes('JSON解析失败')) {
        throw error;
      }
      throw new Error(`获取远程书签列表失败: ${error.message}`);
    }
  }

  // 批量删除远程书签
  static async deleteRemoteBookmarks(bookmarksToDelete) {
    try {
      const cloudBookmarks = await this.downloadBookmarks();
      const deletedIds = new Set();
      
      // 递归收集所有要删除的项目ID（包括文件夹内的所有子项）
      // 处理可能带前缀的ID
      function collectDeletedIds(items) {
        if (!items || !Array.isArray(items)) return;
        
        items.forEach(item => {
          deletedIds.add(item.id);
          if (item.type === 'folder' && item.children) {
            collectDeletedIds(item.children);
          }
        });
      }
      
      collectDeletedIds(bookmarksToDelete);

      // 递归过滤要保留的书签
      function filterBookmarks(bookmarks, path = []) {
        if (!bookmarks || !Array.isArray(bookmarks)) return [];
      
        return bookmarks.filter(bookmark => {
          // 检查当前书签或文件夹是否需要删除
          if (deletedIds.has(bookmark.id)) {
            return false; // 直接删除
          }
          
          if (bookmark.type === 'folder') {
            // 递归处理子节点
            const safeChildren = bookmark.children && Array.isArray(bookmark.children) ? bookmark.children : [];
            const filteredChildren = filterBookmarks(safeChildren, [...path, bookmark.name]);
            bookmark.children = filteredChildren;
            // 文件夹即使为空也保留，除非它本身在删除列表中
            return true;
          } else if (bookmark.type === 'url') {
            // URL类型的书签需要检查是否在删除列表中
            return !deletedIds.has(bookmark.id);
          }
          return true;
        });
      }

      // 遍历所有根文件夹过滤书签
      if (cloudBookmarks.roots) {
        for (const root in cloudBookmarks.roots) {
          const safeChildren = cloudBookmarks.roots[root].children && Array.isArray(cloudBookmarks.roots[root].children) ? cloudBookmarks.roots[root].children : [];
          cloudBookmarks.roots[root].children = filterBookmarks(safeChildren, [cloudBookmarks.roots[root].name]);
        }
      }
      
      await this.uploadBookmarks(cloudBookmarks);
      return true;
    } catch (error) {
      // 如果是密钥相关的错误，提供更具体的错误信息
      if (error.message.includes('加密密钥') || error.message.includes('解密失败') || error.message.includes('JSON解析失败')) {
        throw error;
      }
      throw new Error(`删除远程书签失败: ${error.message}`);
    }
  }
}