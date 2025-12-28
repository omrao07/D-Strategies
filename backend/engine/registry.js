/**
 * registry.js
 *
 * Engine-facing registry reader.
 * Consumes artifacts produced by data_ext/registrybridge.py
 *
 * Responsibilities:
 * - Load datasets, features, lineage
 * - Provide lookup & discovery APIs
 * - Remain read-only and deterministic
 */

import fs from "fs";
import path from "path";

/* ============================
   Helpers
   ============================ */

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/* ============================
   Registry
   ============================ */

export class Registry {
  constructor(root = "registry") {
    this.root = root;

    this._datasets = null;
    this._features = null;
    this._lineage = null;
  }

  /* =========================
     Internal Loaders
     ========================= */

  _load(kind) {
    const dir = path.join(this.root, kind);
    const files = listDirSafe(dir);

    const out = new Map();
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const obj = readJSON(path.join(dir, f));
      out.set(obj.id, obj);
    }
    return out;
  }

  _ensureLoaded() {
    if (!this._datasets) this._datasets = this._load("datasets");
    if (!this._features) this._features = this._load("features");
    if (!this._lineage) this._lineage = this._load("lineage");
  }

  /* =========================
     Public APIs
     ========================= */

  datasets() {
    this._ensureLoaded();
    return Array.from(this._datasets.values());
  }

  features() {
    this._ensureLoaded();
    return Array.from(this._features.values());
  }

  lineage() {
    this._ensureLoaded();
    return Array.from(this._lineage.values());
  }

  /* =========================
     Lookups
     ========================= */

  getDataset(id) {
    this._ensureLoaded();
    return this._datasets.get(id) || null;
  }

  getFeature(id) {
    this._ensureLoaded();
    return this._features.get(id) || null;
  }

  /* =========================
     Queries
     ========================= */

  featuresByRegion(region) {
    this._ensureLoaded();
    return this.features().filter(f => f.region === region);
  }

  featuresByMetric(metric) {
    this._ensureLoaded();
    return this.features().filter(f => f.metric === metric);
  }

  datasetsByRegion(region) {
    this._ensureLoaded();
    return this.datasets().filter(d => d.region === region);
  }

  featuresForDataset(datasetId) {
    this._ensureLoaded();
    const links = this.lineage().filter(l => l.dataset_id === datasetId);
    return links
      .map(l => this._features.get(l.feature_id))
      .filter(Boolean);
  }

  datasetsForFeature(featureId) {
    this._ensureLoaded();
    const links = this.lineage().filter(l => l.feature_id === featureId);
    return links
      .map(l => this._datasets.get(l.dataset_id))
      .filter(Boolean);
  }

  /* =========================
     Refresh (optional)
     ========================= */

  refresh() {
    this._datasets = null;
    this._features = null;
    this._lineage = null;
  }
}

/* ============================
   Example Usage
   ============================ */

if (import.meta.url === `file://${process.argv[1]}`) {
  const registry = new Registry("registry");

  console.log("Datasets:", registry.datasets().length);
  console.log("Features:", registry.features().length);

  const usFeatures = registry.featuresByRegion("US");
  console.log("US Features:", usFeatures.map(f => f.name));
}