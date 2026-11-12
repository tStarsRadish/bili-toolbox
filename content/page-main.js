/**
 * BiliClean —— 页面注入层（MAIN world）
 *
 * 为什么必须在 MAIN world：要改写页面自己的 navigator.clipboard / document.execCommand /
 * history.pushState，只能在页面自身的 JS 环境里做。内容脚本（ISOLATED world）改不到。
 *
 * 通信：window.postMessage，channel = 'biliclean'，见 bridge.js。
 */
(function () {
  'use strict';

  const CHANNEL = 'biliclean';
  const FLAG = '__bilicleanMainLoaded';
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true, configurable: false, enumerable: false });

  const isTop = window.top === window;
  const HOST_RE = /(^|\.)(bilibili\.com|b23\.tv)$/i;
  const isBiliHost = HOST_RE.test(location.hostname);

  let enabled = { copy: true, url: true };
  let seq = 0;
  const pending = new Map();

  /* ------------------------------------------------------------------ *
   * 与 bridge 通信
   * ------------------------------------------------------------------ */

  function post(msg) {
    try {
      window.postMessage(Object.assign({ __biliclean: CHANNEL }, msg), location.origin);
    } catch (e) {
      /* 忽略 */
    }
  }

  function requestClean(text, timeoutMs) {
    return new Promise((resolve) => {
      if (!/bilibili\.com|b23\.tv/i.test(text)) {
        resolve(text);
        return;
      }
      const id = 'c' + ++seq;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        resolve(fallbackClean(text));
      }, timeoutMs || 250);

      pending.set(id, (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(id);
        resolve(payload && typeof payload.text === 'string' ? payload.text : fallbackClean(text));
      });

      post({ kind: 'clean-text', id, text, report: true });
    });
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__biliclean !== CHANNEL || event.source !== window) return;

    if (data.kind === 'clean-text-result' && pending.has(data.id)) {
      pending.get(data.id)(data);
      return;
    }
    if (data.kind === 'settings') {
      enabled = {
        copy: data.stripOnCopy !== false,
        url: data.cleanAddressBar !== false,
      };
      if (isTop && enabled.url) runUrlClean();
    }
  });

  post({ kind: 'hello' });

  /* ------------------------------------------------------------------ *
   * 本地兜底清洗（bridge 没响应时用，保证绝不把脏链接放出去）
   * ------------------------------------------------------------------ */

  const FALLBACK_NAMES = new Set([
    'vd_source', 'spm_id_from', 'from_source', 'share_source', 'share_medium', 'share_plat',
    'share_tag', 'share_session_id', 'share_from', 'share_times', 'unique_k', 'bbid',
    'timestamp', 'buvid', 'buvid3', 'buvid4', 'from_spmid', 'spmid', 'spm', 'seid',
    'trackid', 'track_id', 'from_track_id', 'bsource', 'msource', 'live_from', 'launch_id',
    'plat_id', 'scm', 'up_id', 'is_story_h5', 'from', 'gclid', 'fbclid', 'msclkid',
  ]);
  const FALLBACK_KEEP = new Set(['p', 't', 'ep_id', 'cid', 'aid', 'bvid', 'oid', 'page', 'start', 'end']);

  function fallbackClean(text) {
    if (!/bilibili\.com|b23\.tv/i.test(text)) return text;
    return text.replace(/https?:\/\/[^\s<>"'`）)】」』]+/gi, (raw) => {
      const tailMatch = raw.match(/[，。、；：！？,.;:!?）)】」』]+$/);
      const tail = tailMatch ? tailMatch[0] : '';
      const core = tail ? raw.slice(0, -tail.length) : raw;
      const m = core.match(/^([^?#]*)\?([^#]*)(#.*)?$/);
      if (!m) return raw;
      const kept = m[2].split('&').filter((pair) => {
        const name = decodeSafe(pair.split('=')[0] || '').toLowerCase();
        if (!name) return false;
        if (FALLBACK_KEEP.has(name)) return true;
        if (FALLBACK_NAMES.has(name)) return false;
        if (/^utm_/i.test(name)) return false;
        if (/^share_/i.test(name) && name !== 'share_id') return false;
        if (/^vd_/i.test(name)) return false;
        return true;
      });
      return m[1] + (kept.length ? '?' + kept.join('&') : '') + (m[3] || '') + tail;
    });
  }

  function decodeSafe(s) {
    try {
      return decodeURIComponent(String(s).replace(/\+/g, ' '));
    } catch (e) {
      return String(s);
    }
  }

  /* ------------------------------------------------------------------ *
   * 1. 地址栏清洗（history）
   * ------------------------------------------------------------------ */

  function runUrlClean() {
    if (!isTop || !isBiliHost || !enabled.url) return;
    const href = location.href;
    if (!/[?&](vd_source|spm_id_from|from_source|share_source|share_medium|share_plat|buvid)/i.test(href)) {
      return;
    }
    const cleaned = fallbackClean(href);
    if (cleaned === href) return;
    try {
      history.replaceState(history.state, '', cleaned);
    } catch (e) {
      return;
    }
    post({ kind: 'url-cleaned', url: cleaned });
  }

  const wrapHistory = (name) => {
    const original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function () {
      const ret = original.apply(this, arguments);
      try {
        runUrlClean();
      } catch (e) {
        /* 忽略 */
      }
      return ret;
    };
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', () => setTimeout(runUrlClean, 0));
  window.addEventListener('hashchange', () => setTimeout(runUrlClean, 0));

  /* ------------------------------------------------------------------ *
   * 2. 剪贴板钩子
   * ------------------------------------------------------------------ */

  const clipboard = navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    const originalWriteText = clipboard.writeText.bind(clipboard);
    Object.defineProperty(clipboard, 'writeText', {
      configurable: true,
      writable: true,
      value: function writeText(text) {
        if (!enabled.copy) return originalWriteText(text);
        return requestClean(String(text == null ? '' : text)).then((cleaned) =>
          originalWriteText(cleaned)
        );
      },
    });
  }

  if (clipboard && typeof clipboard.write === 'function' && typeof window.ClipboardItem === 'function') {
    const originalWrite = clipboard.write.bind(clipboard);
    Object.defineProperty(clipboard, 'write', {
      configurable: true,
      writable: true,
      value: async function write(items) {
        if (!enabled.copy || !Array.isArray(items)) return originalWrite(items);
        try {
          const rewritten = [];
          for (const item of items) {
            const types = Array.from(item.types || []);
            const textType = types.find((t) => /^text\//i.test(t));
            if (!textType) {
              rewritten.push(item);
              continue;
            }
            const blob = await item.getType(textType);
            const text = await blob.text();
            const cleaned = await requestClean(text);
            rewritten.push(
              new window.ClipboardItem({ [textType]: new Blob([cleaned], { type: textType }) })
            );
          }
          return originalWrite(rewritten);
        } catch (e) {
          return originalWrite(items);
        }
      },
    });
  }

  const originalExecCommand = document.execCommand.bind(document);
  document.execCommand = function execCommand(command) {
    if (
      enabled.copy &&
      typeof command === 'string' &&
      command.toLowerCase() === 'copy' &&
      isBiliHost
    ) {
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel && sel.rangeCount && !sel.isCollapsed) {
        const text = sel.toString();
        if (/bilibili\.com|b23\.tv/i.test(text)) {
          const cleaned = fallbackClean(text);
          if (cleaned !== text) return copyViaEvent(cleaned);
        }
      }
    }
    return originalExecCommand.apply(document, arguments);
  };

  function copyViaEvent(text) {
    let ok = false;
    const onCopy = (e) => {
      try {
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
        ok = true;
      } catch (err) {
        /* 忽略 */
      }
    };
    document.addEventListener('copy', onCopy, { once: true, capture: true });
    try {
      originalExecCommand('copy');
    } finally {
      document.removeEventListener('copy', onCopy, true);
    }
    return ok;
  }
})();
