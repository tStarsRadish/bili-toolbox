/**
 * BiliToolbox —— VRChat 播放器链接解析
 *
 * 90VRchat 的 B 站播放器接受的是「BV 号」而不是完整 URL：
 *   https://biliplayer.91vrchat.com/player/?url=BV1UThizGEpK
 *
 * 所以这里只做一件事：从任意输入（页面 URL / 裸 BV 号 / 分享文案）里
 * 抽出 BV 号，再拼成播放器地址。不做任何网络请求。
 *
 * 同一份代码在 Service Worker、内容脚本、弹窗与 Node 测试里共用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.BiliVrchat = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PLAYER_BASE = 'https://biliplayer.91vrchat.com/player/?url=';

  /** BV 号固定是 BV + 10 位大小写字母数字 */
  const BV_RE = /BV[0-9A-Za-z]{10}/;

  /** 归一化：前缀统一大写，其余字符保持原样（BV 号大小写敏感） */
  function normalizeBvid(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    const m = s.match(/^[Bb][Vv]([0-9A-Za-z]{10})$/);
    if (!m) return null;
    return 'BV' + m[1];
  }

  /** 在任意字符串里找 BV 号（取第一个） */
  function findBvid(text) {
    if (text == null) return null;
    const m = String(text).match(BV_RE);
    if (!m) return null;
    return normalizeBvid(m[0]);
  }

  /**
   * 从 URL / 裸号 / 分享文案里抽 BV 号。
   *
   * 优先级：
   *   1. 路径里的 /video/BVxxx（最可靠，就是当前视频）
   *   2. query 里的 bvid=BVxxx
   *   3. 任意位置的 BVxxx
   *
   * @returns {string|null}
   */
  function extractBvid(input) {
    if (input == null) return null;
    const s = String(input).trim();
    if (!s) return null;

    // 裸号
    const bare = normalizeBvid(s);
    if (bare) return bare;

    // 路径 /video/BVxxx 或 /video/av123 后面的分段
    const inPath = s.match(/\/video\/([Bb][Vv][0-9A-Za-z]{10})/);
    if (inPath) return normalizeBvid(inPath[1]);

    // query 参数 bvid=
    const inQuery = s.match(/[?&]bvid=([Bb][Vv][0-9A-Za-z]{10})/i);
    if (inQuery) return normalizeBvid(inQuery[1]);

    // 兜底：任意位置
    return findBvid(s);
  }

  /** 拼播放器地址；没有 BV 号返回 null */
  function buildPlayerUrl(bvid) {
    const bv = normalizeBvid(bvid) || findBvid(bvid);
    return bv ? PLAYER_BASE + bv : null;
  }

  /** 一步到位：任意输入 → 播放器地址 */
  function toPlayerUrl(input) {
    const bv = extractBvid(input);
    return bv ? PLAYER_BASE + bv : null;
  }

  /** 这个地址是不是 bilibili 的视频页（用来决定要不要出悬浮栏） */
  function isVideoPage(url) {
    const s = String(url || '');
    if (!/^https?:\/\//i.test(s)) return false;
    try {
      const u = new URL(s);
      if (!/(^|\.)(bilibili\.com|b23\.tv)$/i.test(u.hostname)) return false;
      return Boolean(extractBvid(s));
    } catch (e) {
      return false;
    }
  }

  /** av 号页面：VRChat 播放器只认 BV，这里给出可读的提示 */
  function isAvOnly(url) {
    const s = String(url || '');
    if (extractBvid(s)) return false;
    return /\/video\/av\d+/i.test(s);
  }

  /**
   * 统一出口，调用方不用自己判断各种情况。
   * @returns {{ok:boolean, bvid:string|null, url:string|null, reason:string}}
   */
  function explain(input) {
    const s = String(input || '');
    const bvid = extractBvid(s);
    if (bvid) {
      return { ok: true, bvid, url: PLAYER_BASE + bvid, reason: '' };
    }
    if (isAvOnly(s)) {
      return { ok: false, bvid: null, url: null, reason: 'av 号页面：VRChat 播放器只接受 BV 号' };
    }
    if (/b23\.tv/i.test(s)) {
      return { ok: false, bvid: null, url: null, reason: 'b23.tv 短链里看不到 BV 号，请先展开短链' };
    }
    if (!s.trim()) {
      return { ok: false, bvid: null, url: null, reason: '没有输入' };
    }
    return { ok: false, bvid: null, url: null, reason: '没有找到 BV 号' };
  }

  return {
    PLAYER_BASE,
    BV_RE,
    normalizeBvid,
    findBvid,
    extractBvid,
    buildPlayerUrl,
    toPlayerUrl,
    isVideoPage,
    isAvOnly,
    explain,
  };
});
