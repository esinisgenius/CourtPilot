const INITIAL_RADIUS_METERS = 3000;
const RADIUS_LADDER_METERS = Object.freeze([3000, 5000, 8000, 12000]);

function getInitialRadiusMeters() {
  return INITIAL_RADIUS_METERS;
}

function getNextRadius(currentRadiusMeters, ladder = RADIUS_LADDER_METERS) {
  if (!Number.isFinite(currentRadiusMeters) || currentRadiusMeters <= 0) {
    return ladder[0];
  }

  const next = ladder.find((radius) => radius > currentRadiusMeters);
  return next ?? ladder[ladder.length - 1];
}

export {
  INITIAL_RADIUS_METERS,
  RADIUS_LADDER_METERS,
  getInitialRadiusMeters,
  getNextRadius,
};
