/*
 * Google Maps loader with a working no-key fallback.
 *
 * The API key is fetched from /api/config (environment-driven) rather than
 * hardcoded in the HTML, so it can be rotated without touching source. When the
 * key is missing or the script fails to load, every function here degrades to a
 * manual coordinate flow instead of throwing.
 */
(function (global) {
  'use strict';

  var loadPromise = null;
  var available = false;
  var loadError = null;

  function load() {
    if (loadPromise) return loadPromise;

    loadPromise = global.AquaAPI.config()
      .then(function (cfg) {
        if (!cfg.mapsEnabled || !cfg.googleMapsApiKey) {
          loadError = 'no-key';
          return false;
        }
        return new Promise(function (resolve) {
          var cb = '__aquaMapsReady';
          var timer = setTimeout(function () { loadError = 'timeout'; resolve(false); }, 12000);

          global[cb] = function () {
            clearTimeout(timer);
            available = true;
            resolve(true);
          };

          var s = document.createElement('script');
          s.src =
            'https://maps.googleapis.com/maps/api/js?key=' +
            encodeURIComponent(cfg.googleMapsApiKey) +
            '&libraries=places&loading=async&callback=' + cb;
          s.async = true;
          s.defer = true;
          s.onerror = function () {
            clearTimeout(timer);
            loadError = 'script-error';
            resolve(false);
          };
          document.head.appendChild(s);
        });
      })
      .catch(function () { loadError = 'config-error'; return false; });

    return loadPromise;
  }

  function isAvailable() { return available; }

  function fallbackMessage() {
    if (loadError === 'no-key') return 'Map preview is unavailable (no Google Maps key configured). You can still use your current location or enter coordinates.';
    return 'The map could not load. You can still use your current location or enter coordinates manually.';
  }

  function renderFallback(el, note) {
    if (!el) return;
    el.classList.add('map-fallback');
    el.innerHTML =
      '<div><div style="font-size:26px;margin-bottom:6px">MAP</div>' +
      '<div class="small">' + global.UI.esc(note || fallbackMessage()) + '</div></div>';
  }

  /** Promise-wrapped geolocation with human-readable failure reasons. */
  function currentPosition(options) {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) {
        reject(new Error('Your browser does not support location access.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
        },
        function (err) {
          var messages = {
            1: 'Location permission was denied. Allow it in your browser settings, or pick the spot on the map.',
            2: 'Your location is unavailable right now. Try again or pick the spot on the map.',
            3: 'Getting your location took too long. Try again or pick the spot on the map.',
          };
          reject(new Error(messages[err.code] || 'Could not get your location.'));
        },
        Object.assign({ enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }, options || {})
      );
    });
  }

  /** Reverse geocode; resolves to null rather than failing the caller. */
  function reverseGeocode(lat, lng) {
    if (!available || !global.google || !global.google.maps) return Promise.resolve(null);
    return new Promise(function (resolve) {
      try {
        new global.google.maps.Geocoder().geocode(
          { location: { lat: lat, lng: lng } },
          function (results, status) {
            resolve(status === 'OK' && results && results[0] ? results[0].formatted_address : null);
          }
        );
      } catch (e) { resolve(null); }
    });
  }

  /**
   * A draggable location picker. The pin stays fixed in the centre and the map
   * moves under it - the standard delivery-app pattern.
   */
  function createPicker(el, initial, onChange) {
    var start = initial || { latitude: 12.9716, longitude: 77.5946 };
    if (!available) {
      renderFallback(el);
      return { setCenter: function () {}, getCenter: function () { return start; }, available: false };
    }

    el.classList.remove('map-fallback');
    var map = new global.google.maps.Map(el, {
      center: { lat: start.latitude, lng: start.longitude },
      zoom: 16,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'greedy',
      clickableIcons: false,
    });

    var settle = null;
    map.addListener('center_changed', function () {
      clearTimeout(settle);
      // Debounce: fire once the user stops panning, not on every frame.
      settle = setTimeout(function () {
        var c = map.getCenter();
        if (onChange) onChange({ latitude: c.lat(), longitude: c.lng() });
      }, 380);
    });

    return {
      available: true,
      map: map,
      setCenter: function (lat, lng, zoom) {
        map.setCenter({ lat: lat, lng: lng });
        if (zoom) map.setZoom(zoom);
      },
      getCenter: function () {
        var c = map.getCenter();
        return { latitude: c.lat(), longitude: c.lng() };
      },
    };
  }

  /** Places autocomplete on a text input. No-op when maps are unavailable. */
  function attachAutocomplete(input, onPlace) {
    if (!available || !global.google.maps.places) return null;
    try {
      var ac = new global.google.maps.places.Autocomplete(input, {
        fields: ['geometry', 'formatted_address', 'name'],
        componentRestrictions: { country: 'in' },
      });
      ac.addListener('place_changed', function () {
        var place = ac.getPlace();
        if (!place || !place.geometry || !place.geometry.location) return;
        onPlace({
          latitude: place.geometry.location.lat(),
          longitude: place.geometry.location.lng(),
          address: place.formatted_address || place.name,
        });
      });
      return ac;
    } catch (e) { return null; }
  }

  /** Live tracking map: destination pin + moving tanker marker. */
  function createTracker(el, destination) {
    if (!available) {
      renderFallback(el, 'Live map preview needs a Google Maps key. Distance and ETA below still update live.');
      return {
        available: false,
        updateDriver: function () {},
        destroy: function () {},
      };
    }

    el.classList.remove('map-fallback');
    var map = new global.google.maps.Map(el, {
      center: { lat: destination.latitude, lng: destination.longitude },
      zoom: 14,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'cooperative',
    });

    new global.google.maps.Marker({
      position: { lat: destination.latitude, lng: destination.longitude },
      map: map,
      title: 'Delivery address',
      icon: {
        path: global.google.maps.SymbolPath.CIRCLE,
        scale: 9, fillColor: '#14a2c3', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3,
      },
    });

    var driverMarker = null;
    var routeLine = null;

    return {
      available: true,
      map: map,
      updateDriver: function (lat, lng) {
        var pos = { lat: lat, lng: lng };
        if (!driverMarker) {
          driverMarker = new global.google.maps.Marker({
            position: pos, map: map, title: 'Your tanker',
            icon: {
              path: global.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
              scale: 6, fillColor: '#0a1a29', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2,
            },
          });
        } else {
          driverMarker.setPosition(pos);
        }

        if (routeLine) routeLine.setMap(null);
        routeLine = new global.google.maps.Polyline({
          path: [pos, { lat: destination.latitude, lng: destination.longitude }],
          strokeColor: '#14a2c3', strokeOpacity: 0.75, strokeWeight: 4, map: map,
        });

        var bounds = new global.google.maps.LatLngBounds();
        bounds.extend(pos);
        bounds.extend({ lat: destination.latitude, lng: destination.longitude });
        map.fitBounds(bounds, 60);
      },
      destroy: function () {
        if (driverMarker) driverMarker.setMap(null);
        if (routeLine) routeLine.setMap(null);
      },
    };
  }

  global.AquaMaps = {
    load: load,
    isAvailable: isAvailable,
    fallbackMessage: fallbackMessage,
    renderFallback: renderFallback,
    currentPosition: currentPosition,
    reverseGeocode: reverseGeocode,
    createPicker: createPicker,
    createTracker: createTracker,
    attachAutocomplete: attachAutocomplete,
  };
})(window);
