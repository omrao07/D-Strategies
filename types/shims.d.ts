// shims.d.ts
// Type declarations for non-TS modules, JSON imports, and globals

// Allow importing JSON files as objects
declare module "*.json" {
  const value: any;
  export default value;
}

// Allow importing SVG/PNG/etc. as strings (for assets in templates/UI)
declare module "*.svg" {
  const value: string;
  export default value;
}
declare module "*.png" {
  const value: string;
  export default value;
}
declare module "*.jpg" {
  const value: string;
  export default value;
}
declare module "*.css" {
  const value: string;
  export default value;
}

// Allow imports of .mjs and .cjs files
declare module "*.mjs";
declare module "*.cjs";

// Extend Node.js process.env typing for our custom keys
declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV?: string;
    PORT?: string;
    API_NINJAS_KEY?: string;
    AISSTREAM_API_KEY?: string;
    GEE_APP_BASE?: string;
  }
}

declare var __dirname: string;
declare var module: any;
declare var require: any;

// Shim for fetch in Node if not using dom lib
declare function fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;

// Generic fallback for any "missing" module
declare module "*";