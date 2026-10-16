/**
 * Parse a semver string into its numeric components.
 *
 * Pre-release labels (e.g. "-beta", "-rc.1") are stripped before parsing.
 * This means "1.0.0-beta" compares as equal to "1.0.0" — full pre-release
 * ordering (e.g. alpha < beta < rc < release) is not supported.
 *
 * @param {string} version  e.g. '1.4.0' or '2.0.0-beta.1'
 * @returns {{ major: number, minor: number, patch: number }}
 */
function parse(version) {
  // Strip pre-release label before splitting (e.g. '1.0.0-beta.1' → '1.0.0')
  const base = String(version).split('-')[0];
  const parts = base.split('.').map(s => parseInt(s, 10) || 0);
  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
  };
}

/**
 * Compare two semver strings.
 *
 * @returns {-1|0|1}  -1 if a < b, 0 if equal, 1 if a > b
 */
export function compare(a, b) {
  const av = parse(a);
  const bv = parse(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (av[key] < bv[key]) return -1;
    if (av[key] > bv[key]) return  1;
  }
  return 0;
}

/**
 * Returns true if serverVersion is strictly newer than clientVersion.
 *
 * @param {string} serverVersion
 * @param {string} clientVersion
 */
export function isNewer(serverVersion, clientVersion) {
  return compare(serverVersion, clientVersion) > 0;
}
