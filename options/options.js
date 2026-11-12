/**
 * B站工具箱 —— 设置页逻辑
 */
(function () {
  'use strict';

  const BC = globalThis.BiliClean;
  const Store = globalThis.BiliCleanStore;
  const VR = globalThis.BiliVrchat;

  const $ = (id) => document.getElementById(id);

  let settings = Store.DEFAULTS;
  let options = Store.toCleanOptions(settings);

  /* ---------------------------- 保存状态提示 ---------------------------- */

  let saveTimer = null;
  function flashSaved(text) {
    const node = $('save-state');
    node.textContent = text || '已保存';
    node.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => node.classList.remove('show'), 1600);
  }

  async function persist(patch, note) {
    settings = await Store.setSettings(patch);
    options = Store.toCleanOptions(settings);
    flashSaved(note);
    renderRules();
    renderGroups();
    return settings;
  }

  /* ---------------------------- 通用开关 ---------------------------- */

  function bindSwitches() {
    document.querySelectorAll('.switch[data-key]').forEach((input) => {
      input.addEventListener('change', async () => {
        await persist({ [input.dataset.key]: input.checked });
      });
    });
  }

  function syncSwitches() {
    document.querySelectorAll('.switch[data-key]').forEach((input) => {
      input.checked = Boolean(settings[input.dataset.key]);
    });
  }

  /* ---------------------------- 分组 ---------------------------- */

  const GROUP_ORDER = ['device', 'share', 'spm', 'utm', 'custom'];

  function groupParamCount(id) {
    if (id === 'custom') return settings.extraParams.length;
    return BC.TRACK_RULES.filter((r) => r.group === id).length;
  }

  function renderGroups() {
    const host = $('groups');
    host.textContent = '';
    for (const id of GROUP_ORDER) {
      const meta =
        id === 'custom'
          ? {
              id: 'custom',
              name: '自定义参数',
              desc: '你在下面填的额外移除参数',
            }
          : BC.GROUPS[id];
      if (!meta) continue;

      const on = settings.groups[id] !== false;
      const label = document.createElement('label');
      label.className = 'group' + (on ? ' on' : '');

      const body = document.createElement('div');
      body.className = 'group-body';

      const name = document.createElement('div');
      name.className = 'group-name';
      name.textContent = meta.name;
      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = String(groupParamCount(id));
      name.appendChild(count);

      const desc = document.createElement('div');
      desc.className = 'group-desc';
      desc.textContent = meta.desc || '';

      body.append(name, desc);

      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.className = 'switch';
      sw.checked = on;
      sw.addEventListener('change', async (e) => {
        e.stopPropagation();
        const next = Object.assign({}, settings.groups, { [id]: sw.checked });
        await persist({ groups: next });
      });

      label.append(body, sw);
      host.appendChild(label);
    }
  }

  /* ---------------------------- 参数表 ---------------------------- */

  function ruleRows() {
    const rows = BC.TRACK_RULES.map((r) => ({
      name: r.name,
      group: r.group,
      desc: r.label,
      kind: 'exact',
    }));
    for (const p of BC.TRACK_PATTERNS) {
      rows.push({
        name: p.re.toString().replace(/^\/|\/[a-z]*$/g, ''),
        group: 'pattern',
        desc: p.label,
        kind: 'pattern',
        patternGroup: p.group,
      });
    }
    return rows;
  }

  const GROUP_LABEL = {
    device: '设备指纹',
    share: '分享链',
    spm: '站内来源',
    utm: '营销参数',
    custom: '自定义',
    pattern: '前缀匹配',
  };

  function paramState(row) {
    const keep = new Set((settings.keepParams || []).map((x) => String(x).toLowerCase()));
    if (row.kind === 'exact') {
      if (keep.has(row.name.toLowerCase()) || BC.KEEP_PARAMS.has(row.name.toLowerCase())) {
        return { text: '保留', cls: 'state-keep' };
      }
      const groupOn = settings.groups[row.group] !== false;
      return groupOn
        ? { text: '移除', cls: 'state-on' }
        : { text: '已停用', cls: 'state-off' };
    }
    const groupOn = settings.groups[row.patternGroup] !== false;
    return groupOn ? { text: '移除', cls: 'state-on' } : { text: '已停用', cls: 'state-off' };
  }

  function renderRules() {
    const tbody = $('rule-body');
    const q = ($('rule-filter').value || '').trim().toLowerCase();
    const groupFilter = $('rule-group').value;
    const all = ruleRows();
    const list = all.filter((r) => {
      if (groupFilter === 'pattern') {
        if (r.kind !== 'pattern') return false;
      } else if (groupFilter) {
        if (r.kind !== 'exact' || r.group !== groupFilter) return false;
      }
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || String(r.desc).toLowerCase().includes(q);
    });

    tbody.textContent = '';
    const frag = document.createDocumentFragment();
    for (const row of list) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.className = 'p-name';
      tdName.textContent = row.kind === 'pattern' ? row.name : row.name;

      const tdGroup = document.createElement('td');
      tdGroup.className = 'p-group';
      tdGroup.textContent = GROUP_LABEL[row.group] || row.group;

      const tdDesc = document.createElement('td');
      tdDesc.className = 'p-desc';
      tdDesc.textContent = row.desc || '';

      const tdState = document.createElement('td');
      const st = paramState(row);
      const span = document.createElement('span');
      span.className = 'state ' + st.cls;
      span.textContent = st.text;
      tdState.appendChild(span);

      tr.append(tdName, tdGroup, tdDesc, tdState);
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    $('rule-count').textContent = `共 ${all.length} 条 · 当前显示 ${list.length} 条`;
  }

  /* ---------------------------- 自定义 ---------------------------- */

  function linesToList(text) {
    return String(text || '')
      .split(/[\n,，;；\s]+/)
      .map((s) => s.trim().replace(/^[?&]+/, ''))
      .filter(Boolean);
  }

  function fillCustom() {
    $('extra-params').value = (settings.extraParams || []).join('\n');
    $('keep-params').value = (settings.keepParams || []).join('\n');
  }

  $('btn-save-custom').addEventListener('click', async () => {
    const extraParams = linesToList($('extra-params').value);
    const keepParams = linesToList($('keep-params').value);
    await persist({ extraParams, keepParams }, '自定义规则已保存');
    runSandbox();
  });

  /* ---------------------------- 测试台 ---------------------------- */

  function runSandbox() {
    const input = $('sandbox-input').value;
    const res = BC.cleanText(input, options);
    $('sandbox-out').textContent = res.text || '—';

    const detail = $('sandbox-detail');
    detail.textContent = '';
    if (!res.removed.length) {
      const li = document.createElement('li');
      li.textContent = '没有命中任何追踪参数。';
      detail.appendChild(li);
      return;
    }
    const seen = new Set();
    for (const r of res.removed) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      const li = document.createElement('li');
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = r.name;
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = r.value || '(空)';
      const d = document.createElement('span');
      d.textContent = r.label || '';
      li.append(n, v, d);
      detail.appendChild(li);
    }
  }

  $('btn-sandbox').addEventListener('click', runSandbox);

  /* ---------------------------- 统计 ---------------------------- */

  async function renderStats() {
    const stats = await Store.getStats();
    $('s-today').textContent = stats.today;
    $('s-total').textContent = stats.total;
    const hosts = Object.entries(stats.byHost || {}).sort((a, b) => b[1] - a[1]);
    $('s-sites').textContent = hosts.length;
    $('stats-note').textContent = stats.lastCleaned
      ? '最近一次：' + new Date(stats.lastCleaned).toLocaleString('zh-CN')
      : '还没有记录';

    const host = $('host-list');
    host.textContent = '';
    const max = hosts.reduce((m, [, n]) => Math.max(m, Number(n) || 0), 1);
    for (const [name, n] of hosts.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'host-row';
      const hn = document.createElement('span');
      hn.className = 'host-name';
      hn.textContent = name;
      const bar = document.createElement('span');
      bar.className = 'host-bar';
      const fill = document.createElement('i');
      fill.style.width = Math.max(4, Math.round((Number(n) / max) * 100)) + '%';
      bar.appendChild(fill);
      const num = document.createElement('span');
      num.className = 'host-num';
      num.textContent = String(n);
      row.append(hn, bar, num);
      host.appendChild(row);
    }
    if (!hosts.length) {
      const row = document.createElement('div');
      row.className = 'host-row';
      row.textContent = '暂无数据，去 B 站逛逛就会有了。';
      host.appendChild(row);
    }
  }

  $('btn-reset-stats').addEventListener('click', async () => {
    await Store.resetStats();
    await renderStats();
    flashSaved('统计已清零');
  });

  $('btn-reset-all').addEventListener('click', async () => {
    settings = await Store.resetSettings();
    options = Store.toCleanOptions(settings);
    syncSwitches();
    renderGroups();
    renderRules();
    fillCustom();
    runSandbox();
    flashSaved('已恢复默认设置');
  });

  /* ---------------------------- VRChat 转换测试 ---------------------------- */

  function runVrTest() {
    const input = $('vr-test-input').value;
    const res = VR.explain(input);
    const out = $('vr-test-out');
    if (res.ok) {
      out.textContent = res.url;
      out.dataset.ok = '1';
      out.style.color = '';
    } else {
      out.textContent = '✗ ' + res.reason;
      out.dataset.ok = '';
      out.style.color = '#e35d80';
    }
    return res;
  }

  $('vr-test-btn').addEventListener('click', runVrTest);

  $('vr-test-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runVrTest();
  });

  $('vr-test-input').addEventListener('input', runVrTest);

  $('vr-test-copy').addEventListener('click', async () => {
    const res = runVrTest();
    if (!res.ok) {
      flashSaved('没有可复制的结果');
      return;
    }
    try {
      await navigator.clipboard.writeText(res.url);
      flashSaved('播放器链接已复制');
    } catch (e) {
      flashSaved('复制失败');
    }
  });

  /* ---------------------------- 启动 ---------------------------- */

  (async function init() {
    settings = await Store.getSettings(true);
    options = Store.toCleanOptions(settings);
    bindSwitches();
    syncSwitches();
    renderGroups();
    renderRules();
    fillCustom();
    runSandbox();
    runVrTest();
    await renderStats();

    $('rule-filter').addEventListener('input', renderRules);
    $('rule-group').addEventListener('change', renderRules);

    Store.onChange((next) => {
      settings = next;
      options = Store.toCleanOptions(next);
      syncSwitches();
      renderGroups();
      renderRules();
      runSandbox();
    });

    if (location.hash === '#welcome') {
      document.querySelector('.hero .sub').textContent =
        '安装完成！去 B 站随便点开一个视频：地址栏里那些 vd_source 会自己消失，右下角会多出一条 VRChat 播放器悬浮栏。';
    }
  })();
})();
