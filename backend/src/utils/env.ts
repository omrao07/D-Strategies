// backend/src/utils/env.ts

import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`❌ Missing environment variable: ${key}`);
  }
  return value;
}

export const env = {
  PORT: parseInt(process.env.PORT || '8080', 10),

  // API Keys
  API_NINJAS_KEY: requireEnv('API_NINJAS_KEY'),
  AISSTREAM_API_KEY: requireEnv('AISSTREAM_API_KEY'),

  // Google Earth Engine App URL
  GEE_APP_BASE: requireEnv('GEE_APP_BASE'),
};