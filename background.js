/**
 * B站工具箱 —— MV3 Service Worker
 *
 * 职责：
 *   1. 把用户设置同步成 declarativeNetRequest 动态规则（网络层去参，拦都拦得住）；
 *   2. 右键菜单：清当前页 / 解析 b23.tv 短链 / 清剪贴板链接 / 生成 VRChat 播放器链接；
 *   3. 图标角标计数；
 *   4. 消息中枢（给内容脚本、悬浮栏和 popup 用）。
 */
import './shared/clean.js';
import './shared/store.js';
import './shared/vrchat.js';

const BC = globalThis.BiliClean;
const Store = globalThis.BiliCleanStore;
const VR = globalThis.BiliVrchat;

const DNR_RULE_ID = 1;
const NETWORK_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'xmlhttprequest',
  'media',
  'image',
  'ping',
  'other',
];

/* ------------------------------------------------------------------ *
 * DNR 规则同步
 * ------------------------------------------------------------------ */

async function buildDnrRules(settings) {
  if (!settings.cleanNetwork) return [];
  const params = BC.paramsForNetworkRule(Store.toCleanOptions(settings));
  if (!params.length) return [];
  return [
    {
      id: DNR_RULE_ID,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { transform: { queryTransform: { removeParams: params } } },
      },
      condition: {
        requestDomains: ['bilibili.com', 'b23.tv'],
        resourceTypes: NETWORK_RESOURCE_TYPES,
      },
    },
  ];
}

let syncing = null;

async function syncDnrRules(force) {
  if (syncing && !force) return syncing;
  syncing = (async () => {
    const settings = await Store.getSettings(true);
    const rules = await buildDnrRules(settings);
    try {
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      const removeRuleIds = existing.map((r) => r.id);
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules: rules,
      });
    } catch (err) {
      console.warn('[BiliClean] 同步 DNR 规则失败：', err && err.message ? err.message : err);
    }
  })();
  try {
    await syncing;
  } finally {
    syncing = null;
  }
}

/* ------------------------------------------------------------------ *
 * 角标
 * ------------------------------------------------------------------ */

async function refreshBadge() {
  const settings = await Store.getSettings();
  if (!settings.badge) {
    await chrome.action.setBadgeText({ text: '' }).catch(() => {});
    return;
  }
  const stats = await Store.getStats();
  const n = stats.today;
  await chrome.action
    .setBadgeBackgroundColor({ color: '#fb7299' })
    .catch(() => {});
  await chrome.action
    .setBadgeText({ text: n > 0 ? (n > 999 ? '999+' : String(n)) : '' })
    .catch(() => {});
  await chrome.action.setTitle({ title: `B站工具箱 · 今日已清除 ${n} 个追踪参数` }).catch(() => {});
}

async function recordClean(host, removedCount) {
  await Store.bumpStats(host, removedCount);
  await refreshBadge();
}

/* ------------------------------------------------------------------ *
 * 右键菜单
 * ------------------------------------------------------------------ */

const MENU = {
  page: 'bilitoolbox-clean-page',
  link: 'bilitoolbox-clean-link',
  short: 'bilitoolbox-resolve-short',
  clipboard: 'bilitoolbox-clean-clipboard',
  vrchat: 'bilitoolbox-vrchat-player',
};

async function rebuildMenus() {
  const settings = await Store.getSettings(true);
  await chrome.contextMenus.removeAll().catch(() => {});
  if (!settings.contextMenu) return;

  chrome.contextMenus.create({
    id: MENU.page,
    title: '清除本页链接中的追踪参数',
    contexts: ['page'],
    documentUrlPatterns: ['*://*.bilibili.com/*'],
  });
  chrome.contextMenus.create({
    id: MENU.link,
    title: '复制已清除追踪参数的链接',
    contexts: ['link'],
    targetUrlPatterns: ['*://*.bilibili.com/*', '*://*.b23.tv/*'],
  });
  if (settings.parseShortLink) {
    chrome.contextMenus.create({
      id: MENU.short,
      title: '解析 b23.tv 短链为纯净链接',
      contexts: ['link', 'page'],
      targetUrlPatterns: ['*://*.b23.tv/*'],
      documentUrlPatterns: ['*://*.b23.tv/*'],
    });
  }
  // VRChat 播放器链接：只要是 B 站视频页/视频链接就给
  chrome.contextMenus.create({
    id: MENU.vrchat,
    title: '生成 VRChat 播放器链接（91vrchat）',
    contexts: ['page', 'link'],
    documentUrlPatterns: ['*://*.bilibili.com/video/*', '*://*.bilibili.com/list/*'],
    targetUrlPatterns: ['*://*.bilibili.com/video/*', '*://*.b23.tv/*'],
  });
  chrome.contextMenus.create({
    id: MENU.clipboard,
    title: '清除剪贴板里的 B 站追踪链接',
    contexts: ['page', 'selection'],
  });
}

/* ------------------------------------------------------------------ *
 * 短链解析
 * ------------------------------------------------------------------ */

async function resolveShortLink(url) {
  const settings = await Store.getSettings();
  if (!settings.parseShortLink) {
    return { ok: false, error: '短链解析已在设置中关闭' };
  }
  if (!BC.isShortLink(url)) {
    return { ok: false, error: '不是 b23.tv 短链' };
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
    });
    const finalUrl = res.url || url;
    const cleaned = BC.cleanUrl(finalUrl, Store.toCleanOptions(settings));
    return { ok: true, finalUrl, cleanedUrl: cleaned.url, removed: cleaned.removed };
  } catch (err) {
    return { ok: false, error: '解析失败：' + (err && err.message ? err.message : String(err)) };
  }
}

