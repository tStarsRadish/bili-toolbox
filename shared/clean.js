/**
 * BiliClean —— B 站追踪链接清洗核心
 *
 * 一份代码，三种运行环境：
 *   1. MV3 Service Worker（ES module：import 后取 globalThis.BiliClean）
 *   2. 内容脚本 / MAIN world 脚本（classic script：自动挂到 globalThis.BiliClean）
 *   3. Node 单元测试（require 后取 module.exports）
 *
 * 设计原则：
 *   - 只删“确定是追踪用”的参数，绝不误删 p / t / ep_id / cid 这类会影响播放定位的参数；
 *   - 白名单优先：KEEP_PARAMS 里的参数即使命中正则也不会被删；
 *   - 保留原始 URL 的编码与参数顺序，不做无谓的重排。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.BiliClean = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.1.0';

  /* ------------------------------------------------------------------ *
   * 参数分组
   * ------------------------------------------------------------------ */

  const GROUPS = {
    device: {
      id: 'device',
      name: '设备指纹',
      desc: '把“谁在看”编成 ID 塞进链接，是 B 站最核心的跨站追踪手段',
      enabledByDefault: true,
    },
    share: {
      id: 'share',
      name: '分享与传播链',
      desc: '点分享 / 复制链接时附带的来源、会话、时间戳，用于还原传播路径',
      enabledByDefault: true,
    },
    spm: {
      id: 'spm',
      name: '站内曝光与来源',
      desc: '记录你从哪个推荐位、哪个搜索词点进来的（spm_id_from 等）',
      enabledByDefault: true,
    },
    utm: {
      id: 'utm',
      name: '通用营销参数',
      desc: 'UTM / gclid / fbclid 等全网通行的广告归因参数',
      enabledByDefault: true,
    },
  };

  /* ------------------------------------------------------------------ *
   * 精确匹配的追踪参数
   * ------------------------------------------------------------------ */

  const TRACK_RULES = [
    // —— 设备指纹 ——
    { name: 'vd_source', group: 'device', label: '设备指纹 ID（B 站最典型的追踪参数）' },
    { name: 'buvid', group: 'device', label: '浏览器设备 ID' },
    { name: 'buvid3', group: 'device', label: '浏览器设备 ID（buvid3）' },
    { name: 'buvid4', group: 'device', label: '浏览器设备 ID（buvid4）' },

    // —— 分享与传播链 ——
    { name: 'share_source', group: 'share', label: '分享来源（copy_web / WEIXIN …）' },
    { name: 'share_medium', group: 'share', label: '分享介质（android / iphone / web）' },
    { name: 'share_plat', group: 'share', label: '分享平台（ios / android / pc）' },
    { name: 'share_tag', group: 'share', label: '分享标记（s_i）' },
    { name: 'share_session_id', group: 'share', label: '分享会话 ID' },
    { name: 'share_from', group: 'share', label: '分享入口（ugc …）' },
    { name: 'share_times', group: 'share', label: '分享次数' },
    { name: 'unique_k', group: 'share', label: '分享短链唯一标记' },
    { name: 'bbid', group: 'share', label: '分享链路 ID' },
    { name: 'timestamp', group: 'share', label: '分享时间戳' },
    { name: 'ts', group: 'share', label: '分享时间戳（短）' },
    { name: 'up_id', group: 'share', label: '分享时携带的 UP 主 ID（页面并不需要）' },
    { name: 'plat_id', group: 'share', label: '客户端平台 ID' },
    { name: 'launch_id', group: 'share', label: '客户端启动 ID' },
    { name: 'is_story_h5', group: 'share', label: '图文 / 故事页分享标记' },
    { name: 'bsource', group: 'share', label: '外部搜索来源（如 bsource=search_google）' },

    // —— 站内曝光与来源 ——
    { name: 'spm_id_from', group: 'spm', label: '站内曝光位（333.788 …）' },
    { name: 'from_spmid', group: 'spm', label: '上级曝光位' },
    { name: 'spmid', group: 'spm', label: '曝光位' },
    { name: 'spm', group: 'spm', label: '通用曝光位' },
    { name: 'scm', group: 'spm', label: '来源渠道' },
    { name: 'from_source', group: 'spm', label: '来源（webtop_search / share …）' },
    { name: 'from', group: 'spm', label: '来源标记（search / space / dynamic）' },
    { name: 'seid', group: 'spm', label: '搜索会话 ID' },
    { name: 'trackid', group: 'spm', label: '推荐流追踪 ID' },
    { name: 'track_id', group: 'spm', label: '推荐流追踪 ID' },
    { name: 'from_track_id', group: 'spm', label: '推荐流追踪 ID' },
    { name: 'msource', group: 'spm', label: '移动端来源' },
    { name: 'live_from', group: 'spm', label: '直播来源' },
    { name: 'hotRank', group: 'spm', label: '热门榜来源' },

    // —— 通用营销参数 ——
    { name: 'gclid', group: 'utm', label: 'Google Ads 点击 ID' },
    { name: 'gbraid', group: 'utm', label: 'Google Ads 点击 ID' },
    { name: 'wbraid', group: 'utm', label: 'Google Ads 点击 ID' },
    { name: 'fbclid', group: 'utm', label: 'Facebook 点击 ID' },
    { name: 'msclkid', group: 'utm', label: 'Microsoft Ads 点击 ID' },
    { name: 'yclid', group: 'utm', label: 'Yandex 点击 ID' },
    { name: 'twclid', group: 'utm', label: 'Twitter 点击 ID' },
    { name: 'igshid', group: 'utm', label: 'Instagram 分享 ID' },
    { name: 'mc_cid', group: 'utm', label: 'Mailchimp 活动 ID' },
    { name: 'mc_eid', group: 'utm', label: 'Mailchimp 用户 ID' },
    { name: '_hsenc', group: 'utm', label: 'HubSpot 追踪' },
    { name: '_hsmi', group: 'utm', label: 'HubSpot 追踪' },
    { name: 'oly_anon_id', group: 'utm', label: 'Omeda 匿名 ID' },
    { name: 'oly_enc_id', group: 'utm', label: 'Omeda 加密 ID' },
    { name: 'vero_id', group: 'utm', label: 'Vero 追踪 ID' },
    { name: 'ref_src', group: 'utm', label: '来源推荐标记' },
  ];

  /* ------------------------------------------------------------------ *
   * 前缀 / 正则匹配的追踪参数
   * ------------------------------------------------------------------ */

  const TRACK_PATTERNS = [
    { re: /^utm_/i, group: 'utm', label: 'UTM 营销参数' },
    { re: /^share_(?!id$)/i, group: 'share', label: '分享追踪参数' },
    { re: /^spm_/i, group: 'spm', label: '站内曝光位' },
    { re: /^from_(?!page$)/i, group: 'spm', label: '来源标记' },
    { re: /^vd_/i, group: 'device', label: '设备指纹参数' },
  ];

  /**
   * 白名单：这些参数一旦出现，任何规则都不能删它。
   * 它们直接决定“打开哪一集 / 第几个分 P / 从哪里开始播”。
   */
  const KEEP_PARAMS = new Set([
    'p', 'page', 't', 'start', 'end',
    'ep_id', 'cid', 'aid', 'bvid', 'oid', 'season_id', 'section_id',
    'business', 'type', 'sub_type', 'keyword', 'search_type', 'order',
    'duration', 'danmaku', 'sort', 'tab', 'sid', 'rid', 'mid', 'fid', 'tid',
    'q', 'navhide', 'wide', 'comment_on', 'autoplay', 'mode', 'no_title',
  ]);

  /** 属于“播放进度定位”的参数，受 keepProgress 开关保护。 */
  const PROGRESS_PARAMS = new Set(['t', 'start', 'end', 'navhide', 'autoplay']);

  /* ------------------------------------------------------------------ *
   * 域名判定
   * ------------------------------------------------------------------ */

  const CLEAN_DOMAINS = ['bilibili.com', 'b23.tv', 'hdslb.com'];

  function isBiliHost(hostname) {
    if (!hostname) return false;
    const host = String(hostname).toLowerCase().replace(/\.$/, '');
    return CLEAN_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  }

  /* ------------------------------------------------------------------ *
   * URL 拆解（手工解析，保留原始编码与顺序）
   * ------------------------------------------------------------------ */

  function splitUrl(raw) {
    let s = String(raw == null ? '' : raw).trim();
    // 复制来的链接里经常带 HTML 实体
    s = s.replace(/&amp;/gi, '&');
    let hash = '';
    const hashAt = s.indexOf('#');
    if (hashAt >= 0) {
      hash = s.slice(hashAt);
      s = s.slice(0, hashAt);
    }
    let query = '';
    const qAt = s.indexOf('?');
    if (qAt >= 0) {
      query = s.slice(qAt + 1);
      s = s.slice(0, qAt);
    }
    return { base: s, query, hash };
  }

  function safeDecode(v) {
    try {
      return decodeURIComponent(String(v).replace(/\+/g, ' '));
    } catch (e) {
      return String(v);
    }
  }

  function parsePairs(query) {
    if (!query) return [];
    return query
      .split('&')
      .filter((p) => p.length > 0)
      .map((pair) => {
        const eq = pair.indexOf('=');
        const rawName = eq >= 0 ? pair.slice(0, eq) : pair;
        const rawValue = eq >= 0 ? pair.slice(eq + 1) : '';
        return { raw: pair, name: safeDecode(rawName), rawName, rawValue };
      });
  }

  /* ------------------------------------------------------------------ *
   * 规则查询
   * ------------------------------------------------------------------ */

  function normalizeList(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((x) => String(x == null ? '' : x).trim().replace(/^[?&]+/, ''))
      .filter(Boolean);
  }

  function buildRuleIndex(extraParams) {
    const exact = new Map();
    for (const r of TRACK_RULES) exact.set(r.name.toLowerCase(), r);
    for (const name of normalizeList(extraParams)) {
      const key = name.toLowerCase();
      if (!exact.has(key)) {
        exact.set(key, { name: key, group: 'custom', label: '自定义移除参数' });
      }
    }
    return exact;
  }

  function matchRule(name, exact) {
    const key = String(name || '').toLowerCase();
    if (!key) return null;
    const hit = exact.get(key);
    if (hit) return hit;
    for (const p of TRACK_PATTERNS) {
      if (p.re.test(key)) return { name: key, group: p.group, label: p.label };
    }
    return null;
  }

  function defaultOptions(overrides) {
    const groups = {};
    for (const id of Object.keys(GROUPS)) groups[id] = GROUPS[id].enabledByDefault;
    groups.custom = true;
    const opts = {
      groups,
      extraParams: [],
      keepParams: [],
      keepProgress: true,
      dropEmptyQuery: true,
    };
    if (overrides && typeof overrides === 'object') {
      Object.assign(opts, overrides);
      if (overrides.groups) opts.groups = Object.assign(groups, overrides.groups);
    }
    return opts;
  }

  /**
   * 判断单个参数是否该被移除。
   * @returns {{name:string,label:string,group:string}|null}
   */
  function classifyParam(name, options) {
    const opts = options || defaultOptions();
    const key = String(name || '').toLowerCase();
    if (!key) return null;

    // 1. 用户手动加的“强制保留”优先级最高
    const keep = new Set(normalizeList(opts.keepParams).map((x) => x.toLowerCase()));
    if (keep.has(key)) return null;

    // 2. 播放进度参数：默认保留，只有用户关掉 keepProgress 才删
    if (PROGRESS_PARAMS.has(key)) {
      if (opts.keepProgress === false) {
        return { name: key, label: '播放进度定位参数', group: 'progress' };
      }
      return null;
    }

    // 3. 业务白名单：p / ep_id / cid 这类永远不动
    if (KEEP_PARAMS.has(key)) return null;

    // 4. 追踪规则
    const rule = matchRule(key, buildRuleIndex(opts.extraParams));
    if (!rule) return null;
    const enabled = opts.groups ? opts.groups[rule.group] : true;
    if (enabled === false) return null;
    return rule;
  }

  /* ------------------------------------------------------------------ *
   * 主入口
   * ------------------------------------------------------------------ */

  /**
   * 清洗一个 URL。
   * @returns {{url:string, original:string, changed:boolean, removed:Array<{name:string,value:string,label:string,group:string}>}}
   */
  function cleanUrl(raw, overrides) {
    const original = String(raw == null ? '' : raw);
    const opts = defaultOptions(overrides);
    const parts = splitUrl(original);
    const pairs = parsePairs(parts.query);
    const removed = [];
    const kept = [];

    for (const pair of pairs) {
      const rule = classifyParam(pair.name, opts);
      if (rule) {
        removed.push({
          name: pair.name,
          value: safeDecode(pair.rawValue),
          label: rule.label,
          group: rule.group,
        });
      } else {
        kept.push(pair.raw);
      }
    }

    let query = kept.join('&');
    if (!query && opts.dropEmptyQuery === false) query = '';
    const url = parts.base + (query ? '?' + query : '') + parts.hash;

    return {
      url,
      original,
      changed: removed.length > 0 && url !== original,
      removed,
    };
  }

  /** 只需要一个布尔值时用它。 */
  function isTracked(raw, overrides) {
    return cleanUrl(raw, overrides).removed.length > 0;
  }

  /** 在“当前页面 URL”上做清洗：只处理白名单域名。 */
  function cleanPageUrl(raw, overrides) {
    const res = cleanUrl(raw, overrides);
    if (!res.changed) return res;
    let host = '';
    try {
      host = new URL(res.url).hostname;
    } catch (e) {
      try {
        host = new URL('https://' + res.url).hostname;
      } catch (e2) {
        return res;
      }
    }
    if (!isBiliHost(host)) {
      return { url: res.original, original: res.original, changed: false, removed: [] };
    }
    return res;
  }

  /* ------------------------------------------------------------------ *
   * 文本里的链接（分享文案常见形态）
   * ------------------------------------------------------------------ */

  const ABS_URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  // 裸域名：不能把 ? 前面的英文标点吃掉，也不能匹配到更长域名的后缀
  const BARE_URL_RE =
    /(^|[\s（(【[「『"'`>：:，,])((?:[a-z0-9-]+\.)*(?:bilibili\.com|b23\.tv)(?::\d+)?\/[^\s<>"'`）)】」』]*)/gi;

  function trimTrailingPunct(u) {
    let out = u;
    // 末尾的中英文标点大概率不属于 URL
    while (out.length && /[，。、；：！？,.;:!?）)】」』"'`]/.test(out[out.length - 1])) {
      out = out.slice(0, -1);
    }
    return out;
  }

  /** 从 URL 里取出 hostname（容忍缺协议、裸域名） */
  function hostOf(url) {
    const s = String(url || '');
    try {
      return new URL(s).hostname.toLowerCase();
    } catch (e) {
      /* 继续尝试 */
    }
    try {
      return new URL('https://' + s.replace(/^\/\//, '')).hostname.toLowerCase();
    } catch (e) {
      return '';
    }
  }

  /**
   * 清洗一段文本里的所有 B 站链接。
   *
   * 只有“确实是 B 站域名”的链接才会被动，其余 URL 一律原样放行 ——
   * 否则分享文案里夹着的 GitHub / 知乎链接会被顺手改掉，那是越权。
   *
   * @returns {{text:string, changed:boolean, removed:Array, count:number}}
   */
  function cleanText(text, overrides) {
    const src = String(text == null ? '' : text);
    let changed = false;
    let count = 0;
    const removed = [];
    const opts = overrides;

    const replaceOne = (candidate) => {
      const tail = trimTrailingPunct(candidate);
      const suffix = candidate.slice(tail.length);

      if (!isBiliHost(hostOf(tail))) return candidate;

      const res = cleanUrl(tail, opts);
      if (!res.changed) return candidate;
      changed = true;
      count += 1;
      removed.push(...res.removed);
      return res.url + suffix;
    };

    let out = src.replace(ABS_URL_RE, (m) => replaceOne(m));
    out = out.replace(BARE_URL_RE, (m, prefix, candidate) => prefix + replaceOne(candidate));

    return { text: out, changed, removed, count };
  }

  /* ------------------------------------------------------------------ *
   * 给 declarativeNetRequest 用的参数清单
   * ------------------------------------------------------------------ */

  function paramsForNetworkRule(overrides) {
    const opts = defaultOptions(overrides);
    const params = new Set();
    for (const r of TRACK_RULES) {
      if (opts.groups && opts.groups[r.group] === false) continue;
      params.add(r.name);
    }
    // 正则规则无法直接交给 DNR，这里把已知前缀展开成常见取值
    const prefixExpansions = {
      utm_: ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
        'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic'],
      share_: ['share_source', 'share_medium', 'share_plat', 'share_tag', 'share_session_id',
        'share_from', 'share_times'],
      spm_: ['spm_id_from', 'spm'],
      from_: ['from_spmid', 'from_source', 'from_track_id'],
      vd_: ['vd_source'],
    };
    for (const [prefix, list] of Object.entries(prefixExpansions)) {
      const group = TRACK_PATTERNS.find((p) => p.re.source.indexOf(prefix) >= 0);
      const groupId = group ? group.group : 'custom';
      if (opts.groups && opts.groups[groupId] === false) continue;
      for (const name of list) params.add(name);
    }
    for (const name of normalizeList(opts.extraParams)) params.add(name);
    for (const name of normalizeList(opts.keepParams)) params.delete(name);
    return Array.from(params);
  }

  /* ------------------------------------------------------------------ *
   * 展示用
   * ------------------------------------------------------------------ */

  function explainParam(name) {
    const key = String(name || '').toLowerCase();
    const exact = buildRuleIndex([]).get(key);
    if (exact) return exact.label;
    const m = matchRule(key, new Map());
    return m ? m.label : null;
  }

  /** 把 removed 数组压成 “vd_source=abc123… ” 这种短标签 */
  function summarizeRemoved(removed, max = 3) {
    if (!removed || !removed.length) return '';
    const parts = removed.slice(0, max).map((r) => r.name);
    if (removed.length > max) parts.push('等 ' + removed.length + ' 个');
    return parts.join('、');
  }

  /** 短链：b23.tv 之类 */
  function isShortLink(url) {
    try {
      const host = new URL(String(url)).hostname.toLowerCase();
      return host === 'b23.tv' || host.endsWith('.b23.tv');
    } catch (e) {
      return /^(?:https?:\/\/)?(?:www\.)?b23\.tv\//i.test(String(url));
    }
  }

  return {
    VERSION,
    GROUPS,
    TRACK_RULES,
    TRACK_PATTERNS,
    KEEP_PARAMS,
    PROGRESS_PARAMS,
    CLEAN_DOMAINS,
    isBiliHost,
    isShortLink,
    hostOf,
    splitUrl,
    parsePairs,
    cleanUrl,
    cleanPageUrl,
    cleanText,
    isTracked,
    classifyParam,
    paramsForNetworkRule,
    explainParam,
    summarizeRemoved,
    defaultOptions,
  };
});
