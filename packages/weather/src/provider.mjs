const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

class WeatherProviderError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'WeatherProviderError';
    this.code = code;
  }
}

function normalizeNullableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeOpenMeteoHourly(json) {
  const hourly = json?.hourly;
  if (!hourly || !Array.isArray(hourly.time)) {
    throw new WeatherProviderError('WEATHER_PROVIDER_MALFORMED_RESPONSE', 'Open-Meteo response did not include hourly time series');
  }

  const byLocalHour = new Map();
  for (let index = 0; index < hourly.time.length; index += 1) {
    byLocalHour.set(hourly.time[index], {
      localHour: hourly.time[index],
      temperatureC: normalizeNullableNumber(hourly.temperature_2m?.[index]),
      feelsLikeC: normalizeNullableNumber(hourly.apparent_temperature?.[index]),
      precipitationProbability: normalizeNullableNumber(hourly.precipitation_probability?.[index]),
      precipitationMm: normalizeNullableNumber(hourly.precipitation?.[index]),
      windKph: normalizeNullableNumber(hourly.wind_speed_10m?.[index]),
      weatherCode: hourly.weather_code?.[index] == null ? null : String(hourly.weather_code[index]),
      source: 'open-meteo',
      forecastAvailable: true,
    });
  }

  return byLocalHour;
}

function createOpenMeteoProvider({
  fetchImpl = globalThis.fetch,
  baseUrl = OPEN_METEO_FORECAST_URL,
  stats = { requestCount: 0 },
  maxAttempts = 2,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new WeatherProviderError('WEATHER_FETCH_UNAVAILABLE', 'fetch is not available in this runtime');
  }

  return {
    name: 'open-meteo',
    stats,
    async getHourlyForecast({ location, startDate, endDate }) {
      const url = new URL(baseUrl);
      url.searchParams.set('latitude', String(location.latitude));
      url.searchParams.set('longitude', String(location.longitude));
      url.searchParams.set('timezone', location.timezone);
      url.searchParams.set('start_date', startDate);
      url.searchParams.set('end_date', endDate);
      url.searchParams.set('hourly', [
        'temperature_2m',
        'apparent_temperature',
        'precipitation_probability',
        'precipitation',
        'wind_speed_10m',
        'weather_code',
      ].join(','));
      url.searchParams.set('wind_speed_unit', 'kmh');

      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        stats.requestCount += 1;
        try {
          const response = await fetchImpl(url);
          if (response.ok) return normalizeOpenMeteoHourly(await response.json());
          lastError = new WeatherProviderError(
            'WEATHER_PROVIDER_HTTP_ERROR',
            `Open-Meteo failed with HTTP ${response.status}`,
          );
          if (response.status < 500 || attempt === maxAttempts) throw lastError;
        } catch (error) {
          lastError = error;
          if (error instanceof WeatherProviderError || attempt === maxAttempts) throw error;
        }
      }
      throw lastError;
    },
  };
}

export {
  OPEN_METEO_FORECAST_URL,
  WeatherProviderError,
  createOpenMeteoProvider,
  normalizeOpenMeteoHourly,
};
