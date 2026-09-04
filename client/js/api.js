/* AquaFlow client API layer - shared by customer, admin and driver pages. */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'aquaflow.token';
  var USER_KEY = 'aquaflow.user';

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }
  function setSession(token, user) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch (e) { /* private mode */ }
  }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
  }
  function clearSession() {
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch (e) {}
  }

  /** Thrown for any non-2xx response; carries the server's structured error. */
  function ApiError(message, status, code, details) {
    var err = new Error(message);
    err.name = 'ApiError';
    err.status = status;
    err.code = code;
    err.details = details;
    return err;
  }

  function request(method, path, body, options) {
    options = options || {};
    var headers = { Accept: 'application/json' };
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';

    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, options.timeout || 20000) : null;

    return fetch(path, {
      method: method,
      headers: headers,
      credentials: 'same-origin',
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
      signal: controller ? controller.signal : undefined,
    })
      .then(function (res) {
        if (timer) clearTimeout(timer);
        return res
          .json()
          .catch(function () { return { success: false, error: { message: 'Unexpected server response.' } }; })
          .then(function (json) {
            if (!res.ok || json.success === false) {
              var e = json.error || {};
              // An expired/!revoked session should bounce the user to sign-in.
              if (res.status === 401) {
                clearSession();
                global.dispatchEvent(new CustomEvent('aquaflow:signed-out'));
              }
              throw ApiError(e.message || 'Request failed', res.status, e.code, e.details);
            }
            return json;
          });
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        if (err.name === 'AbortError') throw ApiError('The request timed out. Check your connection.', 0, 'TIMEOUT');
        if (err.name === 'ApiError') throw err;
        throw ApiError('Cannot reach the server. Check your internet connection.', 0, 'NETWORK');
      });
  }

  function unwrap(p) { return p.then(function (json) { return json.data; }); }

  var api = {
    ApiError: ApiError,
    getToken: getToken,
    getUser: getUser,
    setSession: setSession,
    clearSession: clearSession,
    isSignedIn: function () { return Boolean(getToken()); },

    raw: request,
    get: function (p, o) { return unwrap(request('GET', p, null, o)); },
    getFull: function (p, o) { return request('GET', p, null, o); },
    post: function (p, b, o) { return unwrap(request('POST', p, b, o)); },
    patch: function (p, b, o) { return unwrap(request('PATCH', p, b, o)); },
    put: function (p, b, o) { return unwrap(request('PUT', p, b, o)); },
    del: function (p, o) { return unwrap(request('DELETE', p, null, o)); },

    /* ---------- typed helpers ---------- */
    config: function () { return api.get('/api/config'); },
    health: function () { return api.get('/api/health'); },
    products: function () { return api.get('/api/products'); },
    businessInfo: function () { return api.get('/api/business-info'); },
    serviceability: function (lat, lng) {
      return api.get('/api/serviceability?latitude=' + lat + '&longitude=' + lng);
    },

    requestOtp: function (phone) { return api.post('/api/auth/otp/request', { phone: phone }); },
    verifyOtp: function (payload) {
      return api.post('/api/auth/otp/verify', payload).then(function (data) {
        api.setSession(data.token, data.user);
        return data;
      });
    },
    adminLogin: function (phone, password) {
      return api.post('/api/auth/admin/login', { phone: phone, password: password }).then(function (data) {
        api.setSession(data.token, data.user);
        return data;
      });
    },
    me: function () { return api.get('/api/auth/me'); },
    logout: function () {
      return api.post('/api/auth/logout', {}).catch(function () { return null; }).then(function () {
        api.clearSession();
      });
    },

    addresses: function () { return api.get('/api/addresses'); },
    createAddress: function (a) { return api.post('/api/addresses', a); },
    deleteAddress: function (id) { return api.del('/api/addresses/' + id); },

    createOrder: function (o) { return api.post('/api/orders', o); },
    orders: function (q) { return api.getFull('/api/orders' + (q || '')); },
    activeOrders: function () { return api.get('/api/orders/active'); },
    order: function (id) { return api.get('/api/orders/' + id); },
    track: function (id) { return api.get('/api/orders/' + id + '/track'); },
    cancelOrder: function (id, reason) { return api.post('/api/orders/' + id + '/cancel', { reason: reason }); },

    createPayment: function (orderId) { return api.post('/api/payments/create', { orderId: orderId }); },
    verifyPayment: function (p) { return api.post('/api/payments/verify', p); },
    failPayment: function (p) { return api.post('/api/payments/failed', p); },

    notifications: function () { return api.getFull('/api/notifications'); },
    readNotifications: function (ids) { return api.post('/api/notifications/read', { ids: ids }); },

    chat: function (payload) { return api.post('/api/chat', payload); },

    driver: {
      me: function () { return api.get('/api/driver/me'); },
      orders: function (scope) { return api.get('/api/driver/orders?scope=' + (scope || 'active')); },
      setStatus: function (id, status, note) {
        return api.post('/api/driver/orders/' + id + '/status', { status: status, note: note });
      },
      location: function (lat, lng, heading) {
        return api.post('/api/driver/location', { latitude: lat, longitude: lng, heading: heading });
      },
      availability: function (available) { return api.post('/api/driver/availability', { available: available }); },
    },

    admin: {
      stats: function () { return api.get('/api/admin/stats'); },
      live: function () { return api.get('/api/admin/live'); },
      orders: function (q) { return api.getFull('/api/admin/orders' + (q || '')); },
      assignDriver: function (id, driverId, vehicleId) {
        return api.post('/api/admin/orders/' + id + '/assign-driver', { driverId: driverId, vehicleId: vehicleId });
      },
      setOrderStatus: function (id, status, note) {
        return api.post('/api/admin/orders/' + id + '/status', { status: status, note: note });
      },
      drivers: function () { return api.get('/api/admin/drivers'); },
      createDriver: function (d) { return api.post('/api/admin/drivers', d); },
      updateDriver: function (id, d) { return api.patch('/api/admin/drivers/' + id, d); },
      vehicles: function () { return api.get('/api/admin/vehicles'); },
      createVehicle: function (v) { return api.post('/api/admin/vehicles', v); },
      updateVehicle: function (id, v) { return api.patch('/api/admin/vehicles/' + id, v); },
      products: function () { return api.get('/api/admin/products'); },
      createProduct: function (p) { return api.post('/api/admin/products', p); },
      updateProduct: function (id, p) { return api.patch('/api/admin/products/' + id, p); },
      customers: function (q) { return api.getFull('/api/admin/customers' + (q || '')); },
      updateCustomer: function (id, b) { return api.patch('/api/admin/customers/' + id, b); },
      payments: function (q) { return api.getFull('/api/admin/payments' + (q || '')); },
      serviceAreas: function () { return api.get('/api/admin/service-areas'); },
      createServiceArea: function (a) { return api.post('/api/admin/service-areas', a); },
      deleteServiceArea: function (id) { return api.del('/api/admin/service-areas/' + id); },
      businessInfo: function () { return api.get('/api/admin/business-info'); },
      saveBusinessInfo: function (b) { return api.put('/api/admin/business-info', b); },
      support: function () { return api.get('/api/admin/support'); },
    },
  };

  global.AquaAPI = api;
})(window);
