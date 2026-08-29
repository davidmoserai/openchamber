import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDeviceInfo } from '@/lib/device';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Radio } from '@/components/ui/radio';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Icon } from "@/components/icon/Icon";
import {
    SettingsSection,
    SettingsCheckboxRow,
    SettingsFieldRow,
    SettingsControlGroup,
    SettingsChipGroup,
    SETTINGS_SELECT_SIZE,
    SETTINGS_SELECT_ROW_TRIGGER_CLASS,
    SETTINGS_CONTROL_CLUSTER_CLASS,
    SETTINGS_FIELD_LABEL_CLASS,
    SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { cn } from '@/lib/utils';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useI18n } from '@/lib/i18n';
import { useLocalTTS } from '@/hooks/useLocalTTS';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';
import { toWavBlob, blobToBase64 } from '@/lib/voice/wavEncoder';
import { disposePreviewAudio } from './voicePreviewAudio';

const LOCAL_STT_MODELS = [
    {
        id: 'parakeet-tdt-0.6b-v2-int8',
        labelKey: 'settings.voice.page.stt.model.parakeetV2',
        badgeKey: 'settings.voice.page.stt.badge.bestForEnglish',
        accuracy: 5,
        speed: 5,
        size: '460 MB',
    },
    {
        id: 'parakeet-tdt-0.6b-v3-int8',
        labelKey: 'settings.voice.page.stt.model.parakeetV3',
        badgeKey: 'settings.voice.page.stt.badge.bestForMultilingual',
        accuracy: 5,
        speed: 4,
        size: '465 MB',
    },
    {
        id: 'whisper-base-int8',
        labelKey: 'settings.voice.page.stt.model.whisperBase',
        badgeKey: null,
        accuracy: 3,
        speed: 3,
        size: '200 MB',
    },
    {
        id: 'whisper-tiny-int8',
        labelKey: 'settings.voice.page.stt.model.whisperTiny',
        badgeKey: null,
        accuracy: 2,
        speed: 4,
        size: '115 MB',
    },
] as const;

interface DictationModelState {
    id: string;
    installed: boolean;
    downloading: boolean;
    downloadProgress: number | null;
    downloadError: string | null;
}

const RatingBar = ({ value, label }: { value: number; label: string }) => (
    <span className="flex items-center gap-1.5" title={`${label}: ${value}/5`}>
        <span
            className="h-1.5 w-12 flex-shrink-0 overflow-hidden rounded-full bg-[var(--interactive-border)]"
            aria-hidden="true"
        >
            <span
                className="block h-full rounded-full bg-[var(--primary-base)]"
                style={{ width: `${(value / 5) * 100}%` }}
            />
        </span>
        <span className="typography-ui-compact text-muted-foreground">{label}</span>
    </span>
);

