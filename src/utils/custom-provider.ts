// SPDX-License-Identifier: Apache-2.0

export type CustomProviderConfig = {
  baseURL: string;
  model: string;
};

const CUSTOM_BASE_URL_KEY = 'custom_provider_base_url';
const CUSTOM_MODEL_KEY = 'custom_provider_model';

async function getLocalWithSyncFallback(key: string): Promise<string | null> {
  const localResult = await chrome.storage.local.get(key);
  const localValue = localResult[key];
  if (typeof localValue === 'string' && localValue) {
    return localValue;
  }

  const syncResult = await chrome.storage.sync.get(key);
  const syncValue = syncResult[key];
  if (typeof syncValue === 'string' && syncValue) {
    await chrome.storage.local.set({ [key]: syncValue });
    await chrome.storage.sync.remove(key);
    return syncValue;
  }

  return null;
}

export async function getCustomProviderConfig(): Promise<CustomProviderConfig | null> {
  const [baseURL, model] = await Promise.all([
    getLocalWithSyncFallback(CUSTOM_BASE_URL_KEY),
    getLocalWithSyncFallback(CUSTOM_MODEL_KEY),
  ]);
  if (!baseURL || !model) {
    return null;
  }
  return { baseURL, model };
}

export async function setCustomProviderConfig(config: CustomProviderConfig): Promise<void> {
  const baseURL = config.baseURL.trim();
  const model = config.model.trim();
  await Promise.all([
    chrome.storage.local.set({ [CUSTOM_BASE_URL_KEY]: baseURL, [CUSTOM_MODEL_KEY]: model }),
    chrome.storage.sync.remove(CUSTOM_BASE_URL_KEY),
    chrome.storage.sync.remove(CUSTOM_MODEL_KEY),
  ]);
}

export async function clearCustomProviderConfig(): Promise<void> {
  await Promise.all([
    chrome.storage.local.remove([CUSTOM_BASE_URL_KEY, CUSTOM_MODEL_KEY]),
    chrome.storage.sync.remove([CUSTOM_BASE_URL_KEY, CUSTOM_MODEL_KEY]),
  ]);
}

