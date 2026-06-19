/**
 * Deprecated Tau extension shim.
 *
 * Tau now runs as a standalone web app (`tau`) that manages its own
 * `pi --mode rpc` child sessions. This file is intentionally a no-op so old
 * Pi package caches do not accidentally start recursive mirror servers.
 */

export default function () {
  if (process.env.TAU_DISABLED === '1' || process.env.TAU_DISABLED === 'true') return;
  console.log('[Tau] The Pi extension is deprecated. Run `tau` in your shell to start the standalone web app.');
}
