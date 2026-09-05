/* Shared UI helpers: toasts, sheets, formatting, loading states, sockets. */
(function (global) {
  'use strict';

  /* ---------------- escaping ---------------- */

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- toasts ---------------- */

  function toastHost() {
    var host = document.querySelector('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }

  function toast(message, type, ms) {
    var host = toastHost();
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .2s';
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, ms || (type === 'error' ? 5000 : 3200));
  }

  /* ---------------- formatting ---------------- */

  function rupees(amount) {
    var n = Number(amount || 0);
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency', currency: 'INR', maximumFractionDigits: n % 1 === 0 ? 0 : 2,
      }).format(n);
    } catch (e) {
      return 'Rs ' + n.toFixed(0);
    }
  }

  function litres(l) {
    return Number(l || 0).toLocaleString('en-IN') + ' L';
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 45) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
    if (diff < 604800) return Math.floor(diff / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  function dateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  }

  var STATUS_TONE = {
    PENDING: 'warn', PAYMENT_FAILED: 'danger', CONFIRMED: 'info',
    DRIVER_ASSIGNED: 'info', DRIVER_ACCEPTED: 'info',
    OUT_FOR_DELIVERY: 'info', ARRIVING: 'warn',
    DELIVERED: 'success', CANCELLED: 'muted', FAILED: 'danger',
  };

  function statusBadge(status, label) {
    return '<span class="badge badge-' + (STATUS_TONE[status] || 'muted') + '">' + esc(label || status) + '</span>';
  }

  /* ---------------- loading / empty states ---------------- */

  function skeleton(container, count, kind) {
    if (!container) return;
    var html = '';
    for (var i = 0; i < (count || 3); i++) {
      html += '<div class="skeleton ' + (kind === 'line' ? 'skel-line' : 'skel-card') + '"></div>';
    }
    container.innerHTML = html;
  }

  function empty(container, icon, title, body, actionHtml) {
    if (!container) return;
    container.innerHTML =
      '<div class="empty">' +
      '<div class="empty-icon">' + esc(icon || '') + '</div>' +
      '<h3>' + esc(title) + '</h3>' +
      (body ? '<p class="small">' + esc(body) + '</p>' : '') +
      (actionHtml || '') +
      '</div>';
  }

  function errorState(container, message, retryFn) {
    if (!container) return;
    container.innerHTML =
      '<div class="empty">' +
      '<div class="empty-icon">!</div>' +
      '<h3>Something went wrong</h3>' +
      '<p class="small">' + esc(message) + '</p>' +
      (retryFn ? '<button class="btn btn-ghost btn-sm" data-retry>Try again</button>' : '') +
      '</div>';
    if (retryFn) {
      var btn = container.querySelector('[data-retry]');
      if (btn) btn.addEventListener('click', retryFn);
    }
  }

  /** Puts a button into a spinner state and restores it afterwards. */
  function busy(button, isBusy, busyLabel) {
    if (!button) return;
    if (isBusy) {
      if (!button.dataset.label) button.dataset.label = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<span class="btn-spinner"></span>' + (busyLabel ? ' ' + esc(busyLabel) : '');
    } else {
      button.disabled = false;
      if (button.dataset.label) button.innerHTML = button.dataset.label;
    }
  }

  /* ---------------- sheets / modals ---------------- */

  function sheet(html, options) {
    options = options || {};
    var overlay = document.createElement('div');
    overlay.className = 'overlay' + (options.center ? ' modal-center' : '');
    overlay.innerHTML =
      '<div class="sheet" role="dialog" aria-modal="true">' +
      (options.center ? '' : '<div class="sheet-grip"></div>') + html + '</div>';

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      if (options.onClose) options.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    var first = overlay.querySelector('input, select, textarea, button');
    if (first && !options.noAutoFocus) setTimeout(function () { first.focus(); }, 60);

    return { el: overlay, root: overlay.querySelector('.sheet'), close: close };
  }

  function confirm(message, options) {
    options = options || {};
    return new Promise(function (resolve) {
      var s = sheet(
        '<h3>' + esc(options.title || 'Are you sure?') + '</h3>' +
        '<p class="small muted">' + esc(message) + '</p>' +
        '<div class="row mt-2" style="gap:8px">' +
        '<button class="btn btn-ghost grow" data-no>' + esc(options.cancelText || 'Cancel') + '</button>' +
        '<button class="btn ' + (options.danger ? 'btn-danger' : 'btn-primary') + ' grow" data-yes>' +
        esc(options.confirmText || 'Confirm') + '</button></div>',
        { center: true, onClose: function () { resolve(false); } }
      );
      s.root.querySelector('[data-no]').addEventListener('click', function () { s.close(); });
      s.root.querySelector('[data-yes]').addEventListener('click', function () {
        s.el.dataset.resolved = '1';
        if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
        document.body.style.overflow = '';
        resolve(true);
      });
    });
  }

  /* ---------------- connectivity ---------------- */

  function watchConnectivity() {
    var bar = document.createElement('div');
    bar.className = 'offline-bar hidden';
    bar.textContent = 'You are offline. Some actions will not work.';
    document.body.appendChild(bar);
    function update() { bar.classList.toggle('hidden', navigator.onLine); }
    global.addEventListener('online', update);
    global.addEventListener('offline', update);
    update();
  }

  /* ---------------- socket ---------------- */

  /**
   * Connects Socket.IO with the auth token. Returns null when the library did
   * not load, so callers fall back to polling instead of throwing.
   */
  function connectSocket(handlers) {
    if (typeof global.io !== 'function') return null;
    var token = global.AquaAPI && global.AquaAPI.getToken();
    if (!token) return null;

    var socket = global.io({
      auth: { token: token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 12,
      reconnectionDelay: 1200,
      reconnectionDelayMax: 8000,
    });

    socket.on('connect_error', function (err) {
      // Surface only the auth case; transient network errors self-heal.
      if (err && err.message === 'UNAUTHORIZED') {
        console.warn('Live updates unavailable: session expired.');
      }
    });

    Object.keys(handlers || {}).forEach(function (event) {
      socket.on(event, handlers[event]);
    });
    return socket;
  }

  /* ---------------- motion helpers ---------------- */

  var prefersReduced =
    global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /**
   * Reveals elements as they scroll into view. Elements are marked with
   * .reveal; the observer adds .in exactly once, then stops watching them.
   */
  var revealObserver = null;
  function observeReveals(root) {
    if (prefersReduced || typeof IntersectionObserver === 'undefined') {
      // Without motion, make sure nothing stays invisible.
      (root || document).querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
      return;
    }
    if (!revealObserver) {
      revealObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) {
              e.target.classList.add('in');
              revealObserver.unobserve(e.target);
            }
          });
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.06 }
      );
    }
    (root || document).querySelectorAll('.reveal:not(.in)').forEach(function (el) {
      revealObserver.observe(el);
    });
  }

  /** Counts a number up to its final value. Used for dashboard stats. */
  function countUp(el, to, format, ms) {
    if (!el) return;
    if (prefersReduced) { el.textContent = format ? format(to) : String(to); return; }
    var from = 0;
    var dur = ms || 900;
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      // easeOutExpo
      var eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      var v = from + (to - from) * eased;
      el.textContent = format ? format(v) : String(Math.round(v));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  global.UI = {
    esc: esc,
    observeReveals: observeReveals,
    countUp: countUp,
    prefersReducedMotion: prefersReduced,
    toast: toast,
    rupees: rupees,
    litres: litres,
    timeAgo: timeAgo,
    dateTime: dateTime,
    statusBadge: statusBadge,
    skeleton: skeleton,
    empty: empty,
    errorState: errorState,
    busy: busy,
    sheet: sheet,
    confirm: confirm,
    watchConnectivity: watchConnectivity,
    connectSocket: connectSocket,
  };
})(window);
