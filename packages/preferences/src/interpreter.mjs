import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  PreferenceSchemaError,
  normalizePreferenceProfile,
  validatePreferenceProfile,
} from './schema.mjs';
import { openAiPreferenceProfileJsonSchema } from './openai-schema.mjs';

class PreferenceInterpreterError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'PreferenceInterpreterError';
    this.code = code;
  }
}

async function loadEnvFile(path = resolve('.env')) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

function buildInterpreterMessages(text) {
  return [
    {
      role: 'system',
      content: [
        'You convert natural-language tennis court requests into a strict JSON Preference Profile v2. Return JSON only.',
        'Do not create numerical weights. Use only high, medium, low, or uncertain for importance and priority.',
        'Do not add preferences, constraints, objectives, locations, weather needs, prices, courts, dates, durations, or travel-time needs that the user did not state or strongly imply.',
        'If the user does not state a date range, use the deterministic default searchScope.days=7 and do not invent 1, 14, or 30 days. If the user states today, tomorrow, this week, weekend, or next few days, put that in searchScope.dateRange and let downstream policy derive days.',
        'Distinguish six categories: searchScope says where/when to search; transportPreference summarizes stated commute/mode preferences; hardConstraints define which candidates are legal; preferences are relaxable ranking signals; objectives optimize among feasible candidates; unresolvedPreferences are meaningful requirements this schema cannot represent.',
        'When the user states a time eligibility boundary such as 17点以后, 13点前, 13点前或者17点以后, or 13点到17点不行, preserve it as a hard start_time constraint. It may also help searchScope, but searchScope alone is not enough.',
        'Hard vs soft is determined primarily by semantic acceptability, not by absolute words such as 必须, 绝对, or 肯定. A direct acceptable range or exclusion can be hard even without those words.',
        'If violating a condition would put the recommendation outside the user stated acceptable solution space, put it in hardConstraints with type hard and relaxable false.',
        'Requirements such as 一个小时, 只打一个小时, 连续两小时没人的场, 后一小时也得空着, or 而且后一小时没人 are hard unless the user clearly marks them as optional. Phrases such as 最好后一小时没人 or 最好连续两小时 are soft.',
        'Negative vague time wording such as 中午不想打 usually means a soft avoid preference unless the user says that period is impossible, unavailable, or unacceptable. Keep it as rule.period=midday; do not invent 11:00-14:00.',
        'For multiple courts, scope modifiers carefully. In 最好找两块挨着的场，不过分开也行, court_count exact 2 is the requested count, while adjacency is the relaxable part.',
        'Explicit fallback language such as 其他也行, 实在没有也可以, 分开也不是不行 usually means a soft relaxable preference.',
        'When the user says 最好17点后，实在不行下午也可以, 17:00后 is preferred soft timing, not a hard constraint, because the user explicitly accepts afternoon as fallback.',
        'When the user says 周六有事，周日晚上八点后, treat Saturday as unavailable and Sunday after 20:00 as the acceptable hard time window. Do not reinterpret 周六有事 as a vague midday preference.',
        'Optimization wording such as 最便宜, 价格最低, 便宜更重要, 越早越好, 通勤时间最短, 尽量多打一会儿 belongs in objectives, not as a fake threshold. Do not also create an equivalent soft preference for the same semantic objective.',
        'Milder wording such as 便宜一点, 便宜一点就更好了, or 稍微便宜点 is a soft price preference, not an objective.',
        'Explicit no-preference statements such as 无所谓, 随便, 都可以, 不在乎, 怎么样都行 must be omitted for that feature. Do not put explicit indifference in unresolvedPreferences.',
        'Put something in unresolvedPreferences only when it is a real user requirement or uncertainty that cannot be reliably represented. If it is successfully structured, do not duplicate it in unresolvedPreferences. Preserve uncertainty such as 晚上可能也有安排 or vague requirements such as 时间合适 as unresolvedPreferences instead of pretending to know a time window.',
        'Do not invent exact numeric thresholds for vague language. Use semantic period/dateRange values such as evening, afternoon, midday, weekend, next_few_days, not_too_early, not_too_late, or not_too_hot when the user was vague. Do not emit a semantic period together with a made-up numeric range for the same vague phrase.',
        'Every rule must match the feature type. Never use time operators for price, court, venue, weather, duration, adjacency, court_count, or travel_time. Use one canonical time representation: 13点前或者17点以后 is before=13:00 and after=17:00, not before/after plus an equivalent exclude range.',
        'Do not represent the same hard time requirement twice. For 13点到17点不行, prefer one canonical hard start_time rule before=13:00 and after=17:00 rather than both an exclude range and an equivalent before/after rule.',
        'Weather preferences should use direction preferred or avoid, never higher. For comfortable weather use rule.condition=comfortable. For 别下雨就行 use hard weather rule.condition=no_rain.',
        'Use only feature-appropriate relaxationDirection values: price higher_price; start_time wider_time_window; date wider_date_window; court include_nonpreferred; venue other_venues; travel_time longer_travel_time; duration or consecutive_availability shorter_duration; court_count split_courts; adjacency non_adjacent_courts; otherwise ask_user. For weather, prefer ask_user unless the user gives a specific fallback.',
        'Use transportPreference only for explicitly stated commute preference fields: maxTransitMinutes, maxWalkMinutes, and preferredTransportModes with values TRANSIT, WALK, or DRIVE. Do not add transfer count or any other transport field.',
        'Use travel_time for user-facing commute/travel burden. Do not use distance as a user Preference feature. Venue search radius such as 3km is system policy, not user preference. Do not estimate distance or travel time; only structure the user stated limit or mode preference.',
        'For 公交最好30分钟以内 or transit preferably within 30 minutes: set transportPreference.maxTransitMinutes=30 and add a soft relaxable travel_time preference with rule.maxTransitMinutes=30. For 公交不能超过30分钟 or must be within 30 minutes by transit: set the same transportPreference field and add a hard non-relaxable travel_time constraint.',
        'For 走路15分钟以内最好: set transportPreference.maxWalkMinutes=15 and add a soft relaxable travel_time preference with rule.maxWalkMinutes=15. For 走路不能超过15分钟: make that travel_time rule hard.',
        'For 更愿意坐公交 or prefer transit: set transportPreference.preferredTransportModes=["TRANSIT"] and add a soft travel_time preference with rule.preferredTransportModes=["TRANSIT"]. For 开车也可以: include DRIVE in preferredTransportModes only as an acceptable/preferred soft mode; do not make other modes forbidden.',
        'Phrases such as 远一点也行, farther is OK, or a bit longer is fine mean the travel_time preference is soft and relaxable with relaxationDirection=longer_travel_time, not a hard constraint.',
        'Use duration for requested play length. Use consecutive_availability for two continuous hours or a following-hour-free requirement. Use court_count and adjacency for multiple adjacent courts.',
        'Preserve short sourceText evidence wherever supported. Prefer conservative interpretation when genuinely ambiguous.',
        'Few-shot examples:',
        'Input: 17点以后都可以，越早越好. Output meaning: hardConstraints has start_time after 17:00; objectives has start_time earlier.',
        'Input: 找最便宜的. Output meaning: objectives has price minimize; no duplicate price soft preference.',
        'Input: Court 4、5、6优先，其他也行. Output meaning: preferences has court include Court 4/5/6, relaxable true; no hard court constraint.',
        'Input: 只看Court 4、5、6. Output meaning: hardConstraints has court include Court 4/5/6, relaxable false.',
        'Input: 价格无所谓，后一小时也得空着. Output meaning: omit price; structure consecutive_availability minMinutes 120 or equivalent hard requirement from the second clause.',
        'Input: 贵一点没事，而且后一小时没人. Output meaning: do not set price direction higher; keep the following-hour requirement.',
        'Input: 最近几天帮我挑一个合适的，我没什么特别要求. Output meaning: searchScope.dateRange next_few_days; no preferences, objectives, or unresolved no-preference text.',
        'Input: 我下午有事，晚上可能也有安排. Output meaning: hard start_time avoid semantic period afternoon; unresolvedPreferences preserves evening uncertainty; do not invent 18:00-20:00.',
        'Input: 明天17点后，公交最好30分钟内，远一点也行，最好连续两小时. Output meaning: tomorrow and after 17:00 hard time scope; soft relaxable travel_time maxTransitMinutes 30; transportPreference.maxTransitMinutes=30; soft consecutive_availability preferredMinutes 120.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: text,
    },
  ];
}

function parseProviderContent(content) {
  if (typeof content !== 'string') {
    throw new PreferenceInterpreterError('PREFERENCE_INTERPRETER_MALFORMED_OUTPUT', 'LLM output content was not a JSON string');
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new PreferenceInterpreterError('PREFERENCE_INTERPRETER_MALFORMED_OUTPUT', 'LLM output was not valid JSON', { cause: error });
  }
}

function createOpenAiPreferenceProvider({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
} = {}) {
  return {
    name: 'openai-chat-completions',
    async interpret(text) {
      if (!apiKey) {
        throw new PreferenceInterpreterError(
          'LLM_PROVIDER_NOT_CONFIGURED',
          'Missing OPENAI_API_KEY. Add it to .env or the environment before running preference:set.',
        );
      }

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: buildInterpreterMessages(text),
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'preference_profile',
              strict: true,
              schema: openAiPreferenceProfileJsonSchema,
            },
          },
        }),
      });

      if (!response.ok) {
        const message = await response.text().catch(() => '');
        throw new PreferenceInterpreterError(
          'LLM_PROVIDER_ERROR',
          `OpenAI preference interpreter failed with HTTP ${response.status}${message ? `: ${message}` : ''}`,
        );
      }

      const json = await response.json();
      const content = json?.choices?.[0]?.message?.content;
      return parseProviderContent(content);
    },
  };
}

async function interpretPreferences(text, { provider, now = new Date() } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new PreferenceInterpreterError('PREFERENCE_INPUT_EMPTY', 'Preference text must be a non-empty string');
  }

  await loadEnvFile();
  const selectedProvider = provider ?? createOpenAiPreferenceProvider();

  let rawProfile;
  try {
    rawProfile = await selectedProvider.interpret(text);
  } catch (error) {
    if (error instanceof PreferenceInterpreterError) throw error;
    throw new PreferenceInterpreterError('LLM_PROVIDER_ERROR', error.message, { cause: error });
  }

  const profile = normalizePreferenceProfile(rawProfile, {
    sourceText: text,
    updatedAt: now.toISOString(),
  });

  try {
    return validatePreferenceProfile(profile);
  } catch (error) {
    if (error instanceof PreferenceSchemaError) {
      throw new PreferenceInterpreterError('PREFERENCE_SCHEMA_REJECTED', error.message, { cause: error });
    }
    throw error;
  }
}

export {
  PreferenceInterpreterError,
  buildInterpreterMessages,
  createOpenAiPreferenceProvider,
  interpretPreferences,
  loadEnvFile,
  parseProviderContent,
};
