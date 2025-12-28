/*
|--------------------------------------------------------------------------
| Google Earth Engine Connector
|--------------------------------------------------------------------------
| Satellite imagery, NDVI, land use, commodity & climate signals
| Typical use: agriculture, logistics, commodity tracking
|--------------------------------------------------------------------------
*/

type GeoBoundingBox = {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

type SatelliteQuery = {
  region: GeoBoundingBox
  startDate: string
  endDate: string
  layer?: "NDVI" | "EVI" | "RAIN" | "TEMPERATURE"
}

/*
|--------------------------------------------------------------------------
| Auth Helper
|--------------------------------------------------------------------------
| Google Earth Engine usually uses service accounts / OAuth
| Here we keep it abstract & env-based
|--------------------------------------------------------------------------
*/

function validateConfig() {
  if (!process.env.GEE_PROJECT_ID) {
    throw new Error("GEE_PROJECT_ID not configured")
  }
}

/* ---------------- NDVI / Vegetation ---------------- */

export async function fetchVegetationIndex(
  query: SatelliteQuery
) {
  validateConfig()

  return {
    provider: "google-earth-engine",
    layer: query.layer ?? "NDVI",
    region: query.region,
    period: {
      from: query.startDate,
      to: query.endDate,
    },
    values: [],
    generatedAt: new Date().toISOString(),
  }

  /*
  Real implementation outline:
  - Authenticate via service account
  - Build ee.Geometry.Rectangle
  - Filter ImageCollection (e.g., MODIS / Sentinel)
  - Compute NDVI/EVI
  - Reduce region to time series
  */
}

/* ---------------- Rainfall / Climate ---------------- */

export async function fetchClimateData(
  query: SatelliteQuery
) {
  validateConfig()

  return {
    provider: "google-earth-engine",
    layer: query.layer ?? "RAIN",
    region: query.region,
    period: {
      from: query.startDate,
      to: query.endDate,
    },
    values: [],
    generatedAt: new Date().toISOString(),
  }

  /*
  Typical datasets:
  - CHIRPS (rainfall)
  - ERA5 (temperature)
  - NOAA datasets
  */
}