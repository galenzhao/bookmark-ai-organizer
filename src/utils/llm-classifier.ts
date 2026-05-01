// SPDX-License-Identifier: Apache-2.0
import OpenAI from 'openai';
import { SecurityManager } from './security';
import { getProviderPreference, getSelectedOpenRouterModel, chooseDefaultOpenRouterModel, clearSelectedOpenRouterModel, setSelectedOpenRouterModel } from './openrouter';
import { getCustomProviderConfig } from './custom-provider';

interface AIProvider {
    name: string;
    baseURL: string;
    model: string;
}

export interface ClassificationResult {
    folderPath: string[];
    tags: string[];
    confidence: number;
    suggestedTitle?: string;
}

export interface ClassificationOptions {
    providerOverride?: string | null;
    modelOverride?: string | null;
}

export interface ClassificationResultWithMeta extends ClassificationResult {
    providerId: string;
    providerName: string;
    model: string;
}

export class LlmClassifier {
    private apiKey: string | undefined = undefined;
    private providerOverride: string | null = null;
    private selectedOpenRouterModel: string | null = null;
    private providers: Record<string, AIProvider> = {
        openai: {
            name: 'OpenAI',
            baseURL: 'https://api.openai.com/v1',
            model: 'gpt-3.5-turbo'
        },
        moonshot: {
            name: 'Moonshot (Kimi)',
            baseURL: 'https://api.moonshot.ai/v1',
            model: 'kimi-k2-0711-preview'
        },
        grok: {
            name: 'Grok',
            baseURL: 'https://api.x.ai/v1',
            model: 'grok-beta'
        },
        openrouter: {
            name: 'OpenRouter',
            baseURL: 'https://openrouter.ai/api/v1',
            // Use a stable widely-available smaller model as initial default; can be overridden dynamically
            model: 'openai/gpt-4o-mini'
        },
        groq: {
            name: 'Groq',
            baseURL: 'https://api.groq.com/openai/v1',
            model: 'llama-3.3-70b-versatile'
        },
        custom: {
            name: 'Custom (OpenAI-compatible)',
            baseURL: 'http://localhost:11434/v1',
            model: 'gpt-4o-mini'
        },
    };

    constructor() {}

    private async loadApiKey() {
        this.apiKey = (await SecurityManager.getApiKey())?.trim();
    }

    private async loadPreferences() {
        try {
            this.providerOverride = await getProviderPreference();
            this.selectedOpenRouterModel = await getSelectedOpenRouterModel();
        } catch {
            this.providerOverride = null;
            this.selectedOpenRouterModel = null;
        }
    }

    private detectProviderId(apiKey: string): string {
        if (apiKey.startsWith('gsk_')) {
            return 'groq';
        } else if (apiKey.startsWith('sk-') && !apiKey.includes('kimi') && !apiKey.includes('or-v1')) {
            return 'openai';
        } else if (apiKey.startsWith('sk-or-v1-') || apiKey.includes('openrouter')) {
            return 'openrouter';
        } else if (apiKey.includes('kimi') || apiKey.length > 40) {
            return 'moonshot';
        } else if (apiKey.includes('grok') || apiKey.startsWith('xai-')) {
            return 'grok';
        }
        return 'openrouter';
    }

    async classifyUrl(url: string, title: string, options: ClassificationOptions = {}): Promise<ClassificationResult> {
        const result = await this.classifyUrlWithMeta(url, title, options);
        return {
            folderPath: result.folderPath,
            tags: result.tags,
            confidence: result.confidence,
        };
    }

