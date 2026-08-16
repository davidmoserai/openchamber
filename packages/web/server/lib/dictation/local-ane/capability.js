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

// Darwin 23.x == macOS 14 (Sonoma). FluidAudio's CoreML APIs require macOS 14+.
const MIN_DARWIN_KERNEL_MAJOR = 23;

function isAppleSiliconMac() {
  if (process.platform !== 'darwin') {
    return false;
  }
  // Prefer the chip model over process.arch: process.arch reports 'x64' when
  // running under Rosetta even on Apple Silicon hardware.
  const model = os.cpus()?.[0]?.model || '';
  return /Apple/i.test(model);
}

function meetsMinimumMacOSVersion() {
  const match = /^(\d+)/.exec(os.release());
  const kernelMajor = match ? Number(match[1]) : 0;
  return kernelMajor >= MIN_DARWIN_KERNEL_MAJOR;
}

/**
 * @returns {boolean} whether this server can run the ANE dictation engine:
 *   Apple Silicon, a new enough macOS, and the helper binary is present.
 */
export function isAneDictationSupported() {
  return isAppleSiliconMac() && meetsMinimumMacOSVersion() && Boolean(resolveAneHelperPath());
}
