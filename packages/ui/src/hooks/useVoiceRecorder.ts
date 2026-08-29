/**
 * One-shot mic recorder for capturing a short reference clip (Qwen3-TTS
 * voice cloning). Unlike useDictationAudioSource (streaming PCM for STT),
 * this records a single clip via MediaRecorder and hands back a normalized
 * WAV Blob — the format the recording browser produces (webm/opus, mp4,
 * ...) doesn't matter, since toWavBlob() decodes and re-encodes it.
 */

import { useCallback, useRef, useState } from 'react';
import { toWavBlob } from '@/lib/voice/wavEncoder';

export interface UseVoiceRecorderReturn {
    isRecording: boolean;
    error: string | null;
    start: () => Promise<void>;
    /** Stops recording and resolves with the normalized WAV Blob. */
    stop: () => Promise<Blob | null>;
}

export function useVoiceRecorder(): UseVoiceRecorderReturn {
    const [isRecording, setIsRecording] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const streamRef = useRef<MediaStream | null>(null);

    const start = useCallback(async (): Promise<void> => {
        setError(null);
        try {
            if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
                throw new Error('Microphone access is not available in this browser');
            }
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            chunksRef.current = [];
            const recorder = new MediaRecorder(stream);
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    chunksRef.current.push(event.data);
                }
            };
            recorderRef.current = recorder;
            recorder.start();
            setIsRecording(true);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to start recording';
            setError(message);
            throw err;
        }
    }, []);

    const stop = useCallback(async (): Promise<Blob | null> => {
        const recorder = recorderRef.current;
        if (!recorder) {
            return null;
        }

        const rawBlob = await new Promise<Blob>((resolve) => {
            recorder.onstop = () => {
                resolve(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }));
            };
            recorder.stop();
        });

        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setIsRecording(false);

        try {
            return await toWavBlob(rawBlob);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to process recording';
            setError(message);
            return null;
        }
    }, []);

    return { isRecording, error, start, stop };
}
