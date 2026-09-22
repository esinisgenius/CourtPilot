import { WeatherMemoryCache, createWeatherCacheKey } from './cache.mjs';
import { WeatherProviderError, createOpenMeteoProvider } from './provider.mjs';

const defaultWeatherCache = new WeatherMemoryCache();

function getZonedDateTimeParts(instant, timezone) {
  const date = new Date(instant);
  if (Number.isNaN(date.valueOf())) throw new Error(`Invalid instant: ${instant}`);

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

function forecastHourKeyForSlot(slot, timezone) {
  const parts = getZonedDateTimeParts(slot.startTime, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
}

function forecastDateForSlot(slot, timezone) {
  const parts = getZonedDateTimeParts(slot.startTime, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getForecastDateRange(slots, timezone) {
  const dates = slots.map((slot) => forecastDateForSlot(slot, timezone)).sort();
  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
  };
}

function unavailableWeather(slot, source, reason, detail = null, httpStatus = null) {
  return {
    candidateId: slot.id,
    startTime: slot.startTime,
    temperatureC: null,
    feelsLikeC: null,
    precipitationProbability: null,
    precipitationMm: null,
    windKph: null,
    weatherCode: null,
    source,
    forecastAvailable: false,
    unavailableReason: reason,
    unavailableDetail: detail,
    httpStatus,
  };
}

function weatherForSlot(slot, hourlyForecast, timezone, source) {
  const localHour = forecastHourKeyForSlot(slot, timezone);
  const forecast = hourlyForecast.get(localHour);
  if (!forecast) return unavailableWeather(slot, source, 'forecast_hour_unavailable');

  return {
    candidateId: slot.id,
    startTime: slot.startTime,
    temperatureC: forecast.temperatureC,
    feelsLikeC: forecast.feelsLikeC,
    precipitationProbability: forecast.precipitationProbability,
    precipitationMm: forecast.precipitationMm,
    windKph: forecast.windKph,
    weatherCode: forecast.weatherCode,
    source: forecast.source ?? source,
    forecastAvailable: true,
  };
}

async function getWeatherForSlots({
  location,
  slots,
  provider = createOpenMeteoProvider(),
  cache = defaultWeatherCache,
} = {}) {
  if (!location || typeof location !== 'object') throw new Error('location is required');
  if (!Array.isArray(slots)) throw new Error('slots must be an array');
  if (slots.length === 0) return [];

  const timezone = location.timezone;
  if (typeof timezone !== 'string' || timezone.length === 0) throw new Error('location.timezone is required');

  const { startDate, endDate } = getForecastDateRange(slots, timezone);
  const cacheKey = createWeatherCacheKey({ location, startDate, endDate });
  let hourlyForecast = cache?.get(cacheKey);

  try {
    if (!hourlyForecast) {
      hourlyForecast = await provider.getHourlyForecast({ location, startDate, endDate });
      cache?.set(cacheKey, hourlyForecast);
    }
  } catch (error) {
    const reason = error instanceof WeatherProviderError ? error.code : 'WEATHER_PROVIDER_ERROR';
    const detail = error instanceof Error ? error.message : String(error);
    const httpStatus = error instanceof WeatherProviderError ? error.httpStatus : null;
    return slots.map((slot) => unavailableWeather(
      slot,
      provider.name ?? 'weather-provider',
      reason,
      detail,
      httpStatus,
    ));
  }

  return slots.map((slot) => weatherForSlot(slot, hourlyForecast, timezone, provider.name ?? 'weather-provider'));
}

export {
  defaultWeatherCache,
  forecastDateForSlot,
  forecastHourKeyForSlot,
  getForecastDateRange,
  getWeatherForSlots,
};
