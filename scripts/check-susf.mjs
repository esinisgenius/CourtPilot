import { getSusfAvailability } from '../packages/susf/src/index.mjs';

try {
  const availability = await getSusfAvailability({
    days: Number(process.env.SUSF_DAYS_COUNT ?? 1),
    durationMinutes: Number(process.env.SUSF_DURATION ?? 60),
  });
  const discovery = availability.discovery ?? {};
  const courtIds = new Set(availability.map((slot) => slot.facilityId).filter(Boolean));
  const courts = new Set(availability.map((slot) => slot.court).filter(Boolean));

  console.log(JSON.stringify({
    provider: 'susf',
    auth: 'public',
    anonymousBootstrap: true,
    userAuthentication: false,
    facilityCount: discovery.facilityCount ?? courtIds.size,
    courtCount: discovery.courtCount ?? courts.size,
    slotCount: availability.length,
    samples: availability.slice(0, 5),
  }, null, 2));
} catch (error) {
  if (error?.code) {
    console.error(error.code);
    if (error.message && error.message !== error.code) {
      console.error(error.message);
    }
  } else {
    console.error(error?.message ?? String(error));
  }
  process.exitCode = 1;
}
