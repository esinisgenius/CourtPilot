import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { INITIAL_RADIUS_METERS } from './radius.mjs';
import { isValidCoordinate } from './geo.mjs';

const DEFAULT_SAVED_AREAS_PATH = resolve(process.cwd(), 'data/saved-play-areas.json');

class SavedPlayAreasError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'SavedPlayAreasError';
    this.code = 'SAVED_PLAY_AREAS_ERROR';
    this.issues = issues;
  }
}

function validateSavedPlayArea(area) {
  const issues = [];
  if (!area || typeof area !== 'object' || Array.isArray(area)) {
    return ['area must be an object'];
  }
  if (typeof area.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(area.id)) {
    issues.push('area.id must be a stable string id');
  }
  if (typeof area.label !== 'string' || area.label.trim().length === 0) {
    issues.push('area.label must be a non-empty string');
  }
  if (!isValidCoordinate(area.center)) {
    issues.push('area.center must contain valid lat/lng');
  }
  if (area.defaultRadiusMeters !== undefined
    && (!Number.isInteger(area.defaultRadiusMeters) || area.defaultRadiusMeters <= 0)) {
    issues.push('area.defaultRadiusMeters must be a positive integer when present');
  }
  return issues;
}

function normalizeSavedPlayArea(area) {
  const issues = validateSavedPlayArea(area);
  if (issues.length > 0) throw new SavedPlayAreasError('Invalid saved play area', issues);

  return {
    id: area.id,
    label: area.label,
    center: {
      lat: area.center.lat,
      lng: area.center.lng,
    },
    defaultRadiusMeters: area.defaultRadiusMeters ?? INITIAL_RADIUS_METERS,
  };
}

function normalizeSavedPlayAreasDocument(document) {
  const issues = [];
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new SavedPlayAreasError('Saved play areas document must be an object', ['document must be an object']);
  }
  if (document.version !== 1) issues.push('version must be 1');
  if (!Array.isArray(document.areas)) issues.push('areas must be an array');
  if (issues.length > 0) throw new SavedPlayAreasError('Invalid saved play areas document', issues);

  const seen = new Set();
  const areas = document.areas.map((area) => normalizeSavedPlayArea(area));
  for (const area of areas) {
    if (seen.has(area.id)) throw new SavedPlayAreasError('Duplicate saved play area id', [`duplicate area id ${area.id}`]);
    seen.add(area.id);
  }

  return {
    version: 1,
    areas,
  };
}

async function loadSavedPlayAreasDocument({ filePath = DEFAULT_SAVED_AREAS_PATH } = {}) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return normalizeSavedPlayAreasDocument(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, areas: [] };
    if (error instanceof SavedPlayAreasError) throw error;
    throw new SavedPlayAreasError('Failed to load saved play areas', [error.message]);
  }
}

async function listSavedPlayAreas(options = {}) {
  const document = await loadSavedPlayAreasDocument(options);
  return document.areas;
}

async function getSavedPlayArea(id, options = {}) {
  const areas = await listSavedPlayAreas(options);
  return areas.find((area) => area.id === id) ?? null;
}

async function saveSavedPlayArea(area, { filePath = DEFAULT_SAVED_AREAS_PATH } = {}) {
  const normalized = normalizeSavedPlayArea(area);
  const document = await loadSavedPlayAreasDocument({ filePath });
  const areas = document.areas.filter((existing) => existing.id !== normalized.id);
  areas.push(normalized);
  areas.sort((a, b) => a.id.localeCompare(b.id));

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ version: 1, areas }, null, 2)}\n`, 'utf8');
  return normalized;
}

export {
  DEFAULT_SAVED_AREAS_PATH,
  SavedPlayAreasError,
  getSavedPlayArea,
  listSavedPlayAreas,
  loadSavedPlayAreasDocument,
  normalizeSavedPlayArea,
  normalizeSavedPlayAreasDocument,
  saveSavedPlayArea,
  validateSavedPlayArea,
};
