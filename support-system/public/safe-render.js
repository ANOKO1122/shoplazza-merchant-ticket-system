/* Shared rules for rendering plain business data in HTML and image/link attributes. */
(function () {
  'use strict';

  function escape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function url(value) {
    if (typeof value !== 'string') return '';
    var raw = value.trim();
    // Persisted URLs must be HTTP(S) or root-relative. Blob URLs are only used
    // directly by the local file preview, never accepted from stored messages.
    if (!raw || /[\u0000-\u0020\u007f\\]/.test(raw)) return '';
    if (raw.indexOf('//') === 0) raw = 'https:' + raw;
    if (!/^https?:\/\//i.test(raw) && raw.charAt(0) !== '/') return '';
    try {
      var parsed = new URL(raw, window.location.origin);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
      if (parsed.username || parsed.password) return '';
      return parsed.href;
    } catch (e) {
      return '';
    }
  }

  function role(value) {
    return ['customer', 'agent', 'system', 'platform'].indexOf(value) >= 0 ? value : 'system';
  }

  function images(attachments) {
    if (!Array.isArray(attachments)) return '';
    var html = attachments.map(function (value) {
      var src = url(value);
      if (!src) return '';
      // Data belongs in an attribute, not in the JavaScript handler source.
      return '<img src="' + escape(src) + '" data-image-url="' + escape(src) +
        '" class="chat-img" onclick="SupportSafe.showImage(this.getAttribute(\'data-image-url\'))" loading="lazy">';
    }).join('');
    return html ? '<div class="msg-images">' + html + '</div>' : '';
  }

  function showImage(value) {
    var src = url(value);
    if (!src) return;
    var lightbox = document.createElement('div');
    lightbox.className = 'image-lightbox';
    var img = document.createElement('img');
    img.src = src;
    img.alt = '';
    lightbox.appendChild(img);
    lightbox.onclick = function () { lightbox.remove(); };
    document.body.appendChild(lightbox);
  }

  window.SupportSafe = { escape: escape, url: url, role: role, images: images, showImage: showImage };
})();
