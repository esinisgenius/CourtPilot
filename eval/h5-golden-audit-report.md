# H5 Golden QA Audit

Generated: 2026-09-14T08:45:11.476Z

Pass rate: 20/20 (100%)

## Cases

| Case | Category | Result | Actual behavior | Failure root cause |
| --- | --- | --- | --- | --- |
| L02-suburb-mascot | location:suburb | PASS | ASKING_USER; providers=bookable; recommendations=Aloha Street Tennis Courts |  |
| L03-suburb-chatswood-unseen | location:suburb | PASS | ASKING_USER; providers=none; recommendations=none |  |
| L04-natural-cn-burwood | location:natural-language | PASS | SATISFACTORY; providers=sportlogic, unified-bookings; recommendations=Burwood Tennis Courts, Strathfield Sports Club Tennis |  |
| L05-landmark-usyd | location:landmark | PASS | SATISFACTORY; providers=susf, intrac; recommendations=Sydney Uni Sport Tennis Courts, Sydney Uni Sport Tennis Courts |  |
| L06-station-central | location:landmark | PASS | SATISFACTORY; providers=susf, intrac; recommendations=Sydney Uni Sport Tennis Courts, Sydney Uni Sport Tennis Courts, Moore Park Tennis Courts |  |
| L07-university-macquarie | location:landmark | PASS | ASKING_USER; providers=none; recommendations=none |  |
| L08-shopping-centre-broadway | location:poi | PASS | SATISFACTORY; providers=susf, intrac; recommendations=Sydney Uni Sport Tennis Courts, Sydney Uni Sport Tennis Courts, Moore Park Tennis Courts |  |
| L09-fuzzy-city-nearby | location:fuzzy | PASS | SATISFACTORY; providers=susf; recommendations=Sydney Uni Sport Tennis Courts, Sydney Uni Sport Tennis Courts |  |
| L10-implicit-profile-location | location:implicit | PASS | SATISFACTORY; providers=sportlogic, unified-bookings; recommendations=Strathfield Sports Club Tennis, Burwood Tennis Courts |  |
| L11-implicit-current-location | location:implicit | PASS | SATISFACTORY; providers=sportlogic, unified-bookings; recommendations=Burwood Tennis Courts, Strathfield Sports Club Tennis |  |
| L12-no-location-sydney-fallback | location:implicit | PASS | ASKING_USER; providers=susf, bookable, intrac, sportlogic, unified-bookings; recommendations=Strathfield Sports Club Tennis, Aloha Street Tennis Courts, Sydney Uni Sport Tennis Courts |  |
| L13-ambiguous-newtown | location:ambiguous | PASS | ASKING_USER; providers=none; recommendations=none |  |
| L14-out-of-scope-strathfield | provider-routing | PASS | SATISFACTORY; providers=sportlogic, unified-bookings; recommendations=Burwood Tennis Courts, Strathfield Sports Club Tennis |  |
| T15-weekend-sunday-after-8 | time | PASS | ASKING_USER; providers=susf, bookable, intrac, sportlogic, unified-bookings; recommendations=Strathfield Sports Club Tennis |  |
| T16-before-13-or-after-17 | time | PASS | ASKING_USER; providers=susf, bookable, intrac, sportlogic, unified-bookings; recommendations=Sydney Uni Sport Tennis Courts, Sydney Uni Sport Tennis Courts, Aloha Street Tennis Courts |  |
| T17-hard-continuous-two-hours | time:duration | PASS | MAX_ITERATIONS_REACHED; providers=susf, bookable, intrac, sportlogic, unified-bookings; recommendations=none |  |
| P19-soft-weather-unknown-retained | weather | PASS | SATISFACTORY; providers=sportlogic, unified-bookings; recommendations=Burwood Tennis Courts, Strathfield Sports Club Tennis |  |
| P20-hard-weather-unknown-fail-closed | weather | PASS | MAX_ITERATIONS_REACHED; providers=sportlogic, unified-bookings; recommendations=none |  |
| V21-positive-tennis-proof | provider-integrity | PASS | ASKING_USER; providers=bookable; recommendations=Aloha Street Tennis Courts |  |
| F22-provider-partial-failure | failure | PASS | MAX_ITERATIONS_REACHED; providers=bookable; recommendations=none |  |

## Issues



## SUSF / USYD Bias

- Current audit no longer finds SUSF as a hidden initial-provider fallback.
- No-location requests now use an explicit Sydney fallback scope with multiple active providers.
- SUSF/USYD can still appear for CBD/Central/Broadway because the configured SUSF venue has real coordinates inside the search radius.
- Remaining ranking fairness depends on completing geo metadata for non-SUSF providers, because some configured venues still lack coordinates.

## Strathfield Weather Unknown

- Source: Fixture reproduces the current failure class: weather rows unavailable for Strathfield across venue/suburb/Sydney fallback produce forecastAvailable=false.
- Code path: enrichCandidates -> weatherRowsWithFallback -> applyHardConstraints/evaluateWeather.
- Semantics: Soft weather preference keeps the candidate with weatherUnknown; hard no_rain rejects with reason weather:weather_unknown.

## Recommended Minimum Fix Order

1. Wire production H5 geocoding provider configuration so live requests use Maps-backed resolution when static canonical shortcuts miss.
2. Normalize venue geo metadata across non-SUSF providers to improve Sydney fallback coverage and ranking fairness.
3. Add parser evals for day-specific constraints such as 周六有事，周日晚上八点后 so hard date rules are reliably produced.
4. Map internal statuses to user-facing UI states: location unresolved, provider unavailable, no matching courts, weather unavailable, constraints too strict.
