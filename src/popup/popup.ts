// SPDX-License-Identifier: Apache-2.0
import {
    getProviderPreference,
    getSelectedOpenRouterModel,
    setProviderPreference,
    setSelectedOpenRouterModel,
} from '../utils/openrouter';

type View = 'onboarding' | 'main' | 'settings';
type ToastType = 'success' | 'error' | 'info';
type Theme = 'auto' | 'dark' | 'light';

type RuntimeResponse<T> =
    | { success: true; result: T }
    | { success: false; error: string };

type SettingsState = {
    hasApiKey: boolean;
    apiKeyHint: string | null;
    providerPreference: string | null;
    selectedOpenRouterModel: string | null;
    autoClassifyEnabled: boolean;
};

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

type OpenRouterModelsResponse = {
    models: Array<{ id: string; name?: string }>;
};

const PROVIDER_LABELS: Record<string, string> = {
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    groq: 'Groq',
    moonshot: 'Moonshot',
    grok: 'Grok',
};

class PopupController {
    private views!: Record<View, HTMLElement>;

    // Onboarding
    private obStep1!: HTMLElement;
    private obStep2!: HTMLElement;
    private obApiKey!: HTMLInputElement;
    private obProvider!: HTMLSelectElement;
    private obStepPills!: NodeListOf<HTMLElement>;

    // Main
    private pageTitle!: HTMLElement;
    private pageUrl!: HTMLElement;
    private pageFavicon!: HTMLElement;
    private classifyBtn!: HTMLButtonElement;
    private classifyArea!: HTMLElement;
    private progressArea!: HTMLElement;
    private progressLabel!: HTMLElement;
    private resultArea!: HTMLElement;
    private resultFolder!: HTMLElement;
    private resultMeta!: HTMLElement;
    private resultTags!: HTMLElement;
    private resultViewDetailsBtn!: HTMLButtonElement;
    private resultReclassifyBtn!: HTMLButtonElement;
    private statusPill!: HTMLElement;
    private statusDot!: HTMLElement;
    private statusText!: HTMLElement;
    private providerChipText!: HTMLElement;

    // Detail modal
    private detailModal!: HTMLElement;
    private detailModalClose!: HTMLButtonElement;
    private detailModalBackdrop!: HTMLElement;
    private detailBookmark!: HTMLElement;
    private detailUrl!: HTMLElement;
    private detailDestination!: HTMLElement;
    private detailAction!: HTMLElement;
    private detailConfidence!: HTMLElement;
    private detailProvider!: HTMLElement;
    private detailModel!: HTMLElement;
    private detailTags!: HTMLElement;
    private detailModelSelect!: HTMLSelectElement;
    private detailReclassifyBtn!: HTMLButtonElement;
    private detailReclassifyStatus!: HTMLElement;

    // Settings
    private apiKeyInput!: HTMLInputElement;
    private keyBadge!: HTMLElement;
    private keyBadgeText!: HTMLElement;
    private keyForm!: HTMLElement;
    private providerSelect!: HTMLSelectElement;
    private openRouterModelSection!: HTMLElement;
    private openRouterModels!: HTMLSelectElement;
    private modelStatus!: HTMLElement;
    private autoClassifyToggle!: HTMLButtonElement;
    private themeToggle!: HTMLButtonElement;

    private currentView: View = 'onboarding';
    private settingsLoadToken = 0;
    private modelLoadToken = 0;
    private detailModelLoadToken = 0;
    private lastClassification: ClassifyResultPayload | null = null;

    constructor() {
        this.initElements();
        this.bindEvents();
        void this.initialize().catch((error) => this.handleInitializationError(error));
    }

