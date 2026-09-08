const SYDNEY_TIME_ZONE = 'Australia/Sydney';
const ISO_WITH_TIMEZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

function addMinutesToLocalIso(localIso, minutesToAdd) {
  const match = String(localIso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) throw new Error(`Invalid local ISO datetime: ${localIso}`);
  const [, year, month, day, hour, minute, second = '00'] = match;
  const date = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute) + minutesToAdd,
    Number(second),
  ));
  return date.toISOString().slice(0, 19);
}

function sydneyOffsetForLocalIso(localIso) {
  const probe = new Date(`${String(localIso).slice(0, 19)}Z`);
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: SYDNEY_TIME_ZONE,
    timeZoneName: 'longOffset',
    hour: '2-digit',
  }).formatToParts(probe);
  const value = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+10:00';
  const match = value.match(/GMT([+-]\d{2}):?(\d{2})?/);
  if (!match) return '+10:00';
  return `${match[1]}:${match[2] ?? '00'}`;
}

function withSydneyOffset(localIso) {
  const raw = String(localIso);
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)) return raw;
  const normalized = raw.slice(0, 19);
  return `${normalized}${sydneyOffsetForLocalIso(normalized)}`;
}

function firstVerifiedPrice(priceOptions = []) {
  const price = priceOptions.find((option) => typeof option?.amount === 'number');
  if (!price) {
    return {
      amount: null,
      currency: 'AUD',
      confidence: 'unknown',
    };
  }

  return {
    amount: price.amount,
    currency: price.currency ?? 'AUD',
    confidence: 'verified',
  };
}

function assertNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid canonical availability: ${path} must be a non-empty string`);
  }
}

function assertIsoWithTimezone(value, path) {
  assertNonEmptyString(value, path);
  if (!ISO_WITH_TIMEZONE_PATTERN.test(value) || Number.isNaN(new Date(value).valueOf())) {
    throw new Error(`Invalid canonical availability: ${path} must be a valid ISO8601 datetime with timezone`);
  }
}

function validateCanonicalAvailability(availability) {
  if (!availability || typeof availability !== 'object' || Array.isArray(availability)) {
    throw new Error('Invalid canonical availability: expected object');
  }

  assertNonEmptyString(availability.provider, 'provider');
  assertNonEmptyString(availability.venue?.id, 'venue.id');
  assertNonEmptyString(availability.venue?.name, 'venue.name');
  assertNonEmptyString(availability.venue?.providerVenueId, 'venue.providerVenueId');
  assertNonEmptyString(availability.court?.id, 'court.id');
  assertNonEmptyString(availability.court?.name, 'court.name');
  assertNonEmptyString(availability.court?.providerCourtId, 'court.providerCourtId');
  if (availability.court.surface !== null && typeof availability.court.surface !== 'string') {
    throw new Error('Invalid canonical availability: court.surface must be a string or null');
  }

  assertIsoWithTimezone(availability.slot?.start, 'slot.start');
  assertIsoWithTimezone(availability.slot?.end, 'slot.end');
  if (!Number.isInteger(availability.slot.durationMinutes) || availability.slot.durationMinutes < 1) {
    throw new Error('Invalid canonical availability: slot.durationMinutes must be a positive integer');
  }
  if (typeof availability.slot.available !== 'boolean') {
    throw new Error('Invalid canonical availability: slot.available must be boolean');
  }

  const amount = availability.price?.amount;
  if (amount !== null && typeof amount !== 'number') {
    throw new Error('Invalid canonical availability: price.amount must be a number or null');
  }
  if (availability.price?.currency !== 'AUD') {
    throw new Error('Invalid canonical availability: price.currency must be AUD');
  }
  assertNonEmptyString(availability.price?.confidence, 'price.confidence');

  if (availability.provenance?.source !== 'live') {
    throw new Error('Invalid canonical availability: provenance.source must be live');
  }
  if (availability.provenance?.auth !== 'public') {
    throw new Error('Invalid canonical availability: provenance.auth must be public');
  }
  assertIsoWithTimezone(availability.provenance?.observedAt, 'provenance.observedAt');
  assertNonEmptyString(availability.provenance?.availabilityMethod, 'provenance.availabilityMethod');

  return availability;
}

function canonicalAvailability({
  provider,
  venue,
  court,
  startTime,
  durationMinutes,
  priceOptions = [],
  price = firstVerifiedPrice(priceOptions),
  provenance = {},
}) {
  const start = withSydneyOffset(startTime);
  const end = withSydneyOffset(addMinutesToLocalIso(startTime, durationMinutes));

  return validateCanonicalAvailability({
    provider,
    venue: {
      id: venue.id,
      name: venue.name,
      providerVenueId: String(venue.providerVenueId),
    },
    court: {
      id: court.id,
      name: court.name,
      providerCourtId: String(court.providerCourtId),
      surface: court.surface ?? null,
    },
    slot: {
      start,
      end,
      durationMinutes,
      available: true,
    },
    price: {
      amount: price.amount ?? null,
      currency: price.currency ?? 'AUD',
      confidence: price.confidence ?? 'unknown',
    },
    provenance: {
      source: provenance.source ?? 'live',
      auth: provenance.auth ?? 'public',
      observedAt: withSydneyOffset(provenance.observedAt ?? new Date().toISOString()),
      availabilityMethod: provenance.availabilityMethod,
    },
  });
}

function legacyPriceOptionsFromCanonical(canonical) {
  if (canonical.price.amount === null) return [];
  return [{
    name: 'Canonical verified price',
    amount: canonical.price.amount,
    currency: canonical.price.currency,
    durationMinutes: canonical.slot.durationMinutes,
  }];
}

function legacyProvenanceFromCanonical(canonical) {
  return {
    status: 'verified',
    source: canonical.provider === 'susf' ? 'susf_perfectmind' : canonical.provider,
    access: canonical.provenance.auth,
    freshness: canonical.provenance.source,
    availabilityMethod: canonical.provenance.availabilityMethod,
  };
}

function legacyAvailabilityFromCanonical(canonical, {
  nextHourAlsoAvailable = false,
  sourceMetadata = {},
} = {}) {
  validateCanonicalAvailability(canonical);

  const legacy = {
    canonical,
    provider: canonical.provider,
    venue: canonical.venue.name,
    court: canonical.court.name,
    startTime: canonical.slot.start,
    durationMinutes: canonical.slot.durationMinutes,
    nextHourAlsoAvailable,
    priceOptions: legacyPriceOptionsFromCanonical(canonical),
    provenance: legacyProvenanceFromCanonical(canonical),
    observedAt: canonical.provenance.observedAt,
  };

  if (canonical.provider === 'susf') {
    legacy.facilityId = canonical.court.providerCourtId;
  } else if (canonical.provider === 'bookable') {
    legacy.resourceId = canonical.court.providerCourtId;
    legacy.venueId = Number.isNaN(Number(canonical.venue.providerVenueId))
      ? canonical.venue.providerVenueId
      : Number(canonical.venue.providerVenueId);
  } else if (canonical.provider === 'unified-bookings') {
    legacy.resourceUuid = canonical.court.providerCourtId;
    if (sourceMetadata.resourceId !== undefined) legacy.resourceId = sourceMetadata.resourceId;
    if (sourceMetadata.locationId !== undefined) legacy.locationId = sourceMetadata.locationId;
  } else if (canonical.provider === 'sportlogic') {
    legacy.resourceId = canonical.court.providerCourtId;
  } else if (canonical.provider === 'intrac') {
    legacy.resourceId = canonical.court.providerCourtId;
    legacy.locationId = canonical.venue.providerVenueId;
  }

  if (sourceMetadata.itemId !== undefined) legacy.itemId = sourceMetadata.itemId;
  if (sourceMetadata.officialUrl !== undefined) legacy.officialUrl = sourceMetadata.officialUrl;
  if (sourceMetadata.bookingUrl !== undefined) legacy.bookingUrl = sourceMetadata.bookingUrl;
  if (sourceMetadata.priceMetadata !== undefined) legacy.priceMetadata = sourceMetadata.priceMetadata;

  return legacy;
}

export {
  canonicalAvailability,
  legacyAvailabilityFromCanonical,
  validateCanonicalAvailability,
  withSydneyOffset,
};
