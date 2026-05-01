// SPDX-License-Identifier: Apache-2.0
import { BookmarkManager } from '../utils/bookmark-manager';
import type { BookmarkCreationResult, BookmarkMoveResult } from '../utils/bookmark-manager';
import { LlmClassifier } from '../utils/llm-classifier';
import type { ClassificationResultWithMeta } from '../utils/llm-classifier';
import { SecurityManager } from '../utils/security';
import {
    fetchOpenRouterModels,
    getProviderPreference,
    getSelectedOpenRouterModel,
} from '../utils/openrouter';

type RuntimeRequest = {
    action: string;
    data?: unknown;
};

type RuntimeSuccess<T> = { success: true; result: T };
type RuntimeFailure = { success: false; error: string };
type RuntimeResponse<T> = RuntimeSuccess<T> | RuntimeFailure;

type SettingsState = {
    hasApiKey: boolean;
    apiKeyHint: string | null;
    providerPreference: string | null;
    selectedOpenRouterModel: string | null;
    autoClassifyEnabled: boolean;
};

type ClassifyAndSavePayload = {
    url: string;
    title: string;
};

type ReclassifyPayload = {
    bookmarkId: string;
    modelOverride?: string;
};

type BulkOrganizeJobState = {
    status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
    startedAt: number | null;
    updatedAt: number | null;
    targetRootId: string | null;
    renameTitles: boolean;
    cleanupEmptyFolders: boolean;
    forceReorganize: boolean;
    total: number;
    cursor: number;
    processed: number;
    succeeded: number;
    failed: number;
    skipped: number;
    skippedAlreadyOrganized: number;
    lastError: string | null;
    failureCounts: Record<string, number>;
    recentFailures: Array<{
        bookmarkId: string;
        title: string;
        url: string;
        error: string;
    }>;
    bookmarkIds: string[];
    cleanupCandidateFolderIds: string[];
    avgMsPerBookmark: number | null;
    lastBatchMs: number | null;
    lastBatchSize: number | null;
    backoffUntil: number | null;
    backoffMs: number;
};

type BulkOrganizeProcessedIndex = Record<string, { succeededAt: number; targetRootId: string | null }>;

type ClassifyResultPayload = {
    bookmark: chrome.bookmarks.BookmarkTreeNode;
    folderPath: string[];
    previousFolderPath?: string[];
    folderId: string;
    title: string;
    url: string;
    tags: string[];
    confidence: number;
    provider: string;
    providerId: string;
    model: string;
    action: 'created' | 'moved';
};

const AUTO_CLASSIFY_KEY = 'auto_classify_enabled';
const BULK_ORGANIZE_KEY = 'bulk_organize_job';
const BULK_ORGANIZE_PROCESSED_KEY = 'bulk_organize_processed_v1';
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_TITLE_LENGTH = 300;
const MAX_MODEL_LENGTH = 150;
const BULK_BATCH_SIZE = 5;
const BULK_RECENT_FAILURES_LIMIT = 25;
const BULK_FAILURE_KEYS_LIMIT = 25;
const BULK_ORGANIZE_ALARM = 'bulk_organize_tick';
// Chrome alarms are best-effort and commonly clamp to >= 1 minute.
// We'll also run an immediate batch after starting to avoid "stuck at 0".
const BULK_ORGANIZE_TICK_MINUTES = 1;
// Try to do as much work as possible per alarm tick without risking
// service worker termination. Keep some buffer for storage writes, etc.
const BULK_ORGANIZE_TICK_BUDGET_MS = 22_000;
const BULK_ORGANIZE_MAX_BATCHES_PER_TICK = 30;
const BULK_ORGANIZE_OVERHEAD_MS = 900;
const BULK_ORGANIZE_BATCH_SIZE_MIN = 1;
const BULK_ORGANIZE_BATCH_SIZE_MAX = 12;
const BULK_ORGANIZE_RATE_LIMIT_BACKOFF_MS = 60_000;
const BULK_ORGANIZE_RATE_LIMIT_BACKOFF_MAX_MS = 10 * 60_000;

