/**
 * Server-side capability check for the Apple Neural Engine dictation engine.
 *
 * This must run on the machine hosting the OpenChamber server, not the
 * browser: dictation audio is processed server-side, and a client can be a
 * different device from the server (remote/mobile access to a Mac-hosted
 * server). Client-side OS sniffing (`navigator.userAgent`) would answer the
 * wrong question here.
 */

import os from 'os';

import { resolveAneHelperPath } from './helper-path.js';

// Darwin 23.x == macOS 14 (Sonoma). FluidAudio's CoreML APIs require macOS 14+
// (verified against FluidAudio's own Package.swift `platforms` declaration).
export const MIN_DARWIN_KERNEL_MAJOR = 23;

function isAppleSiliconMac(platform, cpuModel) {
  return platform === 'darwin' && /Apple/i.test(cpuModel);
}

function meetsMinimumMacOSVersion(osRelease) {
  const match = /^(\d+)/.exec(osRelease);
  const kernelMajor = match ? Number(match[1]) : 0;
  return kernelMajor >= MIN_DARWIN_KERNEL_MAJOR;
}

/**
 * @param {{ platform?: string, cpuModel?: string, osRelease?: string,
 *           helperPath?: string | null }} [overrides] injectable for tests;
 *   defaults read the real host. Prefer the chip model over `process.arch`:
 *   `process.arch` reports 'x64' under Rosetta even on Apple Silicon
 *   hardware, so it can't distinguish real Intel Macs from Rosetta-translated
 *   ones.
 * @returns {boolean} whether this server can run the ANE dictation engine:
 *   Apple Silicon, a new enough macOS, and the helper binary is present.
 */
export function isAneDictationSupported({
  platform = process.platform,
  cpuModel = os.cpus()?.[0]?.model || '',
  osRelease = os.release(),
  helperPath = resolveAneHelperPath(),
} = {}) {
  return (
    isAppleSiliconMac(platform, cpuModel) &&
    meetsMinimumMacOSVersion(osRelease) &&
    Boolean(helperPath)
  );
}
