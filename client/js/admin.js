/* AquaFlow - admin operations console */
(function () {
  'use strict';

  var API = window.AquaAPI;
  var esc = UI.esc;
  var $ = function (id) { return document.getElementById(id); };

  var state = { view: 'dashboard', socket: null, drivers: [], vehicles: [], config: null, liveMap: null, markers: {} };

  // Calmer backdrop here than on the customer app - dense tables come first.
  if (window.AquaScene) window.AquaScene.init({ preset: 'admin' });
  document.body.classList.add('scene-immersive');

  /* =========================== LOGIN =========================== */

  $('adminLoginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('adminLoginBtn');
    var err = $('loginError');
    err.classList.add('hidden');
    UI.busy(btn, true, 'Signing in');

    API.adminLogin($('adminPhone').value.trim(), $('adminPassword').value)
      .then(function () { boot(); })
      .catch(function (e2) { err.textContent = e2.message; err.classList.remove('hidden'); })
      .finally(function () { UI.busy(btn, false); });
  });

  $('adminLogout').addEventListener('click', function () {
    API.logout().then(function () { window.location.reload(); });
  });
  window.addEventListener('aquaflow:signed-out', function () {
    setTimeout(function () { window.location.reload(); }, 800);
  });

  /* =========================== NAV =========================== */

  Array.prototype.forEach.call(document.querySelectorAll('.dash-tab'), function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.dash-tab'), function (t) {
        t.classList.toggle('active', t === tab);
      });
      state.view = tab.dataset.view;
      render();
    });
  });

  function host() { return $('viewHost'); }

  function render() {
    var views = {
      dashboard: viewDashboard, orders: viewOrders, live: viewLive, drivers: viewDrivers,
      vehicles: viewVehicles, products: viewProducts, customers: viewCustomers,
      payments: viewPayments, areas: viewAreas, stations: viewStations,
      settings: viewSettings, support: viewSupport,
    };
    (views[state.view] || viewDashboard)();
  }

  function section(title, actionHtml, body) {
    return '<div class="row-between mb-2"><h1 class="mb-0">' + esc(title) + '</h1>' + (actionHtml || '') + '</div>' + body;
  }

  /* =========================== DASHBOARD =========================== */

  function viewDashboard() {
    host().innerHTML = '<div class="stat-grid">' +
      new Array(8).join('x').split('x').map(function () { return '<div class="skeleton skel-card"></div>'; }).join('') + '</div>';

    API.admin.stats()
      .then(function (s) {
        var maxOrders = Math.max.apply(null, s.series.map(function (d) { return d.orders; }).concat([1]));
        var bars = s.series.map(function (d) {
          // Cap at 76% so the count above and the date below always fit.
          var h = (d.orders / maxOrders) * 76;
          return '<div class="bar-col" title="' + esc(d.date) + ': ' + d.orders + ' orders">' +
            '<div class="tiny strong">' + d.orders + '</div>' +
            '<div class="bar" style="height:' + (d.orders ? Math.max(h, 4) : 0) + '%"></div>' +
            '<div class="bar-label">' + esc(d.date.slice(5)) + '</div></div>';
        }).join('');

        var statusRows = s.byStatus.map(function (b) {
          return '<div class="row-between small" style="padding:5px 0;border-bottom:1px solid var(--line)">' +
            UI.statusBadge(b.status, b.status.replace(/_/g, ' ')) + '<span class="strong">' + b.count + '</span></div>';
        }).join('') || '<p class="small muted">No orders yet.</p>';

        host().innerHTML = section('Dashboard', '<span class="small muted">Updated ' + new Date().toLocaleTimeString('en-IN') + '</span>',
          '<div class="stat-grid mb-2">' +
          stat('Total orders', s.totalOrders, 'all time') +
          stat("Today's orders", s.todayOrders, 'since midnight') +
          stat('Pending', s.pendingOrders, 'awaiting confirmation') +
          stat('Active deliveries', s.activeDeliveries, 'in progress') +
          stat('Completed', s.completedOrders, 'delivered') +
          stat('Revenue', UI.rupees(s.revenueRupees), 'collected', true) +
          stat("Today's revenue", UI.rupees(s.todayRevenueRupees), 'since midnight') +
          stat('Active drivers', s.activeDrivers + ' / ' + s.totalDrivers, 'online now') +
          stat('Available tankers', s.availableVehicles + ' / ' + s.totalVehicles, 'active fleet') +
          stat('Customers', s.totalCustomers, 'registered') +
          '</div>' +
          '<div class="split">' +
          '<div class="card reveal"><h3>Orders - last 7 days</h3><div class="bars">' + bars + '</div></div>' +
          '<div class="card reveal"><h3>Orders by status</h3>' + statusRows + '</div></div>');

        animateStats();
        UI.observeReveals(host());
      })
      .catch(function (e) { UI.errorState(host(), e.message, viewDashboard); });
  }

  /**
   * Stat tiles carry their target in data-count so the value can animate up
   * from zero without the markup and the animation disagreeing.
   */
  function animateStats() {
    Array.prototype.forEach.call(host().querySelectorAll('.stat .v[data-count]'), function (el) {
      var target = Number(el.dataset.count);
      var money = el.dataset.money === '1';
      UI.countUp(el, target, function (v) {
        return money ? UI.rupees(Math.round(v)) : String(Math.round(v));
      });
    });
  }

  function stat(k, v, d, accent) {
    // Numeric tiles animate; text tiles (like "3 / 5") render as-is.
    var numeric = typeof v === 'number';
    var money = typeof v === 'string' && /^[^\d]*[\d,.]+$/.test(v) && v.indexOf('₹') === 0;
    var attrs = '';
    var shown = esc(String(v));
    if (numeric) { attrs = ' data-count="' + v + '"'; shown = '0'; }
    else if (money) {
      var n = Number(String(v).replace(/[^\d.]/g, ''));
      if (isFinite(n)) { attrs = ' data-count="' + n + '" data-money="1"'; shown = UI.rupees(0); }
    }
    return '<div class="stat' + (accent ? ' accent' : '') + '"><div class="k">' + esc(k) + '</div>' +
      '<div class="v"' + attrs + '>' + shown + '</div><div class="d">' + esc(d) + '</div></div>';
  }

  /* =========================== ORDERS =========================== */

  var orderFilter = { status: '', search: '', page: 1 };

  function viewOrders() {
    host().innerHTML = section('Orders',
      '<div class="row"><input class="input" id="orderSearch" placeholder="Search order, name, phone" style="width:230px" value="' + esc(orderFilter.search) + '">' +
      '<select class="select" id="orderStatusFilter" style="width:180px"></select></div>',
      '<div id="ordersTable"><div class="skeleton skel-card"></div></div>');

    var statuses = ['', 'PENDING', 'PAYMENT_FAILED', 'CONFIRMED', 'DRIVER_ASSIGNED', 'DRIVER_ACCEPTED',
      'OUT_FOR_DELIVERY', 'ARRIVING', 'DELIVERED', 'CANCELLED', 'FAILED'];
    $('orderStatusFilter').innerHTML = statuses.map(function (s) {
      return '<option value="' + s + '"' + (s === orderFilter.status ? ' selected' : '') + '>' +
        (s ? s.replace(/_/g, ' ') : 'All statuses') + '</option>';
    }).join('');

    $('orderStatusFilter').addEventListener('change', function (e) {
      orderFilter.status = e.target.value; orderFilter.page = 1; loadOrdersTable();
    });
    var searchTimer;
    $('orderSearch').addEventListener('input', function (e) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        orderFilter.search = e.target.value.trim(); orderFilter.page = 1; loadOrdersTable();
      }, 350);
    });

    Promise.all([API.admin.drivers(), API.admin.vehicles()])
      .then(function (r) { state.drivers = r[0]; state.vehicles = r[1]; })
      .catch(function () {})
      .then(loadOrdersTable);
  }

  function loadOrdersTable() {
    var q = '?page=' + orderFilter.page + '&limit=25' +
      (orderFilter.status ? '&status=' + orderFilter.status : '') +
      (orderFilter.search ? '&search=' + encodeURIComponent(orderFilter.search) : '');

    API.admin.orders(q)
      .then(function (res) {
        var el = $('ordersTable');
        if (!res.data.length) { UI.empty(el, '', 'No orders match', 'Try a different filter.'); return; }

        el.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>Order</th><th>Customer</th><th>Load</th><th>Amount</th><th>Payment</th>' +
          '<th>Status</th><th>Driver</th><th>Placed</th><th>Actions</th></tr></thead><tbody>' +
          res.data.map(function (o) {
            return '<tr><td class="strong">' + esc(o.orderNumber) + '</td>' +
              '<td>' + esc(o.customer ? o.customer.name : '-') + '<div class="tiny muted">' +
              esc(o.customer ? o.customer.phone : '') + '</div></td>' +
              '<td>' + esc(o.loadType) + '<div class="tiny muted">' + UI.litres(o.quantityL) + '</div></td>' +
              '<td class="strong">' + UI.rupees(o.totalRupees) + '</td>' +
              '<td>' + paymentBadge(o) + '</td>' +
              '<td>' + UI.statusBadge(o.status, o.statusLabel) + '</td>' +
              '<td>' + (o.driver ? esc(o.driver.name) : '<span class="muted">-</span>') + '</td>' +
              '<td class="tiny muted">' + UI.timeAgo(o.createdAt) + '</td>' +
              '<td><button class="btn btn-ghost btn-xs" data-manage="' + esc(o.id) + '">Manage</button></td></tr>';
          }).join('') + '</tbody></table></div>' +
          pager(res.meta, 'ordersPager');

        Array.prototype.forEach.call(el.querySelectorAll('[data-manage]'), function (b) {
          b.addEventListener('click', function () { openOrderSheet(b.dataset.manage); });
        });
        bindPager(el, function (p) { orderFilter.page = p; loadOrdersTable(); });
      })
      .catch(function (e) { UI.errorState($('ordersTable'), e.message, loadOrdersTable); });
  }

  function paymentBadge(o) {
    if (o.paymentMethod === 'CASH_ON_DELIVERY') return '<span class="badge badge-muted">Cash</span>';
    if (o.paymentStatus === 'PAID') return '<span class="badge badge-success">Paid' + (o.isDemoPayment ? ' (demo)' : '') + '</span>';
    if (o.paymentStatus === 'FAILED') return '<span class="badge badge-danger">Failed</span>';
    return '<span class="badge badge-warn">Unpaid</span>';
  }

  function pager(meta, id) {
    if (!meta || meta.pages <= 1) return '';
    return '<div class="row-between mt-1" id="' + id + '">' +
      '<button class="btn btn-ghost btn-sm" data-page="' + (meta.page - 1) + '"' + (meta.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<span class="small muted">Page ' + meta.page + ' of ' + meta.pages + ' (' + meta.total + ' total)</span>' +
      '<button class="btn btn-ghost btn-sm" data-page="' + (meta.page + 1) + '"' + (meta.page >= meta.pages ? ' disabled' : '') + '>Next</button></div>';
  }

  function bindPager(root, onPage) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-page]'), function (b) {
      b.addEventListener('click', function () { onPage(Number(b.dataset.page)); });
    });
  }

  function openOrderSheet(orderId) {
    API.get('/api/admin/orders/' + orderId).then(function (o) {
      var driverOptions = state.drivers
        .filter(function (d) { return d.isVerified && d.status !== 'SUSPENDED'; })
        .map(function (d) {
          return '<option value="' + esc(d.id) + '"' + (o.driver && o.driver.id === d.id ? ' selected' : '') + '>' +
            esc(d.user.name) + ' (' + esc(d.status) + ')</option>';
        }).join('');

      var vehicleOptions = '<option value="">No tanker</option>' + state.vehicles
        .filter(function (v) { return v.status === 'ACTIVE'; })
        .map(function (v) {
          return '<option value="' + esc(v.id) + '"' + (o.vehicle && o.vehicle.id === v.id ? ' selected' : '') + '>' +
            esc(v.registrationNumber) + ' - ' + UI.litres(v.capacityL) + '</option>';
        }).join('');

      var nextStatuses = (o.nextActions && o.nextActions.ADMIN) || [];

      var timeline = o.timeline.map(function (t) {
        return '<div class="tl-step done"><div class="tl-rail"><div class="tl-dot"></div><div class="tl-line"></div></div>' +
          '<div class="tl-body"><div class="tl-title">' + esc(t.label) + '</div>' +
          '<div class="tiny muted">' + UI.dateTime(t.at) + (t.note ? ' - ' + esc(t.note) : '') + '</div></div></div>';
      }).join('');

      var s = UI.sheet(
        '<div class="row-between mb-1"><h2 class="mb-0">' + esc(o.orderNumber) + '</h2>' +
        UI.statusBadge(o.status, o.statusLabel) + '</div>' +
        '<div class="card mb-2">' +
        kv('Customer', (o.customer ? o.customer.name + ' - ' + o.customer.phone : '-')) +
        kv('Load', o.loadType + ' (' + UI.litres(o.quantityL) + ', qty ' + o.quantity + ')') +
        kv('Amount', UI.rupees(o.totalRupees) + ' - ' + (o.paymentMethod === 'CASH_ON_DELIVERY' ? 'cash on delivery' : o.paymentStatus)) +
        kv('Address', o.deliveryAddressText) +
        kv('Coordinates', o.latitude.toFixed(5) + ', ' + o.longitude.toFixed(5)) +
        (o.notes ? kv('Notes', o.notes) : '') +
        (o.etaMinutes ? kv('ETA', '~' + o.etaMinutes + ' min (' + o.distanceKm + ' km)') : '') +
        '</div>' +

        (o.isTerminal ? '' :
          '<div class="card mb-2"><h3>Assign tanker</h3>' +
          (driverOptions
            ? '<div class="field"><label class="label">Driver</label><select class="select" id="assignDriver">' + driverOptions + '</select></div>' +
              '<div class="field mt-1"><label class="label">Tanker</label><select class="select" id="assignVehicle">' + vehicleOptions + '</select></div>' +
              '<button class="btn btn-primary btn-block mt-2" id="assignBtn">Assign</button>'
            : '<p class="small muted">No verified drivers available. Add one in the Drivers tab.</p>') +
          '</div>') +

        (nextStatuses.length
          ? '<div class="card mb-2"><h3>Change status</h3>' +
            '<div class="field"><select class="select" id="statusSelect">' +
            nextStatuses.map(function (st) { return '<option value="' + st + '">' + st.replace(/_/g, ' ') + '</option>'; }).join('') +
            '</select></div><div class="field mt-1"><input class="input" id="statusNote" placeholder="Reason / note (optional)" maxlength="300"></div>' +
            '<button class="btn btn-dark btn-block mt-1" id="statusBtn">Apply</button>' +
            '<p class="tiny muted mt-1 mb-0">Only transitions valid for the current state are listed. The server re-checks every change.</p></div>'
          : '<div class="alert alert-info mb-2">This order is ' + esc(o.status) + ' and can no longer change.</div>') +

        '<div class="card"><h3>History</h3><div class="timeline">' + timeline + '</div></div>'
      );

      var assignBtn = s.root.querySelector('#assignBtn');
      if (assignBtn) {
        assignBtn.addEventListener('click', function () {
          UI.busy(assignBtn, true, 'Assigning');
          API.admin.assignDriver(o.id, s.root.querySelector('#assignDriver').value, s.root.querySelector('#assignVehicle').value || undefined)
            .then(function () { UI.toast('Driver assigned', 'success'); s.close(); loadOrdersTable(); })
            .catch(function (e) { UI.toast(e.message, 'error'); })
            .finally(function () { UI.busy(assignBtn, false); });
        });
      }

      var statusBtn = s.root.querySelector('#statusBtn');
      if (statusBtn) {
        statusBtn.addEventListener('click', function () {
          UI.busy(statusBtn, true, 'Updating');
          API.admin.setOrderStatus(o.id, s.root.querySelector('#statusSelect').value, s.root.querySelector('#statusNote').value.trim())
            .then(function () { UI.toast('Status updated', 'success'); s.close(); loadOrdersTable(); })
            .catch(function (e) { UI.toast(e.message, 'error'); })
            .finally(function () { UI.busy(statusBtn, false); });
        });
      }
    }).catch(function (e) { UI.toast(e.message, 'error'); });
  }

  function kv(k, v) {
    return '<div class="row-between small" style="padding:4px 0"><span class="muted">' + esc(k) +
      '</span><span class="strong" style="text-align:right;max-width:62%">' + esc(v) + '</span></div>';
  }

  /* =========================== LIVE MAP =========================== */

  function viewLive() {
    host().innerHTML = section('Live deliveries', '', '<div class="split">' +
      '<div class="card"><div class="map map-lg" id="adminMap"></div></div>' +
      '<div><div class="card mb-2"><h3>Drivers online</h3><div id="liveDrivers"></div></div>' +
      '<div class="card"><h3>Active orders</h3><div id="liveOrders"></div></div></div></div>');

    function load() {
      return API.admin.live().then(function (data) {
        $('liveDrivers').innerHTML = data.drivers.length
          ? data.drivers.map(function (d) {
              return '<div class="row-between small" style="padding:6px 0;border-bottom:1px solid var(--line)">' +
                '<div><div class="strong">' + esc(d.name) + '</div><div class="tiny muted">' +
                (d.lastLocationAt ? 'GPS ' + UI.timeAgo(d.lastLocationAt) : 'no GPS yet') + '</div></div>' +
                '<span class="badge badge-' + (d.status === 'ON_DELIVERY' ? 'info' : 'success') + '">' +
                esc(d.status.replace(/_/g, ' ')) + '</span></div>';
            }).join('')
          : '<p class="small muted">No drivers are sharing location right now.</p>';

        $('liveOrders').innerHTML = data.orders.length
          ? data.orders.map(function (o) {
              return '<div class="row-between small" style="padding:6px 0;border-bottom:1px solid var(--line)">' +
                '<div><div class="strong">' + esc(o.orderNumber) + '</div>' +
                '<div class="tiny muted">' + esc(o.loadType) + (o.etaMinutes ? ' - ~' + o.etaMinutes + ' min' : '') + '</div></div>' +
                UI.statusBadge(o.status, o.statusLabel) + '</div>';
            }).join('')
          : '<p class="small muted">No active deliveries.</p>';

        if (state.liveMap && state.liveMap.available) {
          data.drivers.forEach(function (d) { state.liveMap.setDriver(d); });
        }
        return data;
      });
    }

    AquaMaps.load().then(function () {
      var el = $('adminMap');
      if (!AquaMaps.isAvailable()) {
        AquaMaps.renderFallback(el, 'Add GOOGLE_MAPS_API_KEY to .env to see the live fleet map. The lists beside it still update.');
        state.liveMap = { available: false };
      } else {
        var map = new window.google.maps.Map(el, {
          center: { lat: 12.9716, lng: 77.5946 }, zoom: 12, disableDefaultUI: true, zoomControl: true,
        });
        state.liveMap = {
          available: true,
          setDriver: function (d) {
            if (!d.latitude) return;
            var pos = { lat: d.latitude, lng: d.longitude };
            if (state.markers[d.id]) { state.markers[d.id].setPosition(pos); return; }
            state.markers[d.id] = new window.google.maps.Marker({
              position: pos, map: map, title: d.name,
              icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 8,
                fillColor: d.status === 'ON_DELIVERY' ? '#b26a00' : '#0f9d58',
                fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
            });
          },
        };
      }
      load().catch(function (e) { UI.toast(e.message, 'error'); });
    });
  }

  /* =========================== DRIVERS =========================== */

  function viewDrivers() {
    host().innerHTML = section('Drivers',
      '<button class="btn btn-primary btn-sm" id="addDriverBtn">Add driver</button>',
      '<div id="driversTable"><div class="skeleton skel-card"></div></div>');

    $('addDriverBtn').addEventListener('click', openDriverSheet);

    API.admin.drivers().then(function (drivers) {
      state.drivers = drivers;
      var el = $('driversTable');
      if (!drivers.length) {
        UI.empty(el, '', 'No drivers yet', 'Add a driver so you can assign deliveries.');
        return;
      }
      el.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Name</th><th>Phone</th><th>Status</th><th>Verified</th><th>Tankers</th>' +
        '<th>Deliveries</th><th>Last GPS</th><th>Actions</th></tr></thead><tbody>' +
        drivers.map(function (d) {
          return '<tr><td class="strong">' + esc(d.user.name) + '</td><td>' + esc(d.user.phone) + '</td>' +
            '<td><span class="badge badge-' + (d.status === 'AVAILABLE' ? 'success' : d.status === 'ON_DELIVERY' ? 'info' : d.status === 'SUSPENDED' ? 'danger' : 'muted') + '">' +
            esc(d.status.replace(/_/g, ' ')) + '</span></td>' +
            '<td>' + (d.isVerified ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-warn">Pending</span>') + '</td>' +
            '<td>' + (d.vehicles.map(function (v) { return esc(v.registrationNumber); }).join(', ') || '<span class="muted">-</span>') + '</td>' +
            '<td>' + d.totalDeliveries + '</td>' +
            '<td class="tiny muted">' + (d.lastLocationAt ? UI.timeAgo(d.lastLocationAt) : 'never') + '</td>' +
            '<td><button class="btn btn-ghost btn-xs" data-verify="' + esc(d.id) + '" data-val="' + (!d.isVerified) + '">' +
            (d.isVerified ? 'Unverify' : 'Verify') + '</button> ' +
            '<button class="btn btn-ghost btn-xs" data-suspend="' + esc(d.id) + '" data-val="' + (d.status === 'SUSPENDED' ? 'OFFLINE' : 'SUSPENDED') + '">' +
            (d.status === 'SUSPENDED' ? 'Reinstate' : 'Suspend') + '</button></td></tr>';
        }).join('') + '</tbody></table></div>';

      Array.prototype.forEach.call(el.querySelectorAll('[data-verify]'), function (b) {
        b.addEventListener('click', function () {
          API.admin.updateDriver(b.dataset.verify, { isVerified: b.dataset.val === 'true' })
            .then(function () { UI.toast('Driver updated', 'success'); viewDrivers(); })
            .catch(function (e) { UI.toast(e.message, 'error'); });
        });
      });
      Array.prototype.forEach.call(el.querySelectorAll('[data-suspend]'), function (b) {
        b.addEventListener('click', function () {
          API.admin.updateDriver(b.dataset.suspend, { status: b.dataset.val })
            .then(function () { UI.toast('Driver updated', 'success'); viewDrivers(); })
            .catch(function (e) { UI.toast(e.message, 'error'); });
        });
      });
    }).catch(function (e) { UI.errorState($('driversTable'), e.message, viewDrivers); });
  }

  function openDriverSheet() {
    var s = UI.sheet('<h2>Add driver</h2>' +
      '<div class="field"><label class="label">Full name</label><input class="input" id="dName" maxlength="80"></div>' +
      '<div class="field mt-1"><label class="label">Mobile number</label><input class="input" id="dPhone" inputmode="numeric" maxlength="14"></div>' +
      '<div class="field mt-1"><label class="label">Licence number (optional)</label><input class="input" id="dLicense" maxlength="40"></div>' +
      '<div class="field-error hidden mt-1" id="dError"></div>' +
      '<p class="tiny muted mt-1">The driver signs in at /driver with this number using an OTP - no password to share.</p>' +
      '<button class="btn btn-primary btn-block mt-2" id="dSave">Create driver</button>', { center: true });

    s.root.querySelector('#dSave').addEventListener('click', function (ev) {
      var btn = ev.currentTarget;
      var err = s.root.querySelector('#dError');
      err.classList.add('hidden');
      UI.busy(btn, true, 'Creating');
      API.admin.createDriver({
        name: s.root.querySelector('#dName').value.trim(),
        phone: s.root.querySelector('#dPhone').value.trim(),
        licenseNumber: s.root.querySelector('#dLicense').value.trim(),
        isVerified: true,
      })
        .then(function () { UI.toast('Driver created', 'success'); s.close(); viewDrivers(); })
        .catch(function (e) { err.textContent = e.message; err.classList.remove('hidden'); })
        .finally(function () { UI.busy(btn, false); });
    });
  }

  /* =========================== VEHICLES =========================== */

  function viewVehicles() {
    host().innerHTML = section('Tankers',
      '<button class="btn btn-primary btn-sm" id="addVehicleBtn">Add tanker</button>',
      '<div id="vehiclesTable"><div class="skeleton skel-card"></div></div>');

    $('addVehicleBtn').addEventListener('click', openVehicleSheet);

    Promise.all([API.admin.vehicles(), API.admin.drivers()]).then(function (r) {
      state.vehicles = r[0]; state.drivers = r[1];
      var el = $('vehiclesTable');
      if (!r[0].length) { UI.empty(el, '', 'No tankers yet', 'Add your fleet so orders can be assigned.'); return; }

      el.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Registration</th><th>Type</th><th>Capacity</th><th>Status</th><th>Driver</th><th>Actions</th>' +
        '</tr></thead><tbody>' + r[0].map(function (v) {
          return '<tr><td class="strong">' + esc(v.registrationNumber) + '</td><td>' + esc(v.vehicleType) + '</td>' +
            '<td>' + UI.litres(v.capacityL) + '</td>' +
            '<td><span class="badge badge-' + (v.status === 'ACTIVE' ? 'success' : v.status === 'IN_MAINTENANCE' ? 'warn' : 'muted') + '">' +
            esc(v.status.replace(/_/g, ' ')) + '</span></td>' +
            '<td>' + (v.driver ? esc(v.driver.user.name) : '<span class="muted">unassigned</span>') + '</td>' +
            '<td><button class="btn btn-ghost btn-xs" data-toggle-v="' + esc(v.id) + '" data-val="' +
            (v.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE') + '">' +
            (v.status === 'ACTIVE' ? 'Deactivate' : 'Activate') + '</button></td></tr>';
        }).join('') + '</tbody></table></div>';

      Array.prototype.forEach.call(el.querySelectorAll('[data-toggle-v]'), function (b) {
        b.addEventListener('click', function () {
          API.admin.updateVehicle(b.dataset.toggleV, { status: b.dataset.val })
            .then(function () { UI.toast('Tanker updated', 'success'); viewVehicles(); })
            .catch(function (e) { UI.toast(e.message, 'error'); });
        });
      });
    }).catch(function (e) { UI.errorState($('vehiclesTable'), e.message, viewVehicles); });
  }

  function openVehicleSheet() {
    var s = UI.sheet('<h2>Add tanker</h2>' +
      '<div class="field"><label class="label">Registration number</label><input class="input" id="vReg" maxlength="20" placeholder="KA01AB1234"></div>' +
      '<div class="field mt-1"><label class="label">Type</label><input class="input" id="vType" value="TANKER" maxlength="30"></div>' +
      '<div class="field mt-1"><label class="label">Capacity (litres)</label><input class="input" id="vCap" type="number" min="100" max="100000" value="4000"></div>' +
      '<div class="field mt-1"><label class="label">Assign to driver (optional)</label><select class="select" id="vDriver">' +
      '<option value="">Unassigned</option>' + state.drivers.map(function (d) {
        return '<option value="' + esc(d.id) + '">' + esc(d.user.name) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field-error hidden mt-1" id="vError"></div>' +
      '<button class="btn btn-primary btn-block mt-2" id="vSave">Add tanker</button>', { center: true });

    s.root.querySelector('#vSave').addEventListener('click', function (ev) {
      var btn = ev.currentTarget;
      var err = s.root.querySelector('#vError');
      err.classList.add('hidden');
      UI.busy(btn, true, 'Saving');
      API.admin.createVehicle({
        registrationNumber: s.root.querySelector('#vReg').value.trim(),
        vehicleType: s.root.querySelector('#vType').value.trim() || 'TANKER',
        capacityL: Number(s.root.querySelector('#vCap').value),
        driverId: s.root.querySelector('#vDriver').value || null,
      })
        .then(function () { UI.toast('Tanker added', 'success'); s.close(); viewVehicles(); })
        .catch(function (e) { err.textContent = e.message; err.classList.remove('hidden'); })
        .finally(function () { UI.busy(btn, false); });
    });
  }

  /* =========================== PRODUCTS / PRICING =========================== */

  function viewProducts() {
    host().innerHTML = section('Water loads &amp; pricing',
      '<button class="btn btn-primary btn-sm" id="addProductBtn">Add load</button>',
      '<p class="small muted mb-2">Prices set here are the only prices the app will charge. Customers cannot influence them.</p>' +
      '<div id="productsTable"><div class="skeleton skel-card"></div></div>');

    $('addProductBtn').addEventListener('click', function () { openProductSheet(null); });

    API.admin.products().then(function (products) {
      var el = $('productsTable');
      if (!products.length) { UI.empty(el, '', 'No loads configured', 'Add at least one so customers can order.'); return; }

      el.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Name</th><th>Capacity</th><th>Price</th><th>Vehicle type</th><th>Active</th><th>Order</th><th>Actions</th>' +
        '</tr></thead><tbody>' + products.map(function (p) {
          return '<tr><td class="strong">' + esc(p.name) + '<div class="tiny muted">' + esc(p.description || '') + '</div></td>' +
            '<td>' + UI.litres(p.capacityL) + '</td><td class="strong">' + UI.rupees(p.priceRupees) + '</td>' +
            '<td>' + esc(p.vehicleType) + '</td>' +
            '<td>' + (p.isActive ? '<span class="badge badge-success">Live</span>' : '<span class="badge badge-muted">Hidden</span>') + '</td>' +
            '<td>' + p.sortOrder + '</td>' +
            '<td><button class="btn btn-ghost btn-xs" data-edit-p="' + esc(p.id) + '">Edit</button> ' +
            '<button class="btn btn-ghost btn-xs" data-toggle-p="' + esc(p.id) + '" data-val="' + (!p.isActive) + '">' +
            (p.isActive ? 'Hide' : 'Show') + '</button></td></tr>';
        }).join('') + '</tbody></table></div>';

      Array.prototype.forEach.call(el.querySelectorAll('[data-toggle-p]'), function (b) {
        b.addEventListener('click', function () {
          API.admin.updateProduct(b.dataset.toggleP, { isActive: b.dataset.val === 'true' })
            .then(function () { UI.toast('Updated', 'success'); viewProducts(); })
            .catch(function (e) { UI.toast(e.message, 'error'); });
        });
      });
      Array.prototype.forEach.call(el.querySelectorAll('[data-edit-p]'), function (b) {
        b.addEventListener('click', function () {
          openProductSheet(products.filter(function (p) { return p.id === b.dataset.editP; })[0]);
        });
      });
    }).catch(function (e) { UI.errorState($('productsTable'), e.message, viewProducts); });
  }

  function openProductSheet(p) {
    var isEdit = Boolean(p);
    var s = UI.sheet('<h2>' + (isEdit ? 'Edit load' : 'Add load') + '</h2>' +
      '<div class="field"><label class="label">Name</label><input class="input" id="pName" maxlength="60" value="' + esc(p ? p.name : '') + '"></div>' +
      (isEdit ? '' : '<div class="field mt-1"><label class="label">Slug</label><input class="input" id="pSlug" maxlength="60" placeholder="half-load"></div>') +
      '<div class="field mt-1"><label class="label">Description</label><input class="input" id="pDesc" maxlength="300" value="' + esc(p ? (p.description || '') : '') + '"></div>' +
      '<div class="field mt-1"><label class="label">Capacity (litres)</label><input class="input" id="pCap" type="number" min="100" max="100000" value="' + (p ? p.capacityL : 2000) + '"></div>' +
      '<div class="field mt-1"><label class="label">Price (Rs)</label><input class="input" id="pPrice" type="number" min="1" step="1" value="' + (p ? p.priceRupees : 300) + '"></div>' +
      '<div class="field mt-1"><label class="label">Vehicle type</label><input class="input" id="pType" maxlength="30" value="' + esc(p ? p.vehicleType : 'TANKER') + '"></div>' +
      '<div class="field mt-1"><label class="label">Sort order</label><input class="input" id="pSort" type="number" value="' + (p ? p.sortOrder : 0) + '"></div>' +
      '<div class="field-error hidden mt-1" id="pError"></div>' +
      '<button class="btn btn-primary btn-block mt-2" id="pSave">' + (isEdit ? 'Save changes' : 'Create load') + '</button>', { center: true });

    s.root.querySelector('#pSave').addEventListener('click', function (ev) {
      var btn = ev.currentTarget;
      var err = s.root.querySelector('#pError');
      err.classList.add('hidden');
      var body = {
        name: s.root.querySelector('#pName').value.trim(),
        description: s.root.querySelector('#pDesc').value.trim(),
        capacityL: Number(s.root.querySelector('#pCap').value),
        priceRupees: Number(s.root.querySelector('#pPrice').value),
        vehicleType: s.root.querySelector('#pType').value.trim() || 'TANKER',
        sortOrder: Number(s.root.querySelector('#pSort').value) || 0,
      };
      if (!isEdit) body.slug = s.root.querySelector('#pSlug').value.trim();

      UI.busy(btn, true, 'Saving');
      (isEdit ? API.admin.updateProduct(p.id, body) : API.admin.createProduct(body))
        .then(function () { UI.toast('Saved', 'success'); s.close(); viewProducts(); })
        .catch(function (e) { err.textContent = e.message; err.classList.remove('hidden'); })
        .finally(function () { UI.busy(btn, false); });
    });
  }

  /* =========================== CUSTOMERS =========================== */

  function viewCustomers() {
    host().innerHTML = section('Customers',
      '<input class="input" id="custSearch" placeholder="Search name or phone" style="width:240px">',
      '<div id="custTable"><div class="skeleton skel-card"></div></div>');

    var page = 1, search = '';
    function load() {
      API.admin.customers('?page=' + page + '&limit=25' + (search ? '&search=' + encodeURIComponent(search) : ''))
        .then(function (res) {
          var el = $('custTable');
          if (!res.data.length) { UI.empty(el, '', 'No customers found', ''); return; }
          el.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
            '<th>Name</th><th>Phone</th><th>Orders</th><th>Joined</th><th>Last login</th><th>Status</th><th>Actions</th>' +
            '</tr></thead><tbody>' + res.data.map(function (c) {
              return '<tr><td class="strong">' + esc(c.name) + '</td><td>' + esc(c.phone) + '</td>' +
                '<td>' + c._count.customerOrders + '</td>' +
                '<td class="tiny muted">' + UI.timeAgo(c.createdAt) + '</td>' +
                '<td class="tiny muted">' + (c.lastLoginAt ? UI.timeAgo(c.lastLoginAt) : 'never') + '</td>' +
                '<td>' + (c.isActive ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-danger">Blocked</span>') + '</td>' +
                '<td><button class="btn btn-ghost btn-xs" data-block="' + esc(c.id) + '" data-val="' + (!c.isActive) + '">' +
                (c.isActive ? 'Block' : 'Unblock') + '</button></td></tr>';
            }).join('') + '</tbody></table></div>' + pager(res.meta, 'custPager');

          Array.prototype.forEach.call(el.querySelectorAll('[data-block]'), function (b) {
            b.addEventListener('click', function () {
              API.admin.updateCustomer(b.dataset.block, { isActive: b.dataset.val === 'true' })
                .then(function () { UI.toast('Customer updated', 'success'); load(); })
                .catch(function (e) { UI.toast(e.message, 'error'); });
            });
          });
          bindPager(el, function (p) { page = p; load(); });
        })
        .catch(function (e) { UI.errorState($('custTable'), e.message, load); });
    }

    var t;
    $('custSearch').addEventListener('input', function (e) {
      clearTimeout(t);
      t = setTimeout(function () { search = e.target.value.trim(); page = 1; load(); }, 350);
    });
    load();
  }

  /* =========================== PAYMENTS =========================== */

  function viewPayments() {
    host().innerHTML = section('Payments', '', '<div id="payTable"><div class="skeleton skel-card"></div></div>');
    API.admin.payments('?limit=50').then(function (res) {
      var el = $('payTable');
      if (!res.data.length) { UI.empty(el, '', 'No payments yet', ''); return; }
      el.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Order</th><th>Customer</th><th>Amount</th><th>Provider</th><th>Gateway ref</th><th>Status</th><th>When</th>' +
        '</tr></thead><tbody>' + res.data.map(function (p) {
          return '<tr><td class="strong">' + esc(p.order.orderNumber) + '</td>' +
            '<td>' + esc(p.order.customer.name) + '<div class="tiny muted">' + esc(p.order.customer.phone) + '</div></td>' +
            '<td class="strong">' + UI.rupees(p.amountRupees) + '</td>' +
            '<td>' + esc(p.provider) + (p.isDemo ? ' <span class="badge badge-warn">demo</span>' : '') + '</td>' +
            '<td class="tiny muted">' + esc(p.providerPaymentId || p.providerOrderId || '-') + '</td>' +
            '<td><span class="badge badge-' + (p.status === 'PAID' ? 'success' : p.status === 'FAILED' ? 'danger' : 'warn') + '">' +
            esc(p.status) + '</span></td>' +
            '<td class="tiny muted">' + UI.timeAgo(p.paidAt || p.createdAt) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }).catch(function (e) { UI.errorState($('payTable'), e.message, viewPayments); });
  }

  /* =========================== SERVICE AREAS =========================== */

  function viewAreas() {
    host().innerHTML = section('Service areas',
      '<button class="btn btn-primary btn-sm" id="addAreaBtn">Add area</button>',
      '<p class="small muted mb-2">Orders outside every active area are rejected at checkout. With no areas configured, deliveries are unrestricted.</p>' +
      '<div id="areasTable"><div class="skeleton skel-card"></div></div>');

    $('addAreaBtn').addEventListener('click', openAreaSheet);

    API.admin.serviceAreas().then(function (areas) {
      var el = $('areasTable');
      if (!areas.length) { UI.empty(el, '', 'No service areas', 'Deliveries are currently unrestricted.'); return; }
      el.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Name</th><th>Pincode</th><th>Centre</th><th>Radius</th><th>Active</th><th>Actions</th></tr></thead><tbody>' +
        areas.map(function (a) {
          return '<tr><td class="strong">' + esc(a.name) + '</td><td>' + esc(a.pincode || '-') + '</td>' +
            '<td class="tiny muted">' + a.centerLat.toFixed(4) + ', ' + a.centerLng.toFixed(4) + '</td>' +
            '<td>' + a.radiusKm + ' km</td>' +
            '<td>' + (a.isActive ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-muted">No</span>') + '</td>' +
            '<td><button class="btn btn-ghost btn-xs" data-del-area="' + esc(a.id) + '">Delete</button></td></tr>';
        }).join('') + '</tbody></table></div>';

      Array.prototype.forEach.call(el.querySelectorAll('[data-del-area]'), function (b) {
        b.addEventListener('click', function () {
          UI.confirm('Delete this service area? Orders outside the remaining areas will be rejected.', { danger: true })
            .then(function (yes) {
              if (!yes) return;
              API.admin.deleteServiceArea(b.dataset.delArea)
                .then(function () { UI.toast('Area deleted', 'success'); viewAreas(); })
                .catch(function (e) { UI.toast(e.message, 'error'); });
            });
        });
      });
    }).catch(function (e) { UI.errorState($('areasTable'), e.message, viewAreas); });
  }

  function openAreaSheet() {
    var s = UI.sheet('<h2>Add service area</h2>' +
      '<div class="field"><label class="label">Area name</label><input class="input" id="aName" maxlength="80"></div>' +
      '<div class="field mt-1"><label class="label">Pincode (optional)</label><input class="input" id="aPin" maxlength="10"></div>' +
      '<div class="field mt-1"><label class="label">Centre latitude</label><input class="input" id="aLat" type="number" step="0.000001" value="12.9716"></div>' +
      '<div class="field mt-1"><label class="label">Centre longitude</label><input class="input" id="aLng" type="number" step="0.000001" value="77.5946"></div>' +
      '<div class="field mt-1"><label class="label">Radius (km)</label><input class="input" id="aRad" type="number" min="0.5" max="200" value="15"></div>' +
      '<button class="btn btn-ghost btn-block btn-sm mt-1" id="aGps">Use my current location as centre</button>' +
      '<div class="field-error hidden mt-1" id="aError"></div>' +
      '<button class="btn btn-primary btn-block mt-2" id="aSave">Add area</button>', { center: true });

    s.root.querySelector('#aGps').addEventListener('click', function (ev) {
      UI.busy(ev.currentTarget, true, 'Locating');
      AquaMaps.currentPosition()
        .then(function (p) {
          s.root.querySelector('#aLat').value = p.latitude.toFixed(6);
          s.root.querySelector('#aLng').value = p.longitude.toFixed(6);
          UI.toast('Centre set to your location', 'success');
        })
        .catch(function (e) { UI.toast(e.message, 'error'); })
        .finally(function () { UI.busy(ev.currentTarget, false); });
    });

    s.root.querySelector('#aSave').addEventListener('click', function (ev) {
      var btn = ev.currentTarget;
      var err = s.root.querySelector('#aError');
      err.classList.add('hidden');
      UI.busy(btn, true, 'Saving');
      API.admin.createServiceArea({
        name: s.root.querySelector('#aName').value.trim(),
        pincode: s.root.querySelector('#aPin').value.trim(),
        centerLat: Number(s.root.querySelector('#aLat').value),
        centerLng: Number(s.root.querySelector('#aLng').value),
        radiusKm: Number(s.root.querySelector('#aRad').value),
      })
        .then(function () { UI.toast('Service area added', 'success'); s.close(); viewAreas(); })
        .catch(function (e) { err.textContent = e.message; err.classList.remove('hidden'); })
        .finally(function () { UI.busy(btn, false); });
    });
  }

  /* =========================== WATER STATIONS =========================== */

  function viewStations() {
    host().innerHTML = section('Water stations',
      '<button class="btn btn-primary btn-sm" id="addStationBtn">Add station</button>',
      '<p class="small muted mb-2">Tankers fill at these points. Every new order is matched to the nearest ' +
      'active station, which becomes the start of the route the customer tracks on the map.</p>' +
      '<div id="stationsTable"><div class="skeleton skel-card"></div></div>');

    $('addStationBtn').addEventListener('click', function () { openStationSheet(null); });

    API.admin.stations().then(function (stations) {
      var el = $('stationsTable');
      if (!stations.length) {
        UI.empty(el, '', 'No water stations yet',
          'Add one so deliveries have a starting point. Without any, orders still work but the tracking map shows no route origin.');
        return;
      }
      el.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Name</th><th>Address</th><th>Coordinates</th><th>Orders</th><th>Active</th><th>Actions</th>' +
        '</tr></thead><tbody>' + stations.map(function (s) {
          return '<tr><td class="strong">' + esc(s.name) + '</td>' +
            '<td>' + esc(s.address || '-') + '</td>' +
            '<td class="tiny muted">' + s.latitude.toFixed(5) + ', ' + s.longitude.toFixed(5) + '</td>' +
            '<td>' + s._count.orders + '</td>' +
            '<td>' + (s.isActive ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-muted">Off</span>') + '</td>' +
            '<td><button class="btn btn-ghost btn-xs" data-edit-s="' + esc(s.id) + '">Edit</button> ' +
            '<button class="btn btn-ghost btn-xs" data-toggle-s="' + esc(s.id) + '" data-val="' + (!s.isActive) + '">' +
            (s.isActive ? 'Disable' : 'Enable') + '</button> ' +
            '<button class="btn btn-ghost btn-xs" data-del-s="' + esc(s.id) + '">Delete</button></td></tr>';
        }).join('') + '</tbody></table></div>';

      Array.prototype.forEach.call(el.querySelectorAll('[data-toggle-s]'), function (b) {
        b.addEventListener('click', function () {
          API.admin.updateStation(b.dataset.toggleS, { isActive: b.dataset.val === 'true' })
            .then(function () { UI.toast('Station updated', 'success'); viewStations(); })
            .catch(function (e) { UI.toast(e.message, 'error'); });
        });
      });
      Array.prototype.forEach.call(el.querySelectorAll('[data-edit-s]'), function (b) {
        b.addEventListener('click', function () {
          openStationSheet(stations.filter(function (s) { return s.id === b.dataset.editS; })[0]);
        });
      });
      Array.prototype.forEach.call(el.querySelectorAll('[data-del-s]'), function (b) {
        b.addEventListener('click', function () {
          UI.confirm('Delete this station? Past orders keep their history, but new orders will route from the next nearest station.',
            { danger: true, confirmText: 'Delete' }).then(function (yes) {
              if (!yes) return;
              API.admin.deleteStation(b.dataset.delS)
                .then(function () { UI.toast('Station deleted', 'success'); viewStations(); })
                .catch(function (e) { UI.toast(e.message, 'error'); });
            });
        });
      });
    }).catch(function (e) { UI.errorState($('stationsTable'), e.message, viewStations); });
  }

  function openStationSheet(s0) {
    var isEdit = Boolean(s0);
    var s = UI.sheet('<h2>' + (isEdit ? 'Edit station' : 'Add water station') + '</h2>' +
      '<div class="field"><label class="label">Station name</label>' +
      '<input class="input" id="stName" maxlength="80" value="' + esc(s0 ? s0.name : '') + '" placeholder="Central Filling Point"></div>' +
      '<div class="field mt-1"><label class="label">Address (optional)</label>' +
      '<input class="input" id="stAddr" maxlength="300" value="' + esc(s0 ? (s0.address || '') : '') + '"></div>' +
      '<div class="field mt-1"><label class="label">Latitude</label>' +
      '<input class="input" id="stLat" type="number" step="0.000001" value="' + (s0 ? s0.latitude : 12.9716) + '"></div>' +
      '<div class="field mt-1"><label class="label">Longitude</label>' +
      '<input class="input" id="stLng" type="number" step="0.000001" value="' + (s0 ? s0.longitude : 77.5946) + '"></div>' +
      '<button class="btn btn-ghost btn-block btn-sm mt-1" id="stGps">Use my current location</button>' +
      '<div class="field-error hidden mt-1" id="stError"></div>' +
      '<button class="btn btn-primary btn-block mt-2" id="stSave">' + (isEdit ? 'Save changes' : 'Add station') + '</button>',
      { center: true });

    s.root.querySelector('#stGps').addEventListener('click', function (ev) {
      UI.busy(ev.currentTarget, true, 'Locating');
      AquaMaps.currentPosition()
        .then(function (p) {
          s.root.querySelector('#stLat').value = p.latitude.toFixed(6);
          s.root.querySelector('#stLng').value = p.longitude.toFixed(6);
          UI.toast('Coordinates set to your location', 'success');
        })
        .catch(function (e) { UI.toast(e.message, 'error'); })
        .finally(function () { UI.busy(ev.currentTarget, false); });
    });

    s.root.querySelector('#stSave').addEventListener('click', function (ev) {
      var btn = ev.currentTarget;
      var err = s.root.querySelector('#stError');
      err.classList.add('hidden');
      var body = {
        name: s.root.querySelector('#stName').value.trim(),
        address: s.root.querySelector('#stAddr').value.trim(),
        latitude: Number(s.root.querySelector('#stLat').value),
        longitude: Number(s.root.querySelector('#stLng').value),
      };
      UI.busy(btn, true, 'Saving');
      (isEdit ? API.admin.updateStation(s0.id, body) : API.admin.createStation(body))
        .then(function () { UI.toast('Saved', 'success'); s.close(); viewStations(); })
        .catch(function (e) { err.textContent = e.message; err.classList.remove('hidden'); })
        .finally(function () { UI.busy(btn, false); });
    });
  }

  /* =========================== SETTINGS / CHATBOT =========================== */

  function viewSettings() {
    host().innerHTML = section('Chatbot &amp; business information', '',
      '<p class="small muted mb-2">This is the only information the support assistant is allowed to state. ' +
      'Anything not listed here makes it answer "I don\'t have that information."</p>' +
      '<div id="settingsForm"><div class="skeleton skel-card"></div></div>');

    API.admin.businessInfo().then(function (info) {
      $('settingsForm').innerHTML =
        '<div class="split"><div class="card">' +
        f('Company name', 'siName', info.companyName) +
        f('Tagline', 'siTagline', info.tagline) +
        f('Support phone', 'siPhone', info.supportPhone) +
        f('Support email', 'siEmail', info.supportEmail) +
        f('Working hours', 'siHours', info.workingHours) +
        f('Payment methods (comma separated)', 'siPay', (info.paymentMethods || []).join(', ')) +
        '</div><div class="card">' +
        ta('Cancellation policy', 'siCancel', info.cancellationPolicy) +
        ta('Refund policy', 'siRefund', info.refundPolicy) +
        ta('Delivery time note', 'siDelivery', info.deliveryTimeNote) +
        ta('Water source', 'siSource', info.waterSource) +
        ta('Extra notes for the assistant', 'siNotes', info.notes) +
        '</div></div>' +
        '<button class="btn btn-primary mt-2" id="siSave">Save business information</button>' +
        '<div class="card mt-2"><h3>Live data (read-only)</h3>' +
        '<p class="small muted">Prices and service areas are always read from the database, so the assistant cannot quote a stale price.</p>' +
        '<div class="small"><strong>Loads:</strong> ' +
        esc((info.products || []).map(function (p) { return p.name + ' ' + p.litres + 'L Rs' + p.priceRupees; }).join('  |  ') || 'none') + '</div>' +
        '<div class="small mt-1"><strong>Areas:</strong> ' +
        esc((info.serviceAreas || []).map(function (a) { return a.name; }).join(', ') || 'unrestricted') + '</div></div>';

      $('siSave').addEventListener('click', function (ev) {
        var btn = ev.currentTarget;
        UI.busy(btn, true, 'Saving');
        API.admin.saveBusinessInfo({
          companyName: $('siName').value.trim(),
          tagline: $('siTagline').value.trim(),
          supportPhone: $('siPhone').value.trim(),
          supportEmail: $('siEmail').value.trim(),
          workingHours: $('siHours').value.trim(),
          paymentMethods: $('siPay').value.split(',').map(function (x) { return x.trim(); }).filter(Boolean),
          cancellationPolicy: $('siCancel').value.trim(),
          refundPolicy: $('siRefund').value.trim(),
          deliveryTimeNote: $('siDelivery').value.trim(),
          waterSource: $('siSource').value.trim(),
          notes: $('siNotes').value.trim(),
        })
          .then(function () { UI.toast('Business information saved', 'success'); })
          .catch(function (e) { UI.toast(e.message, 'error'); })
          .finally(function () { UI.busy(btn, false); });
      });
    }).catch(function (e) { UI.errorState($('settingsForm'), e.message, viewSettings); });
  }

  function f(label, id, value) {
    return '<div class="field mt-1"><label class="label" for="' + id + '">' + esc(label) + '</label>' +
      '<input class="input" id="' + id + '" value="' + esc(value || '') + '"></div>';
  }
  function ta(label, id, value) {
    return '<div class="field mt-1"><label class="label" for="' + id + '">' + esc(label) + '</label>' +
      '<textarea class="textarea" id="' + id + '">' + esc(value || '') + '</textarea></div>';
  }

  /* =========================== SUPPORT LOG =========================== */

  function viewSupport() {
    host().innerHTML = section('Support conversations', '', '<div id="supportList"><div class="skeleton skel-card"></div></div>');
    API.admin.support().then(function (convos) {
      var el = $('supportList');
      if (!convos.length) { UI.empty(el, '', 'No conversations yet', 'Customer chats with the assistant appear here.'); return; }
      el.innerHTML = convos.map(function (c) {
        return '<div class="card mb-1"><div class="row-between mb-1">' +
          '<span class="strong">' + esc(c.user ? c.user.name + ' (' + c.user.phone + ')' : 'Guest visitor') + '</span>' +
          '<span class="tiny muted">' + UI.timeAgo(c.updatedAt) + '</span></div>' +
          '<div class="chat-log" style="max-height:220px">' + c.messages.map(function (m) {
            return '<div class="bubble ' + (m.role === 'user' ? 'user' : 'bot') + '">' + esc(m.content) + '</div>';
          }).join('') + '</div></div>';
      }).join('');
    }).catch(function (e) { UI.errorState($('supportList'), e.message, viewSupport); });
  }

  /* =========================== BOOT =========================== */

  function boot() {
    $('loginView').classList.add('hidden');
    $('consoleView').classList.remove('hidden');
    // Console content needs the readable scrim; the login screen does not.
    document.body.classList.remove('scene-immersive');
    UI.watchConnectivity();

    API.config().then(function (cfg) {
      state.config = cfg;
      if (cfg.demoMode) $('demoBanner').classList.remove('hidden');
    }).catch(function () {});

    state.socket = UI.connectSocket({
      'admin:order-new': function (o) {
        UI.toast('New order ' + o.orderNumber + ' - ' + o.loadType, 'success');
        if (state.view === 'orders') loadOrdersTable();
        if (state.view === 'dashboard') viewDashboard();
      },
      'admin:order-update': function () {
        if (state.view === 'orders') loadOrdersTable();
        if (state.view === 'live') viewLive();
      },
      'admin:driver-location': function (d) {
        if (state.view === 'live' && state.liveMap && state.liveMap.available) {
          state.liveMap.setDriver({ id: d.driverId, name: 'Driver', latitude: d.latitude, longitude: d.longitude, status: 'ON_DELIVERY' });
        }
      },
      'admin:driver-status': function () { if (state.view === 'drivers') viewDrivers(); },
    });

    if (!state.socket) $('liveDot').className = 'badge badge-muted';

    render();
  }

  if (API.isSignedIn()) {
    API.me()
      .then(function (data) {
        if (data.user.role !== 'ADMIN') {
          UI.toast('This console is for administrators.', 'error');
          API.clearSession();
          setTimeout(function () { window.location.href = '/'; }, 1200);
          return;
        }
        boot();
      })
      .catch(function () { API.clearSession(); });
  }
})();
