/**
 * BiliToolbox —— VRChat 播放器悬浮栏（ISOLATED world）
 *
 * 在 B 站视频页右下角挂一条轻量悬浮栏，展示
 *   https://biliplayer.91vrchat.com/player/?url=<BV号>
 * 并支持一键复制 / 新窗口打开。
 *
 * 设计取舍：
 *   - 不用 shadow DOM 会与 B 站样式互相打架，所以整条栏都在 shadow root 里；
 *   - 默认折叠成小胶囊，不遮挡播放器控件；点击才展开；
 *   - SPA 切换视频时靠 MutationObserver + 定时轮询兜底更新 BV 号；
 *   - 页面本身就带 url= 参数时不再重复拼接（用户可能已经改过号）。
 */
(function () {
  'use strict';

  const VR = globalThis.BiliVrchat;
  const Store = globalThis.BiliCleanStore;
  if (!VR || !Store) return;
  if (globalThis.__biliToolboxVrchatBar) return;
  globalThis.__biliToolboxVrchatBar = true;

  // 只在顶层页面挂栏，iframe 里不挂
  if (window.top !== window) return;

  const HOST_ID = 'bili-toolbox-vrchat-bar';
  const COLLAPSE_KEY = 'bilitoolbox.vrchatBarCollapsed';

  let settings = null;
  let collapsed = true;
  let currentBvid = null;
  let ui = null; // { host, shadow, urlText, btnCopy, btnOpen, body, toggle, dot }

  /* ------------------------------------------------------------------ *
   * 样式
   * ------------------------------------------------------------------ */

  const CSS = `
    :host {
      all: initial;
    }
    .root {
      position: fixed;
      right: 20px;
      bottom: 88px;
      z-index: 2147483000;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
            "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      color: #18191c;
      -webkit-font-smoothing: antialiased;
      transition: opacity .18s ease;
    }
    .root.hidden { display: none; }

    .panel {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(255,255,255,.96);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(24,25,28,.10);
      border-radius: 12px;
      padding: 7px 9px;
      box-shadow: 0 6px 24px rgba(24,25,28,.14), 0 1px 3px rgba(24,25,28,.08);
      max-width: min(560px, calc(100vw - 40px));
    }

    .dot {
      flex: none;
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #00aeec;
      box-shadow: 0 0 0 3px rgba(0,174,236,.16);
    }

    .label {
      flex: none;
      font-size: 11.5px;
      font-weight: 600;
      color: #00aeec;
      letter-spacing: .2px;
      user-select: none;
    }

    .url {
      font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #4b4f57;
      background: #f6f7f9;
      border: 1px solid #e8eaee;
      border-radius: 7px;
      padding: 4px 8px;
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      user-select: all;
      cursor: text;
    }

    .btn {
      flex: none;
      height: 26px;
      padding: 0 10px;
      border-radius: 7px;
      border: 1px solid transparent;
      font: inherit;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      transition: background .15s ease, color .15s ease, border-color .15s ease;
      white-space: nowrap;
    }
    .btn-primary {
      background: #00aeec;
      color: #fff;
    }
    .btn-primary:hover { background: #0099d1; }
    .btn-primary.done { background: #2ea44f; }
    .btn-ghost {
      background: #fff;
      border-color: #e8eaee;
      color: #4b4f57;
    }
    .btn-ghost:hover { border-color: #00aeec; color: #00aeec; }

    .icon-btn {
      flex: none;
      width: 22px; height: 22px;
      display: grid; place-items: center;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #8b8f96;
      cursor: pointer;
      font: inherit;
      font-size: 15px;
      line-height: 1;
    }
    .icon-btn:hover { background: #f0f1f4; color: #18191c; }

    /* 折叠态：只留一个小胶囊 */
    .root.collapsed .panel { padding: 5px 8px; gap: 6px; }
    .root.collapsed .url,
    .root.collapsed .btn-open,
    .root.collapsed .label { display: none; }
    .root.collapsed .btn-copy { height: 24px; }

    @media (max-width: 720px) {
      .root { right: 10px; bottom: 74px; }
      .url { max-width: 150px; }
      .label { display: none; }
    }
  `;

  /* ------------------------------------------------------------------ *
   * 构建 UI
   * ------------------------------------------------------------------ */

  function build() {
    if (ui) return ui;

    const host = document.createElement('div');
    host.id = HOST_ID;
    // 宿主本身不占布局，所有定位都在 shadow 里完成
    host.style.cssText = 'all: initial; position: static;';

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const root = document.createElement('div');
    root.className = 'root';

    const panel = document.createElement('div');
    panel.className = 'panel';

    const dot = document.createElement('span');
    dot.className = 'dot';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'VRChat 播放器';

    const urlText = document.createElement('code');
    urlText.className = 'url';

    const toggle = document.createElement('button');
    toggle.className = 'icon-btn toggle';
    toggle.type = 'button';
    toggle.title = '展开 / 收起';
    toggle.textContent = '›';

    const btnCopy = document.createElement('button');
    btnCopy.className = 'btn btn-primary btn-copy';
    btnCopy.type = 'button';
    btnCopy.textContent = '复制';

    const btnOpen = document.createElement('button');
    btnOpen.className = 'btn btn-ghost btn-open';
    btnOpen.type = 'button';
    btnOpen.textContent = '打开';

    panel.append(dot, label, urlText, btnCopy, btnOpen, toggle);
    root.append(panel);
    shadow.append(style, root);

    document.documentElement.appendChild(host);

    ui = { host, shadow, root, panel, dot, urlText, btnCopy, btnOpen, toggle, label };

    /* ---- 交互 ---- */

    toggle.addEventListener('click', () => {
      setCollapsed(!collapsed, true);
    });

    // 折叠态下点胶囊直接复制，省一次点击
    panel.addEventListener('click', (e) => {
      if (!collapsed) return;
      if (e.target === toggle) return;
      doCopy();
    });

    btnCopy.addEventListener('click', (e) => {
      e.stopPropagation();
      doCopy();
    });

    btnOpen.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = currentPlayerUrl();
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    });

    // 点击 URL 文本即选中，方便手动 Ctrl+C
    urlText.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        const range = document.createRange();
        range.selectNodeContents(urlText);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (err) {
        /* 忽略 */
      }
    });

    return ui;
  }

  function currentPlayerUrl() {
    return currentBvid ? VR.buildPlayerUrl(currentBvid) : null;
  }

  function setCollapsed(next, remember) {
    collapsed = Boolean(next);
    if (!ui) return;
    ui.root.classList.toggle('collapsed', collapsed);
    ui.toggle.textContent = collapsed ? '›' : '‹';
    if (remember) {
      try {
        localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
      } catch (e) {
        /* 隐私模式下可能不可写 */
      }
    }
  }

  let copyTimer = null;
  function doCopy() {
    const url = currentPlayerUrl();
    if (!url) return;

    const flash = (ok) => {
      if (!ui) return;
      const old = ui.btnCopy.textContent;
      ui.btnCopy.textContent = ok ? '已复制' : '复制失败';
      ui.btnCopy.classList.toggle('done', ok);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        ui.btnCopy.textContent = old === '已复制' || old === '复制失败' ? '复制' : old;
        ui.btnCopy.classList.remove('done');
      }, 1400);
    };

    // 悬浮栏是扩展页面上下文，navigator.clipboard 需要焦点；
    // 退化方案是交给后台的 offscreen 文档写。
    const write = async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
          flash(true);
          return;
        }
      } catch (e) {
        /* 落到后台 */
      }
      try {
        const res = await chrome.runtime.sendMessage({ type: 'bilitoolbox:copy', text: url });
        flash(Boolean(res && res.ok));
      } catch (e) {
        flash(false);
      }
    };
    write();
  }

  /* ------------------------------------------------------------------ *
   * 更新
   * ------------------------------------------------------------------ */

  function update() {
    if (!settings) return;

    const href = location.href;
    const bvid = VR.extractBvid(href);

    // 不是视频页 / 功能关闭 / 拿不到 BV 号 → 隐藏
    if (!settings.vrchatBar || !bvid) {
      hide();
      return;
    }

    // BV 号没变就不重建 DOM
    if (bvid === currentBvid && ui && ui.host.isConnected) {
      ui.root.classList.remove('hidden');
      return;
    }

    currentBvid = bvid;
    build();

    const url = VR.buildPlayerUrl(bvid);
    ui.urlText.textContent = url;
    ui.urlText.title = url;
    ui.toggle.title = '展开 / 收起';
    ui.root.classList.remove('hidden');
    setCollapsed(collapsed, false);

    if (settings.vrchatAutoCopy) {
      // 用户明确开了才自动写剪贴板
      chrome.runtime
        .sendMessage({ type: 'bilitoolbox:copy', text: url })
        .catch(() => {});
    }
  }

  function hide() {
    currentBvid = null;
    if (ui && ui.host.isConnected) ui.root.classList.add('hidden');
  }

  function destroy() {
    if (ui && ui.host && ui.host.isConnected) ui.host.remove();
    ui = null;
    currentBvid = null;
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  function readCollapsed() {
    try {
      const v = localStorage.getItem(COLLAPSE_KEY);
      if (v === '0') return false;
      if (v === '1') return true;
    } catch (e) {
      /* 忽略 */
    }
    return true; // 默认折叠，不遮挡播放器
  }

  collapsed = readCollapsed();

  Store.getSettings().then((s) => {
    settings = s;
    update();
  });

  Store.onChange((s) => {
    settings = s;
    if (!s.vrchatBar) destroy();
    else update();
  });

  // SPA 路由变化
  const wrapHistory = (name) => {
    const original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function () {
      const ret = original.apply(this, arguments);
      setTimeout(update, 0);
      return ret;
    };
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', () => setTimeout(update, 0));

  // 兜底轮询：B 站有时不走 history API 直接改地址
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      update();
    }
  }, 1200);

  // 后台要求手动刷新（比如刚从设置页切回来）
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'bilitoolbox:vrchat-refresh') {
      Store.getSettings(true).then((s) => {
        settings = s;
        update();
        sendResponse({ ok: true, bvid: currentBvid });
      });
      return true;
    }
    return undefined;
  });
})();
