import {
  allowedDateRangeTypes,
  allowedDirections,
  allowedFeatures,
  allowedImportance,
  allowedObjectiveDirections,
  allowedObjectiveFeatures,
  allowedPeriods,
  allowedRelaxationDirections,
  allowedTransportModes,
} from './schema.mjs';

const nullableString = { type: ['string', 'null'] };
const nullableBoolean = { type: ['boolean', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const nullableInteger = { type: ['integer', 'null'] };
const timeSchema = {
  type: ['string', 'null'],
  pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
};
const dateSchema = {
  type: ['string', 'null'],
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
};

function strictObject(properties) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function nullableStrictObject(properties) {
  return {
    ...strictObject(properties),
    type: ['object', 'null'],
  };
}

const timeRangeSchema = strictObject({
  start: timeSchema,
  end: timeSchema,
});

const dateRangeSchema = nullableStrictObject({
  type: {
    type: ['string', 'null'],
    enum: [...allowedDateRangeTypes, null],
  },
  startDate: dateSchema,
  endDate: dateSchema,
  value: nullableString,
  sourceText: nullableString,
});

const startTimeRuleSchema = nullableStrictObject({
  before: timeSchema,
  after: timeSchema,
  equals: timeSchema,
  between: {
    anyOf: [timeRangeSchema, { type: 'null' }],
  },
  exclude: {
    type: ['array', 'null'],
    items: timeRangeSchema,
  },
  period: {
    type: ['string', 'null'],
    enum: [...allowedPeriods, null],
  },
});

const priceRuleSchema = nullableStrictObject({
  max: nullableNumber,
  min: nullableNumber,
  preferredRange: nullableStrictObject({
    min: nullableNumber,
    max: nullableNumber,
  }),
});

const listRuleSchema = nullableStrictObject({
  include: {
    type: ['array', 'null'],
    items: { type: 'string' },
  },
  exclude: {
    type: ['array', 'null'],
    items: { type: 'string' },
  },
  values: {
    type: ['array', 'null'],
    items: { type: 'string' },
  },
});

const durationRuleSchema = nullableStrictObject({
  exactMinutes: nullableInteger,
  minMinutes: nullableInteger,
  maxMinutes: nullableInteger,
});

const consecutiveAvailabilityRuleSchema = nullableStrictObject({
  minMinutes: nullableInteger,
  preferredMinutes: nullableInteger,
});

const courtCountRuleSchema = nullableStrictObject({
  exact: nullableInteger,
  min: nullableInteger,
  max: nullableInteger,
});

const adjacencyRuleSchema = nullableStrictObject({
  required: nullableBoolean,
  preferred: nullableBoolean,
});

const travelTimeRuleSchema = nullableStrictObject({
  maxMinutes: nullableInteger,
  preferredMaxMinutes: nullableInteger,
  maxTransitMinutes: nullableInteger,
  maxWalkMinutes: nullableInteger,
  preferredTransportModes: {
    type: ['array', 'null'],
    items: { type: 'string', enum: [...allowedTransportModes] },
  },
});

const weatherRuleSchema = nullableStrictObject({
  condition: {
    type: ['string', 'null'],
    enum: ['no_rain', 'no_precipitation', 'not_too_hot', 'comfortable', null],
  },
  maxTemperatureC: nullableNumber,
});

const nextHourFreeRuleSchema = nullableStrictObject({
  preferredMinutes: nullableInteger,
});

const ruleByFeature = {
  price: priceRuleSchema,
  next_hour_free: nextHourFreeRuleSchema,
  start_time: startTimeRuleSchema,
  date: nullableStrictObject({ dateRange: dateRangeSchema }),
  court: listRuleSchema,
  venue: listRuleSchema,
  area: listRuleSchema,
  surface: listRuleSchema,
  venue_setting: listRuleSchema,
  travel_time: travelTimeRuleSchema,
  weather: weatherRuleSchema,
  duration: durationRuleSchema,
  consecutive_availability: consecutiveAvailabilityRuleSchema,
  court_count: courtCountRuleSchema,
  adjacency: adjacencyRuleSchema,
};

function preferenceItemSchema(feature, type) {
  return strictObject({
    feature: { type: 'string', enum: [feature] },
    type: { type: 'string', enum: [type] },
    importance: { type: 'string', enum: [...allowedImportance] },
    priority: { type: 'string', enum: [...allowedImportance] },
    relaxable: type === 'hard' ? { type: 'boolean', enum: [false] } : { type: 'boolean' },
    relaxationDirection: type === 'hard'
      ? { type: ['string', 'null'], enum: [null] }
      : { type: ['string', 'null'], enum: [...allowedRelaxationDirections, null] },
    sourceText: nullableString,
    direction: {
      type: ['string', 'null'],
      enum: [...allowedDirections, null],
    },
    target: nullableBoolean,
    value: nullableString,
    rule: ruleByFeature[feature],
  });
}

const softPreferenceSchema = {
  anyOf: [...allowedFeatures].map((feature) => preferenceItemSchema(feature, 'soft')),
};

const hardConstraintSchema = {
  anyOf: [...allowedFeatures].map((feature) => preferenceItemSchema(feature, 'hard')),
};

const objectiveSchema = strictObject({
  feature: {
    type: 'string',
    enum: [...allowedObjectiveFeatures],
  },
  direction: {
    type: 'string',
    enum: [...allowedObjectiveDirections],
  },
  priority: {
    type: 'string',
    enum: [...allowedImportance],
  },
  sourceText: nullableString,
});

const searchScopeSchema = strictObject({
  days: { type: 'integer', minimum: 1, maximum: 30 },
  dateRange: dateRangeSchema,
  timeWindow: startTimeRuleSchema,
  location: nullableString,
  sourceText: nullableString,
});

const transportPreferenceSchema = strictObject({
  maxTransitMinutes: nullableInteger,
  maxWalkMinutes: nullableInteger,
  preferredTransportModes: {
    type: ['array', 'null'],
    items: { type: 'string', enum: [...allowedTransportModes] },
  },
});

const unresolvedPreferenceSchema = strictObject({
  text: { type: 'string' },
  reason: nullableString,
  sourceText: nullableString,
});

const openAiPreferenceProfileJsonSchema = strictObject({
  version: { type: 'integer', enum: [2] },
  searchWindowDays: { type: 'integer', minimum: 1, maximum: 30 },
  searchScope: searchScopeSchema,
  transportPreference: transportPreferenceSchema,
  preferences: {
    type: 'array',
    items: softPreferenceSchema,
  },
  hardConstraints: {
    type: 'array',
    items: hardConstraintSchema,
  },
  objectives: {
    type: 'array',
    items: objectiveSchema,
  },
  unresolvedPreferences: {
    type: 'array',
    items: unresolvedPreferenceSchema,
  },
  sourceText: { type: 'string' },
  updatedAt: { type: 'string' },
});

function collectObjectSchemas(schema, path = '#', out = []) {
  if (!schema || typeof schema !== 'object') return out;

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) out.push({ path, schema });

  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    collectObjectSchemas(child, `${path}/properties/${key}`, out);
  }

  if (schema.items) collectObjectSchemas(schema.items, `${path}/items`, out);
  for (const [index, child] of (schema.anyOf ?? []).entries()) {
    collectObjectSchemas(child, `${path}/anyOf/${index}`, out);
  }
  for (const [index, child] of (schema.oneOf ?? []).entries()) {
    collectObjectSchemas(child, `${path}/oneOf/${index}`, out);
  }
  for (const [index, child] of (schema.allOf ?? []).entries()) {
    collectObjectSchemas(child, `${path}/allOf/${index}`, out);
  }
  for (const [key, child] of Object.entries(schema.$defs ?? {})) {
    collectObjectSchemas(child, `${path}/$defs/${key}`, out);
  }

  return out;
}

function assertOpenAiStrictObjectSchema(schema) {
  const failures = [];

  for (const { path, schema: objectSchema } of collectObjectSchemas(schema)) {
    if (objectSchema.additionalProperties !== false) {
      failures.push(`${path} must set additionalProperties=false`);
    }

    const propertyNames = Object.keys(objectSchema.properties ?? {});
    const required = objectSchema.required ?? [];
    if (!Array.isArray(required)) {
      failures.push(`${path} must have required array`);
      continue;
    }

    for (const propertyName of propertyNames) {
      if (!required.includes(propertyName)) {
        failures.push(`${path} required is missing ${propertyName}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`OpenAI strict schema audit failed:\n${failures.join('\n')}`);
  }

  return true;
}

export {
  assertOpenAiStrictObjectSchema,
  collectObjectSchemas,
  openAiPreferenceProfileJsonSchema,
};
