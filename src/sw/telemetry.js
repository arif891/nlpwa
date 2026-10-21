import { getConfig } from './config/index.js';
import { logger } from './logger.js';

/**
 * Send an opt-in telemetry report from the Service Worker (e.g. /api/report).
 * Safe no-op if telemetry is disabled (default).
 *
 * @param {string} eventType
 * @param {Object} [payload={}]
 * @returns {Promise<boolean>}
 */
export async function sendSWTelemetry(eventType, payload = {}) {
  const config = getConfig();
  const telemetry = config.telemetry;
  if (!telemetry) return false;

  const endpoint = typeof telemetry === 'object' && telemetry.url ? telemetry.url : '/api/report';
  const body = {
    event: eventType,
    source: 'service-worker',
    timestamp: Date.now(),
    version: config.version,
    ...payload,
  };

  try {
    if (typeof fetch !== 'undefined') {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return true;
    }
  } catch (err) {
    logger.debug('[NLPWA] Telemetry report failed:', err?.message || err);
  }
  return false;
}
