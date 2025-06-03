(function(){
  'use strict'

  let timer, reader
  
  function decodeArrayBufferInChunks ({
    buffer, onDecodedChunk, onDetected, onComplete, onError, chunkSize = 1024 * 1024
  }) {
    let offset = 0
    const totalLength = buffer.byteLength
  
    // 存储支持的编码格式，TextDecoder 支持的编码列表可以参考 MDN
    // 这里只列举一些常见的，实际应用中可以根据需要扩展
    const supportedEncodings = [
      'utf-8', 'utf-16le', 'utf-16be', 'gbk', 'gb18030', 'big5',
      'shift_jis', 'euc-jp', 'iso-8859-1', 'windows-1252'
    ]
  
    let decoder = null // 存储 TextDecoder 实例，用于后续解码
  
    // 尝试预测编码格式
    function detectEncoding() {
      // 尝试用不同的编码格式解码一小段数据，看是否报错
      // 这种方式不是绝对准确，但对于常见文本文件有一定效果
      const testLength = Math.min(buffer.byteLength, 1024) // 尝试前1KB
      const testView = new Uint8Array(buffer, 0, testLength)
  
      for (const encoding of supportedEncodings) {
        try {
          const tempDecoder = new TextDecoder(encoding, { fatal: true }) // fatal: true 遇到无法解码的字节会抛出错误
          tempDecoder.decode(testView)
          console.log(`Predicted encoding: ${encoding}`)
          return encoding // 找到一个不报错的编码，就认为是它
        } catch (e) {
          // 忽略解码错误，尝试下一个编码
        }
      }
      console.warn('Could not reliably predict encoding, defaulting to utf-8.')
      return 'utf-8' // 默认使用 utf-8
    }
  
    const predictedEncoding = detectEncoding()
    try {
      decoder = new TextDecoder(predictedEncoding)
      onDetected(predictedEncoding)
    } catch (e) {
      if (onError) {
        onError(new Error(`Failed to create TextDecoder with predicted encoding "${predictedEncoding}": ${e.message}`))
      }
      return
    }
  
  
    function processChunk() {
      if (offset < totalLength) {
        const end = Math.min(offset + chunkSize, totalLength)
        const chunk = buffer.slice(offset, end)
        const uint8Array = new Uint8Array(chunk)
  
        try {
          const decodedString = decoder.decode(uint8Array, { stream: true }) // stream: true 表示不是最后一个块
          onDecodedChunk(decodedString)
          offset = end
  
          // 使用 setTimeout 释放主线程，避免阻塞
          timer = setTimeout(processChunk, 0)
        } catch (e) {
          if (onError) {
            onError(e)
          }
          console.error('Error decoding chunk:', e)
        }
      } else {
        // 所有分块处理完毕，处理剩余的缓冲数据（如果有的话）
        try {
          const finalDecodedString = decoder.decode() // 不带参数调用 decode() 会处理剩余的缓冲数据
          if (finalDecodedString) {
            onDecodedChunk(finalDecodedString)
          }
        } catch (e) {
          if (onError) {
            onError(e)
          }
          console.error('Error decoding remaining data:', e)
        }
        onComplete()
      }
    }
  
    // 启动分块处理
    processChunk()
  }

  const PLUGIN_NAME = 'Novel_Preview'
  const TEXT_EXTENSIONS = ['txt', 'md']
  
  function isTextFile(entry) {
    return entry && entry.ext && TEXT_EXTENSIONS.includes(entry.ext.toLowerCase())
  }
  function isMobileBrowser() {
    // 常见移动设备的关键词列表
    const mobileKeywords = [
      'Android', 'webOS', 'iPhone', 'iPad', 'iPod', 'BlackBerry',
      'Windows Phone', 'Mobile', 'IEMobile', 'Opera Mini', 'Mobi'
    ];

    // 获取用户代理字符串并转换为小写
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    const lowerCaseUserAgent = userAgent.toLowerCase();

    // 检查用户代理是否包含任何移动设备关键词
    return mobileKeywords.some(keyword => 
      lowerCaseUserAgent.includes(keyword.toLowerCase())
    );
  }  
  function init () {
    let render, title, tip1, tip2, close, content, nav
    const renderClassName = `${ PLUGIN_NAME }-render`
    const titleClassName = `${ PLUGIN_NAME }-title`
    const tipClassName = `${ PLUGIN_NAME }-tip`
    const closeBTNClassName = `${ PLUGIN_NAME }-close`
    const visibleClassName = `${ PLUGIN_NAME }-visible`
    const contentClassName = `${ PLUGIN_NAME }-content`
    const frozeClassName = `${ PLUGIN_NAME }-froze`
    const navClassName = `${ PLUGIN_NAME }-nav`
    const navBTNClassName = `${ PLUGIN_NAME }-navbtn`
    const stickyClassName = `${ PLUGIN_NAME }-sticky`
    function injection () {
      const CSS = document.createElement('style')
      const CSS_CONTENT = `
      .${ renderClassName } {
        display: flex;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        padding-top: 51.5px;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "STHeiti", "Microsoft YaHei", "Microsoft JhengHei", "Noto Sans SC", "Source Han Sans SC", "WenQuanYi Micro Hei", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        color: inherit !important;
        background: inherit !important;
        z-index: 999;
        visibility: hidden;
        align-items: center;
        flex-direction: column;
        box-sizing: border-box;
      }
      .${ titleClassName } {
        position: absolute;
        top: 15px;
        left: 15px;
        opacity: 0.4;
        font-size: 0.8em;
        width: calc(100% - 100px);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .${ tipClassName } {
        display: none;
        color: inherit !important;
        text-align: center;
        visibility: hidden;
      }
      .${ closeBTNClassName } {
        display: block;
        position: absolute;
        top: 15px;
        right: 15px;
        cursor: pointer;
        opacity: 0.4;
        filter: grayscale();
      }
      .${ visibleClassName } {
        display: block !important;
        visibility: visible !important;
      }
      .${ contentClassName } {
        display: none;
        width: 100%;
        height: 100%;
        padding: 0 15px;
        box-sizing: border-box;
        overflow: auto;
        visibility: hidden;
        background: inherit !important;
      }
      .${ contentClassName } p {
        white-space: pre-wrap;
        word-break: break-all;
        font-size: 1.3em;
        line-height: 2em;
        text-indent: 2em;
      }
      .${ frozeClassName } {
        overflow: hidden;
      }
      .${ navClassName } {
        position: relative;
        top: 0;
        background: inherit !important;
        padding-bottom: 15px;
      }
      .${ navBTNClassName } {
        width: 100px;
      }
      .${ stickyClassName } {
        position: sticky !important;
      }
      `
  
      render = document.createElement('div')
      title = document.createElement('span')
      close = document.createElement('div')
      content = document.createElement('div')
      tip1 = document.createElement('p')
      tip2 = document.createElement('p')
  
      render.className = renderClassName
      title.className = titleClassName
      content.className = contentClassName
      ;[tip1, tip2].forEach(node => node.className = tipClassName)
      title.innerText = '无标题'
      tip1.innerText = `⏬ 正在拉取……已完成 0%`
      tip2.innerText = `⏸ 等待拉取结束`
      tip1.style = 'margin-top: 35%;'
      close.className = closeBTNClassName
      close.innerText = '❌'
      close.addEventListener('click', handleClose)
      CSS.innerHTML = CSS_CONTENT
      ;[title, close, content, tip1, tip2].forEach(node => render.append(node))
      ;[CSS, render].forEach(node => document.body.append(node))
    }
    function changeTitle (value) {
      title.innerText = value
    }
  
    function show (targets) {
      [].concat(targets).forEach(node => {
        node.classList.add(visibleClassName)
      })
    }
    function hide (targets) {
      [].concat(targets).forEach(node => {
        node.classList.remove(visibleClassName)
      })
    }
  
    function tipsReset () {
      tip1.innerText = `⏬ 正在拉取……已完成 0%`
      tip2.innerText = `⏸ 等待拉取结束`
    }
    function renderNovel (paragraphs, container) {
      // 1. 定义标题正则表达式
      const titleRegexes = [
        /^\s*Chapter\s+\d+\s*$/, // e.g., "Chapter 1", " Chapter 12 "
        /^\s*Chapter\s+[IVXLCDM]+\s*$/, // e.g., "Chapter I", "Chapter III" (Roman numerals)
        /^\s*序\s*.*$/, // Prologue
        /^\s*引\s*$/, // Introduction
        /^\s*尾声\s*$/, // Epilogue
        /^(卷\s*[0123456789一二三四五六七八九十零〇百千两壹貳叁肆伍陸柒捌玖拾佰仟]+.*)$/,
        /^(第\s*[0123456789一二三四五六七八九十零〇百千两壹貳叁肆伍陸柒捌玖拾佰仟]+\s*[章回卷节集].*)$/,
        /^(第\s*[0123456789一二三四五六七八九十零〇百千两壹貳叁肆伍陸柒捌玖拾佰仟]+\s*部[^下位分长门队].*)$/,
        /^([0123456789]+\s+.+)$/
      ];

      // 2. 分块处理函数
      function chunkParagraphs(paragraphs) {
        const chunks = [];
        let currentChunk = [];
        let pageCount = 1;
        
        for (let i = 0; i < paragraphs.length; i++) {
          const paragraph = paragraphs[i].trim();
          
          // 检查是否是标题段落
          const isTitle = titleRegexes.some(regex => regex.test(paragraph));
          
          if (isTitle && currentChunk.length > 0) {
            let title = currentChunk[0]

            if (!titleRegexes.some(regex => regex.test(title))) {
              title = `第${pageCount}页`
            }
            // 保存当前块并开始新块
            chunks.push({
              title,
              content: [...currentChunk]
            });
            pageCount++;
            currentChunk = [paragraph];
          } else if (isTitle) {
            // 第一个段落就是标题
            currentChunk.push(paragraph);
          } else {
            // 非标题段落
            currentChunk.push(paragraph);
            
            // 非标题段落达到500段时自动分页
            if (currentChunk.length >= 500) {
              chunks.push({
                title: `第${pageCount}页`,
                content: [...currentChunk]
              });
              pageCount++;
              currentChunk = [];
            }
          }
        }
        
        // 添加最后一块
        if (currentChunk.length > 0) {
            chunks.push({
                title: currentChunk[0] || `第${pageCount}页`,
                content: currentChunk
            });
        }
        
        return chunks;
      }

      // 3. 创建章节数据
      const chapters = chunkParagraphs(paragraphs);
      let currentChapterIndex = 0;

      // 4. 渲染函数
      function renderChapter(index) {
        content.scrollTo(0, 0) /** 重置滚动条 */
        // 更新当前章节索引
        currentChapterIndex = index;
        
        // 获取章节数据
        const chapter = chapters[currentChapterIndex];
        
        // 更新内容区域
        contentDiv.innerHTML = chapter.content
          .map(p => `<p>${p}</p>`)
          .join('');
        
        // 更新下拉菜单选中项
        chapterSelect.value = currentChapterIndex;
        
        // 更新按钮状态
        prevBtn.disabled = currentChapterIndex === 0;
        nextBtn.disabled = currentChapterIndex === chapters.length - 1;
      }

      // 5. 创建UI元素
      container.innerHTML = '';
      
      // 导航栏
      const navBar = document.createElement('div');
      navBar.style.display = 'flex';
      navBar.style.gap = '10px';
      navBar.style.alignItems = 'center';
      navBar.className = navClassName
      nav = navBar
      
      // 上一章按钮
      const prevBtn = document.createElement('button');
      prevBtn.textContent = '后退';
      prevBtn.disabled = true;
      
      // 章节选择器
      const chapterSelect = document.createElement('select');
      chapters.forEach((chapter, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = chapter.title;
        chapterSelect.appendChild(option);
      });
      
      // 下一章按钮
      const nextBtn = document.createElement('button');
      nextBtn.textContent = '前进';
      if (chapters.length <= 1) {
        nextBtn.disabled = true;
      }
      
      [prevBtn, nextBtn].forEach(btn => btn.className = navBTNClassName)

      // 内容区域
      const contentDiv = document.createElement('div');
      contentDiv.style.paddingBottom = '2em'
      
      // 组装UI
      navBar.appendChild(prevBtn);
      navBar.appendChild(chapterSelect);
      navBar.appendChild(nextBtn);
      container.appendChild(navBar);
      container.appendChild(contentDiv);
      
      // 6. 事件监听
      prevBtn.addEventListener('click', () => {
        if (currentChapterIndex > 0) {
          renderChapter(currentChapterIndex - 1);
        }
      });
      
      nextBtn.addEventListener('click', () => {
        if (currentChapterIndex < chapters.length - 1) {
          renderChapter(currentChapterIndex + 1);
        }
      });
      
      chapterSelect.addEventListener('change', () => {
        renderChapter(parseInt(chapterSelect.value));
      });
      
      // 7. 初始渲染
      renderChapter(0);
    }
    async function finish (chunks) {
      tip1.innerText = `✅ 正在拉取……已完成 100%`
      tip2.innerText = `⏬ 正在推断文件编码`
  
      let decodedString = '', upperCasedEncoding
      decodeArrayBufferInChunks({
        buffer: chunks,
        onDecodedChunk (str) {
          decodedString += str
        },
        onDetected (encoding) {
          upperCasedEncoding = encoding.toLocaleUpperCase()
          tip2.innerText = `⏬ 正在转换文件编码 ${ upperCasedEncoding }`
        },
        onComplete () {
          const lines = decodedString.split(/[\r\n]+/g)
          tip2.innerText = `✅ 正在转换文件编码 ${ upperCasedEncoding }……已完成`
          renderNovel(lines, content)
          timer = setTimeout(() => {
            hide([tip1, tip2])
            show([content])
            content.scrollTo(0, 0)
          }, 500)
        },
        onError () {
  
        }
      })
    }
  
    async function fetchWithDownloadProgress(entry) {
      function onProgress ({ loaded, total, percentage }) {
        tip1.innerText = `⏬ 正在拉取……已完成 ${ parseInt(percentage) }%`
      }
      const response = await fetch(entry.uri)
  
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
  
      let total = entry.s
  
      reader = response.body.getReader()
      let receivedLength = 0 // 当前已接收的字节数
      const chunks = [] // 用于存储接收到的数据块
  
      async function reading () {
        const { done, value } = await reader.read()
      
        if (done) {
          // 将所有数据块合并成一个完整的 Uint8Array
          let chunksAll = new Uint8Array(receivedLength)
          let position = 0
          for (let chunk of chunks) {
            chunksAll.set(chunk, position)
            position += chunk.length
          }
  
          finish(chunksAll)
        } else {
          chunks.push(value)
          receivedLength += value.length
        
          // 计算并报告进度
          if (total > 0) {
            const percentage = (receivedLength / total) * 100
            onProgress({ loaded: receivedLength, total: total, percentage: percentage })
          }
          timer = setTimeout(reading)
        }
      }
      timer = setTimeout(reading)
    }
    function handleFullScreen (isExit = false) {
      if (!isMobileBrowser()) { return }
      if (isExit) {
        document.exitFullscreen()
      } else {
        document.documentElement.requestFullscreen({ navigationUI: "hide" })
      }
    }
    function handleNavSticky (event) {
      const target = event.target

      if (nav === null || !document.fullscreenElement) { return }
      if (target === nav || nav.contains(target)) {
        nav.classList.remove(stickyClassName)
      } else {
        nav.classList.toggle(stickyClassName)
      }
    }
    function handleClick (entry) {
      handleFullScreen()
      show([render, tip1, tip2])
      document.body.classList.add(frozeClassName)
  
      changeTitle(entry.name)
      fetchWithDownloadProgress(entry)
      render.addEventListener('click', handleNavSticky)
    }
    function handleClose () {
      handleFullScreen(true)
      hide([render, tip1, tip2, content])
      document.body.classList.remove(frozeClassName)
      
      changeTitle('无标题')
      tipsReset()
      reader.cancel()
      clearTimeout(timer)
      render.removeEventListener('click', handleNavSticky)
      setTimeout(() => {
        content.innerHTML = ''
        nav = null
      })
    }
    HFS.onEvent('fileMenu', ({ entry, menu }) => {
      if (isTextFile(entry) && !entry.isFolder) {
        menu.push({
          id: PLUGIN_NAME,
          label: '在线阅读',
          icon: '📖',
          onClick: () => handleClick(entry)
        })
      }
    })

    if (isMobileBrowser()) {
      function reEnterFullscreen () {
        /** 阅读窗口关闭或已经处于全屏模式时跳出 */
        if (render.classList.contains(visibleClassName) && !document.fullscreenElement) {
          handleFullScreen()
        }
      }
      document.addEventListener('fullscreenchange', () => {
        // 检测是否已退出全屏
        if (!document.fullscreenElement) {
          // 添加一次性点击事件监听器（捕获阶段）
          document.addEventListener('click', reEnterFullscreen, { once: true })
        }
      });
    }
    injection()
  }
  
  init()
})()