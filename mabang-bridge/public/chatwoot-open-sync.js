/* eslint-disable no-console */
(function () {
  var BRIDGE_BASE = window.__SHOPLAZZA_BRIDGE_BASE__ || '/bridge-api';
  var SYNC_TOKEN = window.__SHOPLAZZA_SYNC_TOKEN__ || '';
  var lastKey = '';
  var lastAt = 0;
  var lastPathLogAt = 0;
  var runId = 'open-sync-v4';
  var activeBridgeBase = '';
  /** 当前会话侧栏是否被用户手动修改过（会话级脏标记） */
  var manualDirtyCache = Object.create(null);
  /** 同一会话重复调 /sync/conversation-order 的最小间隔（毫秒），减轻多店后台同步压力 */
  var SYNC_DEDUP_MS = Math.max(8000, Number(window.__SHOPLAZZA_SYNC_DEDUP_MS__) || 25000);
  var lastSyncConvKey = '';
  var lastSyncAt = 0;
  var runTimer = null;

  /**
   * 仅当设置 window.__SHOPLAZZA_DEBUG_INGEST_URL__ 时才上报；生产环境勿向 localhost 打点（会刷屏且拖慢页面）
   */
  function bridgeDebugIngest(message, data) {
    var url = window.__SHOPLAZZA_DEBUG_INGEST_URL__;
    if (!url || typeof url !== 'string') return;
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message, data: data || {}, t: Date.now() }),
      }).catch(function () {});
    } catch (e) {}
  }

  function ensureNoTrailingSlash(s) {
    return String(s || '').replace(/\/+$/, '');
  }

  function looksLikeValidBridgeBase(s) {
    var b = String(s || '').trim();
    if (!b) return false;
    if (/\/public\/storage\//i.test(b)) return false;
    return true;
  }

  BRIDGE_BASE = ensureNoTrailingSlash(BRIDGE_BASE || '/bridge-api');

  /**
   * 候选桥接地址：优先同源反代路径（/bridge-api），避免再探测 https://域名:4000（与 443 不同源 → CORS）
   * 仅当 window.__SHOPLAZZA_TRY_HOST_PORT4000__ === true 时才追加 :4000（本机直连调试用）
   */
  function candidateBases() {
    var out = [];
    function push(v) {
      var s = ensureNoTrailingSlash(v);
      if (!s) return;
      if (out.indexOf(s) >= 0) return;
      out.push(s);
    }
    if (looksLikeValidBridgeBase(BRIDGE_BASE)) push(BRIDGE_BASE);
    push('/bridge-api');
    if (window.__SHOPLAZZA_TRY_HOST_PORT4000__ === true) {
      push('http://' + location.hostname + ':4000');
      push('https://' + location.hostname + ':4000');
    }
    return out;
  }

  function probeBase(base) {
    return fetch(base + '/health', { method: 'GET', credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) return false;
        return r.text().then(function (t) {
          return /chatwoot-shoplazza-bridge/i.test(String(t || ''));
        });
      })
      .catch(function () {
        return false;
      });
  }

  function ensureBridgeBase() {
    if (activeBridgeBase) return Promise.resolve(activeBridgeBase);
    var list = candidateBases();
    var i = 0;
    function next() {
      if (i >= list.length) return Promise.resolve('');
      var b = list[i++];
      return probeBase(b).then(function (ok) {
        if (ok) {
          activeBridgeBase = b;
          return b;
        }
        return next();
      });
    }
    return next();
  }

  function ping(payload) {
    if (window.__SHOPLAZZA_OPEN_SYNC_PING__ !== true) return Promise.resolve();
    return ensureBridgeBase().then(function (base) {
      if (!base) return;
      return fetch(base + '/chatwoot/open-sync-ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ runId: runId, bridgeBase: base }, payload || {})),
      }).catch(function () {});
    });
  }

  function parseRoute() {
    var full = String(location.pathname || '') + String(location.hash || '');
    var m = full.match(/\/app\/accounts\/(\d+)\/(?:inbox\/\d+\/)?conversations\/(\d+)/);
    if (!m) return null;
    return { accountId: Number(m[1]), conversationId: Number(m[2]) };
  }

  /**
   * 为每个会话生成唯一 key，确保“手动修改后不再自动刷新”只影响当前会话
   */
  function conversationKey(route) {
    if (!route) return '';
    return String(route.accountId) + ':' + String(route.conversationId);
  }

  /**
   * 将“用户手动修改过侧栏”的状态写入 sessionStorage：
   * - 用 sessionStorage 而不是 localStorage，避免跨浏览器会话长期污染
   * - 发生异常时仅降级到内存缓存，不影响主流程
   */
  function markConversationManualDirty(route) {
    var key = conversationKey(route);
    if (!key) return;
    manualDirtyCache[key] = true;
    try {
      sessionStorage.setItem('shoplazza_sidebar_dirty:' + key, '1');
    } catch (e) {}
  }

  /**
   * 读取会话脏标记：
   * - 先读内存缓存（快）
   * - 再读 sessionStorage（页面刷新后仍可保留）
   */
  function isConversationManualDirty(route) {
    var key = conversationKey(route);
    if (!key) return false;
    if (manualDirtyCache[key] === true) return true;
    try {
      var v = sessionStorage.getItem('shoplazza_sidebar_dirty:' + key);
      if (v === '1') {
        manualDirtyCache[key] = true;
        return true;
      }
    } catch (e) {}
    return false;
  }

  /**
   * 判断一次事件是否属于“用户手动修改侧栏内容”：
   * - 通过 input/change 提交类事件兜底
   * - 通过 data-action / aria-label / 文本关键词覆盖“保存/更新”等按钮
   * 说明：这里使用宽松匹配，目的是“宁可少量误判，也不要漏判用户手工修改”。
   */
  function looksLikeSidebarManualEditEvent(target) {
    if (!target || !target.closest) return false;
    var panel = target.closest('aside, [role="complementary"], .conversation--details, .woot-widget-bubble, .contact-panel');
    if (!panel) return false;

    var tag = String(target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;

    var btn = target.closest('button, [role="button"], [data-action]');
    if (!btn) return false;

    var action = String(btn.getAttribute('data-action') || '').toLowerCase();
    var aria = String(btn.getAttribute('aria-label') || '').toLowerCase();
    var text = String(btn.textContent || '').toLowerCase();
    var signal = action + ' ' + aria + ' ' + text;
    return /(save|update|submit|edit|apply|confirm|保存|更新|提交|编辑|应用|确认)/.test(signal);
  }

  function tryStoreContactId() {
    try {
      var s = window.$store && window.$store.state;
      var selected =
        (s && s.conversation && s.conversation.selectedConversation) ||
        (s && s.conversations && s.conversations.selectedConversation) ||
        null;
      var id =
        (selected && selected.meta && selected.meta.sender && selected.meta.sender.id) ||
        (selected && selected.contact && selected.contact.id) ||
        (selected && selected.contact_id) ||
        0;
      return Number(id) || 0;
    } catch (e) {
      return 0;
    }
  }

  function tryResourceTimelineContactId(accountId) {
    try {
      var list = performance.getEntriesByType('resource');
      for (var i = list.length - 1; i >= 0; i--) {
        var name = String(list[i].name || '');
        var m = name.match(new RegExp('/api/v1/accounts/' + accountId + '/contacts/(\\d+)(?:\\?|$)'));
        if (m && m[1]) return Number(m[1]) || 0;
      }
    } catch (e) {}
    return 0;
  }

  function syncByConversation(accountId, conversationId) {
    return ensureBridgeBase().then(function (base) {
      if (!base) {
        bridgeDebugIngest('bridge_not_reachable', { accountId: accountId, conversationId: conversationId });
        return { ok: false, status: 0, error: 'bridge_not_reachable' };
      }
      var headers = { 'Content-Type': 'application/json' };
      if (SYNC_TOKEN) headers.Authorization = 'Bearer ' + SYNC_TOKEN;
      return fetch(base + '/sync/conversation-order', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ accountId: accountId, conversationId: conversationId }),
      })
        .then(function (r) {
          return r.json().catch(function () {
            return { ok: false, status: r.status };
          });
        })
        .then(function (json) {
          if (json && typeof json === 'object' && !json.status) json.status = 200;
          bridgeDebugIngest('sync_conversation_order_response', {
            accountId: accountId,
            conversationId: conversationId,
            ok: !!(json && json.ok),
          });
          return json;
        })
        .catch(function (e) {
          bridgeDebugIngest('sync_conversation_order_throw', {
            accountId: accountId,
            conversationId: conversationId,
            err: (e && e.message) || String(e),
          });
          return { ok: false, status: 0, error: (e && e.message) || 'sync_request_failed' };
        });
    });
  }

  function run() {
    var route = parseRoute();
    if (!route) {
      var nowPath = Date.now();
      if (nowPath - lastPathLogAt > 8000) {
        lastPathLogAt = nowPath;
        ping({ phase: 'parse', message: 'route_not_matched', matched: false, path: location.pathname });
      }
      return;
    }
    var k = route.accountId + ':' + route.conversationId;
    var now = Date.now();
    if (k === lastKey && now - lastAt < 1500) return;
    lastKey = k;
    lastAt = now;

    var convKey = k;
    if (isConversationManualDirty(route)) {
      ping({
        phase: 'skip',
        message: 'manual_sidebar_dirty',
        matched: true,
        path: location.pathname,
      });
      return;
    }
    if (convKey === lastSyncConvKey && now - lastSyncAt < SYNC_DEDUP_MS) {
      return;
    }

    ping({ phase: 'parse', message: 'route_matched', matched: true, path: location.pathname });
    tryStoreContactId();
    tryResourceTimelineContactId(route.accountId);

    lastSyncConvKey = convKey;
    lastSyncAt = now;

    syncByConversation(route.accountId, route.conversationId)
      .then(function (r) {
        var ok = !!(r && r.ok);
        var status = Number((r && r.status) || (ok ? 200 : 0)) || 0;
        ping({
          phase: 'sync',
          message: ok ? 'sync_finished' : 'sync_finished_not_ok',
          matched: true,
          syncOk: ok,
          syncStatus: status,
          path: location.pathname,
        });
        window.dispatchEvent(new Event('focus'));
      })
      .catch(function (e) {
        ping({
          phase: 'sync',
          message: 'sync_error',
          matched: true,
          path: location.pathname,
          syncStatus: 0,
        });
        console.warn('[shoplazza-open-sync] skipped:', e && e.message ? e.message : e);
      });
  }

  function scheduleRun() {
    if (runTimer) clearTimeout(runTimer);
    runTimer = setTimeout(function () {
      runTimer = null;
      run();
    }, 400);
  }

  var observer = new MutationObserver(function () {
    scheduleRun();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });
  /**
   * 监听用户操作：一旦识别为侧栏手动编辑，就给当前会话打 dirty。
   * 采用捕获阶段，尽量避免被业务侧 stopPropagation 阻断。
   */
  document.addEventListener(
    'change',
    function (e) {
      var route = parseRoute();
      if (!route) return;
      if (!looksLikeSidebarManualEditEvent(e && e.target)) return;
      markConversationManualDirty(route);
      ping({
        phase: 'mark',
        message: 'manual_sidebar_dirty_set',
        matched: true,
        path: location.pathname,
      });
    },
    true
  );
  document.addEventListener(
    'click',
    function (e) {
      var route = parseRoute();
      if (!route) return;
      if (!looksLikeSidebarManualEditEvent(e && e.target)) return;
      markConversationManualDirty(route);
      ping({
        phase: 'mark',
        message: 'manual_sidebar_dirty_set',
        matched: true,
        path: location.pathname,
      });
    },
    true
  );
  window.addEventListener('popstate', run);
  window.addEventListener('hashchange', run);
  setInterval(run, 12000);
  run();
})();
