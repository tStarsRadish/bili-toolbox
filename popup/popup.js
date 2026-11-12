/**
 * B站工具箱 —— 弹窗逻辑
 *
 * 两个工具共用一个弹窗，用顶部 tab 切换：
 *   clean  —— 追踪参数清除
 *   vrchat —— 91vrchat 播放器链接
 */
(function () {
  'use strict';

  const BC = globalThis.BiliClean;
  const Store = globalThis.BiliCleanStore;
  const VR = globalThis.BiliVrchat;

  const $ = (id) => document.getElementById(id);
  const el = {
    version: $('version'),

    // clean
    statToday: $('stat-today'),
    statTotal: $('stat-total'),
    pageBadge: $('page-badge'),
    pageUrl: $('page-url'),
    removedList: $('removed-list'),
    btnClean: $('btn-clean'),
    btnCopy: $('btn-copy'),
    pageHint: $('page-hint'),
    tgAddress: $('tg-address'),
    tgCopy: $('tg-copy'),
    tgNetwork: $('tg-network'),
    inputText: $('input-text'),
    btnParse: $('btn-parse'),
    btnShort: $('btn-short'),
    resultHost: $('result-host'),

    // vrchat
    vrBadge: $('vr-badge'),
    vrBvid: $('vr-bvid'),
    vrUrl: $('vr-url'),
    vrCopy: $('vr-copy'),
    vrOpen: $('vr-open'),
    vrHint: $('vr-hint'),
    vrInput: $('vr-input'),
    vrConvert: $('vr-convert'),
    vrConvertOpen: $('vr-convert-open'),
    vrResultHost: $('vr-result-host'),
    tgVrBar: $('tg-vrbar'),
    tgVrAuto: $('tg-vrauto'),

    tplResult: $('tpl-result'),
    openOptions: $('open-options'),
    footNote: $('foot-note'),
  };

  let settings = null;
  let options = null;
  let currentTab = null;
  let currentPlayer = null; // { ok, bvid, url, reason }

  /* ------------------------------ 通用 ------------------------------ */

  function setHint(node, text, kind) {
    if (!node) return;
    node.textContent = text || '';
    node.className = 'hint' + (kind ? ' ' + kind : '');
  }

  function badge(node, text, kind) {
    if (!node) return;
    node.textContent = text;
    node.className = 'pill ' + (kind || 'pill-muted');
  }

  function shortUrl(url, max) {
    const limit = max || 78;
    const s = String(url || '');
    if (s.length <= limit) return s;
    const q = s.indexOf('?');
    if (q > 0 && q < limit) return s.slice(0, q) + '?…';
    return s.slice(0, limit - 1) + '…';
  }

  function isBili(url) {
    try {
      return BC.isBiliHost(new URL(url).hostname);
    } catch (e) {
      return false;
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  /** 用模板插入一条结果 */
  function showResult(host, label, text) {
    if (!host) return;
    host.textContent = '';
    const frag = el.tplResult.content.cloneNode(true);
    frag.querySelector('.result-label').textContent = label;
    frag.querySelector('.result-text').textContent = text;
    frag.querySelector('.result-copy').addEventListener('click', async () => {
      const ok = await copy(text);
      setHint(el.vrHint, ok ? '已复制结果。' : '复制失败。', ok ? 'ok' : 'err');
    });
    host.appendChild(frag);
    host.hidden = false;
  }

  /* ------------------------------ tab 切换 ------------------------------ */

  const TABS = ['clean', 'vrchat'];
  const LAST_TAB_KEY = 'bilitoolbox.lastTab';

  function activateTab(name) {
    if (!TABS.includes(name)) name = 'clean';
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.panel-body').forEach((p) => {
      p.hidden = p.dataset.panel !== name;
    });
    try {
      chrome.storage.local.set({ [LAST_TAB_KEY]: name });
    } catch (e) {
      /* ignore */
    }
  }

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => activateTab(t.dataset.tab));
  });

  /* ------------------------------ 统计 ------------------------------ */

  async function refreshStats() {
    const stats = await Store.getStats();
    el.statToday.textContent = stats.today;
    el.statTotal.textContent = stats.total;
  }

  /* ================================================================ *
   * 工具一：清链
   * ================================================================ */

  function renderRemoved(list) {
    el.removedList.textContent = '';
    if (!list || !list.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '没有发现追踪参数';
      el.removedList.appendChild(li);
      return;
    }
    const seen = new Set();
    for (const r of list) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.name;
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = r.label || '';
      li.append(name, label);
      el.removedList.appendChild(li);
    }
  }

  function analyzeTab(tab) {
    currentTab = tab;
    const url = (tab && tab.url) || '';

    if (!url) {
      badge(el.pageBadge, '无法读取', 'pill-muted');
      el.pageUrl.textContent = '—';
      renderRemoved([]);
      el.btnClean.disabled = true;
      el.btnCopy.disabled = true;
      setHint(el.pageHint, '');
      return;
    }

    if (!isBili(url)) {
      badge(el.pageBadge, '未在 B 站', 'pill-muted');
      el.pageUrl.textContent = shortUrl(url);
      renderRemoved([]);
      el.btnClean.disabled = true;
      el.btnCopy.disabled = false;
      el.btnCopy.textContent = '复制当前链接';
      setHint(el.pageHint, '当前标签页不是 B 站页面，可切换到 B 站后重试。');
      return;
    }

    const res = BC.cleanUrl(url, options);
    el.pageUrl.textContent = shortUrl(url, 200);

    if (!res.changed) {
      badge(el.pageBadge, '已干净', 'pill-ok');
      renderRemoved([]);
      el.btnClean.disabled = true;
      el.btnCopy.disabled = false;
      el.btnCopy.textContent = '复制干净链接';
      setHint(el.pageHint, '这个地址里没有追踪参数，保持现状即可。', 'ok');
      return;
    }

    badge(el.pageBadge, `发现 ${res.removed.length} 项`, 'pill-warn');
    renderRemoved(res.removed);
    el.btnClean.disabled = false;
    el.btnCopy.disabled = false;
    el.btnCopy.textContent = '复制干净链接';
    setHint(el.pageHint, '清洗后只删追踪参数，当前分 P 与播放进度不受影响。');
  }

  async function loadTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    analyzeTab(tab);
    renderVrchat(tab);
  }

  el.btnClean.addEventListener('click', async () => {
    if (!currentTab || !currentTab.url) return;
    const res = BC.cleanUrl(currentTab.url, options);
    if (!res.changed) {
      setHint(el.pageHint, '已经没有可清除的参数了。', 'ok');
      return;
    }
    try {
      await chrome.tabs.update(currentTab.id, { url: res.url });
      await Store.bumpStats(new URL(res.url).hostname, res.removed.length);
      await refreshStats();
      el.btnClean.disabled = true;
      badge(el.pageBadge, '已清洗', 'pill-ok');
      setHint(el.pageHint, `已清除 ${res.removed.length} 个追踪参数并跳转到干净地址。`, 'ok');
    } catch (err) {
      setHint(el.pageHint, '清洗失败：' + (err && err.message ? err.message : String(err)), 'err');
    }
  });

  el.btnCopy.addEventListener('click', async () => {
    const url = currentTab && currentTab.url ? currentTab.url : '';
    if (!url) return;
    const res = BC.cleanUrl(url, options);
    const ok = await copy(res.url);
    setHint(el.pageHint, ok ? '已复制到剪贴板。' : '复制失败，请手动选择地址栏。', ok ? 'ok' : 'err');
  });

  el.btnParse.addEventListener('click', async () => {
    const raw = el.inputText.value;
    if (!raw.trim()) {
      setHint(el.pageHint, '请先粘贴一段含 B 站链接的文本。', 'err');
      return;
    }
    const res = BC.cleanText(raw, options);
    if (!res.changed) {
      showResult(el.resultHost, '结果（没有发现追踪参数）', res.text);
      return;
    }
    showResult(
      el.resultHost,
      `已清除 ${res.count} 条链接的 ${res.removed.length} 个参数`,
      res.text
    );
    await Store.bumpStats('', res.removed.length);
    await refreshStats();
  });

  el.btnShort.addEventListener('click', async () => {
    const raw = el.inputText.value.trim();
    const m =
      raw.match(/https?:\/\/(?:www\.)?b23\.tv\/[^\s]+/i) || raw.match(/^(?:www\.)?b23\.tv\/[^\s]+/i);
    if (!m) {
      setHint(el.pageHint, '输入框里没有找到 b23.tv 短链。', 'err');
      return;
    }
    const url = m[0].startsWith('http') ? m[0] : 'https://' + m[0];
    el.btnShort.disabled = true;
    el.btnShort.textContent = '解析中…';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'biliclean:resolve-short', url });
      if (!res || !res.ok) {
        setHint(el.pageHint, (res && res.error) || '解析失败', 'err');
        return;
      }
      showResult(el.resultHost, `已展开并清洗：移除 ${res.removed.length} 个参数`, res.cleanedUrl);
      await Store.bumpStats('', Math.max(1, res.removed.length));
      await refreshStats();
    } catch (err) {
      setHint(el.pageHint, '解析失败：' + (err && err.message ? err.message : String(err)), 'err');
    } finally {
      el.btnShort.disabled = false;
      el.btnShort.textContent = '解析 b23.tv 短链';
    }
  });

  /* ================================================================ *
   * 工具二：VRChat 播放器
   * ================================================================ */

  function renderVrchat(tab) {
    const url = (tab && tab.url) || '';
    const res = VR.explain(url);
    currentPlayer = res;

    if (res.ok) {
      badge(el.vrBadge, res.bvid, 'pill-ok');
      el.vrBvid.textContent = res.bvid;
      el.vrUrl.textContent = res.url;
      el.vrCopy.disabled = false;
      el.vrOpen.disabled = false;
      setHint(
        el.vrHint,
        '在视频页右下角也有悬浮栏，随时可复制。',
        'ok'
      );
      return;
    }

    badge(el.vrBadge, '未检测到', 'pill-muted');
    el.vrBvid.textContent = '—';
    el.vrUrl.textContent = '—';
    el.vrCopy.disabled = true;
    el.vrOpen.disabled = true;
    setHint(
      el.vrHint,
      url && VR.isAvOnly(url) ? res.reason : '打开一个 B 站视频页，这里会自动填好。'
    );
  }

  el.vrCopy.addEventListener('click', async () => {
    if (!currentPlayer || !currentPlayer.ok) return;
    const ok = await copy(currentPlayer.url);
    setHint(el.vrHint, ok ? '已复制播放器链接。' : '复制失败。', ok ? 'ok' : 'err');
  });

  el.vrOpen.addEventListener('click', async () => {
    if (!currentPlayer || !currentPlayer.ok) return;
    try {
      await chrome.runtime.sendMessage({ type: 'bilitoolbox:vrchat-open', url: currentPlayer.url });
    } catch (e) {
      /* ignore */
    }
  });

  function doConvert(openAfter) {
    const raw = el.vrInput.value;
    const res = VR.explain(raw);
    if (!res.ok) {
      el.vrResultHost.hidden = true;
      setHint(el.vrHint, res.reason || '没有找到 BV 号', 'err');
      return;
    }
    showResult(el.vrResultHost, `BV 号 ${res.bvid}`, res.url);
    setHint(el.vrHint, '', '');
    if (openAfter) {
      chrome.runtime
        .sendMessage({ type: 'bilitoolbox:vrchat-open', url: res.url })
        .catch(() => {});
    }
  }

  el.vrConvert.addEventListener('click', () => doConvert(false));
  el.vrConvertOpen.addEventListener('click', () => doConvert(true));

  // 输入框里直接粘贴 B 站链接时，顺手给出结果
  el.vrInput.addEventListener('input', () => {
    const v = el.vrInput.value.trim();
    if (!v) {
      el.vrResultHost.hidden = true;
      return;
    }
    const res = VR.explain(v);
    if (res.ok) {
      showResult(el.vrResultHost, `BV 号 ${res.bvid}`, res.url);
      setHint(el.vrHint, '', '');
    } else {
      el.vrResultHost.hidden = true;
    }
  });

  /* ------------------------------ 开关 ------------------------------ */

  function bindSwitch(input, key) {
    if (!input) return;
    input.addEventListener('change', async () => {
      settings = await Store.setSettings({ [key]: input.checked });
      options = Store.toCleanOptions(settings);
      await loadTab();
    });
  }

  bindSwitch(el.tgAddress, 'cleanAddressBar');
  bindSwitch(el.tgCopy, 'stripOnCopy');
  bindSwitch(el.tgNetwork, 'cleanNetwork');
  bindSwitch(el.tgVrBar, 'vrchatBar');
  bindSwitch(el.tgVrAuto, 'vrchatAutoCopy');

  function applySettings(s) {
    settings = s;
    options = Store.toCleanOptions(s);
    el.tgAddress.checked = Boolean(s.cleanAddressBar);
    el.tgCopy.checked = Boolean(s.stripOnCopy);
    el.tgNetwork.checked = Boolean(s.cleanNetwork);
    el.tgVrBar.checked = Boolean(s.vrchatBar);
    el.tgVrAuto.checked = Boolean(s.vrchatAutoCopy);
    el.version.textContent = 'v' + (BC.VERSION || '1.1.0');
  }

  el.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  /* ------------------------------ 启动 ------------------------------ */

  (async function init() {
    const s = await Store.getSettings(true);
    applySettings(s);

    // 恢复上次停留的 tab；第一次用且当前就在视频页时，直接给 VRChat
    let lastTab = null;
    try {
      const stored = await chrome.storage.local.get(LAST_TAB_KEY);
      const v = stored && stored[LAST_TAB_KEY];
      if (v && TABS.includes(v)) lastTab = v;
    } catch (e) {
      /* ignore */
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!lastTab) {
      lastTab = tab && tab.url && VR.explain(tab.url).ok ? 'vrchat' : 'clean';
    }
    activateTab(lastTab);

    await refreshStats();
    await loadTab();

    Store.onChange((next) => {
      applySettings(next);
      loadTab();
    });
  })();
})();
