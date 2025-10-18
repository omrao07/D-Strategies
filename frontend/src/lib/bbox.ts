/**
 * Bounding box helpers
 *
 * Used for AISstream (ship tracking) and any spatial query logic.
 */

export type BBox = {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
};

const EARTH_RADIUS_KM = 6371; // average Earth radius

/**
 * Compute a bounding box given a center point and radius in km.
 */
export function bboxFromCenter(lat: number, lon: number, km: number): BBox {
  const deltaLat = (km / EARTH_RADIUS_KM) * (180 / Math.PI);
  const deltaLon =
    (km / EARTH_RADIUS_KM) *
    (180 / Math.PI) /
    Math.cos((lat * Math.PI) / 180);

  return {
    minLat: lat - deltaLat,
    maxLat: lat + deltaLat,
    minLon: lon - deltaLon,
    maxLon: lon + deltaLon,
  };
}

/**
 * Convert a bounding box into a query string for APIs.
 */
export function bboxToQuery(bbox: BBox): string {
  return `minLat=${bbox.minLat}&minLon=${bbox.minLon}&maxLat=${bbox.maxLat}&maxLon=${bbox.maxLon}`;
}

/**
 * Check if a point is inside a bounding box.
 */
export function bboxContains(bbox: BBox, lat: number, lon: number): boolean {
  return (
    lat >= bbox.minLat &&
    lat <= bbox.maxLat &&
    lon >= bbox.minLon &&
    lon <= bbox.maxLon
  );
}