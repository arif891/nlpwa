/**
 * Parse a size option accepting bytes, KB, MB, GB, or string (e.g. '50MB', '500KB').
 *
 * @param {number|string|undefined} bytesVal
 * @param {number|undefined} mbVal
 * @param {number|undefined} kbVal
 * @returns {number|null}
 */
export function resolveByteSize(bytesVal, mbVal, kbVal) {
  if (bytesVal != null) {
    if (typeof bytesVal === 'string') {
      const match = bytesVal.trim().match(/^([\d.]+)\s*(gb|mb|kb|b)?$/i);
      if (match) {
        const num = parseFloat(match[1]);
        const unit = (match[2] || 'b').toLowerCase();
        if (unit === 'gb') return Math.round(num * 1024 * 1024 * 1024);
        if (unit === 'mb') return Math.round(num * 1024 * 1024);
        if (unit === 'kb') return Math.round(num * 1024);
        return Math.round(num);
      }
    }
    const parsed = Number(bytesVal);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (mbVal != null) {
    const parsed = Number(mbVal);
    return Number.isNaN(parsed) ? null : Math.round(parsed * 1024 * 1024);
  }
  if (kbVal != null) {
    const parsed = Number(kbVal);
    return Number.isNaN(parsed) ? null : Math.round(parsed * 1024);
  }
  return null;
}
