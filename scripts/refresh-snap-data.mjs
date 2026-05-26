#!/usr/bin/env node
/**
 * Refresh data/snap-mecklenburg.json from USDA SNAP Retailer Locator (FNS ArcGIS).
 * Same dataset as the published USDA CSV download.
 *
 * Usage: node scripts/refresh-snap-data.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL =
  'https://services1.arcgis.com/RLQu0rK7h4kbsBq5/arcgis/rest/services/snap_retailer_location_data/FeatureServer/0/query?where=State%3D%27NC%27%20AND%20County%3D%27MECKLENBURG%27&outFields=Store_Name,Store_Street_Address,City,State,Zip_Code,Store_Type,Latitude,Longitude&returnGeometry=false&f=json&resultRecordCount=2000';

const res = await fetch(URL);
if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
const data = await res.json();

const rows = (data.features || [])
  .map((f) => {
    const a = f.attributes;
    const lat = parseFloat(a.Latitude);
    const lng = parseFloat(a.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      name: a.Store_Name || 'SNAP Retailer',
      lat,
      lng,
      address: [a.Store_Street_Address, a.City, a.State, a.Zip_Code]
        .filter(Boolean)
        .join(', '),
      category: 'snap',
      storeType: a.Store_Type ?? '',
    };
  })
  .filter(Boolean);

writeFileSync(join(ROOT, 'data', 'snap-mecklenburg.json'), JSON.stringify(rows));
console.log(`Wrote ${rows.length} SNAP retailers to data/snap-mecklenburg.json`);