    async classifyUrlWithMeta(url: string, title: string, options: ClassificationOptions = {}): Promise<ClassificationResultWithMeta> {
        // Always reload API key to ensure we have the latest saved key
        await this.loadApiKey();

        if (!this.apiKey) {
            throw new Error('API key not configured. Please save your API key first.');
        }

        await this.loadPreferences();

        const effectiveProviderId = this.resolveProviderId(options.providerOverride);
        const baseProvider = this.providers[effectiveProviderId];
        const provider = { ...baseProvider }; // copy to avoid mutating shared config

        if (effectiveProviderId === 'openrouter') {
            const selectedModel = options.modelOverride ?? this.selectedOpenRouterModel;
            if (selectedModel) {
                provider.model = selectedModel;
            }
        }
        if (effectiveProviderId === 'custom') {
            const config = await getCustomProviderConfig();
            if (!config?.baseURL || !config?.model) {
                throw new Error('Custom provider is not configured. Set Base URL and Model in Settings.');
            }
            if (!this.isValidBaseUrl(config.baseURL)) {
                throw new Error('Custom provider Base URL must be a valid http(s) URL.');
            }
            provider.baseURL = config.baseURL.replace(/\/$/, '');
            provider.model = config.model.trim();
            if (!provider.model) {
                throw new Error('Custom provider model is required.');
            }
        }

        // Create OpenAI client with provider-specific configuration
        const client = new OpenAI({
            apiKey: this.apiKey,
            baseURL: provider.baseURL,
        });

        const prompt = `You are an AI assistant tasked with classifying webpages for bookmark organization. Analyze the provided URL and the existing bookmark title to determine a logical folder structure, relevant tags, and a cleaned bookmark title. Do NOT use emojis or special symbols in folder names. Folder names must be plain text only. Follow these guidelines:

1. **Folder Structure**:
   - Create a folder path with 1-3 levels (e.g., ["News", "Global"] or ["Technology", "Software", "Tools"]).
   - Folder names MUST NOT contain emojis, leading icons, or decorative prefixes/suffixes.
   - Ensure folder names are concise, descriptive, and reflect the webpage's content or purpose.
   - Avoid nested folders deeper than 3 levels.

2. **Tags**:
   - Generate 2-5 concise, lowercase tags that describe the webpage’s content, purpose, or category.
   - Tags should be specific and useful for searching (e.g., "coding" instead of "tech").

3. **Confidence**:
   - Include a confidence score between 0 and 1 for your classification.
   - Use higher confidence only when category intent is clear from URL/title.

4. **Context**:
   - Infer the webpage’s purpose from the URL and title (e.g., blog, e-commerce, news, social media, education).
   - Consider the domain (e.g., github.com → coding, amazon.com → shopping).

5. **Output**:
   - Respond with valid JSON only, containing "folderPath" (array of strings), "tags" (array of strings), "confidence" (number from 0 to 1), and "suggestedTitle" (string).
   - The "suggestedTitle" MUST be based on BOTH the provided URL and the existing title. Do not invent unrelated titles.
   - "suggestedTitle" rules:
     - Keep the original intent/topic. Remove boilerplate like "Home", "Index", or repeated site names.
     - If the title is too generic (e.g., "Home", "Dashboard"), infer a better one from the URL path and domain.
     - Prefer concise, descriptive titles (typically 4–10 words). No emojis in the title.
     - Avoid adding marketing fluff; keep it factual.
   - Do not include markdown, code fences, or extra text.

**URL**: ${url}
**Title**: ${title}

**Examples**:
- URL: https://www.nytimes.com/politics, Title: "Election Updates"
  → {"folderPath": ["News", "Global", "Politics"], "tags": ["politics", "election", "news"], "confidence": 0.9, "suggestedTitle": "Election updates — politics"}
- URL: https://github.com/python, Title: "Python Repository"
  → {"folderPath": ["Technology", "Software", "Coding"], "tags": ["coding", "python", "github"], "confidence": 0.88, "suggestedTitle": "Python on GitHub"}
- URL: https://www.amazon.com/electronics, Title: "Electronics Store"
  → {"folderPath": ["Shopping", "Electronics"], "tags": ["shopping", "electronics", "amazon"], "confidence": 0.95, "suggestedTitle": "Amazon Electronics"}
- URL: https://www.khanacademy.org/math, Title: "Math Lessons"
  → {"folderPath": ["Education", "Math"], "tags": ["education", "math", "learning"], "confidence": 0.9, "suggestedTitle": "Khan Academy — Math lessons"}
- URL: https://www.reddit.com/r/science, Title: "Science Discussions"
  → {"folderPath": ["Social Media", "Science"], "tags": ["social", "science", "reddit"], "confidence": 0.78, "suggestedTitle": "Reddit r/science discussions"} 

**Response Format**:
{
  "folderPath": ["Category", "Subcategory", "Specific"],
  "tags": ["tag1", "tag2", "tag3"],
  "confidence": 0.85,
  "suggestedTitle": "A better title"
}`;

        try {
            const attemptClassification = async (): Promise<string> => {
                const completion = await client.chat.completions.create({
                    model: provider.model,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 300,
                    temperature: 0.2
                });
                return completion.choices[0].message.content || '';
            };

            let retried = false;
            let result: string | undefined;
            try {
                result = await attemptClassification();
            } catch (err) {
                if (provider.name === 'OpenRouter' && err instanceof OpenAI.APIError && err.status === 404 && !retried) {
                    retried = true;
                    await clearSelectedOpenRouterModel();
                    const apiKey = this.apiKey!;
                    const fallback = await chooseDefaultOpenRouterModel(apiKey);
                    if (fallback) {
                        provider.model = fallback;
                        await setSelectedOpenRouterModel(fallback);
                        result = await attemptClassification();
                    } else {
                        throw new Error('No fallback OpenRouter model available.');
                    }
                } else {
                    throw err;
                }
            }

            if (!result) {
                throw new Error('No response content received from AI provider');
            }
            const cleanResult = result.replace(/```json\n?|\n?```/g, '').trim();
            const parsed = JSON.parse(cleanResult);
            if (!parsed.folderPath || !Array.isArray(parsed.folderPath)) {
                throw new Error('Invalid response format: missing folderPath');
            }

            const rawFolderPath: unknown[] = parsed.folderPath;
            const folderPath = rawFolderPath
                .filter((segment: unknown): segment is string => typeof segment === 'string')
                .map((segment: string) => segment.trim())
                .filter(Boolean)
                .slice(0, 3);
            if (!folderPath.length) {
                throw new Error('Invalid response format: empty folderPath');
            }

            const rawTags: unknown[] = Array.isArray(parsed.tags) ? parsed.tags : [];
            const tags = rawTags
                    .filter((tag: unknown): tag is string => typeof tag === 'string')
                    .map((tag: string) => tag.trim().toLowerCase())
                    .filter(Boolean)
                    .slice(0, 5);

            const rawConfidence = Number(parsed.confidence);
            const confidence = Number.isFinite(rawConfidence)
                ? Math.max(0, Math.min(1, rawConfidence))
                : 0.5;

            const suggestedTitle = typeof parsed.suggestedTitle === 'string'
                ? parsed.suggestedTitle.trim().slice(0, 180)
                : undefined;

            const classification: ClassificationResultWithMeta = {
                folderPath,
                tags,
                confidence,
                suggestedTitle,
                providerId: effectiveProviderId,
                providerName: provider.name,
                model: provider.model,
            };

            return classification;
        } catch (error: unknown) {
            if (error instanceof OpenAI.APIError) {
                if (error.status === 401) {
                    throw new Error('Invalid API key. Please check your credentials.');
                } else if (error.status === 429) {
                    throw new Error('Rate limit exceeded. Please try again later.');
                } else if (error.status === 403) {
                    throw new Error('API access forbidden. Check your API key permissions.');
                } else if (error.status === undefined) {
                    // OpenAI SDK uses undefined status for network errors like "Failed to fetch".
                    // Make the root cause actionable by including the provider and base URL.
                    throw new Error(`Connection error. Failed to reach ${provider.name} at ${provider.baseURL}.`);
                } else {
                    throw new Error(`API Error (${error.status}): ${error.message}`);
                }
            }
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            throw new Error(`Classification failed: ${errorMessage}`);
        }
    }

    private resolveProviderId(overrideProvider?: string | null): string {
        if (overrideProvider && this.providers[overrideProvider]) {
            return overrideProvider;
        }

        if (this.providerOverride && this.providers[this.providerOverride]) {
            return this.providerOverride;
        }

        if (!this.apiKey) {
            return 'openrouter';
        }
        return this.detectProviderId(this.apiKey);
    }

    private isValidBaseUrl(value: string): boolean {
        try {
            const parsed = new URL(value);
            return parsed.protocol === 'https:' || parsed.protocol === 'http:';
        } catch {
            return false;
        }
    }
}