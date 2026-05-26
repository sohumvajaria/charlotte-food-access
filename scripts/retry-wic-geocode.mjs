#!/usr/bin/env node
/**
 * Re-geocode WIC clinics missing from data/wic-nc.json (after parse-wic.mjs).
 * Usage: node scripts/retry-wic-geocode.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(ROOT, 'data', 'wic-nc.json');
const PDF_URL =
  'https://www.ncdhhs.gov/ladirectorylist2272025publication/open';
const NOMINATIM_DELAY_MS = 2000;
const USER_AGENT = 'ProvideApp/1.0 (NC WIC directory; contact: local-dev)';

function shouldStopCollect(line) {
  return (
    /WIC Clinic Location/i.test(line) ||
    /Contact Information/i.test(line) ||
    /^Appointments:/i.test(line) ||
    /^Clinic Phone Number:/i.test(line) ||
    /^North Carolina Local WIC/i.test(line) ||
    /^Date of Publication:/i.test(line) ||
    /^WIC Director/i.test(line) ||
    /^Primary Phone Number:/i.test(line) ||
    /^\d{1,3}$/.test(line)
  );
}

async function extractPdfLines() {
  const res = await fetch(PDF_URL);
  if (!res.ok) throw new Error(`PDF fetch failed: ${res.status}`);
  const pdf = await getDocument({ data: await res.arrayBuffer() }).promise;
  const allLines = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const lineMap = new Map();

    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      if (!lineMap.has(y)) lineMap.set(y, []);
      lineMap.get(y).push({ x: item.transform[4], str: item.str });
    }

    const pageLines = [...lineMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, parts]) =>
        parts
          .sort((a, b) => a.x - b.x)
          .map((p) => p.str)
          .join(' ')
          .trim()
      )
      .filter(Boolean);

    allLines.push(...pageLines);
  }

  return allLines;
}

function parseClinics(lines) {
  const clinics = [];
  let agency = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      /County|Health|District|Services|Alliance|Center/i.test(line) &&
      !/Clinic Phone|Appointments|Email|Phone Number|Fax|Website|Director|Coordinator/i.test(
        line
      ) &&
      !/WIC Clinic Location|Contact Information|North Carolina Local/i.test(line)
    ) {
      agency = line;
    }

    const phoneMatch = line.match(/^Clinic Phone Number:\s*([\d()-]+)/);
    if (!phoneMatch) continue;

    const phone = phoneMatch[1].trim();
    const cityMatch = lines[i - 1]?.match(
      /^(.+),\s*North Carolina\s+(\d{5}(?:-\d{4})?)\s*$/
    );
    if (!cityMatch) continue;

    const city = cityMatch[1].trim();
    const zip = cityMatch[2];
    const block = [];

    for (let j = i - 2; j >= 0; j--) {
      if (shouldStopCollect(lines[j])) break;
      block.unshift(lines[j]);
    }

    if (!block.length) continue;

    const digitIdx = block.findIndex((part) => /^\d/.test(part));
    let name;
    let street;

    if (digitIdx === -1) {
      name = agency || block[0];
      street = block[block.length - 1];
    } else if (digitIdx === 0) {
      name = agency || 'WIC Clinic';
      street = block.join(', ');
    } else {
      const localName = block.slice(0, digitIdx).join(' - ');
      street = block.slice(digitIdx).join(', ');
      if (localName === agency || block.slice(0, digitIdx).every((p) => p === agency)) {
        name = agency || localName;
      } else if (agency && !localName.includes(agency)) {
        name = `${agency} - ${localName}`;
      } else {
        name = localName;
      }
    }

    const address = `${street}, ${city}, NC ${zip}`;
    clinics.push({
      name: name.trim(),
      street,
      city,
      zip,
      address,
      phone,
      category: 'wic',
    });
  }

  return clinics;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function nominatimSearch(params) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (res.status === 429) return null;
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();
  const lat = parseFloat(data[0]?.lat);
  const lng = parseFloat(data[0]?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function normalizeStreet(street) {
  return street
    .replace(/\bSuite\s+/gi, 'Suite ')
    .replace(/\bSte\.?\s+/gi, 'Suite ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function geocodeViaCensus(address) {
  const url = new URL(
    'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
  );
  url.searchParams.set('address', address);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('format', 'json');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Census geocoder ${res.status}`);
  const data = await res.json();
  const match = data.result?.addressMatches?.[0];
  const lat = parseFloat(match?.coordinates?.y);
  const lng = parseFloat(match?.coordinates?.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function geocodeClinic(clinic) {
  const { street, city, zip, address } = clinic;
  const streetNorm = normalizeStreet(street);
  const censusAddress = `${streetNorm}, ${city}, NC ${zip}`;
  const censusCoords = await geocodeViaCensus(censusAddress);
  if (censusCoords) return censusCoords;

  const attempts = [
    { street: streetNorm, city, state: 'NC', postalcode: zip, country: 'USA' },
    { q: `${censusAddress}, USA` },
    { q: `${address}, USA` },
    { q: `${streetNorm.split(',')[0]}, ${city}, NC ${zip}` },
    { city, state: 'North Carolina', postalcode: zip, country: 'USA' },
  ];

  for (const params of attempts) {
    const coords = await nominatimSearch(params);
    if (coords) return coords;
    await sleep(1500);
  }

  throw new Error(`No coordinates for: ${address}`);
}

function clinicKey(c) {
  return `${c.name}|${c.address}|${c.phone}`;
}

async function main() {
  const existing = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  const existingKeys = new Set(existing.map(clinicKey));

  console.log(`Existing geocoded clinics: ${existing.length}`);
  console.log('Parsing PDF for full clinic list…');
  const parsed = parseClinics(await extractPdfLines());
  console.log(`Parsed ${parsed.length} clinics from PDF`);

  const missing = parsed.filter((c) => !existingKeys.has(clinicKey(c)));
  console.log(`Retrying geocode for ${missing.length} missing clinics…`);

  const added = [];
  let failed = 0;

  for (let i = 0; i < missing.length; i++) {
    const clinic = missing[i];
    process.stdout.write(`Retry ${i + 1}/${missing.length}: ${clinic.name.slice(0, 48)}…\r`);

    try {
      const { lat, lng } = await geocodeClinic(clinic);
      const { street, city, zip, ...saved } = clinic;
      const row = { ...saved, lat, lng };
      added.push(row);
      existingKeys.add(clinicKey(clinic));
    } catch (err) {
      failed++;
      console.warn(`\nSkip (${clinic.name}): ${err.message}`);
    }

    if (i < missing.length - 1) await sleep(NOMINATIM_DELAY_MS);
  }

  const merged = [...existing, ...added];
  writeFileSync(OUT_PATH, JSON.stringify(merged, null, 2));
  console.log(`\nAdded ${added.length} clinics (${failed} still failed)`);
  console.log(`Loaded ${merged.length} NC WIC clinics`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
