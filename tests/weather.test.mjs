import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WeatherMemoryCache,
  WeatherProviderError,
  createOpenMeteoProvider,
  forecastHourKeyForSlot,
  getWeatherForSlots,
} from '../packages/weather/src/index.mjs';

const sydney = {
  latitude: -33.8886,
  longitude: 151.1873,
  timezone: 'Australia/Sydney',
};

function slot(id, startTime) {
  return { id, startTime, durationMinutes: 60 };
}

function forecast(entries) {
  return new Map(entries.map(([localHour, values]) => [localHour, {
    localHour,
    temperatureC: values.temperatureC ?? null,
    feelsLikeC: values.feelsLikeC ?? null,
    precipitationProbability: values.precipitationProbability ?? null,
    precipitationMm: values.precipitationMm ?? null,
    windKph: values.windKph ?? null,
    weatherCode: values.weatherCode ?? null,
    source: 'test-weather',
    forecastAvailable: true,
  }]));
}

test('hourly forecast mapping uses containing Sydney local hour', () => {
  assert.equal(
    forecastHourKeyForSlot(slot('a', '2026-09-03T08:15:00.000Z'), sydney.timezone),
    '2026-09-03T18:00',
  );
  assert.equal(
    forecastHourKeyForSlot(slot('b', '2026-09-03T08:30:00.000Z'), sydney.timezone),
    '2026-09-03T18:00',
  );
});

test('Sydney timezone is used instead of UTC hour', () => {
  assert.equal(
    forecastHourKeyForSlot(slot('a', '2026-09-03T09:00:00.000Z'), sydney.timezone),
    '2026-09-03T19:00',
  );
});

test('Sydney DST offset is handled by Intl timezone conversion', () => {
  assert.equal(
    forecastHourKeyForSlot(slot('a', '2026-12-01T08:30:00.000Z'), sydney.timezone),
    '2026-12-01T19:00',
  );
});

test('weather fields remain null when provider lacks them', async () => {
  const rows = await getWeatherForSlots({
    location: sydney,
    slots: [slot('a', '2026-09-03T08:15:00.000Z')],
    provider: {
      name: 'test-weather',
      async getHourlyForecast() {
        return forecast([
          ['2026-09-03T18:00', { temperatureC: 21 }],
        ]);
      },
    },
    cache: new WeatherMemoryCache(),
  });

  assert.equal(rows[0].forecastAvailable, true);
  assert.equal(rows[0].temperatureC, 21);
  assert.equal(rows[0].feelsLikeC, null);
  assert.equal(rows[0].windKph, null);
});

test('forecast unavailable is explicit when the hourly row is missing', async () => {
  const rows = await getWeatherForSlots({
    location: sydney,
    slots: [slot('a', '2026-09-03T08:15:00.000Z')],
    provider: {
      name: 'test-weather',
      async getHourlyForecast() {
        return forecast([]);
      },
    },
    cache: new WeatherMemoryCache(),
  });

  assert.equal(rows[0].forecastAvailable, false);
  assert.equal(rows[0].unavailableReason, 'forecast_hour_unavailable');
});

test('batch request handles many slots with one provider call per forecast window', async () => {
  let requestCount = 0;
  const rows = await getWeatherForSlots({
    location: sydney,
    slots: Array.from({ length: 50 }, (_, index) => slot(`slot-${index}`, `2026-09-03T08:${String(index % 60).padStart(2, '0')}:00.000Z`)),
    provider: {
      name: 'test-weather',
      async getHourlyForecast() {
        requestCount += 1;
        return forecast([
          ['2026-09-03T18:00', { temperatureC: 21 }],
        ]);
      },
    },
    cache: new WeatherMemoryCache(),
  });

  assert.equal(rows.length, 50);
  assert.equal(requestCount, 1);
});

test('weather cache avoids repeated provider calls for same location and window', async () => {
  let requestCount = 0;
  const cache = new WeatherMemoryCache();
  const provider = {
    name: 'test-weather',
    async getHourlyForecast() {
      requestCount += 1;
      return forecast([
        ['2026-09-03T18:00', { temperatureC: 21 }],
      ]);
    },
  };

  await getWeatherForSlots({ location: sydney, slots: [slot('a', '2026-09-03T08:15:00.000Z')], provider, cache });
  await getWeatherForSlots({ location: sydney, slots: [slot('b', '2026-09-03T08:30:00.000Z')], provider, cache });

  assert.equal(requestCount, 1);
});

test('provider error returns unavailable weather and does not pretend weather is good', async () => {
  const rows = await getWeatherForSlots({
    location: sydney,
    slots: [slot('a', '2026-09-03T08:15:00.000Z')],
    provider: {
      name: 'test-weather',
      async getHourlyForecast() {
        throw new WeatherProviderError('WEATHER_PROVIDER_HTTP_ERROR');
      },
    },
    cache: new WeatherMemoryCache(),
  });

  assert.equal(rows[0].forecastAvailable, false);
  assert.equal(rows[0].unavailableReason, 'WEATHER_PROVIDER_HTTP_ERROR');
  assert.equal(rows[0].unavailableDetail, 'WEATHER_PROVIDER_HTTP_ERROR');
});

test('Open-Meteo provider preserves HTTP status on failure', async () => {
  const provider = createOpenMeteoProvider({
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });

  await assert.rejects(
    provider.getHourlyForecast({
      location: sydney,
      startDate: '2026-09-03',
      endDate: '2026-09-03',
    }),
    (error) => error.code === 'WEATHER_PROVIDER_HTTP_ERROR' && error.httpStatus === 429,
  );
});

test('Open-Meteo provider retries one transient network failure', async () => {
  let attempts = 0;
  const provider = createOpenMeteoProvider({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('temporary network failure');
      return {
        ok: true,
        async json() {
          return {
            hourly: {
              time: ['2026-09-03T18:00'],
              temperature_2m: [21],
            },
          };
        },
      };
    },
  });

  const result = await provider.getHourlyForecast({
    location: sydney,
    startDate: '2026-09-03',
    endDate: '2026-09-03',
  });

  assert.equal(attempts, 2);
  assert.equal(result.get('2026-09-03T18:00').temperatureC, 21);
});