const LocalModelPicker = ({
    selectedModelId,
    onSelect,
}: {
    selectedModelId: string;
    onSelect: (modelId: string) => void;
}) => {
    const { t } = useI18n();
    const tUnsafe = useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
    const [models, setModels] = useState<Map<string, DictationModelState>>(new Map());
    const [requestingId, setRequestingId] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const response = await runtimeFetch('/api/dictation/status', {
                query: { provider: 'local' },
            });
            if (!response.ok) {
                return;
            }
            const data = await response.json();
            if (Array.isArray(data?.models)) {
                setModels(new Map(data.models.map((m: DictationModelState) => [m.id, m])));
            }
        } catch {
            // Display-only status; keep the previous state on fetch failure.
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const anyDownloading = Array.from(models.values()).some((m) => m.downloading);
    useEffect(() => {
        if (!anyDownloading) {
            return;
        }
        const interval = setInterval(() => {
            void refresh();
        }, 2000);
        return () => clearInterval(interval);
    }, [anyDownloading, refresh]);

    const handleDownload = async (modelId: string) => {
        setRequestingId(modelId);
        try {
            await runtimeFetch(`/api/dictation/models/${encodeURIComponent(modelId)}/download`, {
                method: 'POST',
            });
            await refresh();
        } catch {
            // Status refresh reports errors.
        } finally {
            setRequestingId(null);
        }
    };

    const handleDelete = async (modelId: string) => {
        setRequestingId(modelId);
        try {
            await runtimeFetch(`/api/dictation/models/${encodeURIComponent(modelId)}`, {
                method: 'DELETE',
            });
            await refresh();
        } catch {
            // Status refresh reports errors.
        } finally {
            setRequestingId(null);
        }
    };

    return (
        <div
            role="radiogroup"
            aria-label={t('settings.voice.page.field.model')}
            className="mt-1.5 grid w-full grid-cols-1 gap-3 @xl:grid-cols-2"
        >
            {LOCAL_STT_MODELS.map((entry) => {
                const selected = selectedModelId === entry.id;
                const state = models.get(entry.id) ?? null;
                return (
                    <div
                        key={entry.id}
                        className={cn(
                            'rounded-lg border border-[var(--interactive-border)] p-3',
                            selected && 'border-[var(--primary-base)] bg-[var(--primary-base)]/5',
                        )}
                    >
                        <div className="flex items-start justify-between gap-2">
                            <div
                                className="flex min-w-0 flex-1 cursor-pointer items-start gap-2"
                                role="button"
                                tabIndex={0}
                                onClick={() => onSelect(entry.id)}
                                onKeyDown={(e) => {
                                    if (e.key === ' ' || e.key === 'Enter') {
                                        e.preventDefault();
                                        onSelect(entry.id);
                                    }
                                }}
                            >
                                <div className="pt-0.5">
                                    <Radio
                                        checked={selected}
                                        onChange={() => onSelect(entry.id)}
                                        ariaLabel={tUnsafe(entry.labelKey)}
                                    />
                                </div>
                                <div className="min-w-0 flex-1 space-y-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                            {tUnsafe(entry.labelKey)}
                                        </span>
                                        {entry.badgeKey ? (
                                            <span className="rounded border border-[var(--status-success-border)] bg-[var(--status-success-background)] px-1 text-[9px] font-medium uppercase leading-[14px] tracking-wide text-[var(--status-success)]">
                                                {tUnsafe(entry.badgeKey)}
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <RatingBar value={entry.accuracy} label={t('settings.voice.page.stt.meta.accuracy')} />
                                        <RatingBar value={entry.speed} label={t('settings.voice.page.stt.meta.speed')} />
                                        <span className="typography-ui-compact tabular-nums text-muted-foreground">{entry.size}</span>
                                    </div>
                                    {state?.downloadError ? (
                                        <p className="typography-meta text-[var(--status-error)]">{state.downloadError}</p>
                                    ) : null}
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                {state?.installed ? (
                                    <>
                                        <Button
                                            variant="ghost"
                                            size="xs"
                                            className="h-6 w-6 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                                            disabled={requestingId === entry.id}
                                            onClick={() => { void handleDelete(entry.id); }}
                                            title={t('settings.voice.page.stt.modelDelete')}
                                            aria-label={t('settings.voice.page.stt.modelDelete')}
                                        >
                                            <Icon name="delete-bin" className="h-4 w-4" />
                                        </Button>
                                        <Icon
                                            name="checkbox-circle"
                                            className="h-4 w-4 flex-shrink-0 text-[var(--status-success)]"
                                            aria-label={t('settings.voice.page.stt.modelInstalled')}
                                        />
                                    </>
                                ) : state?.downloading ? (
                                    <span className="flex items-center gap-1.5">
                                        <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                        <span className="typography-ui-compact tabular-nums text-muted-foreground">
                                            {typeof state.downloadProgress === 'number' ? `${state.downloadProgress}%` : ''}
                                        </span>
                                    </span>
                                ) : (
                                    <Button
                                        variant="ghost"
                                        size="xs"
                                        className="h-6 w-6 p-0"
                                        disabled={requestingId === entry.id}
                                        onClick={() => { void handleDownload(entry.id); }}
                                        title={t('settings.voice.page.stt.modelDownload')}
                                        aria-label={t('settings.voice.page.stt.modelDownload')}
                                    >
                                        <Icon name="download" className="h-4 w-4" />
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

/** Kokoro en_v0_19 speaker ids in sherpa-onnx order. */
const KOKORO_VOICE_OPTIONS = [
    { id: 0, label: 'Alloy (af)' },
    { id: 1, label: 'Bella (af)' },
    { id: 2, label: 'Nicole (af)' },
    { id: 3, label: 'Sarah (af)' },
    { id: 4, label: 'Sky (af)' },
    { id: 5, label: 'Adam (am)' },
    { id: 6, label: 'Michael (am)' },
    { id: 7, label: 'Emma (bf)' },
    { id: 8, label: 'Isabella (bf)' },
    { id: 9, label: 'George (bm)' },
    { id: 10, label: 'Lewis (bm)' },
];

const LOCAL_TTS_MODEL_ID = 'kokoro-en-v0_19';
const OMNIVOICE_MODEL_ID = 'omnivoice-multilingual';
const QWEN_TTS_MODEL_ID = 'qwen3-tts-multilingual';

const LOCAL_TTS_ENGINES = [
    { id: LOCAL_TTS_MODEL_ID, label: 'Kokoro', sizeLabel: '305 MB' },
    { id: OMNIVOICE_MODEL_ID, label: 'OmniVoice', sizeLabel: '~750 MB' },
    { id: QWEN_TTS_MODEL_ID, label: 'Qwen3-TTS', sizeLabel: '~1.7 GB' },
] as const;

/**
 * Qwen3-TTS's `lang_code` parameter takes language *names*, not ISO codes
 * (unlike OmniVoice) -- see qwen_tts_server.py / mlx-audio's `generate_audio`.
 */
const QWEN_LANGUAGE_OPTIONS = [
    { code: '', label: 'Auto (infer from text)' },
    { code: 'English', label: 'English' },
    { code: 'German', label: 'German' },
    { code: 'French', label: 'French' },
    { code: 'Spanish', label: 'Spanish' },
    { code: 'Italian', label: 'Italian' },
    { code: 'Portuguese', label: 'Portuguese' },
    { code: 'Russian', label: 'Russian' },
    { code: 'Chinese', label: 'Chinese' },
    { code: 'Japanese', label: 'Japanese' },
    { code: 'Korean', label: 'Korean' },
] as const;

/** Qwen3-TTS language name -> OMNIVOICE_PREVIEW_TEXT's ISO key, so both
 * engines' preview buttons can share the same translated sample sentences. */
const QWEN_LANGUAGE_TO_PREVIEW_KEY: Record<string, string> = {
    English: 'en',
    German: 'de',
    French: 'fr',
    Spanish: 'es',
    Italian: 'it',
    Portuguese: 'pt',
    Russian: 'ru',
    Chinese: 'zh',
    Japanese: 'ja',
    Korean: 'ko',
};

const LocalTtsModelStatus = ({ modelId, label, sizeLabel }: { modelId: string; label: string; sizeLabel: string }) => {
    const { t } = useI18n();
    const [model, setModel] = useState<DictationModelState | null>(null);
    const [requesting, setRequesting] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const response = await runtimeFetch('/api/dictation/status', { query: { provider: 'local' } });
            if (!response.ok) {
                return;
            }
            const data = await response.json();
            const entry = Array.isArray(data?.ttsModels)
                ? data.ttsModels.find((m: DictationModelState) => m.id === modelId)
                : null;
            if (entry) {
                setModel(entry);
            }
        } catch {
            // Display-only status; keep the previous state on fetch failure.
        }
    }, [modelId]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (!model?.downloading) {
            return;
        }
        const interval = setInterval(() => {
            void refresh();
        }, 2000);
        return () => clearInterval(interval);
    }, [model?.downloading, refresh]);

    const request = async (method: 'POST' | 'DELETE') => {
        setRequesting(true);
        try {
            const path = method === 'POST'
                ? `/api/dictation/models/${modelId}/download`
                : `/api/dictation/models/${modelId}`;
            await runtimeFetch(path, { method });
            await refresh();
        } catch {
            // Status refresh reports errors.
        } finally {
            setRequesting(false);
        }
    };

    if (!model) {
        return null;
    }

    return (
        <div className="flex items-center gap-2 py-1.5">
            <span className="typography-ui-label text-foreground">{label}</span>
            <span className="typography-ui-compact tabular-nums text-muted-foreground">{sizeLabel}</span>
            {model.installed ? (
                <>
                    <Icon
                        name="checkbox-circle"
                        className="h-4 w-4 text-[var(--status-success)]"
                        aria-label={t('settings.voice.page.stt.modelInstalled')}
                    />
                    <Button
                        variant="ghost"
                        size="xs"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                        disabled={requesting}
                        onClick={() => { void request('DELETE'); }}
                        title={t('settings.voice.page.stt.modelDelete')}
                        aria-label={t('settings.voice.page.stt.modelDelete')}
                    >
                        <Icon name="delete-bin" className="h-4 w-4" />
                    </Button>
                </>
            ) : model.downloading ? (
                <span className="flex items-center gap-1.5">
                    <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    <span className="typography-ui-compact tabular-nums text-muted-foreground">
                        {typeof model.downloadProgress === 'number' ? `${model.downloadProgress}%` : ''}
                    </span>
                </span>
            ) : (
                <Button
                    variant="ghost"
                    size="xs"
                    className="h-6 w-6 p-0"
                    disabled={requesting}
                    onClick={() => { void request('POST'); }}
                    title={t('settings.voice.page.stt.modelDownload')}
                    aria-label={t('settings.voice.page.stt.modelDownload')}
                >
                    <Icon name="download" className="h-4 w-4" />
                </Button>
            )}
            {model.downloadError ? (
                <span className="typography-meta text-[var(--status-error)]">{model.downloadError}</span>
            ) : null}
        </div>
    );
};

/**
 * Curated subset of OmniVoice's 600+ supported languages (full list at
 * https://github.com/k2-fsa/OmniVoice/blob/master/docs/languages.md). This
 * covers the common cases in a manageable dropdown; the "Other" field below
 * accepts any code from the full list as free text.
 */
const OMNIVOICE_LANGUAGE_OPTIONS = [
    { code: '', label: 'Auto (infer from text)' },
    { code: 'en', label: 'English' },
    { code: 'de', label: 'German' },
    { code: 'fr', label: 'French' },
    { code: 'es', label: 'Spanish' },
    { code: 'it', label: 'Italian' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'nl', label: 'Dutch' },
    { code: 'ru', label: 'Russian' },
    { code: 'pl', label: 'Polish' },
    { code: 'uk', label: 'Ukrainian' },
    { code: 'cs', label: 'Czech' },
    { code: 'sv', label: 'Swedish' },
    { code: 'da', label: 'Danish' },
    { code: 'no', label: 'Norwegian' },
    { code: 'fi', label: 'Finnish' },
    { code: 'el', label: 'Greek' },
    { code: 'tr', label: 'Turkish' },
    { code: 'he', label: 'Hebrew' },
    { code: 'ar', label: 'Arabic' },
    { code: 'fa', label: 'Persian' },
    { code: 'hi', label: 'Hindi' },
    { code: 'bn', label: 'Bengali' },
    { code: 'ur', label: 'Urdu' },
    { code: 'ta', label: 'Tamil' },
    { code: 'te', label: 'Telugu' },
    { code: 'th', label: 'Thai' },
    { code: 'vi', label: 'Vietnamese' },
    { code: 'id', label: 'Indonesian' },
    { code: 'ms', label: 'Malay' },
    { code: 'zh', label: 'Chinese' },
    { code: 'yue', label: 'Cantonese' },
    { code: 'ja', label: 'Japanese' },
    { code: 'ko', label: 'Korean' },
    { code: 'sw', label: 'Swahili' },
    { code: 'am', label: 'Amharic' },
    { code: 'yo', label: 'Yoruba' },
    { code: 'ha', label: 'Hausa' },
    { code: 'af', label: 'Afrikaans' },
] as const;

/**
 * Preview sentences per language. TTS does not translate — it speaks
 * whatever text it's given, using that text's own script to pronounce it
 * correctly. So an English preview line always sounds English no matter
 * what language is selected; the fix is to preview with text actually
 * written in that language, same as the real "read message aloud" feature
 * does automatically for whatever language the message itself is in.
 */
const OMNIVOICE_PREVIEW_TEXT: Record<string, string> = {
    en: 'Hello! This is a preview of OmniVoice.',
    de: 'Hallo! Das ist eine Vorschau von OmniVoice.',
    fr: "Bonjour ! Ceci est un aperçu d'OmniVoice.",
    es: '¡Hola! Esta es una vista previa de OmniVoice.',
    it: "Ciao! Questa è un'anteprima di OmniVoice.",
    pt: 'Olá! Esta é uma prévia do OmniVoice.',
    nl: 'Hallo! Dit is een voorbeeld van OmniVoice.',
    ru: 'Привет! Это предварительный просмотр OmniVoice.',
    pl: 'Cześć! To jest podgląd OmniVoice.',
    uk: 'Привіт! Це попередній перегляд OmniVoice.',
    cs: 'Ahoj! Toto je ukázka OmniVoice.',
    sv: 'Hej! Det här är en förhandsvisning av OmniVoice.',
    da: 'Hej! Dette er en forhåndsvisning af OmniVoice.',
    no: 'Hei! Dette er en forhåndsvisning av OmniVoice.',
    fi: 'Hei! Tämä on esikatselu OmniVoicesta.',
    el: 'Γεια σου! Αυτή είναι μια προεπισκόπηση του OmniVoice.',
    tr: "Merhaba! Bu OmniVoice'un bir önizlemesi.",
    he: 'שלום! זוהי תצוגה מקדימה של OmniVoice.',
    ar: 'مرحباً! هذه معاينة لـ OmniVoice.',
    fa: 'سلام! این پیش‌نمایشی از OmniVoice است.',
    hi: 'नमस्ते! यह OmniVoice का पूर्वावलोकन है।',
    bn: 'হ্যালো! এটি OmniVoice-এর একটি প্রিভিউ।',
    ur: 'ہیلو! یہ OmniVoice کا پیش منظر ہے۔',
    ta: 'வணக்கம்! இது OmniVoice இன் முன்னோட்டம்.',
    te: 'హలో! ఇది OmniVoice యొక్క ప్రివ్యూ.',
    th: 'สวัสดี! นี่คือตัวอย่างของ OmniVoice',
    vi: 'Xin chào! Đây là bản xem trước của OmniVoice.',
    id: 'Halo! Ini adalah pratinjau OmniVoice.',
    ms: 'Hai! Ini adalah pratonton OmniVoice.',
    zh: '你好！这是 OmniVoice 的预览。',
    yue: '你好！呢個係 OmniVoice 嘅預覽。',
    ja: 'こんにちは！これは OmniVoice のプレビューです。',
    ko: '안녕하세요! 이것은 OmniVoice의 미리보기입니다.',
    sw: 'Habari! Huu ni muhtasari wa OmniVoice.',
    am: 'ሰላም! ይህ የ OmniVoice ቅድመ እይታ ነው።',
    yo: 'Bawo! Èyí ni àwòrán OmniVoice.',
    ha: 'Sannu! Wannan gwajin OmniVoice ne.',
    af: "Hallo! Dit is 'n voorskou van OmniVoice.",
};

interface VoiceProfile {
    id: string;
    name: string;
    transcript: string;
    language?: string;
}

const OmniVoiceVoiceManager = ({
    selectedVoiceId,
    onSelectVoice,
}: {
    selectedVoiceId: string;
    onSelectVoice: (voiceId: string) => void;
}) => {
    const { t } = useI18n();
    const [voices, setVoices] = useState<VoiceProfile[]>([]);
    const [isAdding, setIsAdding] = useState(false);
    const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
    const [name, setName] = useState('');
    const [transcript, setTranscript] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { isRecording, start: startRecording, stop: stopRecording } = useVoiceRecorder();

    const refresh = useCallback(async () => {
        try {
            const response = await runtimeFetch('/api/dictation/tts/voices');
            if (!response.ok) return;
            const data = await response.json();
            if (Array.isArray(data?.voices)) {
                setVoices(data.voices);
            }
        } catch {
            // Display-only; keep previous list on failure.
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const handleRecordToggle = async () => {
        setError(null);
        if (isRecording) {
            const blob = await stopRecording();
            if (blob) setRecordedBlob(blob);
            return;
        }
        try {
            await startRecording();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to start recording');
        }
    };

    const handleFileUpload = async (file: File) => {
        setError(null);
        try {
            const wavBlob = await toWavBlob(file);
            setRecordedBlob(wavBlob);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to process audio file');
        }
    };

    const handleSave = async () => {
        if (!recordedBlob || !name.trim() || !transcript.trim()) {
            setError('A clip, name, and exact transcript are all required');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const audioBase64 = await blobToBase64(recordedBlob);
            const response = await runtimeFetch('/api/dictation/tts/voices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), transcript: transcript.trim(), audioBase64 }),
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({ error: 'Failed to save voice' }));
                throw new Error(data.error || 'Failed to save voice');
            }
            const data = await response.json();
            setVoices((prev) => [...prev, data.voice]);
            onSelectVoice(data.voice.id);
            setIsAdding(false);
            setRecordedBlob(null);
            setName('');
            setTranscript('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save voice');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id: string) => {
        try {
            await runtimeFetch(`/api/dictation/tts/voices/${id}`, { method: 'DELETE' });
            setVoices((prev) => prev.filter((v) => v.id !== id));
            if (selectedVoiceId === id) {
                onSelectVoice('');
            }
        } catch {
            // Best-effort; list refresh on next mount will reconcile.
        }
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <Select value={selectedVoiceId || '__default__'} onValueChange={(v) => onSelectVoice(v === '__default__' ? '' : v)}>
                    <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                        <SelectValue placeholder={t('settings.voice.page.omnivoice.defaultVoice')}>
                            {(value) => (value === '__default__' ? t('settings.voice.page.omnivoice.defaultVoice') : voices.find((v) => v.id === value)?.name ?? value)}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="__default__">{t('settings.voice.page.omnivoice.defaultVoice')}</SelectItem>
                        {voices.map((v) => (
                            <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {selectedVoiceId && (
                    <Button size="xs" variant="ghost" onClick={() => handleDelete(selectedVoiceId)} title={t('settings.voice.page.stt.modelDelete')}>
                        <Icon name="delete-bin" className="h-4 w-4" />
                    </Button>
                )}
                <Button size="xs" variant="ghost" onClick={() => setIsAdding((prev) => !prev)}>
                    {isAdding ? t('settings.common.actions.cancel') : t('settings.voice.page.omnivoice.cloneVoice')}
                </Button>
            </div>

            {isAdding && (
                <div className="space-y-2 rounded-lg border border-input p-2.5">
                    <span className={SETTINGS_HELPER_CLASS}>{t('settings.voice.page.omnivoice.cloneHint')}</span>
                    <div className="flex items-center gap-2">
                        <Button size="xs" variant={isRecording ? 'default' : 'ghost'} onClick={() => { void handleRecordToggle(); }}>
                            <Icon name={isRecording ? 'stop' : 'mic'} className="mr-1 h-3.5 w-3.5" />
                            {isRecording ? t('settings.voice.page.omnivoice.stopRecording') : t('settings.voice.page.omnivoice.record')}
                        </Button>
                        <span className={SETTINGS_HELPER_CLASS}>{t('settings.voice.page.omnivoice.orUpload')}</span>
                        <input
                            type="file"
                            accept="audio/*"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) void handleFileUpload(file);
                            }}
                            className="typography-ui-compact text-muted-foreground"
                        />
                        {recordedBlob && (
                            <Icon name="checkbox-circle" className="h-4 w-4 text-[var(--status-success)]" aria-label={t('settings.voice.page.omnivoice.clipReady')} />
                        )}
                    </div>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('settings.voice.page.omnivoice.voiceNamePlaceholder')}
                        className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                    />
                    <textarea
                        value={transcript}
                        onChange={(e) => setTranscript(e.target.value)}
                        placeholder={t('settings.voice.page.omnivoice.transcriptPlaceholder')}
                        rows={2}
                        className="w-full rounded-lg border border-input bg-transparent px-2 py-1.5 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                    />
                    <Button size="xs" onClick={() => { void handleSave(); }} disabled={saving || !recordedBlob}>
                        {saving ? <Icon name="loader-4" className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                        {t('settings.voice.page.omnivoice.saveVoice')}
                    </Button>
                    {error && <div className="typography-meta text-[var(--status-error)]">{error}</div>}
                </div>
            )}
        </div>
    );
};

const OPENAI_VOICE_OPTIONS = [
    { value: 'alloy', label: 'Alloy' },
    { value: 'ash', label: 'Ash' },
    { value: 'ballad', label: 'Ballad' },
    { value: 'coral', label: 'Coral' },
    { value: 'echo', label: 'Echo' },
    { value: 'fable', label: 'Fable' },
    { value: 'nova', label: 'Nova' },
    { value: 'onyx', label: 'Onyx' },
    { value: 'sage', label: 'Sage' },
    { value: 'shimmer', label: 'Shimmer' },
    { value: 'verse', label: 'Verse' },
    { value: 'marin', label: 'Marin' },
    { value: 'cedar', label: 'Cedar' },
];

export const VoiceSettings: React.FC = () => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const setVoiceProvider = useConfigStore((state) => state.setVoiceProvider);
    const speechRate = useConfigStore((state) => state.speechRate);
    const setSpeechRate = useConfigStore((state) => state.setSpeechRate);
    const speechPitch = useConfigStore((state) => state.speechPitch);
    const setSpeechPitch = useConfigStore((state) => state.setSpeechPitch);
    const speechVolume = useConfigStore((state) => state.speechVolume);
    const setSpeechVolume = useConfigStore((state) => state.setSpeechVolume);
    const sayVoice = useConfigStore((state) => state.sayVoice);
    const setSayVoice = useConfigStore((state) => state.setSayVoice);
    const localTtsVoiceId = useConfigStore((state) => state.localTtsVoiceId);
    const setLocalTtsVoiceId = useConfigStore((state) => state.setLocalTtsVoiceId);
    const localTtsModelId = useConfigStore((state) => state.localTtsModelId);
    const setLocalTtsModelId = useConfigStore((state) => state.setLocalTtsModelId);
    const omnivoiceLanguage = useConfigStore((state) => state.omnivoiceLanguage);
    const setOmnivoiceLanguage = useConfigStore((state) => state.setOmnivoiceLanguage);
    const omnivoiceVoiceId = useConfigStore((state) => state.omnivoiceVoiceId);
    const setOmnivoiceVoiceId = useConfigStore((state) => state.setOmnivoiceVoiceId);
    const { speak: speakLocalTts, stop: stopLocalTts, isPlaying: isLocalTtsPlaying, error: localTtsError } = useLocalTTS();

    const previewLocalVoice = useCallback(() => {
        if (isLocalTtsPlaying) {
            stopLocalTts();
            return;
        }
        if (localTtsModelId === OMNIVOICE_MODEL_ID || localTtsModelId === QWEN_TTS_MODEL_ID) {
            // Preview with text actually written in the selected language —
            // TTS pronounces whatever text it's given, it does not translate,
            // so an English line would sound English regardless of the
            // language picked here.
            const previewKey = localTtsModelId === QWEN_TTS_MODEL_ID
                ? (QWEN_LANGUAGE_TO_PREVIEW_KEY[omnivoiceLanguage] ?? 'en')
                : omnivoiceLanguage;
            const previewText = OMNIVOICE_PREVIEW_TEXT[previewKey] ?? OMNIVOICE_PREVIEW_TEXT.en;
            void speakLocalTts(previewText, {
                model: localTtsModelId,
                language: omnivoiceLanguage || undefined,
                refVoiceId: omnivoiceVoiceId || undefined,
                speed: useConfigStore.getState().speechRate,
            });
            return;
        }
        const voiceLabel = KOKORO_VOICE_OPTIONS.find((v) => v.id === localTtsVoiceId)?.label
            ?? String(localTtsVoiceId);
        void speakLocalTts(t('settings.voice.page.preview.voiceLine', { voiceName: voiceLabel }), {
            model: LOCAL_TTS_MODEL_ID,
            speakerId: localTtsVoiceId,
            speed: useConfigStore.getState().speechRate,
        });
    }, [isLocalTtsPlaying, localTtsVoiceId, localTtsModelId, omnivoiceLanguage, omnivoiceVoiceId, speakLocalTts, stopLocalTts, t]);
    const browserVoice = useConfigStore((state) => state.browserVoice);
    const setBrowserVoice = useConfigStore((state) => state.setBrowserVoice);
    const openaiVoice = useConfigStore((state) => state.openaiVoice);
    const setOpenaiVoice = useConfigStore((state) => state.setOpenaiVoice);
    const openaiApiKey = useConfigStore((state) => state.openaiApiKey);
    const setOpenaiApiKey = useConfigStore((state) => state.setOpenaiApiKey);
    const openaiCompatibleUrl = useConfigStore((state) => state.openaiCompatibleUrl);
    const setOpenaiCompatibleUrl = useConfigStore((state) => state.setOpenaiCompatibleUrl);
    const openaiCompatibleApiKey = useConfigStore((state) => state.openaiCompatibleApiKey);
    const setOpenaiCompatibleApiKey = useConfigStore((state) => state.setOpenaiCompatibleApiKey);
    const openaiCompatibleVoice = useConfigStore((state) => state.openaiCompatibleVoice);
    const setOpenaiCompatibleVoice = useConfigStore((state) => state.setOpenaiCompatibleVoice);
    const openaiCompatibleTtsModel = useConfigStore((state) => state.openaiCompatibleTtsModel);
    const setOpenaiCompatibleTtsModel = useConfigStore((state) => state.setOpenaiCompatibleTtsModel);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const ttsInputMode = useConfigStore((state) => state.ttsInputMode);
    const setTtsInputMode = useConfigStore((state) => state.setTtsInputMode);
    // STT settings
    const sttProvider = useConfigStore((state) => state.sttProvider);
    const setSttProvider = useConfigStore((state) => state.setSttProvider);
    const sttServerUrl = useConfigStore((state) => state.sttServerUrl);
    const setSttServerUrl = useConfigStore((state) => state.setSttServerUrl);
    const sttApiKey = useConfigStore((state) => state.sttApiKey);
    const setSttApiKey = useConfigStore((state) => state.setSttApiKey);
    const sttModel = useConfigStore((state) => state.sttModel);
    const setSttModel = useConfigStore((state) => state.setSttModel);
    const sttLocalModel = useConfigStore((state) => state.sttLocalModel);
    const setSttLocalModel = useConfigStore((state) => state.setSttLocalModel);
    const sttLanguage = useConfigStore((state) => state.sttLanguage);
    const setSttLanguage = useConfigStore((state) => state.setSttLanguage);
    const setShowMessageTTSButtons = useConfigStore((state) => state.setShowMessageTTSButtons);
    const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
    const setDictationEnabled = useConfigStore((state) => state.setDictationEnabled);

    const [isSayAvailable, setIsSayAvailable] = useState(false);
    const [sayVoices, setSayVoices] = useState<Array<{ name: string; locale: string }>>([]);
    const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
    const [previewAudio, setPreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [isOpenAIAvailable, setIsOpenAIAvailable] = useState(false);
    const [isOpenAIPreviewPlaying, setIsOpenAIPreviewPlaying] = useState(false);
    const [openaiPreviewAudio, setOpenaiPreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [isCompatiblePreviewPlaying, setIsCompatiblePreviewPlaying] = useState(false);
    const [compatiblePreviewAudio, setCompatiblePreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [isBrowserPreviewPlaying, setIsBrowserPreviewPlaying] = useState(false);

    useEffect(() => {
        const loadVoices = async () => {
            const voices = await browserVoiceService.waitForVoices();
            setBrowserVoices(voices);
        };
        loadVoices();

        if ('speechSynthesis' in window) {
            window.speechSynthesis.onvoiceschanged = () => {
                setBrowserVoices(window.speechSynthesis.getVoices());
            };
        }

        return () => {
            if ('speechSynthesis' in window) {
                window.speechSynthesis.onvoiceschanged = null;
            }
        };
    }, []);

    const filteredBrowserVoices = useMemo(() => {
        return browserVoices
            .filter(v => v.lang)
            .sort((a, b) => {
                const aIsEnglish = a.lang.startsWith('en');
                const bIsEnglish = b.lang.startsWith('en');
                if (aIsEnglish && !bIsEnglish) return -1;
                if (!aIsEnglish && bIsEnglish) return 1;
                const langCompare = a.lang.localeCompare(b.lang);
                if (langCompare !== 0) return langCompare;
                return a.name.localeCompare(b.name);
            });
    }, [browserVoices]);

    const previewBrowserVoice = useCallback(() => {
        if (isBrowserPreviewPlaying) {
            browserVoiceService.cancelSpeech();
            setIsBrowserPreviewPlaying(false);
            return;
        }

        const selectedVoice = browserVoices.find(v => v.name === browserVoice);
        const voiceName = selectedVoice?.name ?? t('settings.voice.page.preview.browserVoiceFallback');
        const previewText = t('settings.voice.page.preview.voiceLine', { voiceName });

        setIsBrowserPreviewPlaying(true);

        const utterance = new SpeechSynthesisUtterance(previewText);
        utterance.rate = speechRate;
        utterance.pitch = speechPitch;
        utterance.volume = speechVolume;

        if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang;
        }

        utterance.onend = () => setIsBrowserPreviewPlaying(false);
        utterance.onerror = () => setIsBrowserPreviewPlaying(false);

        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
    }, [browserVoice, browserVoices, speechRate, speechPitch, speechVolume, isBrowserPreviewPlaying, t]);

    useEffect(() => {
        return () => {
            if (isBrowserPreviewPlaying) {
                browserVoiceService.cancelSpeech();
            }
        };
    }, [isBrowserPreviewPlaying]);

    useEffect(() => {
        if (!showMessageTTSButtons || (voiceProvider !== 'openai' && voiceProvider !== 'openai-compatible')) {
            setIsOpenAIAvailable(openaiApiKey.trim().length > 0);
            return;
        }

        const checkOpenAIAvailability = async () => {
            try {
                const response = await runtimeFetch('/api/tts/status');
                const data = await response.json();
                const hasServerKey = data.available;
                const hasSettingsKey = openaiApiKey.trim().length > 0;
                setIsOpenAIAvailable(hasServerKey || hasSettingsKey);
            } catch {
                setIsOpenAIAvailable(openaiApiKey.trim().length > 0);
            }
        };

        checkOpenAIAvailability();
    }, [openaiApiKey, showMessageTTSButtons, voiceProvider]);

    useEffect(() => {
        if (!showMessageTTSButtons) {
            setIsSayAvailable(false);
            setSayVoices([]);
            return;
        }

        runtimeFetch('/api/tts/say/status')
            .then(res => res.json())
            .then(data => {
                setIsSayAvailable(data.available);
                if (data.voices) {
                    const uniqueVoices = data.voices
                        .filter((v: { name: string; locale: string }, i: number, arr: Array<{ name: string; locale: string }>) =>
                            arr.findIndex((x: { name: string }) => x.name === v.name) === i
                        )
                        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
                    setSayVoices(uniqueVoices);
                }
            })
            .catch(() => {
                setIsSayAvailable(false);
            });
    }, [showMessageTTSButtons]);

    const previewVoice = useCallback(async () => {
        if (previewAudio) {
            disposePreviewAudio(previewAudio);
            setPreviewAudio(null);
            setIsPreviewPlaying(false);
            return;
        }

        setIsPreviewPlaying(true);
        let audio: HTMLAudioElement | null = null;
        try {
            const response = await runtimeFetch('/api/tts/say/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.voiceLine', { voiceName: sayVoice }),
                    voice: sayVoice,
                    rate: Math.round(100 + (speechRate - 0.5) * 200),
                }),
            });

            if (!response.ok) throw new Error('Preview failed');

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            audio = new Audio(url);

            audio.onended = () => {
                disposePreviewAudio(audio);
                setPreviewAudio(null);
                setIsPreviewPlaying(false);
            };

            audio.onerror = () => {
                disposePreviewAudio(audio);
                setPreviewAudio(null);
                setIsPreviewPlaying(false);
            };

            setPreviewAudio(audio);
            await audio.play();
        } catch {
            disposePreviewAudio(audio);
            setPreviewAudio(null);
            setIsPreviewPlaying(false);
        }
    }, [sayVoice, speechRate, previewAudio, t]);

    useEffect(() => {
        return () => {
            disposePreviewAudio(previewAudio);
        };
    }, [previewAudio]);

    const previewOpenAIVoice = useCallback(async () => {
        if (openaiPreviewAudio) {
            disposePreviewAudio(openaiPreviewAudio);
            setOpenaiPreviewAudio(null);
            setIsOpenAIPreviewPlaying(false);
            return;
        }

        setIsOpenAIPreviewPlaying(true);
        let audio: HTMLAudioElement | null = null;
        try {
            const response = await runtimeFetch('/api/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.voiceLine', { voiceName: openaiVoice }),
                    voice: openaiVoice,
                    speed: speechRate,
                    apiKey: openaiApiKey || undefined,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            audio = new Audio(url);

            audio.onended = () => {
                disposePreviewAudio(audio);
                setOpenaiPreviewAudio(null);
                setIsOpenAIPreviewPlaying(false);
            };

            audio.onerror = () => {
                disposePreviewAudio(audio);
                setOpenaiPreviewAudio(null);
                setIsOpenAIPreviewPlaying(false);
            };

            setOpenaiPreviewAudio(audio);
            await audio.play();
        } catch {
            disposePreviewAudio(audio);
            setOpenaiPreviewAudio(null);
            setIsOpenAIPreviewPlaying(false);
        }
    }, [openaiVoice, speechRate, openaiPreviewAudio, openaiApiKey, t]);

    useEffect(() => {
        return () => {
            disposePreviewAudio(openaiPreviewAudio);
        };
    }, [openaiPreviewAudio]);

    const previewCompatibleVoice = useCallback(async () => {
        if (compatiblePreviewAudio) {
            disposePreviewAudio(compatiblePreviewAudio);
            setCompatiblePreviewAudio(null);
            setIsCompatiblePreviewPlaying(false);
            return;
        }

        if (!openaiCompatibleUrl.trim()) return;

        setIsCompatiblePreviewPlaying(true);
        let audio: HTMLAudioElement | null = null;
        try {
            const response = await runtimeFetch('/api/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.customServerLine'),
                    voice: openaiCompatibleVoice,
                    model: openaiCompatibleTtsModel || undefined,
                    speed: speechRate,
                    baseURL: openaiCompatibleUrl,
                    apiKey: openaiCompatibleApiKey || undefined,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            audio = new Audio(url);

            audio.onended = () => {
                disposePreviewAudio(audio);
                setCompatiblePreviewAudio(null);
                setIsCompatiblePreviewPlaying(false);
            };

            audio.onerror = () => {
                disposePreviewAudio(audio);
                setCompatiblePreviewAudio(null);
                setIsCompatiblePreviewPlaying(false);
            };

            setCompatiblePreviewAudio(audio);
            await audio.play();
        } catch {
            disposePreviewAudio(audio);
            setCompatiblePreviewAudio(null);
            setIsCompatiblePreviewPlaying(false);
        }
    }, [openaiCompatibleUrl, openaiCompatibleVoice, openaiCompatibleTtsModel, openaiCompatibleApiKey, speechRate, compatiblePreviewAudio, t]);

    useEffect(() => {
        return () => {
            disposePreviewAudio(compatiblePreviewAudio);
        };
    }, [compatiblePreviewAudio]);

    const sliderClass = "flex-1 min-w-0 h-1.5 bg-[var(--interactive-border)] rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:border-0 disabled:opacity-50";

    return (
        <>
            <SettingsSection
                settingsItem="voice.playback"
                title={t('settings.voice.page.section.playbackAndSummary')}
                divider={false}
                contentClassName="space-y-4"
            >
                <SettingsCheckboxRow
                    checked={showMessageTTSButtons}
                    onChange={setShowMessageTTSButtons}
                    label={t('settings.voice.page.field.messageReadAloudButton')}
                    ariaLabel={t('settings.voice.page.field.messageReadAloudButtonAria')}
                />

                {showMessageTTSButtons && (
                    <>
                        <SettingsControlGroup
                            title={t('settings.voice.page.field.provider')}
                            info={(
                                <ul className="space-y-1">
                                    <li><strong>{t('settings.voice.page.provider.browser')}</strong> {t('settings.voice.page.tooltip.browser')}</li>
                                    <li><strong>{t('settings.voice.page.provider.local')}</strong> {t('settings.voice.page.tooltip.localTts')}</li>
                                    <li><strong>{t('settings.voice.page.provider.openai')}</strong> {t('settings.voice.page.tooltip.openai')}</li>
                                    <li><strong>{t('settings.voice.page.provider.custom')}</strong> {t('settings.voice.page.tooltip.custom')}</li>
                                    <li><strong>{t('settings.voice.page.provider.say')}</strong> {t('settings.voice.page.tooltip.say')}</li>
                                </ul>
                            )}
                        >
                            <SettingsChipGroup
                                value={voiceProvider}
                                onChange={setVoiceProvider}
                                aria-label={t('settings.voice.page.field.provider')}
                                className="w-full gap-1.5 sm:gap-2"
                                options={[
                                    { value: 'browser', label: t('settings.voice.page.provider.browser') },
                                    { value: 'local', label: t('settings.voice.page.provider.local') },
                                    { value: 'openai', label: t('settings.voice.page.provider.openai') },
                                    { value: 'openai-compatible', label: t('settings.voice.page.provider.custom') },
                                    ...(isSayAvailable
                                        ? [{
                                            value: 'say' as const,
                                            label: (
                                                <>
                                                    <Icon name="apple" className="mr-0.5 h-3.5 w-3.5" />
                                                    {t('settings.voice.page.provider.say')}
                                                </>
                                            ),
                                        }]
                                        : []),
                                ]}
                            />
                        </SettingsControlGroup>

                            {/* OpenAI API Key */}
                            {voiceProvider === 'openai' && (
                                <div className="space-y-1.5">
                                    <span className={cn(SETTINGS_FIELD_LABEL_CLASS, !isOpenAIAvailable && "text-[var(--status-error)]")}>
                                        {t('settings.voice.page.field.apiKey')}
                                    </span>
                                    <span className={cn(SETTINGS_HELPER_CLASS, !isOpenAIAvailable && "text-[var(--status-error)]/80")}>
                                        {isOpenAIAvailable && !openaiApiKey
                                          ? t('settings.voice.page.field.apiKeyHintUsingConfig')
                                          : !isOpenAIAvailable
                                            ? t('settings.voice.page.field.apiKeyHintRequired')
                                            : t('settings.voice.page.field.apiKeyHintProvide')}
                                    </span>
                                    <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                        <input
                                            type="password"
                                            value={openaiApiKey}
                                            onChange={(e) => setOpenaiApiKey(e.target.value)}
                                            placeholder="sk-..."
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                        {openaiApiKey && (
                                            <button
                                                type="button"
                                                onClick={() => setOpenaiApiKey('')}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <Icon name="close" className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* OpenAI-compatible custom server */}
                            {voiceProvider === 'openai-compatible' && (
                                <div className="space-y-3">
                                    <div className="space-y-1.5">
                                        <span className="flex items-center gap-1.5">
                                            <span className={cn(SETTINGS_FIELD_LABEL_CLASS, !openaiCompatibleUrl.trim() && "text-[var(--status-error)]")}>
                                                {t('settings.voice.page.field.serverUrl')}
                                            </span>
                                            <SettingsInfoHint>{t('settings.voice.page.field.serverUrlHint')}</SettingsInfoHint>
                                        </span>
                                        <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                            <input
                                                type="text"
                                                value={openaiCompatibleUrl}
                                                onChange={(e) => setOpenaiCompatibleUrl(e.target.value)}
                                                placeholder="http://localhost:8880/v1"
                                                className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                            />
                                            {openaiCompatibleUrl && (
                                                <button
                                                    type="button"
                                                    onClick={() => setOpenaiCompatibleUrl('')}
                                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                                >
                                                    <Icon name="close" className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <span className={SETTINGS_FIELD_LABEL_CLASS}>API Key</span>
                                        <span className={SETTINGS_HELPER_CLASS}>
                                            Optional
                                        </span>
                                        <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                            <input
                                                type="password"
                                                value={openaiCompatibleApiKey}
                                                onChange={(e) => setOpenaiCompatibleApiKey(e.target.value)}
                                                placeholder="sk-..."
                                                className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                            />
                                            {openaiCompatibleApiKey && (
                                                <button
                                                    type="button"
                                                    onClick={() => setOpenaiCompatibleApiKey('')}
                                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                                >
                                                    <Icon name="close" className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.voice.page.field.model')}</span>
                                        <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                            <input
                                                type="text"
                                                value={openaiCompatibleTtsModel}
                                                onChange={(e) => setOpenaiCompatibleTtsModel(e.target.value)}
                                                placeholder="speaches-ai/Kokoro-82M-v1.0-ONNX"
                                                className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <span className="flex items-center gap-1.5">
                                            <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.voice.page.field.voice')}</span>
                                            <SettingsInfoHint>{t('settings.voice.page.field.voiceIdentifierHint')}</SettingsInfoHint>
                                        </span>
                                        <div className={cn('flex items-center gap-2', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                            <div className="relative min-w-0 flex-1">
                                                <input
                                                    type="text"
                                                    value={openaiCompatibleVoice}
                                                    onChange={(e) => setOpenaiCompatibleVoice(e.target.value)}
                                                    placeholder="af_sky"
                                                    className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                                />
                                            </div>
                                            <Button size="xs" variant="ghost" onClick={previewCompatibleVoice} title={t('settings.voice.page.actions.preview')} disabled={!openaiCompatibleUrl.trim()}>
                                                {isCompatiblePreviewPlaying ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />}
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Local TTS engine (Kokoro, OmniVoice, or Qwen3-TTS) */}
                            {voiceProvider === 'local' && (
                                <SettingsFieldRow label={t('settings.voice.page.field.engine')}>
                                    <Select
                                        value={localTtsModelId}
                                        onValueChange={(v) => {
                                            // SAFETY: v is one of LOCAL_TTS_ENGINES' ids, rendered as this Select's own SelectItem values below.
                                            setLocalTtsModelId(v as typeof localTtsModelId);
                                        }}
                                    >
                                        <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {LOCAL_TTS_ENGINES.map((engine) => (
                                                <SelectItem key={engine.id} value={engine.id}>{engine.label}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SettingsFieldRow>
                            )}
                            {voiceProvider === 'local' && (
                                <LocalTtsModelStatus
                                    modelId={localTtsModelId}
                                    label={LOCAL_TTS_ENGINES.find((e) => e.id === localTtsModelId)?.label ?? ''}
                                    sizeLabel={LOCAL_TTS_ENGINES.find((e) => e.id === localTtsModelId)?.sizeLabel ?? ''}
                                />
                            )}

                            {/* Voice Selection */}
                            <SettingsFieldRow label={t('settings.voice.page.field.voice')}>
                                    {voiceProvider === 'local' && localTtsModelId === LOCAL_TTS_MODEL_ID && (
                                        <>
                                            <Select
                                                value={String(localTtsVoiceId)}
                                                onValueChange={(value) => setLocalTtsVoiceId(Number.parseInt(value, 10) || 0)}
                                            >
                                                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')}>
                                                        {(value) => KOKORO_VOICE_OPTIONS.find((v) => String(v.id) === value)?.label ?? value}
                                                    </SelectValue>
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {KOKORO_VOICE_OPTIONS.map((v) => (
                                                        <SelectItem key={v.id} value={String(v.id)}>{v.label}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewLocalVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isLocalTtsPlaying ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />}
                                            </Button>
                                            {localTtsError ? (
                                                <span className="typography-meta text-[var(--status-error)]">{localTtsError}</span>
                                            ) : null}
                                        </>
                                    )}

                                    {voiceProvider === 'local' && (localTtsModelId === OMNIVOICE_MODEL_ID || localTtsModelId === QWEN_TTS_MODEL_ID) && (
                                        <div className="flex w-full flex-col gap-2">
                                            <div className="flex items-center gap-2">
                                                <Select value={omnivoiceLanguage} onValueChange={setOmnivoiceLanguage}>
                                                    <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                        <SelectValue>
                                                            {(value) => {
                                                                const options = localTtsModelId === QWEN_TTS_MODEL_ID ? QWEN_LANGUAGE_OPTIONS : OMNIVOICE_LANGUAGE_OPTIONS;
                                                                return options.find((l) => l.code === value)?.label ?? value;
                                                            }}
                                                        </SelectValue>
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {(localTtsModelId === QWEN_TTS_MODEL_ID ? QWEN_LANGUAGE_OPTIONS : OMNIVOICE_LANGUAGE_OPTIONS).map((l) => (
                                                            <SelectItem key={l.code || 'auto'} value={l.code}>{l.label}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                                <Button size="xs" variant="ghost" onClick={previewLocalVoice} title={t('settings.voice.page.actions.preview')}>
                                                    {isLocalTtsPlaying ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />}
                                                </Button>
                                            </div>
                                            {/* Voice profiles are a shared library across cloning-capable engines,
                                                not scoped per engine -- any WAV + accurate transcript works as a
                                                reference regardless of which model does the cloning. */}
                                            <OmniVoiceVoiceManager selectedVoiceId={omnivoiceVoiceId} onSelectVoice={setOmnivoiceVoiceId} />
                                            {localTtsError ? (
                                                <span className="typography-meta text-[var(--status-error)]">{localTtsError}</span>
                                            ) : null}
                                        </div>
                                    )}

                                    {voiceProvider === 'openai' && isOpenAIAvailable && (
                                        <>
                                            <Select value={openaiVoice} onValueChange={setOpenaiVoice}>
                                                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {OPENAI_VOICE_OPTIONS.map((v) => (
                                                        <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewOpenAIVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isOpenAIPreviewPlaying ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}

                                    {voiceProvider === 'openai-compatible' && (
                                        <span className={SETTINGS_HELPER_CLASS}>{t('settings.voice.page.field.configuredAbove')}</span>
                                    )}

                                    {voiceProvider === 'say' && isSayAvailable && sayVoices.length > 0 && (
                                        <>
                                            <Select value={sayVoice} onValueChange={setSayVoice}>
                                                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {sayVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isPreviewPlaying ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}

                                    {voiceProvider === 'browser' && filteredBrowserVoices.length > 0 && (
                                        <>
                                            <Select value={browserVoice || '$auto'} onValueChange={(value) => setBrowserVoice(value === '$auto' ? '' : value)}>
                                                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={t('settings.voice.page.field.auto')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="$auto">{t('settings.voice.page.field.auto')}</SelectItem>
                                                    {filteredBrowserVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name} ({v.lang})</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewBrowserVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isBrowserPreviewPlaying ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}
                            </SettingsFieldRow>

                            {/* Speech Rate */}
                            <SettingsFieldRow label={t('settings.voice.page.field.speechRate')}>
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechRate} onChange={(e) => setSpeechRate(Number(e.target.value))} className={sliderClass} />}
                                    <NumberInput value={speechRate} onValueChange={setSpeechRate} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                            </SettingsFieldRow>

                            {/* Speech Pitch */}
                            <SettingsFieldRow label={t('settings.voice.page.field.speechPitch')}>
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechPitch} onChange={(e) => setSpeechPitch(Number(e.target.value))} className={sliderClass} />}
                                    <NumberInput value={speechPitch} onValueChange={setSpeechPitch} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                            </SettingsFieldRow>

                            {/* Speech Volume */}
                            <SettingsFieldRow label={t('settings.voice.page.field.speechVolume')}>
                                    {!isMobile && <input type="range" min={0} max={1} step={0.1} value={speechVolume} onChange={(e) => setSpeechVolume(Number(e.target.value))} className={sliderClass} />}
                                    {isMobile ? (
                                        <NumberInput value={Math.round(speechVolume * 100)} onValueChange={(v) => setSpeechVolume(v / 100)} min={0} max={100} step={10} className="w-16 tabular-nums" />
                                    ) : (
                                        <span className="typography-ui-label text-foreground tabular-nums min-w-[3rem] text-right">
                                            {Math.round(speechVolume * 100)}%
                                        </span>
                                    )}
                            </SettingsFieldRow>

                            <SettingsControlGroup title={t('settings.voice.page.field.ttsInputMode')}>
                                <SettingsChipGroup
                                    value={ttsInputMode}
                                    onChange={setTtsInputMode}
                                    aria-label={t('settings.voice.page.field.ttsInputMode')}
                                    className="w-full gap-1.5 sm:gap-2"
                                    options={[
                                        { value: 'sanitized', label: t('settings.voice.page.field.ttsInputModeSanitized') },
                                        { value: 'raw', label: t('settings.voice.page.field.ttsInputModeRaw') },
                                        { value: 'summarized', label: t('settings.voice.page.field.ttsInputModeSummarized') },
                                    ]}
                                />
                            </SettingsControlGroup>
                    </>
                )}
            </SettingsSection>

            <SettingsSection
                settingsItem="voice.speech-recognition"
                title={t('settings.voice.page.section.speechRecognition')}
                contentClassName="space-y-4"
            >
                <SettingsCheckboxRow
                    checked={dictationEnabled}
                    onChange={setDictationEnabled}
                    label={t('settings.voice.page.field.enableVoiceInput')}
                    ariaLabel={t('settings.voice.page.field.enableVoiceInputAria')}
                />

                {dictationEnabled && (
                    <>
                        <SettingsControlGroup
                            title={t('settings.voice.page.field.provider')}
                            info={(
                                <ul className="space-y-1">
                                    <li><strong>{t('settings.voice.page.provider.local')}</strong> {t('settings.voice.page.tooltip.sttLocal')}</li>
                                    <li><strong>{t('settings.voice.page.provider.server')}</strong> {t('settings.voice.page.tooltip.sttServer')}</li>
                                </ul>
                            )}
                        >
                            <SettingsChipGroup
                                value={sttProvider}
                                onChange={setSttProvider}
                                aria-label={t('settings.voice.page.field.provider')}
                                className="w-full gap-1.5 sm:gap-2"
                                options={[
                                    { value: 'local', label: t('settings.voice.page.provider.local') },
                                    { value: 'openai-compatible', label: t('settings.voice.page.provider.server') },
                                ]}
                            />
                        </SettingsControlGroup>

                        {sttProvider === 'local' && (
                            <div className="space-y-1.5">
                                <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.voice.page.field.model')}</span>
                                <LocalModelPicker selectedModelId={sttLocalModel} onSelect={setSttLocalModel} />
                            </div>
                        )}

                        {sttProvider === 'openai-compatible' && (
                            <div className="space-y-3">
                                <div className="space-y-1.5">
                                    <span className="flex items-center gap-1.5">
                                        <span className={cn(SETTINGS_FIELD_LABEL_CLASS, !sttServerUrl.trim() && "text-[var(--status-error)]")}>
                                            {t('settings.voice.page.field.serverUrl')}
                                        </span>
                                        <SettingsInfoHint>{t('settings.voice.page.field.sttServerUrlHint')}</SettingsInfoHint>
                                    </span>
                                    <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                        <input
                                            type="text"
                                            value={sttServerUrl}
                                            onChange={(e) => setSttServerUrl(e.target.value)}
                                            placeholder="http://localhost:8001/v1"
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                        {sttServerUrl && (
                                            <button
                                                type="button"
                                                onClick={() => setSttServerUrl('')}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <Icon name="close" className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <span className={SETTINGS_FIELD_LABEL_CLASS}>API Key</span>
                                    <span className={SETTINGS_HELPER_CLASS}>
                                        Optional
                                    </span>
                                    <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                        <input
                                            type="password"
                                            value={sttApiKey}
                                            onChange={(e) => setSttApiKey(e.target.value)}
                                            placeholder="sk-..."
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                        {sttApiKey && (
                                            <button
                                                type="button"
                                                onClick={() => setSttApiKey('')}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <Icon name="close" className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.voice.page.field.model')}</span>
                                    <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                        <input
                                            type="text"
                                            value={sttModel}
                                            onChange={(e) => setSttModel(e.target.value)}
                                            placeholder="deepdml/faster-whisper-large-v3-turbo-ct2"
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <span className="flex items-center gap-1.5">
                                        <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.voice.page.field.language')}</span>
                                        <SettingsInfoHint>{t('settings.voice.page.field.sttLanguageHint')}</SettingsInfoHint>
                                    </span>
                                    <div className="relative max-w-[8rem]">
                                        <input
                                            type="text"
                                            value={sttLanguage}
                                            onChange={(e) => setSttLanguage(e.target.value)}
                                            placeholder="auto"
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </SettingsSection>
        </>
    );
};
