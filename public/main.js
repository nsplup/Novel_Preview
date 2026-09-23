(function () {
  'use strict'

  /* ================================================================
   * 常量
   * ================================================================ */
  const PLUGIN_NAME = 'Novel_Preview'
  const TEXT_EXTENSIONS = ['txt', 'md']

  const LS_FONT = PLUGIN_NAME + '.fontSize'
  const LS_PROGRESS = PLUGIN_NAME + '.progress.'

  const FONT_DEFAULT = 19
  const FONT_MIN = 13
  const FONT_MAX = 42
  const FONT_STEP = 2

  const SEARCH_MAX = 300
  const DECODE_CHUNK = 1024 * 1024
  const SAVE_DELAY = 700

  const TOC_ITEM_H = 48      // .np-toc-item: 44 + 2*2 margin
  const SEARCH_ITEM_H = 66   // .np-result:   64 + 2*1 margin
  const OVERSCAN = 6

  const ENCODINGS = [
    'utf-8', 'gb18030', 'big5', 'utf-16le', 'utf-16be',
    'shift_jis', 'euc-jp', 'windows-1252', 'iso-8859-1'
  ]

  /* ================================================================
   * SVG 图标
   * ================================================================ */
  const _svg = (d) =>
    `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`

  const ICON = {
    back: _svg('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
    prev: _svg('<path d="m15 18-6-6 6-6"/>'),
    next: _svg('<path d="m9 18 6-6-6-6"/>'),
    search: _svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>'),
    clear: _svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    fontUp: _svg('<path d="M2.5 19 7.5 6l5 13"/><path d="M4.3 14.6h6.4"/><path d="M16 17.5h5.5"/><path d="M18.75 14.75v5.5"/>'),
    fontDown: _svg('<path d="M2.5 19 7.5 6l5 13"/><path d="M4.3 14.6h6.4"/><path d="M16 17.5h5.5"/>')
  }

  /* ================================================================
   * 工具
   * ================================================================ */
  function isMobile() {
    const ua = navigator.userAgent || ''
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|Windows Phone|IEMobile|Opera Mini|Mobi/i.test(ua)) return true
    if (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua)) return true
    return false
  }

  const MOBILE = isMobile()

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }

  const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

  function isTextFile(entry) {
    return entry && entry.ext && TEXT_EXTENSIONS.includes(String(entry.ext).toLowerCase())
  }

  function ensureViewport() {
    const head = document.head || document.getElementsByTagName('head')[0]
    if (!head) return

    let meta = head.querySelector('meta[name="viewport"]')

    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'viewport')
      meta.setAttribute('content', 'width=device-width, initial-scale=1')
      head.appendChild(meta)
      return
    }

    // 如果已存在，提取现有的 content 转化成键值对进行精细化更新/补充
    let content = meta.getAttribute('content') || ''

    // 简易替换或拼接示例：确保 width 和 initial-scale 正确
    if (!/width\s*=\s*device-width/i.test(content)) {
      content = content.replace(/width\s*=\s*[^,]+/i, '').trim()
      content = content ? `${content}, width=device-width` : 'width=device-width'
    }
    if (!/initial-scale\s*=\s*1/i.test(content)) {
      content = content.replace(/initial-scale\s*=\s*[^,]+/i, '').trim()
      content = content ? `${content}, initial-scale=1` : 'initial-scale=1'
    }

    meta.setAttribute('content', content.replace(/^,\s*|,\s*$/g, ''))
  }

  /* ================================================================
   * 编码识别
   * ================================================================ */
  function isValidUtf8(bytes) {
    let i = 0
    const len = bytes.length
    while (i < len) {
      const b = bytes[i]
      let n = 0
      if (b < 0x80) { i++; continue }
      else if ((b & 0xE0) === 0xC0) { if (b < 0xC2) return false; n = 1 }
      else if ((b & 0xF0) === 0xE0) { n = 2 }
      else if ((b & 0xF8) === 0xF0) { if (b > 0xF4) return false; n = 3 }
      else return false

      if (i + n >= len) return true
      for (let k = 1; k <= n; k++) {
        if ((bytes[i + k] & 0xC0) !== 0x80) return false
      }
      i += n + 1
    }
    return true
  }

  function detectEncoding(buffer) {
    const bytes = new Uint8Array(buffer)
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8'
    if (bytes.length >= 2) {
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le'
      if (bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be'
    }
    const sample = bytes.subarray(0, Math.min(bytes.length, 65536))
    if (isValidUtf8(sample)) return 'utf-8'
    for (const enc of ENCODINGS) {
      if (enc === 'utf-8') continue
      let dec
      try { dec = new TextDecoder(enc, { fatal: true }) } catch (e) { continue }
      try { dec.decode(sample); return enc } catch (e) { /* try next */ }
    }
    return 'utf-8'
  }

  /* ================================================================
   * 章节切分（含"第一节课"等边缘场景排除）
   * ================================================================ */
  const CN_NUM = '0-9一二三四五六七八九十零〇百千两壹貳叁肆伍陸柒捌玖拾佰仟'

  const TITLE_PATTERNS = [
    new RegExp(`^\\s*Chapter\\s+\\d+\\s*[.:：、\\-—]?\\s*.{0,40}$`, 'i'),
    new RegExp(`^\\s*Chapter\\s+[IVXLCDM]+\\s*[.:：、\\-—]?\\s*.{0,40}$`, 'i'),
    /^\s*(?:序章|序言|序|楔子|引子|尾声|尾章|终章|大结局|后记|番外|外传)\s*[.:：、]?\s*.{0,30}$/,
    new RegExp(`^第\\s*[${CN_NUM}]+\\s*章(?!程|鱼|法|节).{0,40}$`),
    new RegExp(`^第\\s*[${CN_NUM}]+\\s*回(?!合|答|忆|家|信|来|去|头).{0,40}$`),
    new RegExp(`^第\\s*[${CN_NUM}]+\\s*节(?!课|日|目|气|奏|省|约|假|能|俭).{0,40}$`),
    new RegExp(`^第\\s*[${CN_NUM}]+\\s*卷.{0,40}$`),
    new RegExp(`^第\\s*[${CN_NUM}]+\\s*集(?!锦|合|团|体|市|邮|装).{0,40}$`),
    new RegExp(`^第\\s*[${CN_NUM}]+\\s*部(?!分|长|队|门|落|位|署|下|件).{0,40}$`),
    new RegExp(`^卷\\s*[${CN_NUM}]+.{0,40}$`),
    /^\d{1,4}\s+\S.{0,40}$/
  ]

  function isTitleLine(text) {
    if (!text) return false
    if (text.length < 2 || text.length > 40) return false
    if (/[，。！？；：、,\.!?;:]$/.test(text)) return false
    for (let i = 0; i < TITLE_PATTERNS.length; i++) {
      if (TITLE_PATTERNS[i].test(text)) return true
    }
    return false
  }

  function splitChapters(paragraphs) {
    const chapters = []
    let current = null

    for (let i = 0; i < paragraphs.length; i++) {
      const text = paragraphs[i].trim()
      if (!text) continue

      if (isTitleLine(text)) {
        if (current) chapters.push(current)
        current = { title: text, lines: [text] }
      } else {
        if (!current) current = { title: '正文', lines: [] }
        current.lines.push(text)
      }
    }

    if (current) chapters.push(current)
    if (!chapters.length) chapters.push({ title: '正文', lines: ['（空文件）'] })
    return chapters
  }

  /* ================================================================
   * 虚拟列表（支持元素回收）
   *
   *  renderItem(item, el) 约定：
   *    - el 为 undefined  → 创建并返回新元素
   *    - el 为已有元素     → 原地更新并返回该元素
   *
   *  内部维护：
   *    mounted : Map<index, HTMLElement>  当前挂在 DOM 上的元素
   *    pool    : HTMLElement[]            已回收、可复用的空闲元素
   * ================================================================ */
  function createVirtualList({ container, itemHeight, overscan = OVERSCAN, renderItem }) {
    let items = []
    let start = -1
    let end = -1
    let rafId = 0

    const mounted = new Map()
    const pool = []

    container.innerHTML = ''

    const emptyEl = document.createElement('div')
    emptyEl.className = 'np-empty'
    emptyEl.style.display = 'none'
    container.appendChild(emptyEl)

    const total = document.createElement('div')
    total.style.position = 'relative'
    total.style.width = '100%'
    container.appendChild(total)

    const layer = document.createElement('div')
    layer.style.position = 'absolute'
    layer.style.left = '0'
    layer.style.right = '0'
    layer.style.top = '0'
    layer.style.willChange = 'transform'
    total.appendChild(layer)

    function place(el, index) {
      el.style.transform = `translate3d(0, ${index * itemHeight}px, 0)`
    }

    function detach(el) {
      if (el.parentNode) el.parentNode.removeChild(el)
    }

    /* 从池中取元素（或新建），写入内容并定位 */
    function acquire(index) {
      const cached = pool.pop()
      const isNew = !cached
      const el = renderItem(items[index], cached) || cached
      if (isNew) {
        el.style.position = 'absolute'
        el.style.top = '0'
        el.style.left = '0'
        el.style.willChange = 'transform'
      }
      place(el, index)
      return el
    }

    function recycleAll() {
      mounted.forEach((el) => {
        detach(el)
        pool.push(el)
      })
      mounted.clear()
    }

    function doUpdate() {
      if (!items.length) return

      const st = container.scrollTop
      const vh = container.clientHeight || 1
      const s = Math.max(0, Math.floor(st / itemHeight) - overscan)
      const e = Math.min(items.length, Math.ceil((st + vh) / itemHeight) + overscan)

      if (s === start && e === end) return
      start = s
      end = e

      /* 1. 回收移出可视区的元素 */
      const dead = []
      mounted.forEach((el, i) => {
        if (i < s || i >= e) dead.push(i)
      })
      for (let k = 0; k < dead.length; k++) {
        const i = dead[k]
        const el = mounted.get(i)
        mounted.delete(i)
        detach(el)
        pool.push(el)
      }

      /* 2. 挂载新进入可视区的元素（优先复用池中元素） */
      const frag = document.createDocumentFragment()
      for (let i = s; i < e; i++) {
        if (mounted.has(i)) continue
        const el = acquire(i)
        mounted.set(i, el)
        frag.appendChild(el)
      }
      if (frag.childNodes.length) layer.appendChild(frag)
    }

    function schedule() {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        doUpdate()
      })
    }

    container.addEventListener('scroll', schedule, { passive: true })

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => { schedule() })
      ro.observe(container)
    }

    function setItems(newItems) {
      items = newItems || []
      emptyEl.style.display = 'none'
      total.style.display = ''
      total.style.height = (items.length * itemHeight) + 'px'

      recycleAll()
      start = -1
      end = -1
      container.scrollTop = 0
      doUpdate()
    }

    function showEmpty(message) {
      items = []
      recycleAll()
      total.style.height = '0px'
      total.style.display = 'none'
      start = -1
      end = -1
      emptyEl.textContent = message || ''
      emptyEl.style.display = ''
      container.scrollTop = 0
    }

    /* 原地重渲染当前已挂载的元素（不动 DOM 结构） */
    function refresh() {
      if (!items.length) return
      mounted.forEach((el, i) => {
        if (i < items.length) {
          renderItem(items[i], el)
          place(el, i)
        }
      })
      start = -1
      end = -1
      doUpdate()
    }

    return { setItems, showEmpty, refresh }
  }

  /* ================================================================
   * CSS
   * ================================================================ */
  const CSS_TEXT = `
  .np-render {
    --np-font-size: 19px;
    --np-line-height: 1.85;
    --np-header-h: 70px;
    --np-surface: rgba(250,250,250,.94);
    --np-solid: #fafafa;
    --np-line: rgba(127,127,127,.22);
    --np-hover: rgba(127,127,127,.12);
    --np-accent: #3b82f6;
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", "Segoe UI", Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.5;
    color: inherit;
    background: inherit;
    z-index: 2147483000;
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
    transition: opacity .18s ease;
    -webkit-tap-highlight-color: transparent;
    -webkit-text-size-adjust: 100%;
  }
  @media (prefers-color-scheme: dark) {
    .np-render {
      --np-surface: rgba(28,28,30,.92);
      --np-solid: #1c1c1e;
      --np-line: rgba(255,255,255,.18);
      --np-hover: rgba(255,255,255,.10);
    }
  }
  .np-render.np-visible {
    visibility: visible;
    opacity: 1;
    pointer-events: auto;
  }
  .np-render *, .np-render *::before, .np-render *::after { box-sizing: border-box; }

  body.np-locked { overflow: hidden !important; }

  /* ---------- 统一禁用交互设备的默认行为 ---------- */
  .np-iconbtn,
  .np-chapterbtn,
  .np-search-clear,
  .np-toc-item,
  .np-result {
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
    touch-action: manipulation;
  }

  /* ---------- 顶部工具栏 ---------- */
  .np-header {
    position: absolute;
    top: 0; left: 0; right: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    padding: 2px 8px 6px;
    padding-top: max(2px, env(safe-area-inset-top));
    background: var(--np-surface);
    -webkit-backdrop-filter: blur(20px) saturate(1.5);
    backdrop-filter: blur(20px) saturate(1.5);
    transition: transform .26s cubic-bezier(.32,.72,0,1), opacity .18s ease;
    will-change: transform;
  }
  .np-render.np-chrome-hidden .np-header {
    transform: translateY(-100%);
    opacity: 0;
    pointer-events: none;
  }

  .np-header-title {
    display: flex;
    align-items: center;
    height: 18px;
    padding: 0 4px;
    font-size: 11px;
    font-weight: 500;
    opacity: .48;
    overflow: hidden;
  }
  .np-title {
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .np-header-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 42px;
  }
  .np-header-spacer {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* ---------- 图标按钮 ---------- */
  .np-iconbtn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    transition: background .15s ease, transform .12s ease;
    -webkit-appearance: none;
    appearance: none;
    -webkit-tap-highlight-color: transparent;
  }
  .np-iconbtn:hover { background: var(--np-hover); }
  .np-iconbtn:active { background: var(--np-line); transform: scale(.93); }
  .np-iconbtn svg { width: 20px; height: 20px; display: block; }
  .np-iconbtn:disabled { opacity: .3; pointer-events: none; }

  /* ---------- 章节名/目录按钮（固定宽度） ---------- */
  .np-chapterbtn {
    flex: 0 0 auto;
    width: 200px;
    height: 36px;
    padding: 0 10px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background .15s ease;
    -webkit-appearance: none;
    appearance: none;
    -webkit-tap-highlight-color: transparent;
  }
  .np-chapterbtn:hover { background: var(--np-hover); }
  .np-chapterbtn:active { background: var(--np-line); }
  .np-chapter-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 640px) {
    .np-chapterbtn { width: 115px; font-size: 12px; }
  }

  /* ---------- 正文区 ---------- */
  .np-body {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  .np-reader {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 20px;
    font-size: var(--np-font-size);
    line-height: var(--np-line-height);
    outline: none;
    scrollbar-width: thin;
  }
  .np-reader p {
    margin: 0 0 .7em;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: break-word;
    text-indent: 2em;
  }
  .np-reader p.np-flash {
    animation: np-flash 1.6s ease;
  }
  @keyframes np-flash {
    0%, 55% { background: rgba(255,205,0,.30); }
    100%    { background: transparent; }
  }

  /* ---------- 目录面板（全屏二级界面） ---------- */
  .np-toc-panel {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--np-solid);
    z-index: 20;
    visibility: hidden;
    opacity: 0;
    transform: translateX(28px);
    transition: opacity .2s ease, transform .22s cubic-bezier(.32,.72,0,1), visibility .2s;
    overscroll-behavior: contain;
  }
  .np-toc-panel.np-visible {
    visibility: visible;
    opacity: 1;
    transform: none;
  }
  .np-panel-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    padding-top: max(6px, env(safe-area-inset-top));
    min-height: 54px;
    border-bottom: .5px solid var(--np-line);
    position: relative;
    z-index: 2;
  }
  .np-panel-title {
    font-size: 15px;
    font-weight: 600;
    flex: 1 1 auto;
    min-width: 0;
    padding: 0 4px;
  }
  .np-panel-meta {
    font-size: 12px;
    opacity: .45;
    flex: 0 0 auto;
    padding-right: 8px;
  }

  .np-toc-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    contain: strict;
    padding-bottom: 4px;
  }

  /* ---------- 目录项（当前项与非当前项等高） ---------- */
  .np-toc-item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 44px;
    width: calc(100% - 12px);
    margin: 2px 6px;
    padding: 0 12px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 14px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
    -webkit-tap-highlight-color: transparent;
    transition: background .12s ease;
  }
  .np-toc-item:hover { background: var(--np-hover); }
  .np-toc-item.np-current {
    background: var(--np-hover);
    font-weight: 600;
  }
  .np-toc-index {
    flex: 0 0 auto;
    min-width: 26px;
    font-size: 11px;
    opacity: .38;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .np-toc-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .np-toc-progress {
    flex: 0 0 auto;
    font-size: 11px;
    opacity: .55;
    padding: 2px 8px;
    border-radius: 20px;
    background: var(--np-hover);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .np-toc-progress.np-empty { visibility: hidden; }

  /* ---------- 搜索浮窗（顶部定位，高度 40%） ---------- */
  .np-search-panel {
    position: absolute;
    top: calc(var(--np-header-h, 70px) + 4px);
    left: 8px;
    right: 8px;
    height: 40vh;
    height: 40dvh;
    min-height: 180px;
    max-height: 420px;
    background: var(--np-solid);
    border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,.18), 0 0 0 .5px var(--np-line);
    z-index: 15;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
    transform: translateY(-10px);
    transition: opacity .2s ease, transform .22s cubic-bezier(.32,.72,0,1), visibility .2s;
  }
  .np-search-panel.np-visible {
    visibility: visible;
    opacity: 1;
    pointer-events: auto;
    transform: none;
  }
  .np-search-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    min-height: 52px;
    border-bottom: .5px solid var(--np-line);
    position: relative;
    z-index: 2;
  }
  .np-search-input-wrap {
    flex: 1 1 auto;
    min-width: 0;
    position: relative;
  }
  .np-search-input {
    width: 100%;
    height: 38px;
    padding: 0 38px 0 12px;
    border: 0;
    border-radius: 10px;
    background: var(--np-hover);
    color: inherit;
    font-family: inherit;
    font-size: 15px;
    outline: none;
    -webkit-appearance: none;
    appearance: none;
  }
  .np-search-input::placeholder { color: currentColor; opacity: .38; }
  .np-search-clear {
    position: absolute;
    right: 5px;
    top: 50%;
    transform: translateY(-50%);
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: rgba(127,127,127,.22);
    color: inherit;
    display: none;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
    -webkit-tap-highlight-color: transparent;
  }
  .np-search-clear:hover { background: rgba(127,127,127,.34); }
  .np-search-clear svg { width: 13px; height: 13px; display: block; }
  .np-search-input-wrap.np-has-value .np-search-clear { display: flex; }

  .np-search-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    contain: strict;
    text-align: left;
    padding-bottom: 3px;
  }

  .np-search-tip {
    flex: 0 0 auto;
    padding: 6px 12px;
    font-size: 11.5px;
    line-height: 1.4;
    text-align: center;
    opacity: .55;
    border-top: .5px solid var(--np-line);
  }
  .np-search-tip[hidden] { display: none; }

  /* ---------- 搜索结果项（紧凑版） ---------- */
  .np-result {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    height: 64px;
    width: calc(100% - 8px);
    margin: 1px 4px;
    padding: 6px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
    -webkit-tap-highlight-color: transparent;
    transition: background .12s ease;
  }
  .np-result:hover { background: var(--np-hover); }
  .np-result-title {
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.4;
    margin-bottom: 1px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }
  .np-result-preview {
    font-size: 12.5px;
    opacity: .62;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-align: left;
  }
  .np-result mark {
    background: rgba(255,205,0,.42);
    color: inherit;
  }
  .np-empty {
    padding: 24px 16px;
    text-align: center;
    font-size: 13px;
    opacity: .5;
    line-height: 1.5;
  }

  /* ---------- 加载层 ---------- */
  .np-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--np-solid);
    z-index: 30;
    transition: opacity .25s ease, visibility .25s;
  }
  .np-loading.np-hidden {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }
  .np-loading-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    padding: 24px;
    max-width: 88vw;
    text-align: center;
  }
  .np-spinner {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 2.5px solid var(--np-line);
    border-top-color: var(--np-accent);
    animation: np-spin .8s linear infinite;
  }
  @keyframes np-spin { to { transform: rotate(360deg); } }
  .np-loading-text {
    font-size: 14px;
    opacity: .65;
    min-height: 1.4em;
    word-break: break-all;
  }
  .np-progress {
    width: 220px;
    max-width: 66vw;
    height: 4px;
    border-radius: 2px;
    background: var(--np-line);
    overflow: hidden;
    position: relative;
  }
  .np-progress-bar {
    height: 100%;
    width: 0;
    border-radius: 2px;
    background: var(--np-accent);
    transition: width .18s ease;
  }
  .np-progress.np-indeterminate .np-progress-bar {
    width: 34% !important;
    animation: np-slide 1.15s cubic-bezier(.65,.05,.36,1) infinite;
  }
  @keyframes np-slide {
    0%   { transform: translateX(-110%); }
    100% { transform: translateX(320%); }
  }
  `

  /* ================================================================
   * 状态
   * ================================================================ */
  let session = 0
  let activeReader = null
  let saveTimer = 0
  let searchTimer = 0

  let chapters = []
  let currentIndex = 0
  let currentLine = -1
  let lineOffsets = []
  let progress = {}
  let progressKey = ''
  let fontSize = FONT_DEFAULT

  let composing = false
  let scrollRaf = 0

  /* DOM */
  let root, headerEl, titleEl, readerEl
  let prevBtn, nextBtn, chapterLabel
  let tocPanel, tocList, tocMeta
  let searchPanel, searchInput, searchInputWrap, searchList, searchTip
  let loadingEl, loadingText, progressEl, progressBar
  let tocVirtual = null
  let searchVirtual = null

  /* ================================================================
   * 构建 UI
   * ================================================================ */
  function buildUI() {
    const style = document.createElement('style')
    style.textContent = CSS_TEXT

    root = document.createElement('div')
    root.className = 'np-render'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')

    root.innerHTML = `
      <header class="np-header">
        <div class="np-header-title"><span class="np-title">无标题</span></div>
        <div class="np-header-bar">
          <button class="np-iconbtn" data-act="close" aria-label="关闭">${ICON.back}</button>
          <span class="np-header-spacer"></span>
          <button class="np-iconbtn" data-act="fontDown" aria-label="减小字号">${ICON.fontDown}</button>
          <button class="np-iconbtn" data-act="fontUp" aria-label="增大字号">${ICON.fontUp}</button>
          <button class="np-iconbtn" data-act="search" aria-label="全文搜索">${ICON.search}</button>
          <button class="np-iconbtn" data-act="prev" aria-label="上一章" disabled>${ICON.prev}</button>
          <button class="np-chapterbtn" data-act="toc" aria-label="目录">
            <span class="np-chapter-label">加载中…</span>
          </button>
          <button class="np-iconbtn" data-act="next" aria-label="下一章" disabled>${ICON.next}</button>
        </div>
      </header>

      <div class="np-body">
        <div class="np-reader" tabindex="0"></div>
      </div>

      <div class="np-toc-panel">
        <div class="np-panel-head">
          <button class="np-iconbtn" data-act="closeToc" aria-label="返回">${ICON.back}</button>
          <span class="np-panel-title">目录</span>
          <span class="np-panel-meta"></span>
        </div>
        <div class="np-toc-list"></div>
      </div>

      <div class="np-search-panel">
        <div class="np-search-head">
          <div class="np-search-input-wrap">
            <input class="np-search-input" type="text" inputmode="search" enterkeyhint="search"
                   placeholder="搜索章节名或正文" autocomplete="off" autocorrect="off"
                   autocapitalize="off" spellcheck="false" />
            <button class="np-search-clear" data-act="clearSearch" aria-label="清空" tabindex="-1">${ICON.clear}</button>
          </div>
        </div>
        <div class="np-search-list"></div>
        <div class="np-search-tip" hidden></div>
      </div>

      <div class="np-loading">
        <div class="np-loading-inner">
          <div class="np-spinner"></div>
          <div class="np-loading-text">准备中…</div>
          <div class="np-progress"><div class="np-progress-bar"></div></div>
        </div>
      </div>
    `

    document.body.appendChild(style)
    document.body.appendChild(root)

    headerEl = root.querySelector('.np-header')
    titleEl = root.querySelector('.np-title')
    readerEl = root.querySelector('.np-reader')

    prevBtn = root.querySelector('[data-act="prev"]')
    nextBtn = root.querySelector('[data-act="next"]')
    chapterLabel = root.querySelector('.np-chapter-label')

    tocPanel = root.querySelector('.np-toc-panel')
    tocList = root.querySelector('.np-toc-list')
    tocMeta = root.querySelector('.np-panel-meta')

    searchPanel = root.querySelector('.np-search-panel')
    searchInput = root.querySelector('.np-search-input')
    searchInputWrap = root.querySelector('.np-search-input-wrap')
    searchList = root.querySelector('.np-search-list')
    searchTip = root.querySelector('.np-search-tip')

    loadingEl = root.querySelector('.np-loading')
    loadingText = root.querySelector('.np-loading-text')
    progressEl = root.querySelector('.np-progress')
    progressBar = root.querySelector('.np-progress-bar')

    tocVirtual = createVirtualList({
      container: tocList,
      itemHeight: TOC_ITEM_H,
      renderItem: renderTocItem
    })

    searchVirtual = createVirtualList({
      container: searchList,
      itemHeight: SEARCH_ITEM_H,
      renderItem: renderSearchItem
    })

    bindEvents()
    syncLayoutMetrics()
  }

  /* ================================================================
   * 布局尺寸同步
   * ================================================================ */
  function syncLayoutMetrics() {
    if (!headerEl) return
    const h = headerEl.offsetHeight
    if (h > 0) root.style.setProperty('--np-header-h', h + 'px')
  }

  /* ================================================================
   * 事件绑定
   * ================================================================ */
  function bindEvents() {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]')
      if (!btn || !root.contains(btn)) return
      switch (btn.dataset.act) {
        case 'close': close(); break
        case 'prev': goPrev(); break
        case 'next': goNext(); break
        case 'toc': openToc(); break
        case 'closeToc': closeToc(); break
        case 'search':
          if (searchPanel.classList.contains('np-visible')) closeSearch()
          else openSearch()
          break
        case 'clearSearch':
          searchInput.value = ''
          updateSearchHasValue()
          renderSearchPlaceholder()
          searchInput.focus()
          break
        case 'fontUp': changeFontSize(FONT_STEP); break
        case 'fontDown': changeFontSize(-FONT_STEP); break
      }
    })

    readerEl.addEventListener('scroll', onReaderScroll, { passive: true })

    // 点击正文：切换工具栏 + 移动端重新进入全屏
    readerEl.addEventListener('click', (e) => {
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return
      if (e.target.closest('a')) return

      root.classList.toggle('np-chrome-hidden')

      if (MOBILE) {
        requestFullscreen()
      }
    })

    // 搜索输入：输入法合成中不触发搜索
    searchInput.addEventListener('compositionstart', () => { composing = true })
    searchInput.addEventListener('compositionend', () => {
      composing = false
      updateSearchHasValue()
      scheduleSearch()
    })
    searchInput.addEventListener('input', (e) => {
      updateSearchHasValue()
      if (composing || e.isComposing) return
      scheduleSearch()
    })
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        clearTimeout(searchTimer)
        runSearch(searchInput.value)
      }
    })

    // 点击搜索浮窗外部 → 关闭浮窗
    document.addEventListener('click', (e) => {
      if (!searchPanel.classList.contains('np-visible')) return
      if (searchPanel.contains(e.target)) return
      if (e.target.closest && e.target.closest('[data-act="search"]')) return
      closeSearch()
      e.stopPropagation()
    }, true)

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      if (!root.classList.contains('np-visible')) return
      if (searchPanel.classList.contains('np-visible')) { closeSearch(); return }
      if (tocPanel.classList.contains('np-visible')) { closeToc(); return }
      close()
    })

    window.addEventListener('resize', () => {
      syncLayoutMetrics()
      if (!root.classList.contains('np-visible')) return
      cacheLineOffsets()
    })

    document.addEventListener('fullscreenchange', syncLayoutMetrics)
  }

  function updateSearchHasValue() {
    if (!searchInputWrap) return
    searchInputWrap.classList.toggle('np-has-value', searchInput.value.length > 0)
  }

  /* ================================================================
   * 加载层
   * ================================================================ */
  function showLoading(text, pct, determinate) {
    loadingEl.classList.remove('np-hidden')
    loadingText.textContent = text
    if (determinate) {
      progressEl.classList.remove('np-indeterminate')
      progressBar.style.width = Math.max(0, Math.min(100, pct || 0)) + '%'
    } else {
      progressEl.classList.add('np-indeterminate')
      progressBar.style.width = ''
    }
  }

  function hideLoading() {
    loadingEl.classList.add('np-hidden')
  }

  /* ================================================================
   * 全屏
   * ================================================================ */
  function requestFullscreen() {
    if (!MOBILE) return
    if (document.fullscreenElement) return
    const el = document.documentElement
    const fn = el.requestFullscreen || el.webkitRequestFullscreen
    if (!fn) return
    try {
      const p = fn.call(el, { navigationUI: 'hide' })
      if (p && typeof p.catch === 'function') p.catch(() => { })
    } catch (e) { /* ignore */ }
  }

  function exitFullscreen() {
    if (!MOBILE) return
    if (!document.fullscreenElement) return
    try {
      const p = document.exitFullscreen()
      if (p && typeof p.catch === 'function') p.catch(() => { })
    } catch (e) { /* ignore */ }
  }

  /* ================================================================
   * 字号
   * ================================================================ */
  function loadFontSize() {
    const v = parseInt(localStorage.getItem(LS_FONT), 10)
    if (Number.isFinite(v) && v >= FONT_MIN && v <= FONT_MAX) return v
    return FONT_DEFAULT
  }

  function applyFontSize() {
    root.style.setProperty('--np-font-size', fontSize + 'px')
  }

  function changeFontSize(delta) {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, fontSize + delta))
    if (next === fontSize) return
    fontSize = next
    try { localStorage.setItem(LS_FONT, String(fontSize)) } catch (e) { }
    applyFontSize()

    const anchor = currentLine
    requestAnimationFrame(() => {
      cacheLineOffsets()
      if (anchor > 0 && lineOffsets[anchor] != null) {
        readerEl.scrollTop = lineOffsets[anchor]
      } else {
        readerEl.scrollTop = 0
      }
    })
  }

  /* ================================================================
   * 阅读进度
   * ================================================================ */
  function loadProgress(key) {
    try {
      const raw = localStorage.getItem(LS_PROGRESS + key)
      if (!raw) return {}
      const obj = JSON.parse(raw)
      return obj && typeof obj === 'object' ? obj : {}
    } catch (e) { return {} }
  }

  function scheduleSaveProgress() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveProgressNow, SAVE_DELAY)
  }

  function saveProgressNow() {
    if (!progressKey) return
    try {
      localStorage.setItem(LS_PROGRESS + progressKey, JSON.stringify(progress))
    } catch (e) { /* ignore */ }
  }

  function onReaderScroll() {
    if (scrollRaf) return
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0
      updateCurrentLine()
    })
  }

  function updateCurrentLine() {
    const len = lineOffsets.length
    if (!len) return
    const top = readerEl.scrollTop + 6

    let lo = 0, hi = len - 1, ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (lineOffsets[mid] <= top) { ans = mid; lo = mid + 1 }
      else hi = mid - 1
    }

    if (currentLine !== ans) {
      currentLine = ans
      if (progress[currentIndex] !== ans) {
        progress[currentIndex] = ans
        scheduleSaveProgress()
      }
    }
  }

  function cacheLineOffsets() {
    const kids = readerEl.children
    lineOffsets = new Array(kids.length)
    for (let i = 0; i < kids.length; i++) {
      lineOffsets[i] = kids[i].offsetTop
    }
  }

  /* ================================================================
   * 章节渲染
   * ================================================================ */
  function renderChapter(index, opts) {
    if (!chapters.length) return
    index = Math.max(0, Math.min(chapters.length - 1, index))
    const ch = chapters[index]

    currentIndex = index

    const frag = document.createDocumentFragment()
    for (let i = 0; i < ch.lines.length; i++) {
      const p = document.createElement('p')
      p.textContent = ch.lines[i]
      frag.appendChild(p)
    }

    readerEl.innerHTML = ''
    readerEl.appendChild(frag)

    cacheLineOffsets()

    const restore = !opts || opts.restore !== false
    const saved = restore ? (progress[index] || 0) : 0

    if (saved > 0 && lineOffsets[saved] != null) {
      readerEl.scrollTop = lineOffsets[saved]
      currentLine = saved
    } else {
      readerEl.scrollTop = 0
      currentLine = 0
      if (progress[index] !== 0) {
        progress[index] = 0
        scheduleSaveProgress()
      }
    }

    updateNav()
  }

  function updateNav() {
    prevBtn.disabled = currentIndex <= 0
    nextBtn.disabled = currentIndex >= chapters.length - 1
    const ch = chapters[currentIndex]
    chapterLabel.textContent = ch ? ch.title : '目录'
    chapterLabel.title = ch ? ch.title : ''
  }

  function goPrev() {
    if (currentIndex > 0) renderChapter(currentIndex - 1)
  }

  function goNext() {
    if (currentIndex < chapters.length - 1) renderChapter(currentIndex + 1)
  }

  /* ================================================================
   * 目录项渲染（可复用：el 传入则原地更新）
   * ================================================================ */
  function renderTocItem(item, el) {
    const { ch, i } = item

    if (!el) {
      el = document.createElement('button')
      el.type = 'button'
      el.className = 'np-toc-item'

      const idx = document.createElement('span')
      idx.className = 'np-toc-index'

      const name = document.createElement('span')
      name.className = 'np-toc-name'

      const prog = document.createElement('span')
      prog.className = 'np-toc-progress'

      el.append(idx, name, prog)
      el._idx = idx
      el._name = name
      el._prog = prog

      el.addEventListener('click', () => {
        const it = el._item
        if (!it) return
        closeToc()
        renderChapter(it.i)
      })
    }

    el._item = item
    el.classList.toggle('np-current', i === currentIndex)

    el._idx.textContent = String(i + 1)

    el._name.textContent = ch.title
    el._name.title = ch.title

    const readLine = progress[i]
    if (typeof readLine === 'number' && readLine > 0) {
      el._prog.textContent = `第 ${readLine + 1} 行`
      el._prog.classList.remove('np-empty')
    } else {
      el._prog.textContent = ''
      el._prog.classList.add('np-empty')
    }

    return el
  }

  function openToc() {
    tocPanel.classList.add('np-visible')

    const items = chapters.map((ch, i) => ({ ch, i }))
    tocVirtual.setItems(items)

    const done = chapters.reduce((acc, _, i) => {
      const v = progress[i]
      return acc + (typeof v === 'number' && v > 0 ? 1 : 0)
    }, 0)
    tocMeta.textContent = `${chapters.length} 章 · 已读 ${done}`

    setTimeout(() => {
      const vh = tocList.clientHeight
      if (!vh) return
      const target = currentIndex * TOC_ITEM_H - vh / 2 + TOC_ITEM_H / 2
      tocList.scrollTop = Math.max(0, target)
    }, 30)
  }

  function closeToc() {
    tocPanel.classList.remove('np-visible')
  }

  /* ================================================================
   * 搜索
   * ================================================================ */
  function openSearch() {
    syncLayoutMetrics()
    searchPanel.classList.add('np-visible')
    if (!searchInput.value.trim()) renderSearchPlaceholder()
    requestAnimationFrame(() => {
      try { searchInput.focus({ preventScroll: true }) } catch (e) { searchInput.focus() }
    })
  }

  function closeSearch(silent) {
    searchPanel.classList.remove('np-visible')
    if (!silent) searchInput.blur()
  }

  function setSearchTip(text) {
    if (!searchTip) return
    if (text) {
      searchTip.textContent = text
      searchTip.hidden = false
    } else {
      searchTip.textContent = ''
      searchTip.hidden = true
    }
  }

  function renderSearchPlaceholder() {
    setSearchTip('')
    searchVirtual.showEmpty('输入关键词开始搜索')
  }

  function scheduleSearch() {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => runSearch(searchInput.value), 200)
  }

  function makeSnippet(text, hitStart, hitLen, maxLen) {
    let start = 0
    let end = text.length

    if (text.length > maxLen) {
      const pad = Math.max(0, Math.floor((maxLen - hitLen) / 2))
      start = Math.max(0, hitStart - pad)
      end = Math.min(text.length, start + maxLen)
      if (end - start < maxLen) start = Math.max(0, end - maxLen)
    }

    const before = escapeHtml(text.slice(start, hitStart))
    const hit = escapeHtml(text.slice(hitStart, hitStart + hitLen))
    const after = escapeHtml(text.slice(hitStart + hitLen, end))

    return (start > 0 ? '…' : '') +
      before + '<mark>' + hit + '</mark>' + after +
      (end < text.length ? '…' : '')
  }

  function runSearch(raw) {
    const q = String(raw || '').trim()

    if (!q) {
      renderSearchPlaceholder()
      return
    }

    const qLower = q.toLowerCase()
    const latin = /[a-z]/i.test(q)
    const results = []
    let truncated = false

    outer:
    for (let ci = 0; ci < chapters.length; ci++) {
      const ch = chapters[ci]
      const title = ch.title

      // 命中章节标题 → 高亮标题，正文处显示第一行内容
      let ti = title.indexOf(q)
      if (ti < 0 && latin) ti = title.toLowerCase().indexOf(qLower)
      if (ti >= 0) {
        const firstBody = ch.lines.length > 1 ? ch.lines[1] : (ch.lines[0] || '')
        results.push({
          ci,
          li: -1,
          titleHit: [ti, q.length],
          preview: firstBody
        })
        if (results.length >= SEARCH_MAX) { truncated = true; break outer }
      }

      // 命中正文
      const lines = ch.lines
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]
        if (li === 0 && ti >= 0) continue
        let idx = line.indexOf(q)
        if (idx < 0 && latin) idx = line.toLowerCase().indexOf(qLower)
        if (idx >= 0) {
          results.push({ ci, li, hit: [idx, q.length], preview: line })
          if (results.length >= SEARCH_MAX) { truncated = true; break outer }
        }
      }
    }

    if (!results.length) {
      setSearchTip('')
      searchVirtual.showEmpty('未找到匹配内容')
      return
    }

    setSearchTip(truncated ? `结果过多，仅显示前 ${SEARCH_MAX} 条` : '')
    searchVirtual.setItems(results)
  }

  /* ================================================================
   * 搜索结果项渲染（可复用：el 传入则原地更新）
   * ================================================================ */
  function renderSearchItem(r, el) {
    const ch = chapters[r.ci]

    if (!el) {
      el = document.createElement('button')
      el.type = 'button'
      el.className = 'np-result'

      const titleDiv = document.createElement('div')
      titleDiv.className = 'np-result-title'

      const prevDiv = document.createElement('div')
      prevDiv.className = 'np-result-preview'

      el.append(titleDiv, prevDiv)
      el._title = titleDiv
      el._prev = prevDiv

      el.addEventListener('click', () => {
        const item = el._item
        if (item) gotoResult(item)
      })
    }

    el._item = r

    if (r.titleHit) {
      el._title.innerHTML = makeSnippet(ch.title, r.titleHit[0], r.titleHit[1], 60)
    } else {
      el._title.textContent = ch.title
    }

    if (r.hit) {
      el._prev.innerHTML = makeSnippet(r.preview, r.hit[0], r.hit[1], 90)
    } else {
      const p = r.preview || ''
      el._prev.textContent = p.length > 90 ? p.slice(0, 90) + '…' : p
    }

    return el
  }

  function gotoResult(r) {
    closeSearch(true)
    renderChapter(r.ci, { restore: false })

    // li === -1 表示命中章节标题，此时高亮第一行（标题行）
    const lineIdx = (typeof r.li === 'number' && r.li >= 0) ? r.li : 0
    const el = readerEl.children[lineIdx]

    if (el) {
      readerEl.scrollTop = el.offsetTop
      el.classList.remove('np-flash')
      void el.offsetWidth
      el.classList.add('np-flash')
      setTimeout(() => el.classList.remove('np-flash'), 1700)

      currentLine = lineIdx
      progress[r.ci] = lineIdx
      scheduleSaveProgress()
    } else {
      readerEl.scrollTop = 0
      currentLine = 0
      progress[r.ci] = 0
      scheduleSaveProgress()
    }
  }

  /* ================================================================
   * 主题色提取
   * ================================================================ */
  function syncSurface() {
    const bg = getComputedStyle(document.body).backgroundColor
    const m = bg && bg.match(/rgba?\(([^)]+)\)/)
    if (!m) return
    const parts = m[1].split(',').map(Number)
    const r = parts[0], g = parts[1], b = parts[2]
    const a = parts.length > 3 ? parts[3] : 1
    if (a === 0) return

    root.style.setProperty('--np-solid', `rgb(${r},${g},${b})`)
    root.style.setProperty('--np-surface', `rgba(${r},${g},${b},0.92)`)

    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    if (lum < 0.5) {
      root.style.setProperty('--np-line', 'rgba(255,255,255,.18)')
      root.style.setProperty('--np-hover', 'rgba(255,255,255,.10)')
    } else {
      root.style.setProperty('--np-line', 'rgba(0,0,0,.14)')
      root.style.setProperty('--np-hover', 'rgba(0,0,0,.06)')
    }
  }

  /* ================================================================
   * 下载
   * ================================================================ */
  async function download(entry, onProgress) {
    const res = await fetch(entry.uri)
    if (!res.ok) throw new Error('HTTP ' + res.status)

    const total = Number(entry.s) || Number(res.headers.get('content-length')) || 0

    if (!res.body || typeof res.body.getReader !== 'function') {
      const buf = await res.arrayBuffer()
      onProgress(buf.byteLength, buf.byteLength || total)
      return buf
    }

    const rdr = res.body.getReader()
    activeReader = rdr

    const chunks = []
    let received = 0

    try {
      for (; ;) {
        const { done, value } = await rdr.read()
        if (done) break
        chunks.push(value)
        received += value.length
        onProgress(received, total)
      }
    } finally {
      activeReader = null
    }

    const out = new Uint8Array(received)
    let pos = 0
    for (let i = 0; i < chunks.length; i++) {
      out.set(chunks[i], pos)
      pos += chunks[i].length
    }
    return out.buffer
  }

  const MB = 1024 * 1024

  /* ================================================================
   * 主流程
   * ================================================================ */
  async function open(entry) {
    const my = ++session

    chapters = []
    currentIndex = 0
    currentLine = -1
    lineOffsets = []
    progress = {}
    progressKey = ''
    readerEl.innerHTML = ''
    readerEl.scrollTop = 0
    searchInput.value = ''
    updateSearchHasValue()
    searchVirtual.showEmpty('')
    setSearchTip('')
    tocVirtual.setItems([])
    closeToc()
    closeSearch(true)
    root.classList.remove('np-chrome-hidden')

    syncSurface()
    applyFontSize()

    root.classList.add('np-visible')
    document.body.classList.add('np-locked')

    await nextFrame()
    syncLayoutMetrics()

    showLoading('正在连接服务器…', 0, false)

    requestFullscreen()

    progressKey = entry.path || entry.uri || entry.name || 'unknown'
    progress = loadProgress(progressKey)

    titleEl.textContent = entry.name || '无标题'
    titleEl.title = entry.name || ''

    /* 1. 下载 */
    let buffer
    try {
      buffer = await download(entry, (loaded, total) => {
        if (my !== session) return
        if (total > 0) {
          const pct = Math.min(100, loaded / total * 100)
          showLoading(
            `正在拉取文件… ${(loaded / MB).toFixed(1)} / ${(total / MB).toFixed(1)} MB`,
            pct, true
          )
        } else {
          showLoading(`正在拉取文件… ${(loaded / MB).toFixed(1)} MB`, 0, false)
        }
      })
    } catch (err) {
      if (my !== session) return
      showLoading('加载失败：' + (err && err.message ? err.message : err), 0, true)
      return
    }

    if (my !== session) return

    /* 2. 识别编码 */
    showLoading('正在识别文件编码…', 0, false)
    await nextFrame()
    if (my !== session) return

    let encoding = 'utf-8'
    try {
      encoding = detectEncoding(buffer)
    } catch (e) { /* ignore */ }

    /* 3. 流式解码 */
    let text = ''
    try {
      const decoder = new TextDecoder(encoding)
      const bytes = new Uint8Array(buffer)
      const total = bytes.length || 1

      for (let off = 0; off < bytes.length; off += DECODE_CHUNK) {
        if (my !== session) return
        const end = Math.min(off + DECODE_CHUNK, bytes.length)
        text += decoder.decode(bytes.subarray(off, end), { stream: true })
        const pct = end / total * 100
        showLoading(`正在解码（${encoding.toUpperCase()}）… ${Math.round(pct)}%`, pct, true)
        await nextFrame()
      }
      text += decoder.decode()
    } catch (err) {
      if (my !== session) return
      showLoading('解码失败：' + (err && err.message ? err.message : err), 0, true)
      return
    }

    if (my !== session) return

    /* 4. 切分章节 */
    showLoading('正在整理章节…', 100, true)
    await nextFrame()
    if (my !== session) return

    const paragraphs = text.split(/[\r\n]+/g)
    chapters = splitChapters(paragraphs)

    /* 5. 渲染 */
    const resume = typeof progress[0] === 'number' ? progress[0] : 0
    renderChapter(0, { restore: resume > 0 })

    await nextFrame()
    if (my !== session) return

    syncLayoutMetrics()
    hideLoading()
  }

  function close() {
    session++

    if (activeReader) {
      try { activeReader.cancel() } catch (e) { /* ignore */ }
      activeReader = null
    }

    clearTimeout(saveTimer)
    clearTimeout(searchTimer)
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0 }

    saveProgressNow()

    closeToc()
    closeSearch(true)
    exitFullscreen()

    root.classList.remove('np-visible')
    root.classList.remove('np-chrome-hidden')
    document.body.classList.remove('np-locked')

    readerEl.innerHTML = ''
    chapters = []
    lineOffsets = []
    currentIndex = 0
    currentLine = -1
    titleEl.textContent = '无标题'
    chapterLabel.textContent = '目录'
    prevBtn.disabled = true
    nextBtn.disabled = true

    setTimeout(() => {
      if (!root.classList.contains('np-visible')) hideLoading()
    }, 260)
  }

  /* ================================================================
   * 初始化
   * ================================================================ */
  function init() {
    ensureViewport()

    fontSize = loadFontSize()
    buildUI()

    HFS.onEvent('fileMenu', ({ entry, menu }) => {
      if (isTextFile(entry) && !entry.isFolder) {
        menu.push({
          id: PLUGIN_NAME,
          label: '在线阅读',
          icon: '📖',
          onClick: () => open(entry)
        })
      }
    })

    if (MOBILE) {
      document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) return
        if (!root.classList.contains('np-visible')) return
        document.addEventListener('click', function reenter() {
          if (root.classList.contains('np-visible') && !document.fullscreenElement) {
            requestFullscreen()
          }
        }, { once: true, capture: true })
      })
    }
  }

  init()
})()