    private initElements(): void {
        this.views = {
            onboarding: this.el('view-onboarding'),
            main: this.el('view-main'),
            settings: this.el('view-settings'),
        };

        this.obStep1 = this.el('ob-step-1');
        this.obStep2 = this.el('ob-step-2');
        this.obApiKey = this.el('ob-api-key') as HTMLInputElement;
        this.obProvider = this.el('ob-provider') as HTMLSelectElement;
        this.obStepPills = document.querySelectorAll('.ob-step-pill');

        this.pageTitle = this.el('page-title');
        this.pageUrl = this.el('page-url');
        this.pageFavicon = this.el('page-favicon');
        this.classifyBtn = this.el('classify-bookmark') as HTMLButtonElement;
        this.classifyArea = this.el('classify-area');
        this.progressArea = this.el('progress-area');
        this.progressLabel = this.el('progress-label');
        this.resultArea = this.el('result-area');
        this.resultFolder = this.el('result-folder');
        this.resultMeta = this.el('result-meta');
        this.resultTags = this.el('result-tags');
        this.resultViewDetailsBtn = this.el('result-view-details') as HTMLButtonElement;
        this.resultReclassifyBtn = this.el('result-reclassify') as HTMLButtonElement;
        this.statusPill = this.el('status-pill');
        this.statusDot = this.el('status-dot');
        this.statusText = this.el('status-text');
        this.providerChipText = this.el('provider-chip-text');

        this.detailModal = this.el('classification-modal');
        this.detailModalClose = this.el('modal-close') as HTMLButtonElement;
        this.detailModalBackdrop = this.el('modal-backdrop');
        this.detailBookmark = this.el('detail-bookmark');
        this.detailUrl = this.el('detail-url');
        this.detailDestination = this.el('detail-destination');
        this.detailAction = this.el('detail-action');
        this.detailConfidence = this.el('detail-confidence');
        this.detailProvider = this.el('detail-provider');
        this.detailModel = this.el('detail-model');
        this.detailTags = this.el('detail-tags');
        this.detailModelSelect = this.el('detail-model-select') as HTMLSelectElement;
        this.detailReclassifyBtn = this.el('detail-reclassify-btn') as HTMLButtonElement;
        this.detailReclassifyStatus = this.el('detail-reclassify-status');

        this.apiKeyInput = this.el('api-key') as HTMLInputElement;
        this.keyBadge = this.el('key-badge');
        this.keyBadgeText = this.el('key-badge-text');
        this.keyForm = this.el('key-form');
        this.providerSelect = this.el('provider-select') as HTMLSelectElement;
        this.openRouterModelSection = this.el('openrouter-model-section');
        this.openRouterModels = this.el('openrouter-models') as HTMLSelectElement;
        this.modelStatus = this.el('model-status');
        this.autoClassifyToggle = this.el('auto-classify-toggle') as HTMLButtonElement;
        this.themeToggle = this.el('theme-toggle') as HTMLButtonElement;
    }

