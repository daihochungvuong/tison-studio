// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * API Config Store v2
 * Manages API providers and keys with localStorage persistence
 * Supports multi-key rotation and IProvider interface (AionUi pattern)
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProviderId, ServiceType } from '@opencut/ai-core';
import { 
  type IProvider, 
  DEFAULT_PROVIDERS, 
  generateId, 
  parseApiKeys,
  maskApiKey as maskKey,
  updateProviderKeys,
  classifyModelByName,
} from '@/lib/api-key-manager';

// Re-export IProvider for convenience
export type { IProvider } from '@/lib/api-key-manager';

// ==================== AI Feature Types ====================

/**
 * AI 功能模块类型
 * 每个功能可以绑定一个 API 供应商
 */
export type AIFeature = 
  | 'script_analysis'       // 剧本分析
  | 'character_generation'  // 角色图片生成
  | 'scene_generation'      // 场景图片生成
  | 'video_generation'      // 视频生成
  | 'image_understanding'   // 图片理解/分析
  | 'chat';                 // 通用对话

/**
 * 功能绑定配置
 * 每个功能可绑定多个供应商/模型（多选）
 * 格式: platform:model 数组，如 ['memefast:deepseek-v3.2', 'memefast:gemini-3-pro-image-preview']
 */
export type FeatureBindings = Record<AIFeature, string[] | null>;

/**
 * 功能信息定义
 */
export const AI_FEATURES: Array<{
  key: AIFeature;
  name: string;
  description: string;
}> = [
  { key: 'script_analysis', name: '剧本分析', description: '将故事文本分解为结构化剧本' },
  { key: 'character_generation', name: '角色生成', description: '生成角色参考图和变体服装' },
  { key: 'scene_generation', name: '场景生成', description: '生成场景环境参考图' },
  { key: 'video_generation', name: '视频生成', description: '将图片转换为视频' },
  { key: 'image_understanding', name: '图片理解', description: '分析图片内容' },
  { key: 'chat', name: '通用对话', description: 'AI 对话和文本生成' },
];

// ==================== Types ====================

/**
 * 高级生成选项
 * 控制视频生成的高级行为
 */
export interface AdvancedGenerationOptions {
  /** 启用视觉连续性：自动将上一分镜尾帧传递给下一分镜作为参考 */
  enableVisualContinuity: boolean;
  /** 启用断点续传：批量生成中断后可从上次位置继续 */
  enableResumeGeneration: boolean;
  /** 启用内容审核容错：遇到敏感内容自动跳过，继续生成其他分镜 */
  enableContentModeration: boolean;
  /** 启用多模型自动切换：首分镜使用 t2v，后续使用 i2v */
  enableAutoModelSwitch: boolean;
}

/** 高级选项默认值 */
export const DEFAULT_ADVANCED_OPTIONS: AdvancedGenerationOptions = {
  enableVisualContinuity: true,
  enableResumeGeneration: true,
  enableContentModeration: true,
  enableAutoModelSwitch: false,
};

// ==================== Image Host Types ====================

/**
 * 图床平台
 */
export type ImageHostPlatform = 'imgbb' | 'cloudflare_r2' | 'custom';

/**
 * 图床供应商配置（独立映射）
 */
export interface ImageHostProvider {
  id: string;
  platform: ImageHostPlatform;
  name: string;
  baseUrl: string;
  uploadPath: string; // 可为完整 URL 或路径
  apiKey: string; // 支持多 Key（逗号/换行）
  enabled: boolean;
  apiKeyParam?: string; // Query 参数名（如 key）
  apiKeyHeader?: string; // Header 名称（可选）
  expirationParam?: string; // 过期参数名（如 expiration）
  imageField?: string; // 表单字段名（默认 image）
  nameField?: string; // 表单字段名（默认 name）
  responseUrlField?: string; // 响应中 URL 字段路径（如 data.url）
  responseDeleteUrlField?: string; // 响应中删除 URL 字段路径
}

/** 图床供应商默认模板（仅用于预设） */
export const DEFAULT_IMAGE_HOST_PROVIDERS: Omit<ImageHostProvider, 'id' | 'apiKey'>[] = [
  {
    platform: 'imgbb',
    name: 'imgbb',
    baseUrl: 'https://api.imgbb.com',
    uploadPath: '/1/upload',
    enabled: true,
    apiKeyParam: 'key',
    expirationParam: 'expiration',
    imageField: 'image',
    nameField: 'name',
    responseUrlField: 'data.url',
    responseDeleteUrlField: 'data.delete_url',
  },
];

