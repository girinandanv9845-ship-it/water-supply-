/* AquaFlow - customer app */
(function () {
  'use strict';

  var API = window.AquaAPI;
  var esc = UI.esc;

  var state = {
    config: null,
    user: null,
    products: [],
    addresses: [],
    selectedProduct: null,
    selectedAddress: null,
    quantity: 1,
    activeOrders: [],
    trackingOrderId: null,
    tracker: null,
    socket: null,
    pollTimer: null,
    chatHistory: [],
    conversationId: null,
    businessInfo: null,
    notifications: [],
  };

  var $ = function (id) { return document.getElementById(id); };

  /* =========================== AUTH =========================== */

  function showAuth() {
    $('authView').classList.remove('hidden');
    $('appView').classList.add('hidden');
    // Auth screens sit directly on the water, with far less scrim.
    document.body.classList.add('scene-immersive');
  }

  function showApp() {
    $('authView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    document.body.classList.remove('scene-immersive');
  }

  var pendingPhone = null;

  $('phoneForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('sendOtpBtn');
    var phone = $('phoneInput').value.trim();
    var err = $('phoneError');
    err.classList.add('hidden');

    if (!/^(\+91|91|0)?[6-9]\d{9}$/.test(phone.replace(/[\s-()]/g, ''))) {
      err.textContent = 'Enter a valid 10-digit Indian mobile number.';
      err.classList.remove('hidden');
      $('phoneInput').setAttribute('aria-invalid', 'true');
      return;
    }
    $('phoneInput').removeAttribute('aria-invalid');

    UI.busy(btn, true, 'Sending');
    API.requestOtp(phone)
      .then(function (data) {
        pendingPhone = data.phone;
        $('otpPhoneLabel').textContent = data.phone;
        $('nameField').classList.toggle('hidden', !data.isNewUser);
        $('stepPhone').classList.add('hidden');
        $('stepOtp').classList.remove('hidden');
        $('otpInput').value = '';
        $('otpInput').focus();

        if (data.demoCode) {
          $('demoCodeBox').innerHTML =
            '<div><strong>Demo mode.</strong> Your code is <strong style="font-size:1.1rem;letter-spacing:.15em">' +
            esc(data.demoCode) + '</strong><br><span class="tiny">Real SMS delivery is used once an SMS provider is configured.</span></div>';
          $('demoCodeBox').classList.remove('hidden');
        } else {
          $('demoCodeBox').classList.add('hidden');
        }
        UI.toast('Code sent to ' + data.phone, 'success');
      })
      .catch(function (e2) {
        err.textContent = e2.message;
        err.classList.remove('hidden');
      })
      .finally(function () { UI.busy(btn, false); });
  });

  $('backToPhone').addEventListener('click', function () {
    $('stepOtp').classList.add('hidden');
    $('stepPhone').classList.remove('hidden');
  });

  $('resendOtp').addEventListener('click', function () {
    if (!pendingPhone) return;
    API.requestOtp(pendingPhone)
      .then(function (data) {
        if (data.demoCode) {
          $('demoCodeBox').innerHTML = '<div><strong>Demo mode.</strong> New code: <strong>' + esc(data.demoCode) + '</strong></div>';
          $('demoCodeBox').classList.remove('hidden');
        }
        UI.toast('A new code has been sent.', 'success');
      })
      .catch(function (e) { UI.toast(e.message, 'error'); });
  });

  $('otpForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('verifyOtpBtn');
    var err = $('otpError');
    err.classList.add('hidden');

    var payload = { phone: pendingPhone, code: $('otpInput').value.trim() };
    if (!$('nameField').classList.contains('hidden')) {
      var n = $('nameInput').value.trim();
      if (n.length < 2) {
        err.textContent = 'Please enter your name.';
        err.classList.remove('hidden');
        return;
      }
      payload.name = n;
    }

    UI.busy(btn, true, 'Verifying');
    API.verifyOtp(payload)
      .then(function (data) {
        state.user = data.user;
        if (data.user.role === 'ADMIN') { window.location.href = '/admin'; return; }
        if (data.user.role === 'DRIVER') { window.location.href = '/driver'; return; }
        return boot();
      })
      .catch(function (e2) {
        err.textContent = e2.message;
        err.classList.remove('hidden');
      })
      .finally(function () { UI.busy(btn, false); });
  });

  function signOut() {
    API.logout().then(function () {
      if (state.socket) state.socket.disconnect();
      window.location.reload();
    });
  }
  $('logoutBtn').addEventListener('click', signOut);
  $('logoutBtn2').addEventListener('click', signOut);
  window.addEventListener('aquaflow:signed-out', function () {
    UI.toast('Your session expired. Please sign in again.', 'warn');
    setTimeout(function () { window.location.reload(); }, 1200);
  });

  /* =========================== TABS =========================== */

  // Both the mobile bottom bar and the desktop side rail drive the same tabs.
  Array.prototype.forEach.call(document.querySelectorAll('.nav-item, .rail-item[data-tab]'), function (btn) {
    btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
  });

  var railChat = $('railChat');
  if (railChat) railChat.addEventListener('click', openChat);

  function switchTab(tabId) {
    ['tabHome', 'tabOrders', 'tabTrack', 'tabAccount'].forEach(function (id) {
      var el = $(id);
      var show = id === tabId;
      el.classList.toggle('hidden', !show);
      if (show) {
        // Restart the entrance animation on every switch.
        el.classList.remove('page-enter');
        void el.offsetWidth;
        el.classList.add('page-enter');
      }
    });
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item, .rail-item[data-tab]'), function (b) {
      b.classList.toggle('active', b.dataset.tab === tabId);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (tabId === 'tabOrders') loadOrders();
    if (tabId === 'tabTrack') renderTracking();
    if (tabId === 'tabAccount') { loadAddresses(); loadNotifications(); }
  }

  /* =========================== PRODUCTS =========================== */

  function loadProducts() {
    UI.skeleton($('productList'), 3);
    return API.products()
      .then(function (products) {
        state.products = products;
        if (!products.length) {
          UI.empty($('productList'), '', 'No water loads available', 'Our team is updating the catalog. Please check back shortly.');
          return;
        }
        $('productList').classList.add('stagger');
        $('productList').innerHTML = products.map(function (p) {
          return (
            '<button class="product" type="button" data-product="' + esc(p.id) + '" aria-pressed="false">' +
            '<span class="drop"><svg viewBox="0 0 24 24" fill="currentColor">' +
            '<path d="M12 2.5s6.5 7 6.5 11.2A6.5 6.5 0 0 1 12 20.2a6.5 6.5 0 0 1-6.5-6.5C5.5 9.5 12 2.5 12 2.5z"/></svg></span>' +
            '<span><span class="name">' + esc(p.name) + '</span>' +
            '<span class="small muted" style="display:block">' + UI.litres(p.capacityL) +
            (p.description ? ' &middot; ' + esc(p.description) : '') + '</span></span>' +
            '<span class="price">' + UI.rupees(p.priceRupees) + '</span></button>'
          );
        }).join('');

        Array.prototype.forEach.call($('productList').querySelectorAll('[data-product]'), function (el) {
          el.addEventListener('click', function (ev) {
            // Anchor the selection ripple at the click point.
            var r = el.getBoundingClientRect();
            el.style.setProperty('--rx', (((ev.clientX - r.left) / r.width) * 100 || 50) + '%');
            el.style.setProperty('--ry', (((ev.clientY - r.top) / r.height) * 100 || 50) + '%');
            selectProduct(el.dataset.product);
          });
        });
      })
      .catch(function (e) {
        UI.errorState($('productList'), e.message, loadProducts);
      });
  }

  function selectProduct(id) {
    state.selectedProduct = state.products.filter(function (p) { return p.id === id; })[0] || null;
    state.quantity = 1;
    Array.prototype.forEach.call($('productList').querySelectorAll('[data-product]'), function (el) {
      el.setAttribute('aria-pressed', el.dataset.product === id ? 'true' : 'false');
    });
    renderSummary();
    $('orderSummaryCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderSummary() {
    var card = $('orderSummaryCard');
    if (!state.selectedProduct) { card.style.display = 'none'; return; }
    card.style.display = 'block';

    var p = state.selectedProduct;
    $('sumLoad').textContent = p.name + ' (' + UI.litres(p.capacityL) + ')';
    $('sumQty').textContent = String(state.quantity);
    $('sumTotal').textContent = UI.rupees(p.priceRupees * state.quantity);
    $('sumAddress').textContent = state.selectedAddress ? state.selectedAddress.fullAddress : 'Choose an address';
  }

  $('qtyPlus').addEventListener('click', function () {
    if (state.quantity < 10) { state.quantity++; renderSummary(); }
  });
  $('qtyMinus').addEventListener('click', function () {
    if (state.quantity > 1) { state.quantity--; renderSummary(); }
  });

  /* =========================== ADDRESSES =========================== */

  function loadAddresses() {
    return API.addresses()
      .then(function (list) {
        state.addresses = list;
        if (!state.selectedAddress && list.length) {
          state.selectedAddress = list.filter(function (a) { return a.isDefault; })[0] || list[0];
        }
        renderAddressBar();
        renderAddressList();
        renderSummary();
        return list;
      })
      .catch(function (e) { UI.toast(e.message, 'error'); return []; });
  }

  function renderAddressBar() {
    $('currentAddressLabel').textContent = state.selectedAddress
      ? (state.selectedAddress.label + ' - ' + state.selectedAddress.fullAddress)
      : 'Choose a delivery address';
  }

  function renderAddressList() {
    var host = $('addressList');
    if (!state.addresses.length) {
      UI.empty(host, '', 'No saved addresses', 'Add one so we know where to deliver.');
      return;
    }
    host.innerHTML = state.addresses.map(function (a) {
      return (
        '<div class="row-between" style="padding:9px 0;border-bottom:1px solid var(--line)">' +
        '<div class="grow"><div class="small strong">' + esc(a.label) +
        (a.isDefault ? ' <span class="badge badge-info">Default</span>' : '') + '</div>' +
        '<div class="tiny muted">' + esc(a.fullAddress) + '</div></div>' +
        '<button class="btn-link" data-del-addr="' + esc(a.id) + '">Remove</button></div>'
      );
    }).join('');

    Array.prototype.forEach.call(host.querySelectorAll('[data-del-addr]'), function (b) {
      b.addEventListener('click', function () {
        UI.confirm('Remove this saved address?', { danger: true, confirmText: 'Remove' }).then(function (yes) {
          if (!yes) return;
          API.deleteAddress(b.dataset.delAddr)
            .then(function () {
              UI.toast('Address removed', 'success');
              if (state.selectedAddress && state.selectedAddress.id === b.dataset.delAddr) {
                state.selectedAddress = null;
              }
              loadAddresses();
            })
            .catch(function (e) { UI.toast(e.message, 'error'); });
        });
      });
    });
  }

  $('locationBar').addEventListener('click', openAddressSheet);
  $('addAddressBtn').addEventListener('click', function () { openAddressSheet(true); });

  function openAddressSheet(forceNew) {
    var saved = state.addresses.map(function (a) {
      return (
        '<button class="card-flat row" style="width:100%;text-align:left;margin-bottom:8px;cursor:pointer" data-pick="' + esc(a.id) + '">' +
        '<span class="grow"><span class="small strong" style="display:block">' + esc(a.label) + '</span>' +
        '<span class="tiny muted">' + esc(a.fullAddress) + '</span></span>' +
        (state.selectedAddress && state.selectedAddress.id === a.id ? '<span class="badge badge-success">Selected</span>' : '') +
        '</button>'
      );
    }).join('');

    var s = UI.sheet(
      '<h2>Delivery address</h2>' +
      (!forceNew && saved ? '<div class="mb-2">' + saved + '</div>' : '') +
      '<div class="card">' +
      '<h3>Add a new address</h3>' +
      '<div class="field"><label class="label" for="addrSearch">Search or type your address</label>' +
      '<input class="input" id="addrSearch" placeholder="Area, street, building..."></div>' +
      '<button class="btn btn-ghost btn-block btn-sm mt-1" id="useGpsBtn">Use my current location</button>' +
      '<div class="map-picker-wrap mt-2"><div class="map" id="pickerMap"></div>' +
      '<div class="map-crosshair">&#128205;</div></div>' +
      '<p class="tiny muted mt-1 mb-0" id="coordLabel">Drag the map to place the pin exactly.</p>' +
      '<div class="field mt-1"><label class="label" for="addrLabel">Save as</label>' +
      '<select class="select" id="addrLabel"><option>Home</option><option>Work</option><option>Other</option></select></div>' +
      '<div class="field mt-1"><label class="label" for="addrFull">Full address</label>' +
      '<textarea class="textarea" id="addrFull" maxlength="400" placeholder="House / flat number, street, area"></textarea></div>' +
      '<div class="field mt-1"><label class="label" for="addrLandmark">Landmark (optional)</label>' +
      '<input class="input" id="addrLandmark" maxlength="200"></div>' +
      '<div class="field-error hidden mt-1" id="addrError"></div>' +
      '<button class="btn btn-primary btn-block mt-2" id="saveAddrBtn">Save address</button></div>'
    );

    Array.prototype.forEach.call(s.root.querySelectorAll('[data-pick]'), function (b) {
      b.addEventListener('click', function () {
        state.selectedAddress = state.addresses.filter(function (a) { return a.id === b.dataset.pick; })[0];
        renderAddressBar(); renderSummary(); s.close();
        UI.toast('Delivering to ' + state.selectedAddress.label, 'success');
      });
    });

    var picked = null;
    var mapEl = s.root.querySelector('#pickerMap');
    var coordLabel = s.root.querySelector('#coordLabel');

    function setPicked(p, alsoFillAddress) {
      picked = p;
      coordLabel.textContent = 'Pin: ' + p.latitude.toFixed(5) + ', ' + p.longitude.toFixed(5);
      if (alsoFillAddress) {
        AquaMaps.reverseGeocode(p.latitude, p.longitude).then(function (addr) {
          if (addr && !s.root.querySelector('#addrFull').value.trim()) {
            s.root.querySelector('#addrFull').value = addr;
          }
        });
      }
    }

    AquaMaps.load().then(function () {
      var picker = AquaMaps.createPicker(mapEl, state.selectedAddress
        ? { latitude: state.selectedAddress.latitude, longitude: state.selectedAddress.longitude }
        : null, function (c) { setPicked(c, false); });

      if (!picker.available) {
        s.root.querySelector('.map-crosshair').style.display = 'none';
      }

      AquaMaps.attachAutocomplete(s.root.querySelector('#addrSearch'), function (place) {
        s.root.querySelector('#addrFull').value = place.address || '';
        setPicked({ latitude: place.latitude, longitude: place.longitude }, false);
        if (picker.available) picker.setCenter(place.latitude, place.longitude, 17);
      });

      s.root.querySelector('#useGpsBtn').addEventListener('click', function (ev) {
        var b = ev.currentTarget;
        UI.busy(b, true, 'Locating');
        AquaMaps.currentPosition()
          .then(function (pos) {
            setPicked(pos, true);
            if (picker.available) picker.setCenter(pos.latitude, pos.longitude, 17);
            UI.toast('Location found', 'success');
          })
          .catch(function (e) { UI.toast(e.message, 'error'); })
          .finally(function () { UI.busy(b, false); });
      });
    });

    s.root.querySelector('#saveAddrBtn').addEventListener('click', function (ev) {
      var btn = ev.currentTarget;
      var err = s.root.querySelector('#addrError');
      err.classList.add('hidden');

      var full = s.root.querySelector('#addrFull').value.trim();
      if (full.length < 5) {
        err.textContent = 'Please enter the full address.'; err.classList.remove('hidden'); return;
      }
      if (!picked) {
        err.textContent = 'Set the pin using the map or your current location so the driver can find you.';
        err.classList.remove('hidden'); return;
      }

      UI.busy(btn, true, 'Saving');
      API.serviceability(picked.latitude, picked.longitude)
        .then(function (check) {
          if (!check.serviceable) throw new Error(check.message);
          return API.createAddress({
            label: s.root.querySelector('#addrLabel').value,
            fullAddress: full,
            landmark: s.root.querySelector('#addrLandmark').value.trim(),
            latitude: picked.latitude,
            longitude: picked.longitude,
            isDefault: state.addresses.length === 0,
          });
        })
        .then(function (addr) {
          state.selectedAddress = addr;
          UI.toast('Address saved', 'success');
          s.close();
          return loadAddresses();
        })
        .catch(function (e) { err.textContent = e.message; err.classList.remove('hidden'); })
        .finally(function () { UI.busy(btn, false); });
    });
  }

  /* =========================== PLACE ORDER =========================== */

  $('placeOrderBtn').addEventListener('click', function (ev) {
    var btn = ev.currentTarget;
    if (!state.selectedProduct) { UI.toast('Choose a water load first.', 'warn'); return; }
    if (!state.selectedAddress) { UI.toast('Choose a delivery address first.', 'warn'); openAddressSheet(); return; }

    var method = $('payMethod').value;
    UI.busy(btn, true, 'Placing order');

    API.createOrder({
      productId: state.selectedProduct.id,
      addressId: state.selectedAddress.id,
      quantity: state.quantity,
      notes: $('notesInput').value.trim(),
      paymentMethod: method,
    })
      .then(function (order) {
        $('notesInput').value = '';
        state.selectedProduct = null;
        renderSummary();
        Array.prototype.forEach.call($('productList').querySelectorAll('[data-product]'), function (el) {
          el.setAttribute('aria-pressed', 'false');
        });

        if (method === 'CASH_ON_DELIVERY') {
          UI.toast('Order placed. Pay the driver on delivery.', 'success');
          return refreshActive().then(function () { switchTab('tabTrack'); });
        }
        return startPayment(order);
      })
      .catch(function (e) { UI.toast(e.message, 'error'); })
      .finally(function () { UI.busy(btn, false); });
  });

  /* =========================== PAYMENT =========================== */

  function startPayment(order) {
    return API.createPayment(order.id)
      .then(function (intent) {
        if (intent.isDemo) return demoPayment(order, intent);
        if (window.__noRazorpay || typeof window.Razorpay !== 'function') {
          UI.toast('The payment window could not load. Check your connection and retry from My orders.', 'error');
          return refreshActive();
        }

        return new Promise(function (resolve) {
          var rzp = new window.Razorpay({
            key: intent.keyId,
            amount: intent.amountInPaise,
            currency: intent.currency,
            name: 'AquaFlow Water Supply',
            description: order.loadType + ' - ' + order.orderNumber,
            order_id: intent.providerOrderId,
            prefill: { name: state.user.name, contact: state.user.phone },
            theme: { color: '#14a2c3' },
            handler: function (response) {
              API.verifyPayment({
                providerOrderId: response.razorpay_order_id,
                providerPaymentId: response.razorpay_payment_id,
                signature: response.razorpay_signature,
              })
                .then(function () {
                  UI.toast('Payment successful. Your order is confirmed.', 'success');
                  return refreshActive();
                })
                .then(function () { switchTab('tabTrack'); resolve(); })
                .catch(function (e) { UI.toast(e.message, 'error'); resolve(); });
            },
            modal: {
              ondismiss: function () {
                API.failPayment({ providerOrderId: intent.providerOrderId, reason: 'Closed at checkout' })
                  .catch(function () {});
                UI.toast('Payment cancelled. You can retry from My orders.', 'warn');
                refreshActive().then(resolve);
              },
            },
          });
          rzp.on('payment.failed', function (resp) {
            API.failPayment({
              providerOrderId: intent.providerOrderId,
              reason: (resp.error && resp.error.description) || 'Payment failed',
            }).catch(function () {});
            UI.toast('Payment failed. You can retry from My orders.', 'error');
            refreshActive().then(resolve);
          });
          rzp.open();
        });
      })
      .catch(function (e) { UI.toast(e.message, 'error'); return refreshActive(); });
  }

  function demoPayment(order, intent) {
    return new Promise(function (resolve) {
      var s = UI.sheet(
        '<div class="alert alert-warn mb-2"><div><strong>Demo payment.</strong> No real money moves. ' +
        'This screen is unavailable when the server runs in production mode.</div></div>' +
        '<h2>Confirm payment</h2>' +
        '<div class="row-between"><span class="muted">Order</span><span class="strong">' + esc(order.orderNumber) + '</span></div>' +
        '<div class="row-between mt-1"><span class="muted">Amount</span><span class="strong" style="font-size:1.2rem">' +
        UI.rupees(intent.amountInPaise / 100) + '</span></div>' +
        '<button class="btn btn-success btn-block mt-2" id="demoPayOk">Simulate successful payment</button>' +
        '<button class="btn btn-ghost btn-block mt-1" id="demoPayFail">Simulate failure</button>',
        { center: true, onClose: resolve }
      );

      s.root.querySelector('#demoPayOk').addEventListener('click', function (ev) {
        UI.busy(ev.currentTarget, true, 'Processing');
        API.verifyPayment({ providerOrderId: intent.providerOrderId })
          .then(function () {
            UI.toast('Demo payment complete. Order confirmed.', 'success');
            s.close();
            return refreshActive();
          })
          .then(function () { switchTab('tabTrack'); resolve(); })
          .catch(function (e) { UI.toast(e.message, 'error'); resolve(); });
      });

      s.root.querySelector('#demoPayFail').addEventListener('click', function () {
        API.failPayment({ providerOrderId: intent.providerOrderId, reason: 'Simulated failure (demo)' })
          .catch(function () {})
          .then(function () {
            UI.toast('Payment marked as failed. Retry from My orders.', 'warn');
            s.close();
            return refreshActive();
          })
          .then(resolve);
      });
    });
  }

  /* =========================== ORDERS =========================== */

  function orderCard(o, compact) {
    var payBtn = '';
    if (o.paymentStatus !== 'PAID' && o.paymentMethod === 'ONLINE' && !o.isTerminal) {
      payBtn = '<button class="btn btn-success btn-sm" data-pay="' + esc(o.id) + '">Pay now</button>';
    }
    var trackBtn = !o.isTerminal
      ? '<button class="btn btn-ghost btn-sm" data-track="' + esc(o.id) + '">Track</button>' : '';
    var cancelBtn = o.canCancel
      ? '<button class="btn-link" data-cancel="' + esc(o.id) + '" style="color:var(--danger)">Cancel</button>' : '';

    return (
      '<div class="card mb-1">' +
      '<div class="row-between mb-1"><span class="small strong">' + esc(o.orderNumber) + '</span>' +
      UI.statusBadge(o.status, o.statusLabel) + '</div>' +
      '<div class="row-between"><div class="grow"><div class="strong">' + esc(o.loadType) +
      ' &middot; ' + UI.litres(o.quantityL) + '</div>' +
      '<div class="tiny muted truncate">' + esc(o.deliveryAddressText) + '</div>' +
      '<div class="tiny muted">' + UI.timeAgo(o.createdAt) +
      (o.paymentStatus === 'PAID' ? ' &middot; Paid' : (o.paymentMethod === 'CASH_ON_DELIVERY' ? ' &middot; Cash on delivery' : ' &middot; Unpaid')) +
      (o.isDemoPayment ? ' (demo)' : '') + '</div></div>' +
      '<div class="strong" style="font-size:1.05rem">' + UI.rupees(o.totalRupees) + '</div></div>' +
      (o.driver && !o.isTerminal
        ? '<div class="small mt-1" style="color:var(--aqua-700)">Driver: ' + esc(o.driver.name) +
          (o.driver.phone ? ' &middot; <a href="tel:' + esc(o.driver.phone) + '">' + esc(o.driver.phone) + '</a>' : '') +
          (o.etaMinutes ? ' &middot; ~' + o.etaMinutes + ' min away' : '') + '</div>'
        : '') +
      (compact ? '' : '<div class="row mt-1" style="gap:8px">' + trackBtn + payBtn + cancelBtn + '</div>') +
      '</div>'
    );
  }

  function bindOrderCardActions(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-track]'), function (b) {
      b.addEventListener('click', function () { state.trackingOrderId = b.dataset.track; switchTab('tabTrack'); });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-pay]'), function (b) {
      b.addEventListener('click', function () {
        UI.busy(b, true);
        API.order(b.dataset.pay)
          .then(startPayment)
          .catch(function (e) { UI.toast(e.message, 'error'); })
          .finally(function () { UI.busy(b, false); loadOrders(); });
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-cancel]'), function (b) {
      b.addEventListener('click', function () {
        UI.confirm('Cancel this order? If you already paid, the refund is processed to your original payment method.',
          { danger: true, confirmText: 'Cancel order', cancelText: 'Keep it', title: 'Cancel order' })
          .then(function (yes) {
            if (!yes) return;
            API.cancelOrder(b.dataset.cancel, 'Cancelled by customer')
              .then(function () { UI.toast('Order cancelled', 'success'); refreshActive(); loadOrders(); })
              .catch(function (e) { UI.toast(e.message, 'error'); });
          });
      });
    });
  }

  function loadOrders() {
    var host = $('ordersList');
    UI.skeleton(host, 3);
    return API.orders('?limit=30')
      .then(function (res) {
        var orders = res.data;
        if (!orders.length) {
          UI.empty(host, '', 'No orders yet', 'Your completed and ongoing orders will appear here.');
          return;
        }
        host.innerHTML = orders.map(function (o) { return orderCard(o); }).join('');
        bindOrderCardActions(host);
      })
      .catch(function (e) { UI.errorState(host, e.message, loadOrders); });
  }

  function refreshActive() {
    return API.activeOrders()
      .then(function (orders) {
        state.activeOrders = orders;
        var slot = $('activeOrderSlot');
        if (!orders.length) { slot.innerHTML = ''; return orders; }

        if (!state.trackingOrderId || !orders.some(function (o) { return o.id === state.trackingOrderId; })) {
          state.trackingOrderId = orders[0].id;
        }

        slot.innerHTML =
          '<div class="card" style="border-color:var(--aqua-300);background:var(--aqua-50)">' +
          '<div class="row-between mb-1"><h3 class="mb-0">Active order</h3>' +
          UI.statusBadge(orders[0].status, orders[0].statusLabel) + '</div>' +
          '<div class="small">' + esc(orders[0].loadType) + ' &middot; ' + UI.litres(orders[0].quantityL) +
          (orders[0].etaMinutes ? ' &middot; arriving in about ' + orders[0].etaMinutes + ' min' : '') + '</div>' +
          '<button class="btn btn-primary btn-block btn-sm mt-2" id="goTrack">Track live</button></div>';
        $('goTrack').addEventListener('click', function () { switchTab('tabTrack'); });
        return orders;
      })
      .catch(function () { return []; });
  }

  /* =========================== TRACKING =========================== */

  var TRACK_STEPS = ['CONFIRMED', 'DRIVER_ASSIGNED', 'DRIVER_ACCEPTED', 'OUT_FOR_DELIVERY', 'ARRIVING', 'DELIVERED'];
  var STEP_LABELS = {
    CONFIRMED: 'Order confirmed', DRIVER_ASSIGNED: 'Tanker assigned', DRIVER_ACCEPTED: 'Driver accepted',
    OUT_FOR_DELIVERY: 'On the way', ARRIVING: 'Arriving now', DELIVERED: 'Delivered',
  };

  function renderTracking() {
    var host = $('trackContent');

    if (!state.activeOrders.length) {
      UI.empty(host, '', 'Nothing to track', 'Place an order and you can follow your tanker live on the map.',
        '<button class="btn btn-primary btn-sm mt-1" onclick="document.querySelector(\'[data-tab=tabHome]\').click()">Order water</button>');
      return;
    }

    var order = state.activeOrders.filter(function (o) { return o.id === state.trackingOrderId; })[0] || state.activeOrders[0];
    state.trackingOrderId = order.id;

    var selector = state.activeOrders.length > 1
      ? '<select class="select mb-2" id="trackSelect">' + state.activeOrders.map(function (o) {
          return '<option value="' + esc(o.id) + '"' + (o.id === order.id ? ' selected' : '') + '>' +
            esc(o.orderNumber) + ' - ' + esc(o.loadType) + '</option>';
        }).join('') + '</select>'
      : '';

    var reached = TRACK_STEPS.indexOf(order.status);
    var timeline = TRACK_STEPS.map(function (s, i) {
      var cls = i < reached ? 'done' : (i === reached ? 'done current' : '');
      var isLast = i === TRACK_STEPS.length - 1;
      return (
        '<div class="tl-step ' + cls + '"><div class="tl-rail"><div class="tl-dot"></div>' +
        (isLast ? '' : '<div class="tl-line"></div>') + '</div>' +
        '<div class="tl-body"><div class="tl-title">' + esc(STEP_LABELS[s]) + '</div></div></div>'
      );
    }).join('');

    host.innerHTML =
      selector +
      '<div class="card mb-2">' +
      '<div class="row-between mb-1"><span class="small strong">' + esc(order.orderNumber) + '</span>' +
      UI.statusBadge(order.status, order.statusLabel) + '</div>' +
      '<div class="map map-lg" id="trackMap"></div>' +
      '<div class="row-between mt-2">' +
      '<div><div class="tiny muted">Distance</div><div class="strong" id="trackDistance">' +
      (order.distanceKm !== null && order.distanceKm !== undefined ? order.distanceKm + ' km' : 'Waiting for driver') + '</div></div>' +
      '<div class="center"><div class="tiny muted">Estimated arrival</div><div class="strong" id="trackEta">' +
      (order.etaMinutes ? '~' + order.etaMinutes + ' min' : 'Calculating') + '</div></div>' +
      '<div style="text-align:right"><div class="tiny muted">Total</div><div class="strong">' +
      UI.rupees(order.totalRupees) + '</div></div></div>' +
      (order.driver
        ? '<div class="card-flat mt-2 row"><div class="grow"><div class="tiny muted">Your driver</div>' +
          '<div class="strong">' + esc(order.driver.name) + '</div></div>' +
          (order.driver.phone ? '<a class="btn btn-ghost btn-sm" href="tel:' + esc(order.driver.phone) + '">Call</a>' : '') + '</div>'
        : '<div class="alert alert-info mt-2">We are assigning a tanker to your order.</div>') +
      '</div>' +
      '<div class="card"><h3>Progress</h3><div class="timeline">' + timeline + '</div>' +
      (order.canCancel ? '<button class="btn btn-ghost btn-block btn-sm mt-1" data-cancel="' + esc(order.id) + '">Cancel order</button>' : '') +
      '</div>';

    bindOrderCardActions(host);

    var sel = $('trackSelect');
    if (sel) sel.addEventListener('change', function () { state.trackingOrderId = sel.value; renderTracking(); });

    AquaMaps.load().then(function () {
      if (state.tracker) state.tracker.destroy();
      state.tracker = AquaMaps.createTracker($('trackMap'), { latitude: order.latitude, longitude: order.longitude });
      if (order.driver && order.driver.latitude) {
        state.tracker.updateDriver(order.driver.latitude, order.driver.longitude);
      }
      if (state.socket) state.socket.emit('order:subscribe', { orderId: order.id }, function () {});
    });
  }

  /* =========================== NOTIFICATIONS =========================== */

  function loadNotifications() {
    return API.notifications()
      .then(function (res) {
        state.notifications = res.data;
        var unread = (res.meta && res.meta.unread) || 0;
        [$('notifBadge'), $('railBadge')].forEach(function (badge) {
          if (!badge) return;
          badge.textContent = unread > 9 ? '9+' : String(unread);
          badge.classList.toggle('hidden', unread === 0);
        });

        var host = $('notificationList');
        if (!res.data.length) { UI.empty(host, '', 'No notifications yet', ''); return; }
        host.innerHTML = res.data.slice(0, 12).map(function (n) {
          return '<div style="padding:8px 0;border-bottom:1px solid var(--line)' + (n.readAt ? ';opacity:.6' : '') + '">' +
            '<div class="small strong">' + esc(n.title) + '</div>' +
            '<div class="tiny muted">' + esc(n.body) + '</div>' +
            '<div class="tiny muted">' + UI.timeAgo(n.createdAt) + '</div></div>';
        }).join('');
      })
      .catch(function () {});
  }

  $('markReadBtn').addEventListener('click', function () {
    API.readNotifications().then(loadNotifications).catch(function () {});
  });

  /* =========================== CHATBOT =========================== */

  $('chatFab').addEventListener('click', openChat);

  function openChat() {
    var suggestions = ['Where is my tanker?', 'What are your prices?', 'How do I cancel?', 'Which areas do you deliver to?'];

    var s = UI.sheet(
      '<h2>Support assistant</h2>' +
      '<p class="tiny muted">Answers come from our published service information. For anything else, our team can help.</p>' +
      '<div class="chat-log" id="chatLog"></div>' +
      '<div class="chat-suggestions mt-1" id="chatChips">' +
      suggestions.map(function (q) { return '<button class="chip" data-q="' + esc(q) + '">' + esc(q) + '</button>'; }).join('') +
      '</div>' +
      '<form class="row mt-2" id="chatForm" style="gap:8px">' +
      '<input class="input grow" id="chatInput" placeholder="Ask a question..." maxlength="500" autocomplete="off">' +
      '<button class="btn btn-primary" type="submit">Send</button></form>',
      { noAutoFocus: false }
    );

    var log = s.root.querySelector('#chatLog');

    function draw() {
      log.innerHTML = state.chatHistory.length
        ? state.chatHistory.map(function (m) {
            return '<div class="bubble ' + (m.role === 'user' ? 'user' : 'bot') + '">' + esc(m.content) + '</div>';
          }).join('')
        : '<div class="bubble bot">Hello! I can help with booking water, prices, your order status, payments and cancellations. What do you need?</div>';
      log.scrollTop = log.scrollHeight;
    }
    draw();

    function send(text) {
      if (!text) return;
      state.chatHistory.push({ role: 'user', content: text });
      draw();

      var typing = document.createElement('div');
      typing.className = 'bubble bot typing';
      typing.innerHTML = '<span></span><span></span><span></span>';
      log.appendChild(typing);
      log.scrollTop = log.scrollHeight;

      API.chat({
        message: text,
        conversationId: state.conversationId || undefined,
        history: state.chatHistory.slice(-8, -1),
      })
        .then(function (res) {
          state.conversationId = res.conversationId;
          state.chatHistory.push({ role: 'assistant', content: res.reply });
          draw();
        })
        .catch(function (e) {
          state.chatHistory.push({
            role: 'assistant',
            content: 'I could not reach support just now (' + e.message + '). Please try again in a moment.',
          });
          draw();
        });
    }

    s.root.querySelector('#chatForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = s.root.querySelector('#chatInput');
      var v = input.value.trim();
      input.value = '';
      send(v);
    });

    Array.prototype.forEach.call(s.root.querySelectorAll('[data-q]'), function (b) {
      b.addEventListener('click', function () { send(b.dataset.q); });
    });
  }

  /* =========================== REALTIME =========================== */

  function connectRealtime() {
    state.socket = UI.connectSocket({
      'order:update': function (order) {
        UI.toast(order.statusLabel + ' - ' + order.orderNumber, 'success');
        refreshActive().then(function () {
          if (!$('tabTrack').classList.contains('hidden')) renderTracking();
        });
        if (!$('tabOrders').classList.contains('hidden')) loadOrders();
      },
      'driver:location': function (payload) {
        if (payload.orderId !== state.trackingOrderId) return;
        var d = $('trackDistance');
        var eta = $('trackEta');
        if (d) d.textContent = payload.distanceKm + ' km';
        if (eta) eta.textContent = '~' + payload.etaMinutes + ' min';
        if (state.tracker && state.tracker.available) {
          state.tracker.updateDriver(payload.latitude, payload.longitude);
        }
      },
      notification: function () { loadNotifications(); },
    });

    // Polling fallback when the socket is unavailable. Deliberately slow, and
    // only while an order is actually in flight.
    if (!state.socket) {
      state.pollTimer = setInterval(function () {
        if (!state.activeOrders.length || document.hidden) return;
        refreshActive().then(function () {
          if (!$('tabTrack').classList.contains('hidden')) renderTracking();
        });
      }, 15000);
    }
  }

  /* =========================== BOOT =========================== */

  function boot() {
    showApp();
    state.user = API.getUser();
    $('greeting').textContent = 'Hi, ' + (state.user ? state.user.name.split(' ')[0] : 'there');
    $('accName').textContent = state.user ? state.user.name : '';
    $('accPhone').textContent = state.user ? state.user.phone : '';
    $('avatarInitial').textContent = state.user ? state.user.name.charAt(0).toUpperCase() : '?';

    if (state.config && state.config.demoMode) $('demoBanner').classList.remove('hidden');

    connectRealtime();
    UI.watchConnectivity();

    return Promise.all([loadProducts(), loadAddresses(), refreshActive(), loadNotifications(), loadBusinessInfo()]);
  }

  function loadBusinessInfo() {
    return API.businessInfo()
      .then(function (info) {
        state.businessInfo = info;
        $('businessCard').innerHTML =
          '<h3>' + esc(info.companyName) + '</h3>' +
          '<p class="small muted mb-1">' + esc(info.tagline || '') + '</p>' +
          '<div class="small"><strong>Hours:</strong> ' + esc(info.workingHours) + '</div>' +
          (info.supportPhone ? '<div class="small"><strong>Support:</strong> <a href="tel:' + esc(info.supportPhone) + '">' + esc(info.supportPhone) + '</a></div>' : '') +
          '<div class="small mt-1"><strong>Cancellation:</strong> ' + esc(info.cancellationPolicy) + '</div>';
      })
      .catch(function () {});
  }

  // Start the water backdrop immediately - it should be there before sign-in.
  if (window.AquaScene) window.AquaScene.init({ preset: 'customer' });

  API.config()
    .then(function (cfg) {
      state.config = cfg;
      if (cfg.demoMode) $('demoBanner').classList.remove('hidden');
    })
    .catch(function () {})
    .then(function () {
      if (!API.isSignedIn()) { showAuth(); return; }
      // Validate the stored token against the server before trusting it.
      return API.me()
        .then(function (data) {
          API.setSession(null, data.user);
          if (data.user.role === 'ADMIN') { window.location.href = '/admin'; return; }
          if (data.user.role === 'DRIVER') { window.location.href = '/driver'; return; }
          return boot();
        })
        .catch(function () { API.clearSession(); showAuth(); });
    });
})();
