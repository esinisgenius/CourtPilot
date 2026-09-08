function normalizeConfiguredUrl(value) {
  const trimmed = value.trim();
  const markdownMatch = trimmed.match(/^\[(https?:\/\/[^\]]+)]\((https?:\/\/[^)]+)\)$/);
  if (markdownMatch) return markdownMatch[2].replaceAll('\\&', '&');

  const firstUrlMatch = trimmed.match(/https?:\/\/[^\])\s]+/);
  if (firstUrlMatch) return firstUrlMatch[0].replaceAll('\\&', '&');

  return trimmed.replaceAll('\\&', '&');
}

function getLandingPageBackUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/\/BookMe4LandingPages\/Facility/i.test(url.pathname)) return null;
    return url.searchParams.get('landingPageBackUrl');
  } catch {
    return null;
  }
}

function looksLikeLoginUrl(url) {
  return /\/login\b|\/account\/login\b|signin|sign-in/i.test(url);
}

async function isLoginPage(page) {
  if (looksLikeLoginUrl(page.url())) return true;

  return page.evaluate(() => {
    const passwordInputs = [...document.querySelectorAll('input[type="password"]')];
    return passwordInputs.some((passwordInput) => {
      const form = passwordInput.closest('form');
      const action = form?.action ?? '';
      if (/\/login\b|\/account\/login\b|signin|sign-in/i.test(action)) return true;

      const scope = form ?? document.body;
      const scopeText = scope?.innerText ?? '';
      const hasUserField = Boolean(scope?.querySelector(
        'input[type="email"], input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]',
      ));
      return Boolean(hasUserField && /login|sign in/i.test(scopeText));
    });
  }).catch(() => false);
}

function parseTennisCourtName(label) {
  const match = label.match(/\bTennis\s+(?:Synthetic\s+|Hard\s+)?Court\s+(\d+)\b/i);
  if (!match) return null;
  return `Court ${Number(match[1])}`;
}

function discoverTennisCourtsFromFacilities(facilities) {
  const byFacilityId = new Map();

  for (const facility of facilities) {
    if (!facility.facilityId || byFacilityId.has(facility.facilityId)) continue;

    const court = parseTennisCourtName(facility.label);
    if (!court) continue;

    byFacilityId.set(facility.facilityId, {
      court,
      domLabel: facility.label.match(/\bTennis\s+(?:Synthetic\s+|Hard\s+)?Court\s+\d+\b/i)?.[0] ?? court,
      facilityId: facility.facilityId,
    });
  }

  return [...byFacilityId.values()]
    .sort((a, b) => {
      const aNumber = Number(a.court.match(/\d+/)?.[0] ?? 0);
      const bNumber = Number(b.court.match(/\d+/)?.[0] ?? 0);
      return aNumber - bNumber || a.court.localeCompare(b.court);
    });
}

async function findCourtFacilities(page) {
  const facilities = await page.$$eval('[data-facilityid]', (nodes) => {
    const clean = (value) => value.replace(/\s+/g, ' ').trim();

    return nodes.map((node) => {
      const element = node;
      const facilityId = element.getAttribute('data-facilityid');
      const candidates = [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.textContent,
        element.closest('[data-name], [aria-label], [title]')?.getAttribute('data-name'),
        element.closest('[data-name], [aria-label], [title]')?.getAttribute('aria-label'),
        element.closest('[data-name], [aria-label], [title]')?.getAttribute('title'),
        element.closest('li, tr, article, section, div')?.textContent,
      ].filter(Boolean);

      return {
        facilityId,
        label: clean(candidates.join(' ')),
      };
    }).filter((item) => item.facilityId);
  });

  return discoverTennisCourtsFromFacilities(facilities);
}

async function pageHasTargetCourtFacilities(page) {
  const courts = await findCourtFacilities(page);
  return courts.length > 0;
}

async function navigateToTennisFacilityList(page, bookingUrl) {
  await page.goto(bookingUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  if (await pageHasTargetCourtFacilities(page)) return page.url();

  const landingPageBackUrl = getLandingPageBackUrl(page.url()) ?? getLandingPageBackUrl(bookingUrl);
  if (landingPageBackUrl) {
    await page.goto(landingPageBackUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    if (await pageHasTargetCourtFacilities(page)) return page.url();
  }

  const rentFacilityUrl = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')];
    const match = links.find((link) => /Rent a Facility/i.test(link.textContent ?? ''));
    return match?.href ?? null;
  }).catch(() => null);

  if (rentFacilityUrl) {
    await page.goto(rentFacilityUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  if (await pageHasTargetCourtFacilities(page)) return page.url();

  const clickedTennis = await page.evaluate(() => {
    const controls = [
      ...document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'),
    ];
    const tennisControl = controls.find((control) => {
      const text = [
        control.textContent,
        control.getAttribute('value'),
        control.getAttribute('aria-label'),
        control.getAttribute('title'),
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      return /^Tennis$/i.test(text);
    });
    if (!tennisControl) return false;
    tennisControl.scrollIntoView({ block: 'center', inline: 'center' });
    tennisControl.click();
    return true;
  }).catch(() => false);

  if (clickedTennis) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll('[data-facilityid]').length > 0, null, {
      timeout: 15_000,
    }).catch(() => {});
  }

  return page.url();
}

async function chooseCourtToTriggerAvailability(page, court) {
  const clicked = await page.evaluate((facilityId) => {
    const facilityNode = document.querySelector(`[data-facilityid="${facilityId}"]`);
    if (!facilityNode) return false;

    const root = facilityNode.closest('li, tr, article, section, .card, .facility, .facility-item, div') ?? facilityNode;
    const candidates = [
      ...root.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'),
    ];

    const choose = candidates.find((candidate) => {
      const text = [
        candidate.textContent,
        candidate.getAttribute('value'),
        candidate.getAttribute('aria-label'),
        candidate.getAttribute('title'),
      ].filter(Boolean).join(' ');
      return /choose|select|book|availability/i.test(text);
    });

    const target = choose ?? facilityNode;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }, court.facilityId);

  if (!clicked) return false;

  console.log(`Choosing ${court.domLabel} once to load its public availability grid.`);
  await page.waitForLoadState('networkidle').catch(() => {});
  return true;
}

export {
  chooseCourtToTriggerAvailability,
  discoverTennisCourtsFromFacilities,
  findCourtFacilities,
  isLoginPage,
  navigateToTennisFacilityList,
  normalizeConfiguredUrl,
};
