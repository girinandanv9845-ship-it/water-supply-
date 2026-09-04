'use strict';

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in kilometres. */
function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Straight-line ETA with a road-winding factor. Deliberately conservative and
 * clearly an estimate - we never present it as a routed, traffic-aware time
 * unless the Directions API is wired up.
 */
const ROAD_FACTOR = 1.35;
const AVG_SPEED_KMPH = 24; // loaded tanker in mixed city traffic

function estimateEtaMinutes(distanceKm, { speedKmph = AVG_SPEED_KMPH } = {}) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return null;
  const minutes = ((distanceKm * ROAD_FACTOR) / speedKmph) * 60;
  // Floor at 2 minutes: "0 min away" reads as broken to a customer.
  return Math.max(2, Math.round(minutes));
}

function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

module.exports = { haversineKm, estimateEtaMinutes, isValidLatLng, EARTH_RADIUS_KM };
