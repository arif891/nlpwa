import { logger } from './logger.js';

let _telemetryConfig = null;

/**
 * Configure client telemetry reporting.
 *
 * @param {boolean|{ url?: string, enabled?: boolean }} config
 */
export function configureTelemetry(config) {
  if (typeof config === 'boolean') {
    _telemetryConfig = { enabled: config, url: '/api/report' };
  } else if (config && typeof config === 'object') {
    _telemetryConfig = {
      enabled: config.enabled !== false,
      url: config.url || '/api/report',
    };
  } else {
    _telemetryConfig = null;
  }
}

/**
 * Send an opt-in telemetry report to the configured endpoint (e.g. /api/report).
 * Safe no-op if telemetry is not explicitly enabled.
 *
 * @param {string} eventType - e.g. 'rollback', 'boot_failure', 'persistent_hash_mismatch', 'storage_warning'
 * @param {Object} [payload={}]
 * @returns {Promise<boolean>}
 */
export async function sendTelemetryReport(eventType, payload = {}) {
  if (!_telemetryConfig || !_telemetryConfig.enabled) {
    return false;
  }

  const endpoint = _telemetryConfig.url || '/api/report';
  const body = {
    event: eventType,
    timestamp: Date.now(),
    url: typeof window !== 'undefined' ? window.location?.href : '',
    ...payload,
  };

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const sent = navigator.sendBeacon(endpoint, JSON.stringify(body));
      if (sent) return true;
    }
    if (typeof fetch !== 'undefined') {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      });
      return true;
    }
  } catch (err) {
    logger.debug?.('[NLPWA] Telemetry report failed:', err?.message || err);
  }
  return false;
}
