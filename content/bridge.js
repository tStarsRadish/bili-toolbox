/**
 * BiliClean —— 桥接脚本（ISOLATED world，document_start）
 *
 * MAIN world 的 page-main.js 拿不到 chrome.* API，通过 window.postMessage
 * 把清洗请求转给这里，这里调用后台下发的规则清洗后回传。
 *
 * 同时负责：
 *   - 把最新设置推给 MAIN world；
 *   - 右键菜单“清剪贴板链接”的落地；
 *   - 页面内复制按钮的兜底修正。
 */
(function () {
  'use strict';

  const BC = globalThis.BiliClean;
  const Store = globalThis.BiliCleanStore;
  if (!BC || !Store) return;
  if (globalThis.__bilicleanBridgeLoaded) return;
  globalThis.__bilicleanBridgeLoaded = true;

  const CHANNEL = 'biliclean';
  const isTop = window.top === window;

  let settings = Store.DEFAULTS;
  let options = Store.toCleanOptions(settings);

  function pushSettings() {
    window.postMessage(
      {
        __biliclean: CHANNEL,
        kind: 'settings',
        stripOnCopy: settings.stripOnCopy,
        cleanAddressBar: settings.cleanAddressBar,
      },
      location.origin
    );
  }

  function applySettings(s) {
    settings = s;
    options = Store.toCleanOptions(s);
    pushSettings();
  }

  Store.getSettings().then(applySettings);
  Store.onChange(applySettings);

  /** 清洗文本，changed 时把统计报给后台 */
  function cleanText(text, report) {
    const res = BC.cleanText(text, options);
    if (res.changed && report !== false) {
      chrome.runtime
        .sendMessage({
          type: 'biliclean:cleaned',
          host: location.hostname,
          url: location.href,
          count: res.count,
        })
        .catch(() => {});
    }
    return res;
  }

  /* ------------------------- MAIN world 的请求 ------------------------- */

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__biliclean !== CHANNEL || event.source !== window) return;

    if (data.kind === 'hello') {
      pushSettings();
      return;
    }

    if (data.kind === 'clean-text') {
      const res = cleanText(String(data.text || ''));
      window.postMessage(
        {
          __biliclean: CHANNEL,
          kind: 'clean-text-result',
          id: data.id,
          text: res.text,
          changed: res.changed,
          count: res.count,
          removed: res.removed.map((r) => r.name),
        },
        location.origin
      );
      return;
    }

    if (data.kind === 'url-cleaned' && isTop) {
      chrome.runtime
        .sendMessage({
          type: 'biliclean:cleaned',
          host: location.hostname,
          url: data.url,
          count: 1,
        })
        .catch(() => {});
    }
  });

  /* ------------------------- 页面内复制按钮兜底 ------------------------- */

  // B 站分享面板的“复制链接”有时绕过 navigator.clipboard，直接写进 input 再 execCommand。
  // 这里在捕获阶段拦一次 click，把 data-biliclean-copy 的值临时换成干净版本。
  document.addEventListener(
    'click',
    (event) => {
      if (!settings.stripOnCopy) return;
      const target = event.target;
      if (!target || !target.closest) return;
      const el = target.closest('[data-biliclean-copy]');
      if (!el) return;
      const raw = el.getAttribute('data-biliclean-copy');
      if (!raw) return;
      const res = cleanText(raw);
      if (!res.changed) return;
      el.setAttribute('data-biliclean-copy', res.text);
      setTimeout(() => {
        try {
          el.setAttribute('data-biliclean-copy', raw);
        } catch (e) {
          /* 元素可能已被移除 */
        }
      }, 1000);
    },
    true
  );

  /* ------------------------- 后台指令 ------------------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    if (msg.type === 'biliclean:clean-clipboard') {
      const res = BC.cleanText(String(msg.text || ''), options);
      if (res.changed) {
        chrome.runtime
          .sendMessage({ type: 'biliclean:copy', text: res.text })
          .then((r) => sendResponse({ ok: Boolean(r && r.ok), text: res.text, changed: true }))
          .catch(() => sendResponse({ ok: false, changed: true, text: res.text }));
        return true;
      }
      sendResponse({ ok: false, changed: false, text: msg.text || '' });
      return undefined;
    }

    if (msg.type === 'biliclean:clean-text') {
      const res = BC.cleanText(String(msg.text || ''), options);
      sendResponse({ ok: true, text: res.text, changed: res.changed, removed: res.removed });
      return undefined;
    }

    if (msg.type === 'biliclean:settings-updated') {
      Store.getSettings(true).then((s) => {
        applySettings(s);
        sendResponse({ ok: true });
      });
      return true;
    }

    return undefined;
  });

  // 首次进入页面时把设置同步一次，避免 MAIN world 用默认值跑太久
  pushSettings();
})();