    private bindEvents(): void {
        this.el('ob-next-1').addEventListener('click', () => this.goToObStep(2));
        this.el('ob-back-1').addEventListener('click', () => this.goToObStep(1));
        this.el('ob-save-key').addEventListener('click', () => void this.onboardSaveKey());
        this.el('ob-toggle-key').addEventListener('click', () =>
            this.toggleKeyVisibility(this.obApiKey, 'ob-toggle-key'));

        document.querySelectorAll<HTMLElement>('.ob-provider-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const url = btn.dataset.url;
                if (url) {
                    void chrome.tabs.create({ url });
                }
            });
        });

        this.classifyBtn.addEventListener('click', () => void this.classifyBookmark());
        this.resultViewDetailsBtn.addEventListener('click', () => void this.openDetailModal());
        this.resultReclassifyBtn.addEventListener('click', () => void this.openDetailModal(true));
        this.el('btn-settings').addEventListener('click', () => this.showView('settings'));

        this.detailModalClose.addEventListener('click', () => this.closeDetailModal());
        this.detailModalBackdrop.addEventListener('click', () => this.closeDetailModal());
        this.detailReclassifyBtn.addEventListener('click', () => void this.reclassifyWithSelectedModel());

        this.el('btn-back').addEventListener('click', () => this.showView('main'));
        this.el('btn-change-key').addEventListener('click', () => this.showKeyForm());
        this.el('btn-cancel-key').addEventListener('click', () => this.hideKeyForm());
        this.el('save-api-key').addEventListener('click', () => void this.saveApiKey());
        this.el('toggle-key').addEventListener('click', () =>
            this.toggleKeyVisibility(this.apiKeyInput, 'toggle-key'));
        this.providerSelect.addEventListener('change', () => void this.onProviderChange());
        this.el('refresh-models').addEventListener('click', () => void this.loadOpenRouterModels(true));
        this.openRouterModels.addEventListener('change', () => void this.onModelSelected());
        this.autoClassifyToggle.addEventListener('click', () => void this.toggleAutoClassify());
        this.themeToggle.addEventListener('click', () => void this.toggleTheme());
        this.el('btn-view-source').addEventListener('click', () =>
            void chrome.tabs.create({ url: 'https://github.com/edmondhillary/bookmark-ai-organizer' }));

        chrome.storage.onChanged.addListener((changes, areaName) => {
            void this.handleStorageChange(changes, areaName);
        });
    }

    private async initialize(): Promise<void> {
        await this.applyStoredTheme();
        const state = await this.fetchSettingsState();

        if (!state.hasApiKey) {
            this.showView('onboarding');
            return;
        }

        this.showView('main');
        await Promise.all([
            this.loadPageInfo(),
            this.updateProviderChip(),
        ]);
    }

    private handleInitializationError(error: unknown): void {
        const message = error instanceof Error ? error.message : 'Failed to initialize popup.';
        this.showView('onboarding');
        this.showToast(message, 'error');
    }

    private showView(view: View): void {
        this.currentView = view;
        (Object.keys(this.views) as View[]).forEach((key) => {
            this.views[key].classList.toggle('hidden', key !== view);
        });

        if (view === 'settings') {
            void this.loadSettingsState();
        }
    }

    private goToObStep(step: 1 | 2): void {
        this.obStep1.classList.toggle('hidden', step !== 1);
        this.obStep2.classList.toggle('hidden', step !== 2);
        this.obStepPills.forEach((pill, i) => {
            pill.classList.toggle('active', i + 1 === step);
            pill.setAttribute('aria-selected', (i + 1 === step).toString());
        });

        if (step === 2) {
            this.obApiKey.focus();
        }
    }

    private async onboardSaveKey(): Promise<void> {
        const apiKey = this.obApiKey.value.trim();
        if (!apiKey) {
            this.showToast('Please enter your API key.', 'error');
            this.obApiKey.focus();
            return;
        }

        const btn = this.el('ob-save-key') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Connecting...';

        try {
            await this.sendAction<SettingsState>('SAVE_API_KEY', { apiKey });
            const provider = this.obProvider.value;
            if (provider !== 'auto') {
                await setProviderPreference(provider);
            }

            this.obApiKey.value = '';
            this.showToast('Connected! Your API key is saved on this device.', 'success');

            setTimeout(() => {
                void this.enterMainAfterKeySave();
            }, 700);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to save API key.';
            this.showToast(`Error: ${message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Connect & Start';
        }
    }

    private async enterMainAfterKeySave(): Promise<void> {
        try {
            await this.fetchSettingsState();
            this.showView('main');
            await Promise.all([this.loadPageInfo(), this.updateProviderChip()]);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to load saved settings.';
            this.showToast(message, 'error');
        }
    }

    private async loadPageInfo(): Promise<void> {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            this.pageTitle.textContent = tab.title || 'Untitled Page';

            try {
                const parsed = new URL(tab.url ?? '');
                const path = parsed.pathname !== '/' ? parsed.pathname : '';
                this.pageUrl.textContent = parsed.hostname + path;
            } catch {
                this.pageUrl.textContent = tab.url ?? '';
            }

            this.pageFavicon.textContent = '';
            if (tab.favIconUrl && this.isSafeImageUrl(tab.favIconUrl)) {
                const img = new Image();
                img.alt = '';
                img.referrerPolicy = 'no-referrer';
                img.onload = () => {
                    this.pageFavicon.textContent = '';
                    this.pageFavicon.appendChild(img);
                };
                img.src = tab.favIconUrl;
            }
        } catch {
            this.pageTitle.textContent = 'Could not load page info';
            this.pageUrl.textContent = '';
        }
    }

    private async classifyBookmark(): Promise<void> {
        this.showProgress('Classifying with AI...');
        this.resultArea.classList.add('hidden');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab.url || !tab.title) {
                throw new Error('No valid URL or title found.');
            }

            this.showProgress('Saving bookmark...');
            const result = await this.sendAction<ClassifyResultPayload>('CLASSIFY_AND_SAVE', {
                url: tab.url,
                title: tab.title,
            });

            this.lastClassification = result;
            this.showClassificationResult(result);
            this.setStatus('Saved!', 'success');
            this.showToast(
                `Saved "${result.title}" to ${this.formatFolderPath(result.folderPath)} (${this.confidenceLabel(result.confidence)}).`,
                'success',
            );
            setTimeout(() => this.setStatus('Ready', 'default'), 3500);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error occurred';
            this.showToast(`Failed: ${message}`, 'error');
            this.setStatus('Error', 'error');
            setTimeout(() => this.setStatus('Ready', 'default'), 3500);
        } finally {
            this.hideProgress();
        }
    }

    private showProgress(message: string): void {
        this.progressLabel.textContent = message;
        this.classifyArea.classList.add('hidden');
        this.progressArea.classList.remove('hidden');
        this.classifyBtn.disabled = true;
    }

    private hideProgress(): void {
        this.progressArea.classList.add('hidden');
        this.classifyArea.classList.remove('hidden');
        this.classifyBtn.disabled = false;
    }

    private showClassificationResult(result: ClassifyResultPayload): void {
        this.resultFolder.textContent = '';
        this.resultTags.textContent = '';

        const folderIcon = this.createFolderIcon();
        this.resultFolder.appendChild(folderIcon);

        result.folderPath.forEach((folder, index) => {
            const folderText = document.createElement('span');
            folderText.textContent = folder;
            this.resultFolder.appendChild(folderText);

            if (index < result.folderPath.length - 1) {
                const separator = document.createElement('span');
                separator.className = 'result-folder-sep';
                separator.setAttribute('aria-hidden', 'true');
                separator.textContent = '›';
                this.resultFolder.appendChild(separator);
            }
        });

        const confidence = this.confidenceLabel(result.confidence);
        this.resultMeta.textContent = `${result.action === 'moved' ? 'Moved' : 'Saved'} "${result.title}" to ${this.formatFolderPath(result.folderPath)}. Confidence: ${confidence}.`;

        const tagNote = document.createElement('span');
        tagNote.className = 'result-note';
        tagNote.textContent = result.tags.length ? 'Suggested tags:' : 'No tags suggested.';
        this.resultTags.appendChild(tagNote);

        result.tags.forEach((tag) => {
            const tagElement = document.createElement('span');
            tagElement.className = 'result-tag';
            tagElement.textContent = `#${tag}`;
            this.resultTags.appendChild(tagElement);
        });

        this.resultArea.classList.remove('hidden');
    }

    private async openDetailModal(focusReclassify = false): Promise<void> {
        if (!this.lastClassification) {
            this.showToast('Classify a bookmark first to view details.', 'info');
            return;
        }

        this.renderDetailModal(this.lastClassification);
        await this.loadDetailModelOptions(false, this.lastClassification.model);
        this.detailModal.classList.remove('hidden');
        if (focusReclassify) {
            this.detailModelSelect.focus();
        }
    }

    private closeDetailModal(): void {
        this.detailModal.classList.add('hidden');
        this.detailReclassifyStatus.textContent = '';
    }

    private renderDetailModal(result: ClassifyResultPayload): void {
        this.detailBookmark.textContent = result.title;
        this.detailUrl.textContent = result.url;
        this.detailDestination.textContent = this.formatFolderPath(result.folderPath);
        this.detailAction.textContent = result.action === 'moved' ? 'Re-classified and moved' : 'Classified and saved';
        this.detailConfidence.textContent = this.confidenceLabel(result.confidence);
        this.detailProvider.textContent = `${result.provider} (${result.providerId})`;
        this.detailModel.textContent = result.model;

        this.detailTags.textContent = '';
        if (!result.tags.length) {
            const empty = document.createElement('span');
            empty.className = 'result-note';
            empty.textContent = 'No tags suggested.';
            this.detailTags.appendChild(empty);
            return;
        }

        result.tags.forEach((tag) => {
            const tagElement = document.createElement('span');
            tagElement.className = 'result-tag';
            tagElement.textContent = `#${tag}`;
            this.detailTags.appendChild(tagElement);
        });
    }

    private async reclassifyWithSelectedModel(): Promise<void> {
        if (!this.lastClassification) {
            return;
        }
        const bookmarkId = this.lastClassification.bookmark.id;
        if (!bookmarkId) {
            this.showToast('The saved bookmark is missing an ID.', 'error');
            return;
        }

        const modelOverride = this.detailModelSelect.value || undefined;
        this.detailReclassifyBtn.disabled = true;
        this.detailReclassifyStatus.textContent = 'Re-classifying bookmark...';

        try {
            const result = await this.sendAction<ClassifyResultPayload>('RECLASSIFY_BOOKMARK', {
                bookmarkId,
                modelOverride,
            });

            this.lastClassification = result;
            this.showClassificationResult(result);
            this.renderDetailModal(result);
            this.detailReclassifyStatus.textContent = `Done. ${result.title} moved to ${this.formatFolderPath(result.folderPath)}.`;
            this.showToast(
                `Re-classified "${result.title}" to ${this.formatFolderPath(result.folderPath)} (${this.confidenceLabel(result.confidence)}).`,
                'success',
            );
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to re-classify bookmark.';
            this.detailReclassifyStatus.textContent = message;
            this.showToast(message, 'error');
        } finally {
            this.detailReclassifyBtn.disabled = false;
        }
    }

    private setStatus(text: string, type: 'default' | 'success' | 'error'): void {
        this.statusText.textContent = text;
        this.statusPill.className = 'status-pill';
        this.statusDot.className = 'status-dot';

        if (type === 'success') {
            this.statusPill.classList.add('is-success');
        } else if (type === 'error') {
            this.statusPill.classList.add('is-error');
            this.statusDot.classList.add('is-error');
        } else {
            this.statusDot.classList.add('is-idle');
        }
    }

    private async handleStorageChange(
        changes: { [key: string]: chrome.storage.StorageChange },
        areaName: string,
    ): Promise<void> {
        if (areaName !== 'local' && areaName !== 'sync') {
            return;
        }

        const changedKeys = Object.keys(changes);
        const tracked = [
            'api_key',
            'encrypted_api_key',
            'provider_preference',
            'openrouter_selected_model',
            'auto_classify_enabled',
        ];
        if (!changedKeys.some((key) => tracked.includes(key))) {
            return;
        }

        const state = await this.fetchSettingsState();
        await this.updateProviderChip();

        if (!state.hasApiKey && this.currentView !== 'onboarding') {
            this.showView('onboarding');
            this.showToast('API key removed. Add a key to continue.', 'info');
            return;
        }

        if (state.hasApiKey && this.currentView === 'onboarding') {
            this.showView('main');
            await Promise.all([this.loadPageInfo(), this.updateProviderChip()]);
        }

        if (this.currentView === 'settings') {
            await this.loadSettingsState();
        }
    }

    private async loadSettingsState(): Promise<void> {
        const loadToken = ++this.settingsLoadToken;
        const state = await this.fetchSettingsState();
        if (loadToken !== this.settingsLoadToken) {
            return;
        }

        this.updateKeyBadge(state.hasApiKey, state.apiKeyHint);
        this.providerSelect.value = state.providerPreference || 'auto';
        this.autoClassifyToggle.setAttribute('aria-checked', state.autoClassifyEnabled ? 'true' : 'false');

        if (this.providerSelect.value === 'openrouter') {
            this.openRouterModelSection.classList.remove('hidden');
            await this.loadOpenRouterModels(false, state.selectedOpenRouterModel);
        } else {
            this.openRouterModelSection.classList.add('hidden');
        }

        const theme = await this.getStoredTheme();
        if (loadToken !== this.settingsLoadToken) {
            return;
        }
        this.themeToggle.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
    }

    private updateKeyBadge(isConnected: boolean, keyHint: string | null): void {
        if (!isConnected) {
            this.keyBadge.className = 'key-badge is-missing';
            this.keyBadgeText.textContent = 'Not configured';
            return;
        }

        this.keyBadge.className = 'key-badge is-connected';
        this.keyBadgeText.textContent = keyHint
            ? `Connected (${keyHint}) — stored locally on this device`
            : 'Connected — stored locally on this device';
    }

    private showKeyForm(): void {
        this.keyForm.classList.remove('hidden');
        this.el('btn-change-key').classList.add('hidden');
        this.apiKeyInput.focus();
    }

    private hideKeyForm(): void {
        this.keyForm.classList.add('hidden');
        this.apiKeyInput.value = '';
        this.apiKeyInput.type = 'password';
        this.resetEyeIcon('toggle-key');
        this.el('btn-change-key').classList.remove('hidden');
    }

    private async saveApiKey(): Promise<void> {
        const apiKey = this.apiKeyInput.value.trim();
        if (!apiKey) {
            this.showToast('Please enter a valid API key.', 'error');
            this.apiKeyInput.focus();
            return;
        }

        const btn = this.el('save-api-key') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Saving...';

        try {
            await this.sendAction<SettingsState>('SAVE_API_KEY', { apiKey });
            this.hideKeyForm();
            const state = await this.fetchSettingsState();
            this.updateKeyBadge(state.hasApiKey, state.apiKeyHint);
            this.showToast('API key saved and synced.', 'success');

            if (this.providerSelect.value === 'openrouter') {
                await this.loadOpenRouterModels(true, state.selectedOpenRouterModel);
            }
            await this.updateProviderChip();
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to save API key';
            this.showToast(`Error: ${message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Key';
        }
    }

    private async onProviderChange(): Promise<void> {
        const provider = this.providerSelect.value;
        await setProviderPreference(provider === 'auto' ? '' : provider);

        if (provider === 'openrouter') {
            this.openRouterModelSection.classList.remove('hidden');
            await this.loadOpenRouterModels(false);
        } else {
            this.openRouterModelSection.classList.add('hidden');
        }

        await this.updateProviderChip();
    }

    private async onModelSelected(): Promise<void> {
        const modelId = this.openRouterModels.value;
        if (!modelId) {
            this.modelStatus.textContent = 'Select a model above';
            return;
        }
        await setSelectedOpenRouterModel(modelId);
        this.modelStatus.textContent = `Using: ${modelId}`;
    }

    private async loadOpenRouterModels(forceRefresh: boolean, preferredModel?: string | null): Promise<void> {
        const loadToken = ++this.modelLoadToken;
        this.openRouterModelSection.classList.remove('hidden');
        this.modelStatus.textContent = 'Loading models...';
        this.openRouterModels.textContent = '';
        this.openRouterModels.appendChild(new Option('Loading...', ''));

        const refreshBtn = this.el('refresh-models');
        refreshBtn.classList.add('is-spinning');

        try {
            const response = await this.sendAction<OpenRouterModelsResponse>('GET_OPENROUTER_MODELS', {
                forceRefresh,
            });
            if (loadToken !== this.modelLoadToken) {
                return;
            }

            const models = response.models;
            if (!models.length) {
                this.openRouterModels.textContent = '';
                this.openRouterModels.appendChild(new Option('No models found', ''));
                this.modelStatus.textContent = 'No models available for this API key.';
                return;
            }

            this.openRouterModels.textContent = '';
            this.openRouterModels.appendChild(new Option(`${models.length} models available...`, ''));
            models.forEach((model) => {
                this.openRouterModels.appendChild(new Option(model.name || model.id, model.id));
            });

            const selected = preferredModel ?? await getSelectedOpenRouterModel();
            if (loadToken !== this.modelLoadToken) {
                return;
            }

            if (selected && models.some((model) => model.id === selected)) {
                this.openRouterModels.value = selected;
                this.modelStatus.textContent = `Using: ${selected}`;
            } else if (selected) {
                this.openRouterModels.value = '';
                this.modelStatus.textContent = 'Saved model unavailable. Choose a new model.';
            } else {
                this.modelStatus.textContent = 'Select a model above';
            }
        } catch (error: unknown) {
            if (loadToken !== this.modelLoadToken) {
                return;
            }
            const message = error instanceof Error ? error.message : 'Failed to load models.';
            this.openRouterModels.textContent = '';
            this.openRouterModels.appendChild(new Option('Failed to load', ''));
            this.modelStatus.textContent = message;
        } finally {
            if (loadToken === this.modelLoadToken) {
                refreshBtn.classList.remove('is-spinning');
            }
        }
    }

    private async loadDetailModelOptions(forceRefresh: boolean, preferredModel?: string): Promise<void> {
        const loadToken = ++this.detailModelLoadToken;
        this.detailReclassifyStatus.textContent = 'Loading model options...';
        this.detailModelSelect.textContent = '';
        this.detailModelSelect.appendChild(new Option('Loading...', ''));

        try {
            const response = await this.sendAction<OpenRouterModelsResponse>('GET_OPENROUTER_MODELS', {
                forceRefresh,
            });
            if (loadToken !== this.detailModelLoadToken) {
                return;
            }

            this.detailModelSelect.textContent = '';
            this.detailModelSelect.appendChild(new Option('Keep provider auto-detect', ''));
            response.models.forEach((model) => {
                this.detailModelSelect.appendChild(new Option(model.name || model.id, model.id));
            });
            if (preferredModel && response.models.some((model) => model.id === preferredModel)) {
                this.detailModelSelect.value = preferredModel;
            }
            this.detailReclassifyStatus.textContent = '';
        } catch (error: unknown) {
            if (loadToken !== this.detailModelLoadToken) {
                return;
            }
            this.detailModelSelect.textContent = '';
            this.detailModelSelect.appendChild(new Option('Failed to load models', ''));
            const message = error instanceof Error ? error.message : 'Unable to load models.';
            this.detailReclassifyStatus.textContent = message;
        }
    }

    private async toggleAutoClassify(): Promise<void> {
        const currentValue = this.autoClassifyToggle.getAttribute('aria-checked') === 'true';
        const nextValue = !currentValue;

        try {
            const result = await this.sendAction<{ autoClassifyEnabled: boolean }>('SET_AUTO_CLASSIFY', {
                enabled: nextValue,
            });
            this.autoClassifyToggle.setAttribute('aria-checked', result.autoClassifyEnabled ? 'true' : 'false');
            this.showToast(
                result.autoClassifyEnabled
                    ? 'Auto-classify is enabled for new bookmarks.'
                    : 'Auto-classify is disabled.',
                'success',
            );
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to update auto-classify setting.';
            this.showToast(message, 'error');
        }
    }

    private async fetchSettingsState(): Promise<SettingsState> {
        return this.sendAction<SettingsState>('GET_SETTINGS_STATE');
    }

    private async updateProviderChip(): Promise<void> {
        const pref = await getProviderPreference();
        this.providerChipText.textContent = pref ? (PROVIDER_LABELS[pref] ?? pref) : 'Auto Detect';
    }

    private async getStoredTheme(): Promise<Theme> {
        try {
            const result = await chrome.storage.local.get('ui_theme');
            return (result.ui_theme as Theme) || 'auto';
        } catch {
            return 'auto';
        }
    }

    private async applyStoredTheme(): Promise<void> {
        const theme = await this.getStoredTheme();
        const root = document.documentElement;
        root.classList.remove('dark', 'light');
        if (theme === 'dark') {
            root.classList.add('dark');
        } else if (theme === 'light') {
            root.classList.add('light');
        }
    }

    private async toggleTheme(): Promise<void> {
        const current = await this.getStoredTheme();
        const next: Theme = current === 'dark' ? 'auto' : 'dark';
        await chrome.storage.local.set({ ui_theme: next });
        await this.applyStoredTheme();
        this.themeToggle.setAttribute('aria-checked', next === 'dark' ? 'true' : 'false');
    }

    private toggleKeyVisibility(input: HTMLInputElement, btnId: string): void {
        const isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';

        const btn = document.getElementById(btnId);
        const svg = btn?.querySelector('svg');
        if (!svg) {
            return;
        }

        if (isHidden) {
            svg.textContent = '';
            svg.appendChild(this.makeSvgPath('path', {
                d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24',
            }));
            svg.appendChild(this.makeSvgPath('line', { x1: '1', y1: '1', x2: '23', y2: '23' }));
        } else {
            this.resetEyeIcon(btnId);
        }
    }

    private resetEyeIcon(btnId: string): void {
        const btn = document.getElementById(btnId);
        const svg = btn?.querySelector('svg');
        if (!svg) {
            return;
        }
        svg.textContent = '';
        svg.appendChild(this.makeSvgPath('path', { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }));
        svg.appendChild(this.makeSvgPath('circle', { cx: '12', cy: '12', r: '3' }));
    }

    private createFolderIcon(): HTMLElement {
        const iconWrap = document.createElement('span');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '12');
        svg.setAttribute('height', '12');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('aria-hidden', 'true');
        const path = this.makeSvgPath('path', {
            d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
        });
        svg.appendChild(path);
        iconWrap.appendChild(svg);
        return iconWrap;
    }

    private makeSvgPath(tag: string, attributes: Record<string, string>): SVGElement {
        const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
        return element;
    }

    private showToast(message: string, type: ToastType = 'info'): void {
        const container = this.el('toast-container');
        const icons: Record<ToastType, string> = {
            success: '✓',
            error: '✕',
            info: 'ℹ',
        };

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.setAttribute('role', 'alert');

        const icon = document.createElement('span');
        icon.className = 'toast-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = icons[type];

        const messageNode = document.createElement('span');
        messageNode.className = 'toast-message';
        messageNode.textContent = message;

        const close = document.createElement('button');
        close.className = 'toast-close';
        close.setAttribute('aria-label', 'Dismiss notification');
        close.textContent = '×';
        close.addEventListener('click', () => this.dismissToast(toast));

        toast.appendChild(icon);
        toast.appendChild(messageNode);
        toast.appendChild(close);
        container.appendChild(toast);
        setTimeout(() => this.dismissToast(toast), 4500);
    }

    private dismissToast(toast: HTMLElement): void {
        if (!toast.parentNode) {
            return;
        }
        toast.classList.add('is-leaving');
        setTimeout(() => toast.remove(), 220);
    }

    private async sendAction<T>(action: string, data?: unknown): Promise<T> {
        const response = await chrome.runtime.sendMessage({ action, data }) as RuntimeResponse<T> | undefined;
        if (!response) {
            throw new Error('No response from background service.');
        }
        if (!response.success) {
            throw new Error(response.error || 'Request failed.');
        }
        return response.result;
    }

    private formatFolderPath(path: string[]): string {
        return path.length ? path.join(' > ') : 'Bookmarks';
    }

    private confidenceLabel(confidence: number): string {
        return `${Math.round(confidence * 100)}%`;
    }

    private isSafeImageUrl(url: string): boolean {
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'https:' || parsed.protocol === 'http:';
        } catch {
            return false;
        }
    }

    private el(id: string): HTMLElement {
        const element = document.getElementById(id);
        if (!element) {
            throw new Error(`Element #${id} not found`);
        }
        return element;
    }
}

new PopupController();