/** Legacy 图床配置（仅用于迁移） */
export interface LegacyImageHostConfig {
  type: ImageHostPlatform;
  imgbbApiKey: string;
  cloudflareR2?: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
  };
  custom?: {
    uploadUrl: string;
    apiKey: string;
  };
}

interface APIConfigState {
  // Provider-based storage (v2)
  providers: IProvider[];
  
  // Feature bindings - which provider to use for each feature
  featureBindings: FeatureBindings;
  
  // Legacy: API Keys (v1, for migration)
  apiKeys: Partial<Record<ProviderId, string>>;
  
  // Concurrency control
  concurrency: number;
  
  // Aspect ratio preference
  aspectRatio: '16:9' | '9:16';
  orientation: 'landscape' | 'portrait';
  
  // Advanced generation options
  advancedOptions: AdvancedGenerationOptions;
  
  // Image host providers (independent mapping)
  imageHostProviders: ImageHostProvider[];
  
  // Model endpoint types from API sync (model ID -> supported_endpoint_types)
  modelEndpointTypes: Record<string, string[]>;
  
  // Model metadata from /api/pricing_new (MemeFast platform classification)
  // model_name -> model_type: "文本" | "图像" | "音视频" | "检索"
  modelTypes: Record<string, string>;
  // model_name -> tags: ["对话","识图","工具"] etc.
  modelTags: Record<string, string[]>;
}

interface APIConfigActions {
  // Provider management (v2)
  addProvider: (provider: Omit<IProvider, 'id'>) => IProvider;
  updateProvider: (provider: IProvider) => void;
  removeProvider: (id: string) => void;
  getProviderByPlatform: (platform: string) => IProvider | undefined;
  getProviderById: (id: string) => IProvider | undefined;
  syncProviderModels: (providerId: string) => Promise<{ success: boolean; count: number; error?: string }>;
  
  // Feature binding management (multi-select)
  setFeatureBindings: (feature: AIFeature, bindings: string[] | null) => void;
  toggleFeatureBinding: (feature: AIFeature, binding: string) => void;
  getFeatureBindings: (feature: AIFeature) => string[];
  getProvidersForFeature: (feature: AIFeature) => Array<{ provider: IProvider; model: string }>;
  isFeatureConfigured: (feature: AIFeature) => boolean;
  // Legacy single-select compat (deprecated)
  setFeatureBinding: (feature: AIFeature, providerId: string | null) => void;
  getFeatureBinding: (feature: AIFeature) => string | null;
  getProviderForFeature: (feature: AIFeature) => IProvider | undefined;
  
  // Legacy API Key management (v1 compat)
  setApiKey: (provider: ProviderId, key: string) => void;
  getApiKey: (provider: ProviderId) => string;
  clearApiKey: (provider: ProviderId) => void;
  clearAllApiKeys: () => void;
  
  // Concurrency
  setConcurrency: (n: number) => void;
  
  // Aspect ratio
  setAspectRatio: (ratio: '16:9' | '9:16') => void;
  toggleOrientation: () => void;
  
  // Advanced generation options
  setAdvancedOption: <K extends keyof AdvancedGenerationOptions>(key: K, value: AdvancedGenerationOptions[K]) => void;
  resetAdvancedOptions: () => void;
  
  // Image host provider management
  addImageHostProvider: (provider: Omit<ImageHostProvider, 'id'>) => ImageHostProvider;
  updateImageHostProvider: (provider: ImageHostProvider) => void;
  removeImageHostProvider: (id: string) => void;
  getImageHostProviderById: (id: string) => ImageHostProvider | undefined;
  getEnabledImageHostProviders: () => ImageHostProvider[];
  isImageHostConfigured: () => boolean;
  
  // Validation
  isConfigured: (provider: ProviderId) => boolean;
  isPlatformConfigured: (platform: string) => boolean;
  checkRequiredKeys: (services: ServiceType[]) => APIConfigStatus;
  checkChatKeys: () => APIConfigStatus;
  checkVideoGenerationKeys: () => APIConfigStatus;
  
  // Display helpers
  maskApiKey: (key: string) => string;
  getAllConfigs: () => { provider: ProviderId; configured: boolean; masked: string }[];
}

type APIConfigStore = APIConfigState & APIConfigActions;

// ==================== Status Type ====================

export interface APIConfigStatus {
  isAllConfigured: boolean;
  missingKeys: string[];
  friendlyMessage: string;
}

