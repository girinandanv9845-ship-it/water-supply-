/* AquaFlow - driver app */
(function () {
  'use strict';

  var API = window.AquaAPI;
  var esc = UI.esc;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    profile: null,
    scope: 'active',
    socket: null,
    watchId: null,
    sharing: false,
    lastSentAt: 0,
    lastPos: null,
    jobs: [],
  };

  // Client-side GPS throttle. The server enforces its own minimum as well, so a
  // buggy or hostile client cannot flood the tracking channel.
  var SEND_INTERVAL_MS = 5000;
  var MIN_MOVE_METERS = 15;

  if (window.AquaScene) window.AquaScene.init({ preset: 'driver' });
  document.body.classList.add('scene-immersive');

  /* =========================== LOGIN =========================== */

  var pendingPhone = null;

  $('dPhoneForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('dSendOtp');
    var err = $('dPhoneError');
    err.classList.add('hidden');
    UI.busy(btn, true, 'Sending');

    API.requestOtp($('dPhoneInput').value.trim())
      .then(function (data) {
        pendingPhone = data.phone;
        if (data.isNewUser) {
          throw new Error('That number is not registered as a driver. Ask your operations team to add you.');
        }
        $('dStepPhone').classList.add('hidden');
        $('dStepOtp').classList.remove('hidden');
        $('dOtpInput').focus();
        if (data.demoCode) {
          $('dDemoCode').innerHTML = '<div><strong>Demo mode.</strong> Code: <strong style="font-size:1.1rem">' + esc(data.demoCode) + '</strong></div>';
          $('dDemoCode').classList.remove('hidden');
        }
      })
      .catch(function (e2) { err.textContent = e2.message; err.classList.remove('hidden'); })
      .finally(function () { UI.busy(btn, false); });
  });

  $('dBack').addEventListener('click', function () {
    $('dStepOtp').classList.add('hidden');
    $('dStepPhone').classList.remove('hidden');
  });

  $('dOtpForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('dVerify');
    var err = $('dOtpError');
    err.classList.add('hidden');
    UI.busy(btn, true, 'Verifying');

    API.verifyOtp({ phone: pendingPhone, code: $('dOtpInput').value.trim() })
      .then(function (data) {
        if (data.user.role !== 'DRIVER') {
          API.clearSession();
          throw new Error('This sign-in is for drivers. Use the customer app instead.');
        }
        boot();
      })
      .catch(function (e2) { err.textContent = e2.message; err.classList.remove('hidden'); })
      .finally(function () { UI.busy(btn, false); });
  });

  $('dLogout').addEventListener('click', function () {
    stopSharing();
    API.logout().then(function () { window.location.reload(); });
  });
  window.addEventListener('aquaflow:signed-out', function () {
    setTimeout(function () { window.location.reload(); }, 800);
  });

  /* =========================== DUTY =========================== */

  $('dutyToggle').addEventListener('click', function (ev) {
    var btn = ev.currentTarget;
    var goingOnline = state.profile.status === 'OFFLINE';
    UI.busy(btn, true);
    API.driver.availability(goingOnline)
      .then(function (r) {
        state.profile.status = r.status;
        renderDuty();
        UI.toast(goingOnline ? 'You are online' : 'You are offline', 'success');
        if (goingOnline && !state.sharing) startSharing();
      })
      .catch(function (e) { UI.toast(e.message, 'error'); })
      .finally(function () { UI.busy(btn, false); });
  });

  function renderDuty() {
    var s = state.profile.status;
    var labels = {
      OFFLINE: 'Offline - you will not receive new deliveries',
      AVAILABLE: 'Online - ready for deliveries',
      ON_DELIVERY: 'On delivery',
      SUSPENDED: 'Suspended - contact your operations team',
    };
    $('dutyText').textContent = labels[s] || s;
    var btn = $('dutyToggle');
    btn.textContent = s === 'OFFLINE' ? 'Go online' : 'Go offline';
    btn.className = 'btn btn-sm ' + (s === 'OFFLINE' ? 'btn-primary' : 'btn-ghost');
    btn.disabled = s === 'SUSPENDED';
  }

  /* =========================== GPS =========================== */

  $('gpsToggle').addEventListener('click', function () {
    if (state.sharing) stopSharing(); else startSharing();
  });

  function metersBetween(a, b) {
    var R = 6371000, toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(b.latitude - a.latitude), dLng = toRad(b.longitude - a.longitude);
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }

  function gpsAlert(message, tone) {
    var el = $('gpsAlert');
    if (!message) { el.classList.add('hidden'); return; }
    el.className = 'alert alert-' + (tone || 'warn') + ' mt-2';
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function startSharing() {
    if (!navigator.geolocation) {
      gpsAlert('This browser does not support location sharing. Customers will not see your position.');
      return;
    }

    gpsAlert('Requesting location permission...', 'info');

    state.watchId = navigator.geolocation.watchPosition(
      function (pos) {
        var current = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          heading: pos.coords.heading,
        };

        // Throttle by time AND by movement: a parked tanker should not stream.
        var now = Date.now();
        var movedEnough = !state.lastPos || metersBetween(state.lastPos, current) >= MIN_MOVE_METERS;
        var dueAnyway = now - state.lastSentAt > 30000;
        if (now - state.lastSentAt < SEND_INTERVAL_MS) return;
        if (!movedEnough && !dueAnyway) return;

        state.lastSentAt = now;
        state.lastPos = current;

        if (state.socket && state.socket.connected) {
          state.socket.emit('driver:location', current, function () {});
        } else {
          // HTTP fallback keeps tracking alive when the socket is down.
          API.driver.location(current.latitude, current.longitude, current.heading).catch(function () {});
        }

        gpsAlert('Sharing live location. Accuracy about ' + Math.round(pos.coords.accuracy) + ' m.', 'success');
      },
      function (err) {
        state.sharing = false;
        renderGps();
        var messages = {
          1: 'Location permission denied. Enable it in your browser settings so customers can track the tanker.',
          2: 'Location is unavailable. Check that GPS is on and you have signal.',
          3: 'Location request timed out. Move to an open area and try again.',
        };
        gpsAlert(messages[err.code] || 'Could not access your location.');
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 }
    );

    state.sharing = true;
    renderGps();
  }

  function stopSharing() {
    if (state.watchId !== null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    state.sharing = false;
    state.lastPos = null;
    renderGps();
    gpsAlert('');
  }

  function renderGps() {
    $('gpsText').textContent = state.sharing
      ? 'On - customers can see your tanker live'
      : 'Off - customers cannot see your tanker';
    var btn = $('gpsToggle');
    btn.textContent = state.sharing ? 'Turn off' : 'Turn on';
    btn.className = 'btn btn-sm ' + (state.sharing ? 'btn-ghost' : 'btn-primary');
  }

  /* =========================== JOBS =========================== */

  Array.prototype.forEach.call(document.querySelectorAll('[data-scope]'), function (b) {
    b.addEventListener('click', function () {
      state.scope = b.dataset.scope;
      Array.prototype.forEach.call(document.querySelectorAll('[data-scope]'), function (x) {
        var on = x === b;
        x.classList.toggle('active', on);
        x.style.background = on ? 'var(--aqua-100)' : 'var(--surface-2)';
        x.style.color = on ? 'var(--aqua-800)' : 'var(--ink-3)';
      });
      loadJobs();
    });
  });

  // Which buttons a driver sees for each status.
  var ACTIONS = {
    DRIVER_ASSIGNED: [
      { to: 'DRIVER_ACCEPTED', label: 'Accept job', cls: 'btn-success' },
      { to: 'CONFIRMED', label: 'Reject', cls: 'btn-ghost', confirm: 'Reject this delivery? It goes back to dispatch.' },
    ],
    DRIVER_ACCEPTED: [{ to: 'OUT_FOR_DELIVERY', label: 'Start delivery', cls: 'btn-primary' }],
    OUT_FOR_DELIVERY: [
      { to: 'ARRIVING', label: 'Arriving', cls: 'btn-primary' },
      { to: 'DELIVERED', label: 'Mark delivered', cls: 'btn-success', confirm: 'Confirm the water has been delivered?' },
    ],
    ARRIVING: [
      { to: 'DELIVERED', label: 'Mark delivered', cls: 'btn-success', confirm: 'Confirm the water has been delivered?' },
      { to: 'FAILED', label: 'Could not deliver', cls: 'btn-ghost', confirm: 'Mark this delivery as failed?' },
    ],
  };

  function loadJobs() {
    var el = $('jobList');
    UI.skeleton(el, 2);

    API.driver.orders(state.scope)
      .then(function (jobs) {
        state.jobs = jobs;
        if (!jobs.length) {
          UI.empty(el, '',
            state.scope === 'history' ? 'No past deliveries' : 'No deliveries assigned',
            state.scope === 'history' ? 'Completed jobs will appear here.' : 'Go online and dispatch will assign you a job.');
          return;
        }

        el.classList.add('stagger');
        el.innerHTML = jobs.map(function (o) {
          var actions = (ACTIONS[o.status] || []).map(function (a) {
            return '<button class="btn ' + a.cls + ' btn-sm" data-act="' + esc(o.id) + '" data-to="' + a.to +
              '" data-confirm="' + esc(a.confirm || '') + '">' + esc(a.label) + '</button>';
          }).join('');

          // Before pickup, navigate to the station; after, to the customer.
          var beforePickup = o.status === 'DRIVER_ASSIGNED' || o.status === 'DRIVER_ACCEPTED';
          var navTarget = beforePickup && o.station
            ? { lat: o.station.latitude, lng: o.station.longitude, label: 'Navigate to ' + o.station.name }
            : { lat: o.latitude, lng: o.longitude, label: 'Navigate to customer' };
          // Route via the station so the driver gets the full leg once loaded.
          var origin = !beforePickup && o.station
            ? '&origin=' + o.station.latitude + ',' + o.station.longitude
            : '';
          var navUrl = 'https://www.google.com/maps/dir/?api=1' + origin +
            '&destination=' + navTarget.lat + ',' + navTarget.lng + '&travelmode=driving';

          return '<div class="card job mb-1' + (o.status === 'DRIVER_ASSIGNED' ? ' urgent' : '') + '">' +
            '<div class="row-between mb-1"><span class="small strong">' + esc(o.orderNumber) + '</span>' +
            UI.statusBadge(o.status, o.statusLabel) + '</div>' +

            '<div class="strong">' + esc(o.loadType) + ' &middot; ' + UI.litres(o.quantityL) + '</div>' +

            // The leg this job covers: fill here, deliver there.
            (o.station
              ? '<div class="leg mb-1"><div class="leg-row"><span class="leg-dot station"></span>' +
                '<span><span class="tiny muted">Fill at</span><br><span class="small strong">' +
                esc(o.station.name) + '</span></span></div>' +
                '<div class="leg-line"></div>' +
                '<div class="leg-row"><span class="leg-dot dest"></span>' +
                '<span><span class="tiny muted">Deliver to' +
                (o.routeKm ? ' &middot; ' + o.routeKm + ' km' : '') + '</span><br><span class="small strong">' +
                esc(o.deliveryAddressText) + '</span></span></div></div>'
              : '<div class="small muted mb-1">' + esc(o.deliveryAddressText) + '</div>') +

            '<div class="card-flat mb-1" style="padding:9px">' +
            '<div class="row-between small"><span class="muted">Customer</span><span class="strong">' +
            esc(o.customer ? o.customer.name : '-') + '</span></div>' +
            (o.customer && o.customer.phone
              ? '<div class="row-between small mt-1"><span class="muted">Phone</span>' +
                '<a class="strong" href="tel:' + esc(o.customer.phone) + '">' + esc(o.customer.phone) + '</a></div>'
              : '') +
            '<div class="row-between small mt-1"><span class="muted">Amount</span><span class="strong">' +
            UI.rupees(o.totalRupees) + ' (' + (o.paymentMethod === 'CASH_ON_DELIVERY'
              ? 'COLLECT CASH' : (o.paymentStatus === 'PAID' ? 'already paid' : 'unpaid')) + ')</span></div>' +
            (o.vehicle ? '<div class="row-between small mt-1"><span class="muted">Tanker</span><span class="strong">' +
              esc(o.vehicle.registrationNumber) + '</span></div>' : '') +
            (o.notes ? '<div class="small mt-1"><span class="muted">Note:</span> ' + esc(o.notes) + '</div>' : '') +
            '</div>' +

            (o.isTerminal ? '' :
              '<a class="btn btn-dark btn-block btn-sm mb-1" href="' + navUrl + '" target="_blank" rel="noopener">' +
              esc(navTarget.label) + '</a>' +
              '<div class="job-actions">' + actions + '</div>') +
            '</div>';
        }).join('');

        Array.prototype.forEach.call(el.querySelectorAll('[data-act]'), function (b) {
          b.addEventListener('click', function () {
            var run = function () {
              UI.busy(b, true);
              API.driver.setStatus(b.dataset.act, b.dataset.to)
                .then(function () { UI.toast('Updated', 'success'); loadJobs(); })
                .catch(function (e) { UI.toast(e.message, 'error'); })
                .finally(function () { UI.busy(b, false); });
            };
            if (b.dataset.confirm) {
              UI.confirm(b.dataset.confirm, { danger: b.dataset.to === 'FAILED' || b.dataset.to === 'CONFIRMED' })
                .then(function (yes) { if (yes) run(); });
            } else { run(); }
          });
        });
      })
      .catch(function (e) { UI.errorState(el, e.message, loadJobs); });
  }

  /* =========================== BOOT =========================== */

  function boot() {
    $('loginView').classList.add('hidden');
    $('driverView').classList.remove('hidden');
    document.body.classList.remove('scene-immersive');
    UI.watchConnectivity();

    API.config().then(function (cfg) {
      if (cfg.demoMode) $('dDemoBanner').classList.remove('hidden');
    }).catch(function () {});

    state.socket = UI.connectSocket({
      'driver:new-assignment': function (o) {
        UI.toast('New delivery assigned: ' + o.orderNumber, 'success');
        loadJobs();
      },
      'driver:order-update': function () { loadJobs(); },
    });

    return API.driver.me()
      .then(function (profile) {
        state.profile = profile;
        $('dName').textContent = profile.user.name;
        renderDuty();
        renderGps();
        loadJobs();
      })
      .catch(function (e) {
        UI.toast(e.message, 'error');
        if (e.status === 403) {
          setTimeout(function () { API.clearSession(); window.location.reload(); }, 2500);
        }
      });
  }

  if (API.isSignedIn()) {
    API.me()
      .then(function (data) {
        if (data.user.role !== 'DRIVER') {
          UI.toast('This app is for drivers.', 'error');
          setTimeout(function () { window.location.href = data.user.role === 'ADMIN' ? '/admin' : '/'; }, 1200);
          return;
        }
        boot();
      })
      .catch(function () { API.clearSession(); });
  }
})();
