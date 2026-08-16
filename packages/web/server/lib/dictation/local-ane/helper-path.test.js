import { describe, it, expect } from 'bun:test';
import path from 'path';

import { resolveAneHelperPath } from './helper-path.js';

describe('resolveAneHelperPath', () => {
  it('returns null on non-macOS platforms without checking the filesystem', () => {
    const fileExists = () => {
      throw new Error('should not check the filesystem off of macOS');
    };
    expect(resolveAneHelperPath({ platform: 'win32', resourcesPath: '/fake', fileExists })).toBeNull();
    expect(resolveAneHelperPath({ platform: 'linux', resourcesPath: '/fake', fileExists })).toBeNull();
  });

  it('prefers the packaged Electron resourcesPath binary when present', () => {
    const resourcesPath = '/Applications/OpenChamber.app/Contents/Resources';
    const expectedPackagedPath = path.join(resourcesPath, 'ane-dictation-helper', 'ane-dictation-helper');

    const resolved = resolveAneHelperPath({
      platform: 'darwin',
      resourcesPath,
      fileExists: (candidate) => candidate === expectedPackagedPath,
    });

    expect(resolved).toBe(expectedPackagedPath);
  });

  it('falls back to the dev build when the packaged binary is missing', () => {
    const resourcesPath = '/Applications/OpenChamber.app/Contents/Resources';
    const packagedPath = path.join(resourcesPath, 'ane-dictation-helper', 'ane-dictation-helper');
    const checked = [];

    const resolved = resolveAneHelperPath({
      platform: 'darwin',
      resourcesPath,
      fileExists: (candidate) => {
        checked.push(candidate);
        return candidate !== packagedPath;
      },
    });

    expect(resolved).not.toBeNull();
    expect(resolved).not.toBe(packagedPath);
    expect(resolved?.endsWith(path.join('.build', 'release', 'ane-dictation-helper'))).toBe(true);
    // Packaged path is checked before falling back to the dev build.
    expect(checked[0]).toBe(packagedPath);
  });

  it('checks only the dev build when not running inside Electron (no resourcesPath)', () => {
    const checked = [];
    resolveAneHelperPath({
      platform: 'darwin',
      resourcesPath: null,
      fileExists: (candidate) => {
        checked.push(candidate);
        return false;
      },
    });
    expect(checked.length).toBe(1);
    expect(checked[0]?.includes('ane-dictation-helper')).toBe(true);
  });

  it('returns null on macOS when neither the packaged nor dev binary exists', () => {
    const resolved = resolveAneHelperPath({
      platform: 'darwin',
      resourcesPath: '/Applications/OpenChamber.app/Contents/Resources',
      fileExists: () => false,
    });
    expect(resolved).toBeNull();
  });
});