/* ------------------------------------------------------------------ *
 * 写入剪贴板（offscreen 文档，MV3 里 navigator.clipboard 不可用于 SW）
 * ------------------------------------------------------------------ */

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (has) return true;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: '把清除过追踪参数的链接写入剪贴板',
      })
      .catch(() => {});
  }
  await creatingOffscreen;
  creatingOffscreen = null;
  return chrome.offscreen.hasDocument().catch(() => false);
}

async function copyToClipboard(text) {
  const ok = await ensureOffscreen();
  if (!ok) return false;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'offscreen:copy', text });
    return Boolean(res && res.ok);
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 通知（角标闪一下代替弹窗，不打扰）
 * ------------------------------------------------------------------ */

async function flashBadge(text) {
  const settings = await Store.getSettings();
  if (!settings.badge) return;
  await chrome.action.setBadgeBackgroundColor({ color: '#00aeec' }).catch(() => {});
  await chrome.action.setBadgeText({ text: String(text).slice(0, 4) }).catch(() => {});
  setTimeout(() => {
    refreshBadge();
  }, 1500);
}

/* ------------------------------------------------------------------ *
 * 菜单点击
 * ------------------------------------------------------------------ */

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const settings = await Store.getSettings();
  try {
    if (info.menuItemId === MENU.page) {
      const target = (tab && tab.url) || info.pageUrl || '';
      const cleaned = BC.cleanUrl(target, Store.toCleanOptions(settings));
      if (!cleaned.changed) {
        await flashBadge('干净');
        return;
      }
      await chrome.tabs.update(tab.id, { url: cleaned.url });
      await recordClean(new URL(cleaned.url).hostname, cleaned.removed.length);
      return;
    }

    if (info.menuItemId === MENU.link) {
      const cleaned = BC.cleanUrl(info.linkUrl || '', Store.toCleanOptions(settings));
      await copyToClipboard(cleaned.url);
      await recordClean(safeHost(cleaned.url), Math.max(1, cleaned.removed.length));
      await flashBadge('✓');
      return;
    }

    if (info.menuItemId === MENU.short) {
      const target = info.linkUrl || info.pageUrl || '';
      const res = await resolveShortLink(target);
      if (!res.ok) {
        await flashBadge('×');
        return;
      }
      await copyToClipboard(res.cleanedUrl);
      await recordClean(safeHost(res.cleanedUrl), Math.max(1, res.removed.length));
      await flashBadge('✓');
      return;
    }

    if (info.menuItemId === MENU.vrchat) {
      const target = info.linkUrl || info.pageUrl || (tab && tab.url) || '';
      const res = VR.explain(target);
      if (!res.ok) {
        await flashBadge('×');
        // 拿不到 BV 号时把原因写到角标 title 上，用户悬停可见
        await chrome.action
          .setTitle({ title: `B站工具箱 · ${res.reason}` })
          .catch(() => {});
        return;
      }
      await copyToClipboard(res.url);
      await flashBadge('VR');
      await chrome.action.setTitle({ title: `B站工具箱 · 已复制 ${res.bvid} 播放器链接` }).catch(() => {});
      return;
    }

    if (info.menuItemId === MENU.clipboard) {
      // 页面里读剪贴板需要用户手势，交给内容脚本处理更稳
      if (tab && tab.id) {
        await chrome.tabs
          .sendMessage(tab.id, { type: 'biliclean:clean-clipboard' })
          .catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[B站工具箱] 菜单处理失败：', err);
  }
});

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * 消息
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  if (msg.type === 'biliclean:settings') {
    Store.getSettings(true).then((s) => sendResponse({ ok: true, settings: s }));
    return true;
  }

  if (msg.type === 'biliclean:cleaned') {
    const host = msg.host || safeHost(msg.url) || '';
    recordClean(host, msg.count).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'biliclean:resolve-short') {
    resolveShortLink(msg.url).then(sendResponse);
    return true;
  }

  if (msg.type === 'biliclean:copy') {
    copyToClipboard(msg.text).then((ok) => sendResponse({ ok }));
    return true;
  }

  if (msg.type === 'biliclean:open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return undefined;
  }

  if (msg.type === 'biliclean:refresh-badge') {
    refreshBadge().then(() => sendResponse({ ok: true }));
    return true;
  }

  /* --------------------- VRChat 播放器 --------------------- */

  if (msg.type === 'bilitoolbox:copy') {
    copyToClipboard(msg.text).then((ok) => sendResponse({ ok }));
    return true;
  }

  if (msg.type === 'bilitoolbox:vrchat') {
    // 任意输入 → 播放器链接（纯计算，不发网络请求）
    sendResponse(VR.explain(msg.url || msg.text || ''));
    return undefined;
  }

  if (msg.type === 'bilitoolbox:vrchat-copy') {
    const res = VR.explain(msg.url || msg.text || '');
    if (!res.ok) {
      sendResponse(res);
      return undefined;
    }
    copyToClipboard(res.url).then((ok) => sendResponse({ ...res, copied: ok }));
    return true;
  }

  if (msg.type === 'bilitoolbox:vrchat-open') {
    const res = VR.explain(msg.url || msg.text || '');
    if (res.ok) {
      chrome.tabs.create({ url: res.url, active: true }).catch(() => {});
    }
    sendResponse(res);
    return undefined;
  }

  return undefined;
});

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await Store.getSettings(true);
  await syncDnrRules(true);
  await rebuildMenus();
  await refreshBadge();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#welcome') }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await syncDnrRules(true);
  await rebuildMenus();
  await refreshBadge();
});

// 设置变化 → 规则 / 菜单 / 角标跟着变
Store.onChange(async () => {
  await syncDnrRules(true);
  await rebuildMenus();
  await refreshBadge();
});

// SW 冷启动时也保证规则在位
syncDnrRules(false).catch(() => {});
refreshBadge().catch(() => {});