// ==================== Provider Info ====================

/**
 * 供应商信息映射
 * 1. memefast - 魔因API，全功能 AI 中转（推荐）
 * 2. runninghub - RunningHub，视角切换/多角度生成
 */
const PROVIDER_INFO: Record<ProviderId, { name: string; services: ServiceType[] }> = {
  memefast: { name: '魔因API', services: ['chat', 'image', 'video', 'vision'] },
  runninghub: { name: 'RunningHub', services: ['image', 'vision'] },
  openai: { name: 'OpenAI', services: [] },
  custom: { name: 'Custom', services: [] },
};

// ==================== Initial State ====================

// Default feature bindings (all null)
const defaultFeatureBindings: FeatureBindings = {
  script_analysis: null,
  character_generation: null,
  scene_generation: null,
  video_generation: null,
  image_understanding: null,
  chat: null,
};
const defaultImageHostProviders: ImageHostProvider[] = DEFAULT_IMAGE_HOST_PROVIDERS.map((p) => ({
  ...p,
  id: generateId(),
  apiKey: '',
}));

// Pre-fill MemeFast for new users (no API Key, just the provider entry)
const memefastTemplate = DEFAULT_PROVIDERS.find(p => p.platform === 'memefast');

const initialState: APIConfigState = {
  providers: memefastTemplate
    ? [{ id: generateId(), ...memefastTemplate, apiKey: '' }]
    : [],
  featureBindings: defaultFeatureBindings,
  apiKeys: {},
  concurrency: 1,  // Default to serial execution (single key rate limit)
  aspectRatio: '16:9',
  orientation: 'landscape',
  advancedOptions: { ...DEFAULT_ADVANCED_OPTIONS },
  imageHostProviders: defaultImageHostProviders,
  modelEndpointTypes: {},
  modelTypes: {},
  modelTags: {},
};

// ==================== Store ====================

