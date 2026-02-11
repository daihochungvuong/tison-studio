// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * Image Generator Service
 * Unified interface for image generation across different AI providers
 * Uses same API logic as storyboard-service.ts
 */

import { getFeatureConfig, getFeatureNotConfiguredMessage } from '@/lib/ai/feature-router';
import { retryOperation } from '@/lib/utils/retry';
import { resolveImageApiFormat } from '@/lib/api-key-manager';
import { useAPIConfigStore } from '@/stores/api-config-store';

export interface ImageGenerationParams {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  resolution?: '1K' | '2K' | '4K';
  referenceImages?: string[];  // Base64 encoded images
  styleId?: string;
}

export interface ImageGenerationResult {
  imageUrl: string;
  taskId?: string;
}

const buildEndpoint = (baseUrl: string, path: string) => {
  const normalized = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(normalized) ? `${normalized}/${path}` : `${normalized}/v1/${path}`;
};

// Aspect ratio to pixel dimension mapping (doubao-seedream 等模型需要像素尺寸)
const ASPECT_RATIO_DIMS: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '4:3': { width: 1152, height: 864 },
  '3:4': { width: 864, height: 1152 },
  '3:2': { width: 1248, height: 832 },
  '2:3': { width: 832, height: 1248 },
  '21:9': { width: 1512, height: 648 },
};

/**
 * 判断模型是否需要像素尺寸格式 (如 "1024x1024") 而非比例格式 (如 "1:1")
 * doubao-seedream, cogview 等国产模型需要像素尺寸
 */
function needsPixelSize(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes('doubao') || m.includes('seedream') || m.includes('cogview') || false /* zhipu removed */;
}

/**
 * Generate image for character
 */
export async function generateCharacterImage(params: ImageGenerationParams): Promise<ImageGenerationResult> {
  return generateImage(params, 'character_generation');
}

/**
 * Generate image for scene
 */
export async function generateSceneImage(params: ImageGenerationParams): Promise<ImageGenerationResult> {
  return generateImage(params, 'character_generation');
}

/**
 * Core image generation function
 * Uses the provider bound to the feature via service mapping
 */
async function generateImage(
  params: ImageGenerationParams,
  feature: 'character_generation'
): Promise<ImageGenerationResult> {
  const featureConfig = getFeatureConfig(feature);
  if (!featureConfig) {
    throw new Error(getFeatureNotConfiguredMessage(feature));
  }
  const apiKey = featureConfig.apiKey;
  const baseUrl = featureConfig.baseUrl?.replace(/\/+$/, '');
  const model = featureConfig.models?.[0];
  if (!apiKey || !baseUrl || !model) {
    throw new Error(getFeatureNotConfiguredMessage(feature));
  }

  const aspectRatio = params.aspectRatio || '1:1';
  const resolution = params.resolution || '2K';

  // 根据元数据决定图片生成 API 格式
  const endpointTypes = useAPIConfigStore.getState().modelEndpointTypes[model];
  const apiFormat = resolveImageApiFormat(endpointTypes, model);

  console.log('[ImageGenerator] Generating image', {
    model,
    apiFormat,
    endpointTypes,
    aspectRatio,
    resolution,
    promptPreview: params.prompt.substring(0, 100) + '...',
  });

  // Gemini 等模型通过 chat completions 生图
  if (apiFormat === 'openai_chat') {
    return submitViaChatCompletions(
      params.prompt,
      model,
      apiKey,
      baseUrl,
      aspectRatio,
      params.referenceImages,
    );
  }

  // 标准格式: /v1/images/generations (GPT Image, DALL-E, Flux, doubao-seedream 等)
  const result = await submitImageTask(
    params.prompt,
    aspectRatio,
    resolution,
    apiKey,
    params.referenceImages,
    model,
    baseUrl
  );

  if (result.imageUrl) {
    return { imageUrl: result.imageUrl };
  }

  if (result.taskId) {
    const imageUrl = await pollTaskStatus(result.taskId, apiKey, baseUrl);
    return { imageUrl, taskId: result.taskId };
  }

  throw new Error('Invalid API response');
}

/**
 * Generate image via /v1/chat/completions (multimodal)
 * Used for Gemini image models that don't support /v1/images/generations
 */
