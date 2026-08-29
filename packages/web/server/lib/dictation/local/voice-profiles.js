/**
 * Saved reference-voice clips for OmniVoice zero-shot cloning. Each profile
 * is a short WAV sample plus its exact transcript (both are required by
 * OmniVoice's `ref_audio`/`ref_text` cloning inputs) stored under
 * `<modelsDir>/omnivoice-voices/<id>/`.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

function voicesDir(modelsDir) {
  return path.join(modelsDir, 'omnivoice-voices');
}

function profileDir(modelsDir, id) {
  return path.join(voicesDir(modelsDir), id);
}

/**
 * @param {string} modelsDir
 * @returns {Promise<Array<{ id: string, name: string, transcript: string, language?: string, createdAt: string }>>}
 */
export async function listVoiceProfiles(modelsDir) {
  const dir = voicesDir(modelsDir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const profiles = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const meta = JSON.parse(await readFile(path.join(dir, entry.name, 'meta.json'), 'utf8'));
          return { id: entry.name, ...meta };
        } catch {
          return null;
        }
      }),
  );
  return profiles.filter((profile) => profile !== null);
}

/**
 * @param {{ modelsDir: string, name: string, transcript: string, language?: string, audioBuffer: Buffer }} params
 * @returns {Promise<{ id: string, name: string, transcript: string, language?: string, createdAt: string }>}
 */
export async function saveVoiceProfile({ modelsDir, name, transcript, language, audioBuffer }) {
  const id = randomUUID();
  const dir = profileDir(modelsDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'audio.wav'), audioBuffer);
  const meta = { name, transcript, language: language || undefined, createdAt: new Date().toISOString() };
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { id, ...meta };
}

/**
 * @param {string} modelsDir
 * @param {string} id
 * @returns {Promise<string | null>} absolute path to the profile's WAV file, or null if missing.
 */
export async function getVoiceProfileAudioPath(modelsDir, id) {
  const audioPath = path.join(profileDir(modelsDir, id), 'audio.wav');
  try {
    await readFile(audioPath);
    return audioPath;
  } catch {
    return null;
  }
}

/**
 * @param {string} modelsDir
 * @param {string} id
 */
export async function getVoiceProfileTranscript(modelsDir, id) {
  try {
    const meta = JSON.parse(await readFile(path.join(profileDir(modelsDir, id), 'meta.json'), 'utf8'));
    return meta.transcript;
  } catch {
    return null;
  }
}

/**
 * @param {string} modelsDir
 * @param {string} id
 * @returns {Promise<boolean>} true if a profile was deleted.
 */
export async function deleteVoiceProfile(modelsDir, id) {
  const dir = profileDir(modelsDir, id);
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