export const useAPIConfigStore = create<APIConfigStore>()(
  persist(
    (set, get) => ({
      ...initialState,

      // ==================== Provider Management (v2) ====================
      
      addProvider: (providerData) => {
        const newProvider: IProvider = {
          ...providerData,
          id: generateId(),
        };
        set((state) => ({
          providers: [...state.providers, newProvider],
        }));
        // Update key manager
        updateProviderKeys(newProvider.id, newProvider.apiKey);
        console.log(`[APIConfig] Added provider: ${newProvider.name}`);
        return newProvider;
      },

      updateProvider: (provider) => {
        set((state) => ({
          providers: state.providers.map(p => p.id === provider.id ? provider : p),
        }));
        // Update key manager
        updateProviderKeys(provider.id, provider.apiKey);
        console.log(`[APIConfig] Updated provider: ${provider.name}`);
      },

      removeProvider: (id) => {
        const provider = get().providers.find(p => p.id === id);
        set((state) => ({
          providers: state.providers.filter(p => p.id !== id),
        }));
        if (provider) {
          console.log(`[APIConfig] Removed provider: ${provider.name}`);
        }
      },

      getProviderByPlatform: (platform) => {
        return get().providers.find(p => p.platform === platform);
      },

      getProviderById: (id) => {
        return get().providers.find(p => p.id === id);
      },

      syncProviderModels: async (providerId) => {
        const provider = get().providers.find(p => p.id === providerId);
        if (!provider) return { success: false, count: 0, error: '供应商不存在' };

        const keys = parseApiKeys(provider.apiKey);
        if (keys.length === 0) return { success: false, count: 0, error: '请先配置 API Key' };

        const baseUrl = provider.baseUrl?.replace(/\/+$/, '');
        if (!baseUrl) return { success: false, count: 0, error: 'Base URL 未配置' };

        try {
          // 用 Set 收集所有 key 的模型，自动去重
          const allModelIds = new Set<string>();
          const isMemefast = provider.platform === 'memefast';

          if (isMemefast) {
            // MemeFast: /api/pricing_new 获取全量元数据（公开接口）
            const domain = baseUrl.replace(/\/v\d+$/, '');
            const pricingUrl = `${domain}/api/pricing_new`;

            const response = await fetch(pricingUrl);
            if (!response.ok) {
              return { success: false, count: 0, error: `pricing_new API 返回 ${response.status}` };
            }

            const json = await response.json();
            const data: Array<{ model_name: string; model_type?: string; tags?: string; supported_endpoint_types?: string[] }> = json.data;
            if (!Array.isArray(data) || data.length === 0) {
              return { success: false, count: 0, error: '响应格式异常' };
            }

            console.log(`[APIConfig] Fetched ${data.length} models from pricing_new`);

            // Store model_type, tags, and endpoint_types
            const types: Record<string, string> = { ...get().modelTypes };
            const tags: Record<string, string[]> = { ...get().modelTags };
            const endpoints: Record<string, string[]> = { ...get().modelEndpointTypes };

            for (const m of data) {
              const name = m.model_name;
              if (!name) continue;
              if (m.model_type) types[name] = m.model_type;
              if (m.tags) {
                tags[name] = typeof m.tags === 'string'
                  ? m.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
                  : m.tags;
              }
              if (Array.isArray(m.supported_endpoint_types)) {
                endpoints[name] = m.supported_endpoint_types;
              }
            }

            set({ modelTypes: types, modelTags: tags, modelEndpointTypes: endpoints });
            console.log(`[APIConfig] Stored metadata: ${Object.keys(types).length} types, ${Object.keys(tags).length} tags`);

            // pricing_new 返回全量（公开列表），先收入
            for (const m of data) {
              if (typeof m.model_name === 'string' && m.model_name.length > 0) {
                allModelIds.add(m.model_name);
              }
            }

            // 再遍历每个 key 查 /v1/models 补充该 key 独有模型
            const modelsUrl = /\/v\d+$/.test(baseUrl)
              ? `${baseUrl}/models`
              : `${baseUrl}/v1/models`;

            for (let ki = 0; ki < keys.length; ki++) {
              try {
                const resp = await fetch(modelsUrl, {
                  headers: { 'Authorization': `Bearer ${keys[ki]}` },
                });
                if (!resp.ok) {
                  console.warn(`[APIConfig] MemeFast key#${ki + 1} /v1/models returned ${resp.status}, skip`);
                  continue;
                }
                const j = await resp.json();
                const arr: Array<{ id: string; supported_endpoint_types?: string[] } | string> = j.data || j;
                if (!Array.isArray(arr)) continue;
                for (const m of arr) {
                  const id = typeof m === 'string' ? m : m.id;
                  if (typeof id === 'string' && id.length > 0) allModelIds.add(id);
                  // 补充 endpoint_types
                  if (typeof m !== 'string' && m.id && Array.isArray(m.supported_endpoint_types)) {
                    endpoints[m.id] = m.supported_endpoint_types as string[];
                  }
                }
                console.log(`[APIConfig] MemeFast key#${ki + 1} contributed models, total so far: ${allModelIds.size}`);
              } catch (e) {
                console.warn(`[APIConfig] MemeFast key#${ki + 1} /v1/models failed:`, e);
              }
            }
            set({ modelEndpointTypes: endpoints });
          } else {
            // Standard OpenAI-compatible: 遍历每个 key 查 /v1/models，合并去重
            const modelsUrl = /\/v\d+$/.test(baseUrl)
              ? `${baseUrl}/models`
              : `${baseUrl}/v1/models`;

            const endpoints: Record<string, string[]> = { ...get().modelEndpointTypes };
            let anySuccess = false;
            let lastError = '';

            for (let ki = 0; ki < keys.length; ki++) {
              try {
                const response = await fetch(modelsUrl, {
                  headers: { 'Authorization': `Bearer ${keys[ki]}` },
                });

                if (!response.ok) {
                  lastError = `key#${ki + 1} API 返回 ${response.status}`;
                  console.warn(`[APIConfig] ${lastError}`);
                  continue;
                }

                const json = await response.json();
                const data: Array<{ id: string; [key: string]: unknown }> = json.data || json;
                if (!Array.isArray(data) || data.length === 0) {
                  console.warn(`[APIConfig] key#${ki + 1} returned empty model list`);
                  continue;
                }

                anySuccess = true;
                for (const m of data) {
                  const id = typeof m === 'string' ? m : m.id;
                  if (typeof id === 'string' && id.length > 0) allModelIds.add(id);
                  // Capture endpoint_types
                  if (typeof m !== 'string' && m.id && Array.isArray(m.supported_endpoint_types)) {
                    endpoints[m.id] = m.supported_endpoint_types as string[];
                  }
                }
                console.log(`[APIConfig] key#${ki + 1} contributed models, total so far: ${allModelIds.size}`);
              } catch (e) {
                lastError = `key#${ki + 1} 网络请求失败`;
                console.warn(`[APIConfig] ${lastError}:`, e);
              }
            }

            set({ modelEndpointTypes: endpoints });

            if (!anySuccess) {
              return { success: false, count: 0, error: lastError || 'API 返回异常' };
            }
          }

          const modelIds = Array.from(allModelIds);
          if (modelIds.length === 0) {
            return { success: false, count: 0, error: '未获取到任何模型' };
          }

          // Replace provider model list with merged & deduped data
          get().updateProvider({ ...provider, model: modelIds });

          console.log(`[APIConfig] Synced ${modelIds.length} models for ${provider.name} (from ${keys.length} keys)`);
          return { success: true, count: modelIds.length };
        } catch (error) {
          console.error('[APIConfig] Model sync failed:', error);
          return { success: false, count: 0, error: '网络请求失败，请检查网络' };
        }
      },

      // ==================== Feature Binding Management (Multi-Select) ====================
      
      // 设置功能的所有绑定（替换）
      setFeatureBindings: (feature, bindings) => {
        set((state) => ({
          featureBindings: { ...state.featureBindings, [feature]: bindings },
        }));
        console.log(`[APIConfig] Set ${feature} -> [${bindings?.join(', ') || '无'}]`);
      },
      
      // 切换单个绑定（添加/移除）
      toggleFeatureBinding: (feature, binding) => {
        const current = get().featureBindings[feature] || [];
        const exists = current.includes(binding);
        const newBindings = exists
          ? current.filter(b => b !== binding)
          : [...current, binding];
        set((state) => ({
          featureBindings: { ...state.featureBindings, [feature]: newBindings.length > 0 ? newBindings : null },
        }));
        console.log(`[APIConfig] Toggle ${feature}: ${binding} -> ${exists ? 'removed' : 'added'}`);
      },

      // 获取功能的所有绑定
      getFeatureBindings: (feature) => {
        const bindings = get().featureBindings;
        const value = bindings?.[feature];
        // 兼容旧数据：如果是字符串，转为数组
        if (typeof value === 'string') return [value];
        return value || [];
      },

      // 获取功能对应的所有 provider + model
      getProvidersForFeature: (feature) => {
        const bindings = get().getFeatureBindings(feature);
        const results: Array<{ provider: IProvider; model: string }> = [];
        
        for (const binding of bindings) {
          const idx = binding.indexOf(':');
          if (idx <= 0) continue;
          const platform = binding.slice(0, idx);
          const model = binding.slice(idx + 1);
          const provider = get().providers.find(p => p.platform === platform);
          if (provider && parseApiKeys(provider.apiKey).length > 0) {
            results.push({ provider, model });
          }
        }
        return results;
      },

      isFeatureConfigured: (feature) => {
        return get().getProvidersForFeature(feature).length > 0;
      },
      
      // Legacy single-select compat (deprecated, for backward compat)
      setFeatureBinding: (feature, providerId) => {
        // 单选兼容：设置为单元素数组
        get().setFeatureBindings(feature, providerId ? [providerId] : null);
      },

      getFeatureBinding: (feature) => {
        const bindings = get().getFeatureBindings(feature);
        return bindings[0] || null;
      },

      getProviderForFeature: (feature) => {
        const providers = get().getProvidersForFeature(feature);
        return providers[0]?.provider;
      },

      // ==================== Legacy API Key management (v1 compat) ====================
      
      setApiKey: (provider, key) => {
        // Update legacy apiKeys
        set((state) => ({
          apiKeys: { ...state.apiKeys, [provider]: key },
        }));
        
        // Also update provider if exists
        const existingProvider = get().getProviderByPlatform(provider);
        if (existingProvider) {
          get().updateProvider({ ...existingProvider, apiKey: key });
        }
        
        console.log(`[APIConfig] Updated ${provider} API key: ${get().maskApiKey(key)}`);
      },

      getApiKey: (provider) => {
        // First check providers (v2)
        const prov = get().getProviderByPlatform(provider);
        if (prov?.apiKey) {
          // Return first key for compatibility
          const keys = parseApiKeys(prov.apiKey);
          return keys[0] || '';
        }
        // Fallback to legacy apiKeys
        return get().apiKeys[provider] || '';
      },

      clearApiKey: (provider) => {
        // Clear from legacy
        set((state) => {
          const newKeys = { ...state.apiKeys };
          delete newKeys[provider];
          return { apiKeys: newKeys };
        });
        
        // Also clear from provider if exists
        const existingProvider = get().getProviderByPlatform(provider);
        if (existingProvider) {
          get().updateProvider({ ...existingProvider, apiKey: '' });
        }
        
        console.log(`[APIConfig] Cleared ${provider} API key`);
      },

      clearAllApiKeys: () => {
        // Clear legacy
        set({ apiKeys: {} });
        
        // Clear all provider keys
        const { providers, updateProvider } = get();
        providers.forEach(p => {
          updateProvider({ ...p, apiKey: '' });
        });
        
        console.log('[APIConfig] Cleared all API keys');
      },

      // ==================== Concurrency ====================
      
      setConcurrency: (n) => {
        const value = Math.max(1, n); // 最小为1，无上限
        set({ concurrency: value });
        console.log(`[APIConfig] Set concurrency to ${value}`);
      },

      // ==================== Aspect ratio ====================
      
      setAspectRatio: (ratio) => {
        set({
          aspectRatio: ratio,
          orientation: ratio === '16:9' ? 'landscape' : 'portrait',
        });
        console.log(`[APIConfig] Set aspect ratio to ${ratio}`);
      },

      toggleOrientation: () => {
        const { aspectRatio } = get();
        const newRatio = aspectRatio === '16:9' ? '9:16' : '16:9';
        get().setAspectRatio(newRatio);
      },

      // ==================== Advanced Generation Options ====================
      
      setAdvancedOption: (key, value) => {
        set((state) => ({
          advancedOptions: { ...state.advancedOptions, [key]: value },
        }));
        console.log(`[APIConfig] Set advanced option ${key} = ${value}`);
      },

      resetAdvancedOptions: () => {
        set({ advancedOptions: { ...DEFAULT_ADVANCED_OPTIONS } });
        console.log('[APIConfig] Reset advanced options to defaults');
      },

      // ==================== Image Host Providers (independent) ====================

      addImageHostProvider: (providerData) => {
        const newProvider: ImageHostProvider = {
          ...providerData,
          id: generateId(),
        };
        set((state) => ({
          imageHostProviders: [...state.imageHostProviders, newProvider],
        }));
        console.log(`[APIConfig] Added image host: ${newProvider.name}`);
        return newProvider;
      },

      updateImageHostProvider: (provider) => {
        set((state) => ({
          imageHostProviders: state.imageHostProviders.map(p => p.id === provider.id ? provider : p),
        }));
        console.log(`[APIConfig] Updated image host: ${provider.name}`);
      },

      removeImageHostProvider: (id) => {
        const provider = get().imageHostProviders.find(p => p.id === id);
        set((state) => ({
          imageHostProviders: state.imageHostProviders.filter(p => p.id !== id),
        }));
        if (provider) {
          console.log(`[APIConfig] Removed image host: ${provider.name}`);
        }
      },

      getImageHostProviderById: (id) => {
        return get().imageHostProviders.find(p => p.id === id);
      },

      getEnabledImageHostProviders: () => {
        return get().imageHostProviders.filter(p => p.enabled);
      },

      isImageHostConfigured: () => {
        const providers = get().imageHostProviders;
        return providers.some(p => {
          const hasKey = parseApiKeys(p.apiKey).length > 0;
          const hasUrl = !!(p.baseUrl || p.uploadPath);
          return p.enabled && hasKey && hasUrl;
        });
      },

      // ==================== Validation ====================
      
      isConfigured: (provider) => {
        // Check v2 providers first
        const prov = get().getProviderByPlatform(provider);
        if (prov) {
          return parseApiKeys(prov.apiKey).length > 0;
        }
        // Fallback to legacy
        const key = get().apiKeys[provider];
        return !!key && key.length > 0;
      },

      isPlatformConfigured: (platform) => {
        const provider = get().getProviderByPlatform(platform);
        return !!provider && parseApiKeys(provider.apiKey).length > 0;
      },

      checkRequiredKeys: (services) => {
        const missing: string[] = [];
        const { isConfigured } = get();

        for (const service of services) {
          // Find provider for this service
          for (const [providerId, info] of Object.entries(PROVIDER_INFO)) {
            if (info.services.includes(service) && !isConfigured(providerId as ProviderId)) {
              if (!missing.includes(info.name)) {
                missing.push(info.name);
              }
            }
          }
        }

        return {
          isAllConfigured: missing.length === 0,
          missingKeys: missing,
          friendlyMessage: missing.length === 0
            ? '所有 API Key 已配置'
            : `缺少以下 API Key：${missing.join('、')}`,
        };
      },

      checkChatKeys: () => {
        return get().checkRequiredKeys(['chat']);
      },

      checkVideoGenerationKeys: () => {
        return get().checkRequiredKeys(['chat', 'image', 'video']);
      },

      // ==================== Display helpers ====================
      
      maskApiKey: (key) => {
        return maskKey(key);
      },

      getAllConfigs: () => {
        const { apiKeys, maskApiKey, isConfigured } = get();
        return (Object.keys(PROVIDER_INFO) as ProviderId[]).map((provider) => ({
          provider,
          configured: isConfigured(provider),
          masked: maskApiKey(apiKeys[provider] || ''),
        }));
      },
    }),
    {
      name: 'opencut-api-config',  // localStorage key
      version: 7,  // v7: remove deprecated providers
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as Partial<APIConfigState> & { imageHostConfig?: LegacyImageHostConfig } | undefined;
        console.log(`[APIConfig] Migrating from version ${version}`);
        
        // Default feature bindings for migration
        const defaultBindings: FeatureBindings = {
          script_analysis: null,
          character_generation: null,
          scene_generation: null,
          video_generation: null,
          image_understanding: null,
          chat: null,
        };
        const resolveImageHostProviders = (): ImageHostProvider[] => {
          const legacyConfig = state?.imageHostConfig;
          let imageHostProviders: ImageHostProvider[] = (state as any)?.imageHostProviders || [];

          if (!imageHostProviders || imageHostProviders.length === 0) {
            if (legacyConfig) {
              if (legacyConfig.type === 'imgbb') {
                imageHostProviders = [
                  {
                    ...DEFAULT_IMAGE_HOST_PROVIDERS[0],
                    id: generateId(),
                    apiKey: legacyConfig.imgbbApiKey || '',
                    enabled: true,
                  },
                ];
              } else if (legacyConfig.type === 'custom' && legacyConfig.custom) {
                imageHostProviders = [
                  {
                    id: generateId(),
                    platform: 'custom',
                    name: '自定义图床',
                    baseUrl: legacyConfig.custom.uploadUrl || '',
                    uploadPath: '',
                    apiKey: legacyConfig.custom.apiKey || '',
                    enabled: true,
                  },
                ];
              } else if (legacyConfig.type === 'cloudflare_r2') {
                imageHostProviders = [
                  {
                    id: generateId(),
                    platform: 'cloudflare_r2',
                    name: 'Cloudflare R2',
                    baseUrl: '',
                    uploadPath: '',
                    apiKey: '',
                    enabled: false,
                  },
                ];
              }
            }

            if (!imageHostProviders || imageHostProviders.length === 0) {
              imageHostProviders = DEFAULT_IMAGE_HOST_PROVIDERS.map((p) => ({
                ...p,
                id: generateId(),
                apiKey: '',
              }));
            }
          }

          return imageHostProviders;
        };
        
        // v1 -> v2: Migrate apiKeys to providers
        if (version === 1 || version === 0) {
          const oldApiKeys = state?.apiKeys || {};
          const providers: IProvider[] = [];
          
          // Create provider entries from old apiKeys
          for (const template of DEFAULT_PROVIDERS) {
            const existingKey = oldApiKeys[template.platform as ProviderId] || '';
            providers.push({
              id: generateId(),
              ...template,
              apiKey: existingKey,
            });
          }
          
          console.log(`[APIConfig] Migrated ${providers.length} providers from v1`);
          
          return {
            ...state,
            providers,
            featureBindings: defaultBindings,
            imageHostProviders: resolveImageHostProviders(),
            // Keep apiKeys for backward compat
            apiKeys: oldApiKeys,
          };
        }
        
        // v2 -> v3: Ensure providers and featureBindings exist
        if (version === 2) {
          const providers = state?.providers || [];
          const mergedBindings = { ...defaultBindings, ...(state?.featureBindings || {}) };
          
          return {
            ...state,
            providers,
            featureBindings: mergedBindings,
            imageHostProviders: resolveImageHostProviders(),
          };
        }

        // v3 -> v4: Ensure RunningHub model uses AppId
        if (version === 3) {
          const providers = (state?.providers || []).map((p: IProvider) => {
            if (p.platform === 'runninghub') {
              const hasOldModel = p.model?.includes('qwen-image-edit-angles');
              const hasAppId = p.model?.includes('2009613632530812930');
              if (!p.model || p.model.length === 0 || hasOldModel || !hasAppId) {
                return {
                  ...p,
                  model: ['2009613632530812930'],
                };
              }
            }
            return p;
          });

          // Ensure featureBindings exists
          const mergedBindings = { ...defaultBindings, ...(state?.featureBindings || {}) };

          return {
            ...state,
            providers,
            featureBindings: mergedBindings,
            imageHostProviders: resolveImageHostProviders(),
          };
        }
        
        // v6 -> v7: Remove deprecated providers (dik3, nanohajimi, apimart, zhipu)
        if (version === 6) {
          const DEPRECATED_PLATFORMS = ['dik3', 'nanohajimi', 'apimart', 'zhipu'];
          const oldProviders: IProvider[] = state?.providers || [];
          const cleanedProviders = oldProviders.filter(
            (p: IProvider) => !DEPRECATED_PLATFORMS.includes(p.platform)
          );
          const removedCount = oldProviders.length - cleanedProviders.length;
          if (removedCount > 0) {
            console.log(`[APIConfig] v6->v7: Removed ${removedCount} deprecated providers`);
          }
          
          // Clean featureBindings referencing deprecated providers
          const oldBindings = state?.featureBindings || {};
          const cleanedBindings: FeatureBindings = { ...defaultBindings };
          for (const [key, value] of Object.entries(oldBindings)) {
            const feature = key as AIFeature;
            if (Array.isArray(value)) {
              const filtered = value.filter(
                (b: string) => !DEPRECATED_PLATFORMS.some((dp) => b.startsWith(dp + ':'))
              );
              cleanedBindings[feature] = filtered.length > 0 ? filtered : null;
            } else {
              cleanedBindings[feature] = null;
            }
          }
          
          return {
            ...state,
            providers: cleanedProviders,
            featureBindings: cleanedBindings,
            imageHostProviders: resolveImageHostProviders(),
          };
        }
        
        // v5 -> v6: Convert featureBindings from string to string[] (multi-select)
        if (version === 5 || version === 4) {
          const oldBindings = state?.featureBindings || {};
          const newBindings: FeatureBindings = { ...defaultBindings };
          
          for (const [key, value] of Object.entries(oldBindings)) {
            const feature = key as AIFeature;
            if (typeof value === 'string' && value) {
              // 将单选字符串转为数组
              newBindings[feature] = [value];
              console.log(`[APIConfig] Migrated ${feature}: "${value}" -> ["${value}"]`);
            } else if (Array.isArray(value)) {
              // 已经是数组，保持不变
              newBindings[feature] = value;
            } else {
              newBindings[feature] = null;
            }
          }
          
          console.log(`[APIConfig] v5->v6: Migrated featureBindings to multi-select format`);
          
          return {
            ...state,
            featureBindings: newBindings,
            imageHostProviders: resolveImageHostProviders(),
          };
        }
        
        // Ensure featureBindings exists (for any version)
        if (!state?.featureBindings) {
          return {
            ...state,
            featureBindings: defaultBindings,
            imageHostProviders: resolveImageHostProviders(),
          };
        }
        
        // Ensure all feature keys exist and migrate string -> string[]
        const mergedBindings: FeatureBindings = { ...defaultBindings };
        for (const [key, value] of Object.entries(state.featureBindings)) {
          const feature = key as AIFeature;
          if (typeof value === 'string' && value) {
            mergedBindings[feature] = [value];
          } else if (Array.isArray(value)) {
            mergedBindings[feature] = value;
          } else {
            mergedBindings[feature] = null;
          }
        }
        
        return {
          ...state,
          featureBindings: mergedBindings,
          imageHostProviders: resolveImageHostProviders(),
        };
      },
      partialize: (state) => ({
        // Persist these fields
        providers: state.providers,
        featureBindings: state.featureBindings,
        apiKeys: state.apiKeys, // Keep for backward compat
        concurrency: state.concurrency,
        aspectRatio: state.aspectRatio,
        orientation: state.orientation,
        advancedOptions: state.advancedOptions,
        imageHostProviders: state.imageHostProviders,
        modelEndpointTypes: state.modelEndpointTypes,
        modelTypes: state.modelTypes,
        modelTags: state.modelTags,
      }),
    }
  )
);

// ==================== Selectors ====================

/**
 * Check if all required APIs for video generation are configured
 */
export const useIsVideoGenerationReady = (): boolean => {
  return useAPIConfigStore((state) => {
    const status = state.checkVideoGenerationKeys();
    return status.isAllConfigured;
  });
};

/**
 * Get the current concurrency setting
 */
export const useConcurrency = (): number => {
  return useAPIConfigStore((state) => state.concurrency);
};
