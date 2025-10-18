// backend/src/utils/bbox.ts

/**
 * Compute a bounding box around a point (lat, lon) with a radius in km.
 * Returns { minLat, maxLat, minLon, maxLon }
 *
 * Example:
 *   const box = bbox(1.29, 103.85, 50);
 *   => { minLat: 0.84, maxLat: 1.74, minLon: 103.39, maxLon: 104.31 }
 */

const EARTH_RADIUS_KM = 6371; // mean Earth radius in km

export function bbox(lat: number, lon: number, radiusKm: number) {
  const deltaLat = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  const deltaLon =
    (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI) / Math.cos((lat * Math.PI) / 180);

  const minLat = lat - deltaLat;
  const maxLat = lat + deltaLat;
  const minLon = lon - deltaLon;
  const maxLon = lon + deltaLon;

  return { minLat, maxLat, minLon, maxLon };
}

/**
 * Convert bounding box object into query string for AISstream
 */
export function bboxQueryString(lat: number, lon: number, radiusKm: number): string {
  const { minLat, maxLat, minLon, maxLon } = bbox(lat, lon, radiusKm);
  return `minLat=${minLat}&maxLat=${maxLat}&minLon=${minLon}&maxLon=${maxLon}`;
}