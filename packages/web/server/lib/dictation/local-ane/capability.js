/**
 * Server-side capability check for the Apple Neural Engine dictation engine.
 * See ../DOCUMENTATION.md for why this must run server-side.
 */

import os from 'os';

import { resolveAneHelperPath } from './helper-path.js';

// Darwin 23.x == macOS 14 (Sonoma); FluidAudio requires macOS 14+.
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
 *           helperPath?: string | null }} [overrides] injectable for tests.
 *   cpuModel over process.arch: the latter reports 'x64' under Rosetta.
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
