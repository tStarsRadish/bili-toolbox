/**
 * BiliClean —— 设置与统计存储
 *
 * 同时用于 MV3 Service Worker（ES module）与内容脚本（classic script）。
 * 所有读写都走 chrome.storage.local，并带内存缓存，避免频繁 I/O。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.BiliCleanStore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEY = 'biliclean.settings';
  const STATS_KEY = 'biliclean.stats';

  const DEFAULTS = {
    version: 1,
    // 各层开关
    cleanAddressBar: true, // 地址栏 / 页面 URL 去参
    stripOnCopy: true, // 复制链接时去参
    cleanNetwork: true, // 网络层请求去参（DNR）
    parseShortLink: true, // 右键解析 b23.tv 短链
    contextMenu: true, // 右键菜单
    badge: true, // 图标角标计数
    notify: true, // 页面提示（默认关）
    // VRChat 播放器
    vrchatBar: true, // 视频页显示悬浮栏
    vrchatAutoCopy: false, // 自动把播放器链接写进剪贴板（默认关，避免打扰）
    // 规则
    groups: {
      device: true,
      share: true,
      spm: true,
      utm: true,
      custom: true,
    },
    keepProgress: true, // 保留 t / start / end 播放进度
    extraParams: [], // 额外移除的参数
    keepParams: [], // 强制保留的参数
  };

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function normalize(raw) {
    const out = clone(DEFAULTS);
    if (!raw || typeof raw !== 'object') return out;
    for (const k of Object.keys(DEFAULTS)) {
      if (raw[k] === undefined) continue;
      if (k === 'groups') {
        out.groups = Object.assign(clone(DEFAULTS.groups), raw.groups || {});
      } else if (k === 'extraParams' || k === 'keepParams') {
        out[k] = Array.isArray(raw[k]) ? raw[k].map(String).filter(Boolean) : [];
      } else if (typeof DEFAULTS[k] === 'boolean') {
        out[k] = Boolean(raw[k]);
      } else {
        out[k] = raw[k];
      }
    }
    return out;
  }

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local;
  }

  let cache = null;
  let pending = null;

  async function getSettings(force) {
    if (cache && !force) return cache;
    if (!hasStorage()) {
      cache = clone(DEFAULTS);
      return cache;
    }
    if (!pending) {
      pending = chrome.storage.local
        .get(KEY)
        .then(async (obj) => {
          const stored = obj && obj[KEY];
          if (stored) {
            cache = normalize(stored);
          } else {
            // 首次运行：把默认值落盘，后续各层（SW / 内容脚本 / 页面）读到的才一致
            cache = clone(DEFAULTS);
            await chrome.storage.local.set({ [KEY]: cache }).catch(() => {});
          }
          pending = null;
          return cache;
        })
        .catch(() => {
          cache = clone(DEFAULTS);
          pending = null;
          return cache;
        });
    }
    return pending;
  }

  async function setSettings(patch) {
    const next = normalize(Object.assign({}, await getSettings(true), patch));
    cache = next;
    if (hasStorage()) {
      await chrome.storage.local.set({ [KEY]: next });
    }
    return next;
  }

  async function resetSettings() {
    cache = clone(DEFAULTS);
    if (hasStorage()) {
      await chrome.storage.local.set({ [KEY]: cache });
    }
    return cache;
  }

  /** 把设置转成 clean.js 认识的形式 */
  function toCleanOptions(settings) {
    const s = settings || DEFAULTS;
    return {
      groups: s.groups,
      keepProgress: s.keepProgress,
      extraParams: s.extraParams,
      keepParams: s.keepParams,
    };
  }

  /* ---------------------------- 统计 ---------------------------- */

  const EMPTY_STATS = { total: 0, today: 0, day: '', byHost: {}, lastCleaned: '' };

  function todayKey(d) {
    const t = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
  }

  function normalizeStats(raw) {
    const out = clone(EMPTY_STATS);
    if (!raw || typeof raw !== 'object') return out;
    out.total = Number(raw.total) || 0;
    out.today = Number(raw.today) || 0;
    out.day = typeof raw.day === 'string' ? raw.day : '';
    out.byHost = raw.byHost && typeof raw.byHost === 'object' ? Object.assign({}, raw.byHost) : {};
    out.lastCleaned = typeof raw.lastCleaned === 'string' ? raw.lastCleaned : '';
    if (out.day !== todayKey()) {
      out.today = 0;
      out.day = todayKey();
    }
    return out;
  }

  async function getStats() {
    if (!hasStorage()) return clone(EMPTY_STATS);
    const obj = await chrome.storage.local.get(STATS_KEY).catch(() => ({}));
    return normalizeStats(obj && obj[STATS_KEY]);
  }

  async function bumpStats(host, removedCount) {
    if (!hasStorage()) return null;
    const stats = await getStats();
    const n = Math.max(1, Number(removedCount) || 1);
    stats.total += n;
    stats.today += n;
    stats.day = todayKey();
    stats.lastCleaned = new Date().toISOString();
    if (host) stats.byHost[host] = (Number(stats.byHost[host]) || 0) + n;
    await chrome.storage.local.set({ [STATS_KEY]: stats }).catch(() => {});
    return stats;
  }

  async function resetStats() {
    if (!hasStorage()) return clone(EMPTY_STATS);
    const fresh = Object.assign(clone(EMPTY_STATS), { day: todayKey() });
    await chrome.storage.local.set({ [STATS_KEY]: fresh }).catch(() => {});
    return fresh;
  }

  /* ------------------------ 变更广播 ------------------------ */

  function onChange(handler) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return () => {};
    const listener = (changes, area) => {
      if (area !== 'local') return;
      if (changes[KEY]) {
        cache = normalize(changes[KEY].newValue);
        handler(cache);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  return {
    KEY,
    STATS_KEY,
    DEFAULTS,
    EMPTY_STATS,
    normalize,
    normalizeStats,
    getSettings,
    setSettings,
    resetSettings,
    toCleanOptions,
    getStats,
    bumpStats,
    resetStats,
    onChange,
    todayKey,
  };
});
