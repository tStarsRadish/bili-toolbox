/**
 * BiliClean —— offscreen 文档
 *
 * MV3 的 Service Worker 里没有 navigator.clipboard，
 * 复制文本必须借助一个 offscreen 文档。
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'offscreen:copy') return undefined;
  const text = String(msg.text == null ? '' : msg.text);
  const done = (ok, error) => sendResponse({ ok, error: error || '' });

  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      done(ok, ok ? '' : 'execCommand 失败');
    } catch (err) {
      done(false, err && err.message ? err.message : String(err));
    }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => done(true),
      () => fallback()
    );
  } else {
    fallback();
  }
  return true;
});
