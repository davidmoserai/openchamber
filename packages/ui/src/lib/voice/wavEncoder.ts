/**
 * Encodes a decoded AudioBuffer as a 16-bit PCM WAV Blob. Used to normalize
 * whatever format the browser records/uploads (webm/opus, mp4, mp3, ...)
 * into plain WAV before it's sent to the server, so cloning reference
 * audio never depends on a server-side ffmpeg install.
 */
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
    const numChannels = 1;
    const sampleRate = buffer.sampleRate;
    const samples = buffer.getChannelData(0);

    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = samples.length * bytesPerSample;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    const writeString = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i += 1) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += 2;
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
}

/** Decodes any browser-supported audio Blob and re-encodes it as WAV. */
export async function toWavBlob(input: Blob): Promise<Blob> {
    const arrayBuffer = await input.arrayBuffer();
    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new AudioContextCtor();
    try {
        const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
        return audioBufferToWavBlob(audioBuffer);
    } finally {
        void context.close();
    }
}

export function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            resolve(result.slice(result.indexOf(',') + 1));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}
