# TennisAgent

Preference-Aware Personal Tennis Agent.

## Current Progress

Implemented:

- SUSF authenticated availability adapter
- Live SUSF Court availability path through `packages/susf`
- Dynamic Tennis Court discovery
- Court 1-6 currently verified
- Next-hour availability detection
- Pre-payment rate table extraction
- Candidate price options for verified Peak / Off-Peak rates
- Natural-language Preference Interpreter interface
- Structured Preference Profile validation
- Hard vs soft preference representation
- Local JSON Preference Profile store
- Candidate Core for factual feature extraction
- Australia/Sydney timezone handling
- Open-Meteo weather enrichment
- Google Calendar FreeBusy adapter
- Enriched candidate hard filtering
- Agent State and Real LLM Replanner loop
- Maps factual layer for location resolution, saved play areas, tennis venue discovery, venue-level travel time, and unified venue contracts
- Tests

Not implemented yet:

- Candidate-level Peak / Off-Peak mapping
- LLM candidate ranking
- MCP Server
- Agent orchestration
- Web UI
- Automatic booking

## Commands

```bash
npm run susf:login
npm run susf:check
npm run preference:set -- "选一个最近几天的连续两小时没人的最便宜的场地，13点前或者17点以后都行，尽量不要在边上的court3和court6"
npm run preference:show
npm run candidates
npm run preview
npm run weather:check
npm run calendar:authorize
npm run calendar:check
npm run calendar:login
npm run maps:resolve -- "USYD"
npm run maps:venues -- "USYD"
npm run maps:check -- "University of Sydney"
npm run feasible
npm test
```

`preference:set` uses OpenAI structured JSON output. Set `OPENAI_API_KEY` in `.env` or the shell first.

Weather uses Open-Meteo hourly forecasts. Candidate start times are mapped to the containing local forecast hour in `Australia/Sydney`, so `18:15` and `18:30` both use the `18:00` hourly row for that local date. Forecasts are requested in batches for the candidate date window and cached in memory for 20 minutes.

Calendar uses a provider selector. The local-first default is `CALENDAR_PROVIDER=auto`: on macOS it tries Apple Calendar through EventKit first, then falls back to Google Calendar FreeBusy if Apple is unavailable or denied and Google is configured. `CALENDAR_PROVIDER=apple` disables Google fallback; `CALENDAR_PROVIDER=google` skips Apple and uses Google only.

Apple Calendar uses macOS system Calendar permission through EventKit. It does not need an Apple ID, Apple password, iCloud private API, Calendar database access, or UI automation. `npm run calendar:authorize` explicitly asks macOS for Calendar access. The Swift bridge only returns busy intervals and never returns event titles, notes, attendees, URLs, descriptions, or locations.

Google Calendar is an optional fallback for non-macOS, cloud deployment, or other users. It uses the FreeBusy API with `https://www.googleapis.com/auth/calendar.freebusy`, stores the OAuth refresh token locally at `.auth/google-calendar.json`, and exposes only busy intervals to candidate enrichment.

Hard filtering is deterministic. Calendar busy is a default hard rejection; Calendar unknown is not treated as free. Weather is factual enrichment only unless the Preference Profile contains an explicit hard weather constraint, in which case unknown weather is not treated as good weather.

Maps uses Google Maps Platform server APIs when `GOOGLE_MAPS_API_KEY` is configured. Location can come from explicit user text, a saved play area, or runtime device geolocation. Explicit user locations take priority and device geolocation is runtime context only; it is not written into the durable Preference Profile.

Venue discovery starts with a deterministic 3 km radius. That radius is search policy, not a user distance preference. User phrases such as "near", "not too far", or "within 15 minutes" should be represented as `travel_time`; straight-line `geoDistanceMeters` is provider metadata only. The default travel mode is `TRANSIT` with `product_default` as its value source unless the user explicitly asks for walking, driving, or public transport.

Maps-discovered venues are venue-level alternatives. Their availability is `unknown` unless reconciled to a verified provider such as SUSF. The system must not present a Google Places venue as bookable at a specific time without a real availability source.

Google Maps real smoke status: EXTERNAL BLOCKER / NOT VERIFIED as of 2026-09-04. The Maps adapter and contracts are implemented and covered by offline synthetic/mocked tests, but real Google provider verification is blocked by Google Cloud review. Do not treat Google Places venue availability as verified until a future real smoke is completed after approval.

The Real LLM Replanner consumes the Preference Profile, Agent State, and factual observations. It evaluates the current candidate set, accepts only bounded actions (`EXPAND_RADIUS`, `SWITCH_SEARCH_AREA`, `ASK_USER`, `SATISFACTORY`, `STOP`), validates the action schema, executes deterministic state changes, and then asks the caller for the next factual observation pass. Synthetic replanning tests use mocked Maps observations only.

Runtime secrets and personal data are ignored:

- `.auth/`
- `.env`
- `data/preferences.json`
- `data/saved-play-areas.json`
- `output/`