async function submitViaChatCompletions(
  prompt: string,
  model: string,
  apiKey: string,
  baseUrl: string,
  aspectRatio: string,
  referenceImages?: string[],
): Promise<ImageGenerationResult> {
  const endpoint = buildEndpoint(baseUrl, 'chat/completions');

  // Build messages
  const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: 'text', text: `Generate an image with aspect ratio ${aspectRatio}: ${prompt}` },
  ];
  // Attach reference images if any
  if (referenceImages && referenceImages.length > 0) {
    for (const img of referenceImages) {
      userContent.push({ type: 'image_url', image_url: { url: img } });
    }
  }

  const requestBody = {
    model,
    messages: [{ role: 'user', content: userContent }],
    // Standard multimodal image generation parameters
    max_tokens: 4096,
  };

  console.log('[ImageGenerator] Submitting via chat completions:', { model, endpoint });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[ImageGenerator] Chat completions error:', response.status, errorText);
    let msg = `图片生成 API 错误: ${response.status}`;
    try { const j = JSON.parse(errorText); msg = j.error?.message || msg; } catch {}
    throw new Error(msg);
  }

  const data = await response.json();
  console.log('[ImageGenerator] Chat completions response received');

  // Extract image from response - multiple possible formats
  const choice = data.choices?.[0];
  if (!choice) throw new Error('响应中无有效内容');

  const message = choice.message;

  // Format 1: content is array with image parts (OpenAI multimodal)
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (part.type === 'image_url' && part.image_url?.url) {
        return { imageUrl: part.image_url.url };
      }
      // Base64 inline image
      if (part.type === 'image' && part.image?.url) {
        return { imageUrl: part.image.url };
      }
      // Some APIs return base64 in data field
      if (part.type === 'image' && part.data) {
        return { imageUrl: `data:image/png;base64,${part.data}` };
      }
    }
  }

  // Format 2: content is string with markdown image link
  if (typeof message?.content === 'string') {
    // Try to extract image URL from markdown: ![...](url)
    const mdMatch = message.content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
    if (mdMatch) return { imageUrl: mdMatch[1] };
    // Try to extract base64 data URI
    const b64Match = message.content.match(/(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/);
    if (b64Match) return { imageUrl: b64Match[1] };
  }

  throw new Error('未能从响应中提取图片 URL');
}

/**
 * Submit image generation task via OpenAI-compatible images/generations API
 */
