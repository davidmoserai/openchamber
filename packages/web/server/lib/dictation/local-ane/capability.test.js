import { describe, it, expect } from 'bun:test';

import { isAneDictationSupported, MIN_DARWIN_KERNEL_MAJOR } from './capability.js';

const CAPABLE = {
  platform: 'darwin',
  cpuModel: 'Apple M2 Pro',
  osRelease: `${MIN_DARWIN_KERNEL_MAJOR}.0.0`,
  helperPath: '/Applications/OpenChamber.app/Contents/Resources/ane-dictation-helper/ane-dictation-helper',
};

describe('isAneDictationSupported', () => {
  it('is supported on Apple Silicon macOS with the helper binary present', () => {
    expect(isAneDictationSupported(CAPABLE)).toBe(true);
  });

  it('is not supported on non-macOS platforms', () => {
    expect(isAneDictationSupported({ ...CAPABLE, platform: 'win32' })).toBe(false);
    expect(isAneDictationSupported({ ...CAPABLE, platform: 'linux' })).toBe(false);
  });

  it('is not supported on Intel Macs', () => {
    expect(isAneDictationSupported({ ...CAPABLE, cpuModel: 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz' })).toBe(false);
  });

  it('rejects a Rosetta-translated report of an Intel chip model as unsupported', () => {
    // process.arch would report 'x64' here too, which is exactly why
    // capability.js keys off the chip model instead.
    expect(isAneDictationSupported({ ...CAPABLE, cpuModel: '' })).toBe(false);
  });

  it('is not supported below the minimum macOS version', () => {
    expect(isAneDictationSupported({ ...CAPABLE, osRelease: `${MIN_DARWIN_KERNEL_MAJOR - 1}.6.0` })).toBe(false);
  });

  it('is supported exactly at the minimum macOS version boundary', () => {
    expect(isAneDictationSupported({ ...CAPABLE, osRelease: `${MIN_DARWIN_KERNEL_MAJOR}.0.0` })).toBe(true);
  });

  it('is supported above the minimum macOS version', () => {
    expect(isAneDictationSupported({ ...CAPABLE, osRelease: `${MIN_DARWIN_KERNEL_MAJOR + 2}.6.0` })).toBe(true);
  });

  it('is not supported when the helper binary is unavailable', () => {
    expect(isAneDictationSupported({ ...CAPABLE, helperPath: null })).toBe(false);
  });

  it('defaults to reading the real host when called with no arguments', () => {
    // No injected overrides: exercises the real process.platform / os.cpus() /
    // os.release() / resolveAneHelperPath() defaults, same call shape every
    // real call site (capability.js has no other consumers) uses.
    expect(() => isAneDictationSupported()).not.toThrow();
  });
});
