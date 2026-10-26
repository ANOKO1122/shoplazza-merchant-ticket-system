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

  function shipments(order, labels) {
    order = order || {};
    labels = labels || {};
    var packageLabel = labels.packageLabel || 'Package';
    var currentLabel = labels.currentLabel || 'Current';
    var emptyLabel = labels.emptyLabel || 'Tracking not available';
    function numbers(values) {
      if (!Array.isArray(values)) return [];
      return values.map(function (value) {
        return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
      }).filter(function (value, index, all) { return value && all.indexOf(value) === index; });
    }
    function numberLines(values, current) {
      return values.length ? values.map(function (value) {
        var marker = current && current.indexOf(value) !== -1
          ? '<span class="shipment-current" style="font-size:11px;color:#8c8c8c;margin-left:6px">' + escape(currentLabel) + '</span>' : '';
        return '<div class="shipment-number" style="overflow-wrap:anywhere">' + escape(value) + marker + '</div>';
      }).join('') : '<span style="color:#8c8c8c">' + escape(emptyLabel) + '</span>';
    }
    var packages = Array.isArray(order.shipments) ? order.shipments.filter(function (item) {
      return item && typeof item === 'object' && !Array.isArray(item);
    }) : [];
    if (!packages.length) {
      var legacy = Array.isArray(order.tracking_numbers) ? order.tracking_numbers : [order.tracking_no];
      return numberLines(numbers(legacy));
    }
    return packages.map(function (shipment, index) {
      var label = packageLabel + ' ' + (index + 1);
      if (shipment.tracking_company) label += ' · ' + shipment.tracking_company;
      return '<div class="shipment-block" data-shipment-id="' + escape(shipment.id || '') + '" style="margin-bottom:6px">' +
        '<div style="font-size:12px;color:#8c8c8c">' + escape(label) + '</div>' +
        numberLines(numbers(shipment.tracking_numbers), numbers(shipment.current_tracking_numbers)) + '</div>';
    }).join('');
  }

  window.SupportSafe = { escape: escape, url: url, role: role, images: images, showImage: showImage, shipments: shipments };
})();