async function submitImageTask(
  prompt: string,
  aspectRatio: string,
  resolution: string,
  apiKey: string,
  referenceImages?: string[],
  model?: string,
  baseUrl?: string
): Promise<{ taskId?: string; imageUrl?: string }> {
  if (!baseUrl) {
    throw new Error('请先在设置中配置图片生成服务映射');
  }
  // 根据模型决定 size 格式
  let sizeValue: string = aspectRatio;
  if (model && needsPixelSize(model)) {
    const dims = ASPECT_RATIO_DIMS[aspectRatio];
    if (dims) {
      sizeValue = `${dims.width}x${dims.height}`;
    }
  }

  const requestData: Record<string, unknown> = {
    model: model,
    prompt,
    n: 1,
    size: sizeValue,
  };

  if (referenceImages && referenceImages.length > 0) {
    console.log('[ImageGenerator] Adding reference images:', referenceImages.length);
    requestData.image_urls = referenceImages;
  }

  console.log('[ImageGenerator] Submitting image task:', {
    model: requestData.model,
    size: requestData.size,
    resolution: requestData.resolution,
    hasImageUrls: !!requestData.image_urls,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const data = await retryOperation(async () => {
      const endpoint = buildEndpoint(baseUrl, 'images/generations');
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestData),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[ImageGenerator] API error:', response.status, errorText);

        let errorMessage = `图片生成 API 错误: ${response.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.message || errorJson.msg || errorMessage;
        } catch {
          if (errorText && errorText.length < 200) errorMessage = errorText;
        }

        if (response.status === 401 || response.status === 403) {
          throw new Error('API Key 无效或已过期');
        } else if (response.status >= 500) {
          throw new Error('图片生成服务暂时不可用');
        }

        const error = new Error(errorMessage) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }

      return response.json();
    }, {
      maxRetries: 3,
      baseDelay: 3000,
      retryOn429: true,
    });

    clearTimeout(timeoutId);
    console.log('[ImageGenerator] API response:', data);

    // GPT Image 返回 choices 格式（MemeFast 文档确认）
    if (data.choices?.[0]?.message?.content) {
      const content = data.choices[0].message.content;
      // 可能是 markdown 图片链接
      const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
      if (mdMatch) return { imageUrl: mdMatch[1] };
      // 可能是 base64
      const b64Match = content.match(/(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/);
      if (b64Match) return { imageUrl: b64Match[1] };
      // 可能直接是 URL
      const urlMatch = content.match(/(https?:\/\/[^\s"']+\.(?:png|jpg|jpeg|webp|gif)[^\s"']*)/i);
      if (urlMatch) return { imageUrl: urlMatch[1] };
    }

    // 标准格式: { data: [{ url }] }
    let taskId: string | undefined;
    const dataList = data.data;
    if (Array.isArray(dataList) && dataList.length > 0) {
      // 直接返回 URL（doubao-seedream、DALL-E 等同步模型）
      if (dataList[0].url) return { imageUrl: dataList[0].url };
      taskId = dataList[0].task_id?.toString();
    }
    taskId = taskId || data.task_id?.toString();

    if (!taskId) {
      const directUrl = data.data?.[0]?.url || data.url;
      if (directUrl) return { imageUrl: directUrl };
      throw new Error('No task_id or image URL in response');
    }

    return { taskId };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error) {
      if (error.name === 'AbortError') throw new Error('API 请求超时');
      throw error;
    }
    throw new Error('调用图片生成 API 时发生未知错误');
  }
}

/**
 * Poll task status until completion
 */
async function pollTaskStatus(
  taskId: string,
  apiKey: string,
  baseUrl: string,
  onProgress?: (progress: number) => void
): Promise<string> {
  const maxAttempts = 120;
  const pollInterval = 2000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const progress = Math.min(Math.floor((attempt / maxAttempts) * 100), 99);
    onProgress?.(progress);

    try {
      const url = new URL(buildEndpoint(baseUrl, `tasks/${taskId}`));
      url.searchParams.set('_ts', Date.now().toString());

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        if (response.status === 404) throw new Error('Task not found');
        throw new Error(`Failed to check task status: ${response.status}`);
      }

      const data = await response.json();
      console.log(`[ImageGenerator] Task ${taskId} status:`, data);

      const status = (data.status ?? data.data?.status ?? 'unknown').toString().toLowerCase();
      const statusMap: Record<string, string> = {
        'pending': 'pending', 'submitted': 'pending', 'queued': 'pending',
        'processing': 'processing', 'running': 'processing', 'in_progress': 'processing',
        'completed': 'completed', 'succeeded': 'completed', 'success': 'completed',
        'failed': 'failed', 'error': 'failed',
      };
      const mappedStatus = statusMap[status] || 'processing';

      if (mappedStatus === 'completed') {
        onProgress?.(100);
        const images = data.result?.images ?? data.data?.result?.images;
        let resultUrl: string | undefined;
        if (images?.[0]) {
          const urlField = images[0].url;
          resultUrl = Array.isArray(urlField) ? urlField[0] : urlField;
        }
        resultUrl = resultUrl || data.output_url || data.result_url || data.url;
        if (!resultUrl) throw new Error('Task completed but no URL in result');
        return resultUrl;
      }

      if (mappedStatus === 'failed') {
        const rawError = data.error || data.error_message || data.data?.error;
        throw new Error(rawError ? String(rawError) : 'Task failed');
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch (error) {
      if (error instanceof Error && 
          (error.message.includes('Task failed') || error.message.includes('no URL') || error.message.includes('Task not found'))) {
        throw error;
      }
      console.error(`[ImageGenerator] Poll attempt ${attempt} failed:`, error);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  throw new Error('图片生成超时');
}

/**
 * Submit a grid/quad image generation request with smart API routing.
 * Handles both chat completions (Gemini) and images/generations (standard) endpoints.
 * Used by merged generation (九宫格) and quad grid (四宫格) in director and sclass panels.
 */
export async function submitGridImageRequest(params: {
  model: string;
  prompt: string;
  apiKey: string;
  baseUrl: string;
  aspectRatio: string;
  resolution?: string;
  referenceImages?: string[];
}): Promise<{ imageUrl?: string; taskId?: string }> {
  const { model, prompt, apiKey, baseUrl, aspectRatio, resolution, referenceImages } = params;
  const normalizedBase = baseUrl.replace(/\/+$/, '');

  // 检测 API 格式（与 generateImage 一致）
  const endpointTypes = useAPIConfigStore.getState().modelEndpointTypes[model];
  const apiFormat = resolveImageApiFormat(endpointTypes, model);
  console.log('[GridImageAPI] format:', apiFormat, 'model:', model);

  if (apiFormat === 'openai_chat') {
    // Gemini 等模型通过 chat completions 生图
    const result = await submitViaChatCompletions(prompt, model, apiKey, normalizedBase, aspectRatio, referenceImages);
    return { imageUrl: result.imageUrl };
  }

  // 标准 images/generations 端点
  const endpoint = buildEndpoint(normalizedBase, 'images/generations');
  const requestBody: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
    aspect_ratio: aspectRatio,
  };
  if (resolution) {
    requestBody.resolution = resolution;
  }
  if (referenceImages && referenceImages.length > 0) {
    requestBody.image_urls = referenceImages;
  }

  console.log('[GridImageAPI] Submitting to', endpoint);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 失败: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  console.log('[GridImageAPI] Response received');

  // GPT Image 可能通过 images/generations 返回 choices 格式
  if (data.choices?.[0]?.message?.content) {
    const content = data.choices[0].message.content;
    const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
    if (mdMatch) return { imageUrl: mdMatch[1] };
    const b64Match = content.match(/(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/);
    if (b64Match) return { imageUrl: b64Match[1] };
    const urlMatch = content.match(/(https?:\/\/[^\s"']+\.(?:png|jpg|jpeg|webp|gif)[^\s"']*)/i);
    if (urlMatch) return { imageUrl: urlMatch[1] };
  }

  // 标准格式: { data: [{ url, task_id }] }
  const normalizeUrl = (url: any): string | undefined => {
    if (!url) return undefined;
    if (Array.isArray(url)) return url[0] || undefined;
    if (typeof url === 'string') return url;
    return undefined;
  };

  const dataField = data.data;
  const firstItem = Array.isArray(dataField) ? dataField[0] : dataField;

  const imageUrl = normalizeUrl(firstItem?.url)
    || normalizeUrl(firstItem?.image_url)
    || normalizeUrl(firstItem?.output_url)
    || normalizeUrl(data.url)
    || normalizeUrl(data.image_url)
    || normalizeUrl(data.output_url);

  const taskId = firstItem?.task_id?.toString()
    || firstItem?.id?.toString()
    || data.task_id?.toString()
    || data.id?.toString();

  return { imageUrl, taskId };
}

/**
 * Convert image URL to persistent format
 * In Electron: saves to local file system and returns local-image:// path
 * In browser: converts to base64
 */
export async function imageUrlToBase64(url: string): Promise<string> {
  // If already a local or base64 path, return as-is
  if (url.startsWith('data:image/') || url.startsWith('local-image://')) {
    return url;
  }
  
  // Try to use Electron local storage first
  if (typeof window !== 'undefined' && window.imageStorage) {
    try {
      const filename = `image_${Date.now()}.png`;
      const result = await window.imageStorage.saveImage(url, 'shots', filename);
      if (result.success && result.localPath) {
        console.log('[ImageGenerator] Saved image locally:', result.localPath);
        return result.localPath;
      }
    } catch (error) {
      console.warn('[ImageGenerator] Local save failed, falling back to base64:', error);
    }
  }
  
  // Fallback to base64 for non-Electron environments
  const convertBlobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };
  
  // Try direct fetch first
  try {
    const response = await fetch(url, { mode: 'cors' });
    if (response.ok) {
      const blob = await response.blob();
      return await convertBlobToBase64(blob);
    }
  } catch (error) {
    console.warn('[ImageGenerator] Direct fetch failed, trying proxy:', error);
  }
  
  // Fallback: use our API proxy to fetch the image
  try {
    const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(url)}`;
    const response = await fetch(proxyUrl);
    if (!response.ok) {
      throw new Error(`Proxy fetch failed: ${response.status}`);
    }
    const blob = await response.blob();
    return await convertBlobToBase64(blob);
  } catch (error) {
    console.warn('[ImageGenerator] Proxy fetch also failed:', error);
    throw error;
  }
}
