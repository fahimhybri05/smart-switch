const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const mod = (x, m) => ((x % m) + m) % m;

/**
 * Local minutes-since-midnight of sunrise/sunset for day-of-year `yday`
 * (0-based), or -1 if the sun doesn't rise/set that day (polar day/night).
 * Almanac for Computers (1990) algorithm, ported verbatim from the old
 * firmware's computeLocalSolarMinutes — accurate to ~1-2 minutes.
 */
export function localSolarMinutes(yday, lat, lon, utcOffsetMin, isSunrise) {
  const N = yday + 1;
  const lngHour = lon / 15;
  const t = N + ((isSunrise ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  const L = mod(M + 1.916 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 282.634, 360);
  let RA = mod(deg(Math.atan(0.91764 * Math.tan(rad(L)))), 360);
  RA = (RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)) / 15;
  const sinDec = 0.39782 * Math.sin(rad(L));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(rad(90.833)) - sinDec * Math.sin(rad(lat))) / (cosDec * Math.cos(rad(lat)));
  if (cosH > 1 || cosH < -1) return -1;
  const H = (isSunrise ? 360 - deg(Math.acos(cosH)) : deg(Math.acos(cosH))) / 15;
  const T = H + RA - 0.06571 * t - 6.622;
  const UT = mod(T - lngHour, 24);
  return Math.round(mod(UT * 60 + utcOffsetMin, 1440)) % 1440;
}
