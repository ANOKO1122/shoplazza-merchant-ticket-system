/* 后台壳：侧栏和 logo 只建一次，切换页面时只替换中间内容。 */
(function () {
  var ADMIN_LINKS = [
    ['/thinkpro-admin', '📋', '工单处理'],
    ['/thinkpro-admin/stores', '🏪', '店铺管理'],
    ['/thinkpro-admin/emails', '📧', '订单邮件管理'],
    ['/thinkpro-admin/email-templates', '📨', '邮件模板'],
    ['/thinkpro-admin/settings', '⚙️', '系统设置'],
    ['/thinkpro-admin/logs', '📋', '系统日志'],
  ];
  var adminNavToken = 0;
  var adminTimers = [];
  var rawSetInterval = window.setInterval.bind(window);

  window.setInterval = function (fn, ms) {
    var id = rawSetInterval(fn, ms);
    adminTimers.push(id);
    return id;
  };

  function clearAdminTimers() {
    adminTimers.forEach(function (id) { clearInterval(id); });
    adminTimers = [];
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function pathOnly(href) {
    return String(href || '').split('?')[0].split('#')[0];
  }

  function navMatch(href, current) {
    var path = pathOnly(current || location.pathname);
    var target = pathOnly(href);
    if (!target) return false;
    if (target === '/thinkpro-admin') return path === '/thinkpro-admin';
    return path === target;
  }

  function shellHtml(active) {
    var agent = window.me || window.__adminAgent;
    var name = agent && agent.name ? agent.name : '';
    var items = ADMIN_LINKS.map(function (item) {
      var cls = navMatch(item[0], active) ? 'nav-item active' : 'nav-item';
      return '<a class="' + cls + '" href="' + item[0] + '"><span class="nav-icon">' + item[1] + '</span>' + item[2] + '</a>';
    }).join('');
    items += '<a class="nav-item" href="/mailpit/" target="_blank"><span class="nav-icon">📬</span>邮件调试</a>';
    return '<div class="app"><aside class="sidebar" id="adminShell"><div class="sidebar-header"><img src="/assets/logo.png" alt="" onerror="this.style.display=\'none\'"><span class="sidebar-title">客服后台</span></div><nav class="nav-menu">' + items + '</nav><div class="sidebar-footer"><span>v1.0.0</span><span id="adminUserName">' + esc(name) + '</span></div></aside><div class="main" id="mainArea"></div></div>';
  }

  function setActive(path) {
    var shell = document.getElementById('adminShell');
    if (!shell) return;
    shell.querySelectorAll('.nav-item').forEach(function (link) {
      if (link.getAttribute('target') === '_blank') return;
      link.classList.toggle('active', navMatch(link.getAttribute('href'), path));
    });
  }

  function adoptExisting() {
    if (document.getElementById('adminShell')) return;
    var aside = document.querySelector('.app > aside.sidebar, .app > .sidebar');
    var main = document.querySelector('.app > .main');
    if (!aside || !main) return;
    aside.id = 'adminShell';
    if (!main.id) main.id = 'mainArea';
  }

  function ensureShell(path) {
    adoptExisting();
    if (document.getElementById('adminShell')) {
      setActive(path);
      var existing = document.getElementById('mainArea');
      if (!existing) {
        var main = document.querySelector('.app > .main');
        if (main) main.id = 'mainArea';
      }
      var nameEl = document.getElementById('adminUserName');
      var agent = window.me || window.__adminAgent;
      if (nameEl && agent && agent.name) nameEl.textContent = agent.name;
      return;
    }
    var html = shellHtml(path);
    var app = document.getElementById('app');
    if (!app) {
      document.body.innerHTML = '<div id="app">' + html + '</div>';
      return;
    }
    app.innerHTML = html;
  }

  function closeOverlays() {
    ['logBubble', 'unpaidModal', 'image-lightbox'].forEach(function (id) {
      var node = document.getElementById(id);
      if (node) node.remove();
    });
    document.querySelectorAll('.image-lightbox').forEach(function (node) { node.remove(); });
  }

  function markPageStyles() {
    document.querySelectorAll('head style').forEach(function (node) {
      if (!node.getAttribute('data-admin-page')) node.setAttribute('data-admin-page', '1');
    });
  }

  function syncPageAssets(doc) {
    doc.querySelectorAll('link[rel="stylesheet"]').forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href || document.querySelector('link[rel="stylesheet"][href="' + href + '"]')) return;
      var el = document.createElement('link');
      el.rel = 'stylesheet';
      el.href = href;
      document.head.appendChild(el);
    });
    document.querySelectorAll('style[data-admin-page]').forEach(function (node) { node.remove(); });
    doc.querySelectorAll('style').forEach(function (style) {
      var el = document.createElement('style');
      el.setAttribute('data-admin-page', '1');
      el.textContent = style.textContent;
      document.head.appendChild(el);
    });
  }

  function isAdminAppPath(pathname) {
    if (!pathname || pathname.indexOf('/thinkpro-admin') !== 0) return false;
    if (pathname.indexOf('/ticket-preview') !== -1) return false;
    if (pathname.indexOf('/email-preview') !== -1) return false;
    return true;
  }

  window.adminEpoch = function () { return adminNavToken; };

  window.adminFrame = function (path) {
    ensureShell(path || location.pathname);
  };

  window.adminGo = function (href, opts) {
    opts = opts || {};
    var url;
    try { url = new URL(href, location.origin); } catch (e) { location.href = href; return; }
    if (url.origin !== location.origin || !isAdminAppPath(url.pathname)) {
      location.href = href;
      return;
    }
    var next = url.pathname + url.search;
    if (!opts.pop && next === location.pathname + location.search && document.getElementById('adminShell')) return;
    var token = ++adminNavToken;
    clearAdminTimers();
    closeOverlays();
    ensureShell(url.pathname);
    var main = document.getElementById('mainArea');
    if (main) main.innerHTML = '<div class="content" style="padding:24px;color:#8c8c8c">加载中...</div>';
    fetch(next, { credentials: 'same-origin', headers: { 'Accept': 'text/html' } }).then(function (res) {
      if (token !== adminNavToken) return null;
      if (res.redirected && res.url.indexOf('/login') !== -1) {
        location.replace(res.url);
        return null;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (html) {
      if (!html || token !== adminNavToken) return;
      var doc = new DOMParser().parseFromString(html, 'text/html');
      if (!opts.pop) history.pushState({ adminSoft: 1 }, '', next);
      document.title = doc.title || document.title;
      syncPageAssets(doc);
      if (url.pathname === '/thinkpro-admin/email-templates') {
        ensureShell(url.pathname);
        var incoming = doc.querySelector('.main');
        var slot = document.getElementById('mainArea');
        if (incoming && slot) slot.innerHTML = incoming.innerHTML;
      }
      var source = [];
      doc.querySelectorAll('script').forEach(function (script) {
        if (!script.src && script.textContent) source.push(script.textContent);
      });
      try {
        (0, eval)(source.join('\n;\n'));
      } catch (error) {
        console.error('[admin-shell] 页面脚本失败，改为整页打开', error);
        location.href = next;
      }
    }).catch(function (error) {
      console.error('[admin-shell] 切换失败，改为整页打开', error);
      if (token === adminNavToken) location.href = next;
    });
  };

  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a.nav-item') : null;
    if (!link) return;
    if (link.getAttribute('target') === '_blank') return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var href = link.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;
    var url;
    try { url = new URL(href, location.origin); } catch (e) { return; }
    if (url.origin !== location.origin || !isAdminAppPath(url.pathname)) return;
    event.preventDefault();
    window.adminGo(url.pathname + url.search);
  });

  window.addEventListener('popstate', function () {
    if (!isAdminAppPath(location.pathname)) return;
    window.adminGo(location.pathname + location.search, { pop: true });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { markPageStyles(); adoptExisting(); });
  } else {
    markPageStyles();
    adoptExisting();
  }
})();