class BackgroundService {
    private readonly bookmarkManager = new BookmarkManager();
    private readonly classifier = new LlmClassifier();
    private readonly pendingInternalBookmarkFingerprints = new Set<string>();

    constructor() {
        this.initializeListeners();
    }

    private initializeListeners(): void {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            void this.routeMessage(request, sender).then(sendResponse);
            return true;
        });

        chrome.runtime.onInstalled.addListener(() => {
            void this.ensureDefaultSettings();
        });

        const actionApi = (chrome as any).action ?? (chrome as any).browserAction;
        actionApi?.onClicked?.addListener(() => {
            // Open a persistent tab-based UI instead of a transient popup.
            void chrome.runtime.openOptionsPage();
        });

        chrome.bookmarks?.onCreated?.addListener((bookmarkId, bookmark) => {
            void this.handleAutoClassifyBookmark(bookmarkId, bookmark);
        });

        chrome.alarms?.onAlarm?.addListener((alarm) => {
            if (alarm.name !== BULK_ORGANIZE_ALARM) {
                return;
            }
            void this.runBulkOrganizeTick();
        });

        globalThis.addEventListener('unhandledrejection', () => {
            // Keep service worker alive and avoid silent failures.
        });
    }

    private async routeMessage(
        request: unknown,
        sender: chrome.runtime.MessageSender,
    ): Promise<RuntimeResponse<unknown>> {
        try {
            if (!this.isRuntimeRequest(request)) {
                return this.failure('Invalid request payload.');
            }
            if (sender.id && sender.id !== chrome.runtime.id) {
                return this.failure('Unauthorized request sender.');
            }

            switch (request.action) {
                case 'SAVE_API_KEY':
                    return this.success(await this.handleSaveApiKey(request.data));
                case 'GET_SETTINGS_STATE':
                    return this.success(await this.getSettingsState());
                case 'GET_OPENROUTER_MODELS':
                    return this.success(await this.handleGetOpenRouterModels(request.data));
                case 'CLASSIFY_AND_SAVE':
                    return this.success(await this.handleClassifyAndSave(request.data));
                case 'CLASSIFY_ONLY':
                    return this.success(await this.handleClassifyOnly(request.data));
                case 'RECLASSIFY_BOOKMARK':
                    return this.success(await this.handleReclassifyBookmark(request.data));
                case 'SET_AUTO_CLASSIFY':
                    return this.success(await this.handleSetAutoClassify(request.data));
                case 'START_BULK_ORGANIZE_ALL':
                    return this.success(await this.handleStartBulkOrganizeAll(request.data));
                case 'RUN_BULK_ORGANIZE_BATCH':
                    return this.success(await this.handleRunBulkOrganizeBatch());
                case 'GET_BULK_ORGANIZE_STATUS':
                    return this.success(await this.handleGetBulkOrganizeStatus());
                case 'CANCEL_BULK_ORGANIZE':
                    return this.success(await this.handleCancelBulkOrganize());
                default:
                    return this.failure('Unknown action.');
            }
        } catch (error: unknown) {
            return this.failure(this.errorMessage(error));
        }
    }

    private async handleSaveApiKey(data: unknown): Promise<SettingsState> {
        const payload = this.ensureObject(data);
        const apiKey = this.ensureString(payload.apiKey, 'API key');
        await SecurityManager.storeApiKey(apiKey);
        return this.getSettingsState();
    }

    private async handleGetOpenRouterModels(data: unknown): Promise<{ models: { id: string; name?: string }[] }> {
        const payload = this.ensureObject(data ?? {});
        const forceRefresh = payload.forceRefresh === true;
        const apiKey = await SecurityManager.getApiKey();
        if (!apiKey) {
            throw new Error('Save an API key before loading OpenRouter models.');
        }

        const models = await fetchOpenRouterModels(apiKey, forceRefresh);
        return {
            models: models.map((model) => ({ id: model.id, name: model.name })),
        };
    }

    private async handleClassifyAndSave(data: unknown): Promise<ClassifyResultPayload> {
        const payload = this.normalizeClassifyPayload(data);
        const classification = await this.classify(payload.url, payload.title, undefined);

        const fingerprint = this.fingerprint(payload.url, payload.title);
        this.pendingInternalBookmarkFingerprints.add(fingerprint);

        let created: BookmarkCreationResult;
        try {
            created = await this.bookmarkManager.createBookmark(
                payload.url,
                payload.title,
                classification.folderPath,
            );
        } finally {
            setTimeout(() => {
                this.pendingInternalBookmarkFingerprints.delete(fingerprint);
            }, 5000);
        }

        return this.buildCreatePayload(created, classification, payload.url);
    }

    private async handleClassifyOnly(data: unknown): Promise<Omit<ClassifyResultPayload, 'bookmark' | 'folderId' | 'action'>> {
        const payload = this.normalizeClassifyPayload(data);
        const classification = await this.classify(payload.url, payload.title, undefined);
        return {
            folderPath: classification.folderPath,
            title: payload.title,
            url: payload.url,
            tags: classification.tags,
            confidence: classification.confidence,
            provider: classification.providerName,
            providerId: classification.providerId,
            model: classification.model,
        };
    }

    private async handleReclassifyBookmark(data: unknown): Promise<ClassifyResultPayload> {
        const payload = this.ensureObject(data);
        const bookmarkId = this.ensureString(payload.bookmarkId, 'Bookmark ID');
        const modelOverride = payload.modelOverride === undefined
            ? undefined
            : this.ensureModel(payload.modelOverride);

        const [bookmark] = await chrome.bookmarks.get(bookmarkId);
        if (!bookmark || !bookmark.url) {
            throw new Error('Bookmark is missing or cannot be classified.');
        }

        const title = bookmark.title || bookmark.url;
        const classification = await this.classify(
            bookmark.url,
            title,
            modelOverride,
        );
        const rootFolderId = await this.getRootFolderId(bookmark);
        const moved = await this.bookmarkManager.moveBookmarkToFolderPath(
            bookmark.id,
            classification.folderPath,
            rootFolderId,
        );

        return this.buildMovePayload(moved, classification, bookmark.url);
    }

    private async handleStartBulkOrganizeAll(data?: unknown): Promise<BulkOrganizeJobState> {
        if (!await SecurityManager.hasApiKey()) {
            throw new Error('Save an API key before organizing existing bookmarks.');
        }

        const existing = await this.readBulkJob();
        if (existing.status === 'running') {
            // If a job is already running, "kick" it in case the service worker
            // was suspended before it could start or alarms are clamped/delayed.
            await this.ensureBulkAlarm();
            void this.runBulkOrganizeTick();
            return existing;
        }

        const payload = this.ensureObject(data ?? {});
        const targetRootId = payload.targetRootId === undefined || payload.targetRootId === null
            ? null
            : this.ensureString(payload.targetRootId, 'Target root folder');
        const renameTitles = payload.renameTitles === true;
        const cleanupEmptyFolders = payload.cleanupEmptyFolders !== false;
        const forceReorganize = payload.forceReorganize === true;

        const bookmarkIds = await this.collectSupportedBookmarkIds();
        const now = Date.now();
        const job: BulkOrganizeJobState = {
            status: 'running',
            startedAt: now,
            updatedAt: now,
            targetRootId,
            renameTitles,
            cleanupEmptyFolders,
            forceReorganize,
            total: bookmarkIds.length,
            cursor: 0,
            processed: 0,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            skippedAlreadyOrganized: 0,
            lastError: null,
            failureCounts: {},
            recentFailures: [],
            bookmarkIds,
            cleanupCandidateFolderIds: [],
            avgMsPerBookmark: null,
            lastBatchMs: null,
            lastBatchSize: null,
            backoffUntil: null,
            backoffMs: BULK_ORGANIZE_RATE_LIMIT_BACKOFF_MS,
        };
        await chrome.storage.local.set({ [BULK_ORGANIZE_KEY]: job });
        await this.ensureBulkAlarm();
        // Start immediately so progress begins without waiting for the first alarm tick.
        void this.runBulkOrganizeTick();
        return job;
    }

    private async handleRunBulkOrganizeBatch(batchSize: number = BULK_BATCH_SIZE): Promise<BulkOrganizeJobState> {
        const job = await this.readBulkJob();
        if (job.status !== 'running') {
            return job;
        }

        if (job.backoffUntil && Date.now() < job.backoffUntil) {
            return job;
        }

        const safeBatchSize = Math.max(BULK_ORGANIZE_BATCH_SIZE_MIN, Math.min(BULK_ORGANIZE_BATCH_SIZE_MAX, batchSize));
        const batch = job.bookmarkIds.slice(job.cursor, job.cursor + safeBatchSize);
        if (!batch.length) {
            const finished: BulkOrganizeJobState = {
                ...job,
                status: 'completed',
                updatedAt: Date.now(),
            };
            await chrome.storage.local.set({ [BULK_ORGANIZE_KEY]: finished });
            if (finished.cleanupEmptyFolders) {
                await this.cleanupEmptyFolders(finished.cleanupCandidateFolderIds);
            }
            await chrome.alarms.clear(BULK_ORGANIZE_ALARM);
            return finished;
        }

        const processedIndex = await this.readProcessedIndex();
        const batchStart = Date.now();
        const processedStart = job.processed;

        for (const bookmarkId of batch) {
            if (job.status !== 'running') {
                break;
            }
            job.cursor += 1;
            job.processed += 1;
            job.updatedAt = Date.now();

            let bookmarkTitle = '';
            let bookmarkUrl = '';
            try {
                const [bookmark] = await chrome.bookmarks.get(bookmarkId);
                if (!bookmark || !bookmark.id || !bookmark.url) {
                    job.skipped += 1;
                    continue;
                }
                bookmarkTitle = bookmark.title || bookmark.url;
                bookmarkUrl = bookmark.url;
                const previousParentId = bookmark.parentId || null;
                if (!this.isSupportedUrl(bookmark.url)) {
                    job.skipped += 1;
                    continue;
                }

                const prior = processedIndex[bookmark.id];
                if (!job.forceReorganize && prior && this.sameTargetRoot(prior.targetRootId, job.targetRootId)) {
                    job.skippedAlreadyOrganized += 1;
                    continue;
                }

                const classification = await this.classify(bookmarkUrl, bookmarkTitle, undefined);
                const rootFolderId = job.targetRootId ?? await this.getRootFolderId(bookmark);
                await this.bookmarkManager.moveBookmarkToFolderPath(
                    bookmark.id,
                    classification.folderPath,
                    rootFolderId,
                );
                if (previousParentId && !job.cleanupCandidateFolderIds.includes(previousParentId)) {
                    job.cleanupCandidateFolderIds.push(previousParentId);
                    // cap to avoid huge storage
                    if (job.cleanupCandidateFolderIds.length > 1500) {
                        job.cleanupCandidateFolderIds = job.cleanupCandidateFolderIds.slice(-1500);
                    }
                }

                if (job.renameTitles && classification.suggestedTitle && classification.suggestedTitle !== bookmarkTitle) {
                    await chrome.bookmarks.update(bookmark.id, { title: classification.suggestedTitle });
                }
                job.succeeded += 1;

                processedIndex[bookmark.id] = {
                    succeededAt: Date.now(),
                    targetRootId: job.targetRootId,
                };
            } catch (error: unknown) {
                job.failed += 1;
                const message = this.errorMessage(error);
                job.lastError = message;
                this.recordBulkFailure(job, bookmarkId, bookmarkTitle, bookmarkUrl, message);

                if (this.isRateLimitError(message)) {
                    job.backoffUntil = Date.now() + job.backoffMs;
                    job.backoffMs = Math.min(job.backoffMs * 2, BULK_ORGANIZE_RATE_LIMIT_BACKOFF_MAX_MS);
                }
            }

            await Promise.all([
                chrome.storage.local.set({ [BULK_ORGANIZE_KEY]: job }),
                chrome.storage.local.set({ [BULK_ORGANIZE_PROCESSED_KEY]: processedIndex }),
            ]);
        }

        if (job.cursor >= job.total) {
            job.status = 'completed';
            job.updatedAt = Date.now();
            await chrome.storage.local.set({ [BULK_ORGANIZE_KEY]: job });
            if (job.cleanupEmptyFolders) {
                await this.cleanupEmptyFolders(job.cleanupCandidateFolderIds);
            }
            await chrome.alarms.clear(BULK_ORGANIZE_ALARM);
        }

        const batchMs = Date.now() - batchStart;
        const processedInBatch = Math.max(1, job.processed - processedStart);
        job.lastBatchMs = batchMs;
        job.lastBatchSize = batch.length;
        const msPer = batchMs / processedInBatch;
        job.avgMsPerBookmark = job.avgMsPerBookmark === null ? msPer : (job.avgMsPerBookmark * 0.8 + msPer * 0.2);
        await chrome.storage.local.set({ [BULK_ORGANIZE_KEY]: job });

        return job;
    }

    private async handleGetBulkOrganizeStatus(): Promise<BulkOrganizeJobState> {
        return this.readBulkJob();
    }

    private async handleCancelBulkOrganize(): Promise<BulkOrganizeJobState> {
        const job = await this.readBulkJob();
        if (job.status !== 'running') {
            return job;
        }
        const cancelled: BulkOrganizeJobState = {
            ...job,
            status: 'cancelled',
            updatedAt: Date.now(),
        };
        await chrome.storage.local.set({ [BULK_ORGANIZE_KEY]: cancelled });
        await chrome.alarms.clear(BULK_ORGANIZE_ALARM);
        return cancelled;
    }

    private async ensureBulkAlarm(): Promise<void> {
        const existing = await chrome.alarms.get(BULK_ORGANIZE_ALARM);
        if (existing) {
            return;
        }
        chrome.alarms.create(BULK_ORGANIZE_ALARM, {
            periodInMinutes: BULK_ORGANIZE_TICK_MINUTES,
            delayInMinutes: BULK_ORGANIZE_TICK_MINUTES,
        });
    }

    private async runBulkOrganizeTick(): Promise<void> {
        try {
            const start = Date.now();
            let batches = 0;

            while (true) {
                const job = await this.readBulkJob();
                if (job.status !== 'running') {
                    await chrome.alarms.clear(BULK_ORGANIZE_ALARM);
                    return;
                }
                if (job.backoffUntil && Date.now() < job.backoffUntil) {
                    return;
                }
                if (Date.now() - start > BULK_ORGANIZE_TICK_BUDGET_MS) {
                    return;
                }
                if (batches >= BULK_ORGANIZE_MAX_BATCHES_PER_TICK) {
                    return;
                }

                const elapsed = Date.now() - start;
                const remainingMs = BULK_ORGANIZE_TICK_BUDGET_MS - elapsed - BULK_ORGANIZE_OVERHEAD_MS;
                if (remainingMs <= 0) {
                    return;
                }

                const avg = job.avgMsPerBookmark ?? 1200;
                const desired = Math.floor(remainingMs / avg);
                const dynamicBatchSize = Math.max(
                    BULK_BATCH_SIZE,
                    Math.min(BULK_ORGANIZE_BATCH_SIZE_MAX, Math.max(BULK_ORGANIZE_BATCH_SIZE_MIN, desired)),
                );

                const updated = await this.handleRunBulkOrganizeBatch(dynamicBatchSize);
                batches += 1;

                if (updated.status !== 'running') {
                    return;
                }
                if (updated.backoffUntil && Date.now() < updated.backoffUntil) {
                    return;
                }
                if (updated.total > 0 && updated.cursor >= updated.total) {
                    return;
                }
            }
        } catch (error: unknown) {
            // Surface errors to the UI via the job state.
            const job = await this.readBulkJob();
            if (job.status === 'running') {
                const failed: BulkOrganizeJobState = {
                    ...job,
                    status: 'failed',
                    lastError: this.errorMessage(error),
                    updatedAt: Date.now(),
                };
                await chrome.storage.local.set({ [BULK_ORGANIZE_KEY]: failed });
            }
        }
    }

    private async handleSetAutoClassify(data: unknown): Promise<{ autoClassifyEnabled: boolean }> {
        const payload = this.ensureObject(data);
        const enabled = payload.enabled === true;
        await chrome.storage.local.set({ [AUTO_CLASSIFY_KEY]: enabled });
        return { autoClassifyEnabled: enabled };
    }

    private async getSettingsState(): Promise<SettingsState> {
        const hasApiKey = await SecurityManager.hasApiKey();
        const [apiKeyHint, providerPreference, selectedOpenRouterModel, autoClassifyEnabled] = await Promise.all([
            SecurityManager.getApiKeyHint(),
            getProviderPreference(),
            getSelectedOpenRouterModel(),
            this.getAutoClassifyEnabled(),
        ]);

        return {
            hasApiKey,
            apiKeyHint,
            providerPreference,
            selectedOpenRouterModel,
            autoClassifyEnabled,
        };
    }

    private async classify(
        url: string,
        title: string,
        modelOverride?: string,
    ): Promise<ClassificationResultWithMeta> {
        const options = modelOverride
            ? { providerOverride: 'openrouter', modelOverride }
            : {};
        return this.classifier.classifyUrlWithMeta(url, title, options);
    }

    private async handleAutoClassifyBookmark(
        _bookmarkId: string,
        bookmark: chrome.bookmarks.BookmarkTreeNode,
    ): Promise<void> {
        if (!bookmark.url || !bookmark.id) {
            return;
        }
        if (!this.isSupportedUrl(bookmark.url)) {
            return;
        }
        if (!await this.getAutoClassifyEnabled()) {
            return;
        }

        const fingerprint = this.fingerprint(bookmark.url, bookmark.title || bookmark.url);
        if (this.pendingInternalBookmarkFingerprints.has(fingerprint)) {
            this.pendingInternalBookmarkFingerprints.delete(fingerprint);
            return;
        }

        if (!await SecurityManager.hasApiKey()) {
            return;
        }

        try {
            const classification = await this.classifier.classifyUrlWithMeta(
                bookmark.url,
                bookmark.title || bookmark.url,
            );
            await this.bookmarkManager.moveBookmarkToFolderPath(bookmark.id, classification.folderPath);
        } catch {
            // Silent fail to avoid spamming users when auto-classification cannot run.
        }
    }

    private buildCreatePayload(
        result: BookmarkCreationResult,
        classification: ClassificationResultWithMeta,
        fallbackUrl: string,
    ): ClassifyResultPayload {
        return {
            bookmark: result.bookmark,
            folderPath: result.folderPath,
            folderId: result.folderId,
            title: result.bookmark.title || '',
            url: result.bookmark.url || fallbackUrl,
            tags: classification.tags,
            confidence: classification.confidence,
            provider: classification.providerName,
            providerId: classification.providerId,
            model: classification.model,
            action: 'created',
        };
    }

    private buildMovePayload(
        result: BookmarkMoveResult,
        classification: ClassificationResultWithMeta,
        fallbackUrl: string,
    ): ClassifyResultPayload {
        return {
            bookmark: result.bookmark,
            folderPath: result.folderPath,
            previousFolderPath: result.previousFolderPath,
            folderId: result.folderId,
            title: result.bookmark.title || '',
            url: result.bookmark.url || fallbackUrl,
            tags: classification.tags,
            confidence: classification.confidence,
            provider: classification.providerName,
            providerId: classification.providerId,
            model: classification.model,
            action: 'moved',
        };
    }

    private normalizeClassifyPayload(data: unknown): ClassifyAndSavePayload {
        const payload = this.ensureObject(data);
        const url = this.ensureUrl(payload.url);
        const title = this.ensureTitle(payload.title);
        return { url, title };
    }

    private ensureUrl(value: unknown): string {
        const url = this.ensureString(value, 'URL');
        if (!this.isSupportedUrl(url)) {
            throw new Error('Only http(s) URLs can be classified.');
        }
        return url;
    }

    private ensureTitle(value: unknown): string {
        const title = this.ensureString(value, 'Title').trim();
        if (!title) {
            throw new Error('Title is required.');
        }
        return title.slice(0, MAX_TITLE_LENGTH);
    }

    private ensureModel(value: unknown): string {
        const model = this.ensureString(value, 'Model override').trim();
        if (!model || model.length > MAX_MODEL_LENGTH) {
            throw new Error('Model override is invalid.');
        }
        return model;
    }

    private ensureString(value: unknown, label: string): string {
        if (typeof value !== 'string') {
            throw new Error(`${label} must be a string.`);
        }
        return value;
    }

    private ensureObject(value: unknown): Record<string, unknown> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Request payload must be an object.');
        }
        return value as Record<string, unknown>;
    }

    private isRuntimeRequest(value: unknown): value is RuntimeRequest {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        const candidate = value as RuntimeRequest;
        return typeof candidate.action === 'string' && candidate.action.length > 0;
    }

    private async getAutoClassifyEnabled(): Promise<boolean> {
        const state = await chrome.storage.local.get(AUTO_CLASSIFY_KEY);
        return state[AUTO_CLASSIFY_KEY] === true;
    }

    private async ensureDefaultSettings(): Promise<void> {
        const existing = await chrome.storage.local.get(AUTO_CLASSIFY_KEY);
        if (typeof existing[AUTO_CLASSIFY_KEY] !== 'boolean') {
            await chrome.storage.local.set({ [AUTO_CLASSIFY_KEY]: false });
        }
    }

    private isSupportedUrl(value: string): boolean {
        try {
            const parsed = new URL(value);
            return SUPPORTED_PROTOCOLS.has(parsed.protocol);
        } catch {
            return false;
        }
    }

    private async collectSupportedBookmarkIds(): Promise<string[]> {
        const tree = await chrome.bookmarks.getTree();
        const ids: string[] = [];
        const visit = (node: chrome.bookmarks.BookmarkTreeNode): void => {
            if (node.url && node.id && this.isSupportedUrl(node.url)) {
                ids.push(node.id);
            }
            node.children?.forEach(visit);
        };
        tree.forEach(visit);
        return ids;
    }

    private async readBulkJob(): Promise<BulkOrganizeJobState> {
        const state = await chrome.storage.local.get(BULK_ORGANIZE_KEY);
        const existing = state[BULK_ORGANIZE_KEY] as BulkOrganizeJobState | undefined;
        if (existing) {
            return existing;
        }
        return {
            status: 'idle',
            startedAt: null,
            updatedAt: null,
            targetRootId: null,
            renameTitles: false,
            cleanupEmptyFolders: true,
            forceReorganize: false,
            total: 0,
            cursor: 0,
            processed: 0,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            skippedAlreadyOrganized: 0,
            lastError: null,
            failureCounts: {},
            recentFailures: [],
            bookmarkIds: [],
            cleanupCandidateFolderIds: [],
            avgMsPerBookmark: null,
            lastBatchMs: null,
            lastBatchSize: null,
            backoffUntil: null,
            backoffMs: BULK_ORGANIZE_RATE_LIMIT_BACKOFF_MS,
        };
    }

    private async cleanupEmptyFolders(candidateFolderIds: string[]): Promise<void> {
        // Best-effort: remove empty folders left behind by moves.
        // Avoid root nodes (0,1,2,3) and anything with children.
        const visited = new Set<string>();
        const roots = new Set(['0', '1', '2', '3']);

        const tryDelete = async (folderId: string): Promise<void> => {
            if (visited.has(folderId) || roots.has(folderId)) {
                return;
            }
            visited.add(folderId);

            let folder: chrome.bookmarks.BookmarkTreeNode | undefined;
            try {
                [folder] = await chrome.bookmarks.get(folderId);
            } catch {
                return;
            }
            if (!folder || folder.url) {
                return;
            }
            const children = await chrome.bookmarks.getChildren(folderId);
            if (children.length > 0) {
                return;
            }
            const parentId = folder.parentId || null;
            try {
                await chrome.bookmarks.remove(folderId);
            } catch {
                return;
            }
            if (parentId) {
                await tryDelete(parentId);
            }
        };

        for (const id of candidateFolderIds) {
            await tryDelete(id);
        }
    }

    private async readProcessedIndex(): Promise<BulkOrganizeProcessedIndex> {
        const state = await chrome.storage.local.get(BULK_ORGANIZE_PROCESSED_KEY);
        const index = state[BULK_ORGANIZE_PROCESSED_KEY] as BulkOrganizeProcessedIndex | undefined;
        return index ?? {};
    }

    private sameTargetRoot(a: string | null, b: string | null): boolean {
        return a === b;
    }

    private recordBulkFailure(
        job: BulkOrganizeJobState,
        bookmarkId: string,
        title: string,
        url: string,
        message: string,
    ): void {
        const key = message.split('\n')[0].slice(0, 160);
        job.failureCounts[key] = (job.failureCounts[key] ?? 0) + 1;

        const compactCounts = Object.entries(job.failureCounts);
        if (compactCounts.length > BULK_FAILURE_KEYS_LIMIT) {
            const sorted = compactCounts.sort((x, y) => y[1] - x[1]).slice(0, BULK_FAILURE_KEYS_LIMIT);
            job.failureCounts = Object.fromEntries(sorted);
        }

        const failureEntry = {
            bookmarkId,
            title,
            url,
            error: message,
        };
        job.recentFailures.unshift(failureEntry);
        if (job.recentFailures.length > BULK_RECENT_FAILURES_LIMIT) {
            job.recentFailures.length = BULK_RECENT_FAILURES_LIMIT;
        }
    }

    private isRateLimitError(message: string): boolean {
        const m = message.toLowerCase();
        return m.includes('rate limit') || m.includes('429') || m.includes('(429)');
    }

    private async getRootFolderId(bookmark: chrome.bookmarks.BookmarkTreeNode): Promise<string> {
        // Keep bookmarks within their top-level root (e.g. Bookmarks bar / Other / Mobile).
        let current = bookmark;
        while (current.parentId) {
            const [parent] = await chrome.bookmarks.get(current.parentId);
            if (!parent) {
                break;
            }
            if (parent.id === '0') {
                return current.id;
            }
            current = parent;
        }
        return '1';
    }

    private fingerprint(url: string, title: string): string {
        return `${url}::${title}`;
    }

    private success<T>(result: T): RuntimeSuccess<T> {
        return { success: true, result };
    }

    private failure(error: string): RuntimeFailure {
        return { success: false, error };
    }

    private errorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return 'Unknown error occurred.';
    }
}

new BackgroundService();