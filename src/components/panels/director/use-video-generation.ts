// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
import { getFeatureConfig } from "@/lib/ai/feature-router";
import { saveVideoToLocal } from "@/lib/image-storage";
import { normalizeUrl } from "./use-image-generation";
import { useAPIConfigStore } from "@/stores/api-config-store";

// ==================== Content Moderation ====================

/**
 * Keywords indicating content moderation errors
 * Based on ScriptAgent's CONTENT_MODERATION_KEYWORDS
 */
const CONTENT_MODERATION_KEYWORDS = [
  'moderation',
  'authentication',
  'content_sensitive',
  'violation',
  'sensitive',
  'policy',
  'refused',
  'rejected',
  'inappropriate',
  'blocked',
  'review',
  'prohibited',
  'not_allowed',
  'unsafe',
  '内容审核',
  '违规',
  '敏感',
  '禁止',
  '拒绝',
  '不合规',
] as const;

/**
 * Check if an error is related to content moderation
 * @param error - Error message or error object
 * @returns true if it's a moderation error
 */
export function isContentModerationError(error: string | Error | unknown): boolean {
  const errorStr = error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase();

  return CONTENT_MODERATION_KEYWORDS.some(keyword => 
    errorStr.includes(keyword.toLowerCase())
  );
}

// Get API configuration for video generation
export function getVideoApiConfig() {
  const featureConfig = getFeatureConfig('video_generation');
  if (!featureConfig) {
    return null;
  }
  
  const keyManager = featureConfig.keyManager;
  const apiKey = keyManager.getCurrentKey() || '';
  const platform = featureConfig.platform;
  const model = featureConfig.models?.[0];
  if (!model) {
    return null;
  }
  const videoBaseUrl = featureConfig.baseUrl?.replace(/\/+$/, '');
  if (!videoBaseUrl) {
    return null;
  }
  
  return {
    apiKey,
    keyManager,
    platform,
    model,
    videoBaseUrl,
  };
}

// Convert local/base64 image to HTTP URL for API
export async function convertToHttpUrl(rawUrl: unknown): Promise<string> {
  const url = typeof rawUrl === 'string' ? rawUrl : (Array.isArray(rawUrl) ? rawUrl[0] : '');
  if (!url) {
    console.warn('[VideoGen] convertToHttpUrl received invalid url:', rawUrl);
    return '';
  }
  
  // Already HTTP URL - use directly
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  
  // For base64/local data URLs, upload to image host
  const { uploadToImageHost, isImageHostConfigured } = await import('@/lib/image-host');
  if (!isImageHostConfigured()) {
    throw new Error('图床未配置，请在设置中配置图床 API Key');
  }

  let imageData = url;
  if (url.startsWith('local-image://')) {
    const { readImageAsBase64 } = await import('@/lib/image-storage');
    const base64 = await readImageAsBase64(url);
    if (!base64) throw new Error(`无法读取本地文件: ${url.substring(0, 40)}`);
    imageData = base64;
  }

  const result = await uploadToImageHost(imageData, {
    name: `media_ref_${Date.now()}`,
    expiration: 15552000,
  });
  if (!result.success || !result.url) {
    throw new Error(result.error || '图床上传失败');
  }
  return result.url;
}

// Build image_with_roles array for video generation
export async function buildImageWithRoles(
  firstFrameUrl: string | undefined,
  lastFrameUrl: string | undefined
): Promise<Array<{ url: string; role: 'first_frame' | 'last_frame' }>> {
  const imageWithRoles: Array<{ url: string; role: 'first_frame' | 'last_frame' }> = [];

  if (firstFrameUrl) {
    const normalizedFirstFrame = normalizeUrl(firstFrameUrl) || '';
    const firstFrameConverted = await convertToHttpUrl(normalizedFirstFrame);
    if (firstFrameConverted) {
      imageWithRoles.push({ url: firstFrameConverted, role: 'first_frame' });
    }
  }

  if (lastFrameUrl) {
    const lastFrameConverted = await convertToHttpUrl(lastFrameUrl);
    if (lastFrameConverted) {
      imageWithRoles.push({ url: lastFrameConverted, role: 'last_frame' });
    }
  }

  return imageWithRoles;
}

// ==================== 模型路由检测 ====================

/**
 * MemeFast supported_endpoint_types → 内部视频路由格式
 * 基于 /api/pricing_new 返回的元数据，而非模型名猜测
 */
const VIDEO_FORMAT_MAP: Record<string, 'unified' | 'volc' | 'wan' | 'kling'> = {
  // 统一格式: /v1/video/create + /v1/video/query
  '视频统一格式': 'unified',
  'openAI视频格式': 'unified',
  'openAI官方视频格式': 'unified',
  'grok视频': 'unified',
  'openai-response': 'unified',
  // Volcengine 豆包/Seedance: /volc/v1/contents/generations/tasks
  '豆包视频异步': 'volc',
  // 阿里百炼 wan: /ali/bailian/...
  '异步': 'wan',
  // 可灵 Kling: /kling/v1/videos/...
  '文生视频': 'kling',
  '图生视频': 'kling',
  // 以下格式暂无专用 handler，fallback 到 unified（未来可扩展）
  '海螺视频生成': 'unified',
  'luma视频生成': 'unified',
  'luma视频扩展': 'unified',
  'runway图生视频': 'unified',
  'aigc-video': 'unified',
  'minimax/video-01异步': 'unified',
};

/**
 * 根据模型的 supported_endpoint_types 元数据检测应使用的视频 API 格式
 * 优先使用 MemeFast /api/pricing_new 同步的元数据，fallback 到模型名推断
 */
function detectVideoApiFormat(model: string): 'unified' | 'volc' | 'wan' | 'kling' {
  // 1. 查询 store 中的 endpoint types 元数据
  const endpointTypes = useAPIConfigStore.getState().modelEndpointTypes[model];
  if (endpointTypes && endpointTypes.length > 0) {
    for (const t of endpointTypes) {
      const format = VIDEO_FORMAT_MAP[t];
      if (format) {
        console.log(`[VideoGen] Metadata-driven routing: ${model} → ${format} (endpoint: ${t})`);
        return format;
      }
    }
    // 有元数据但没匹配到已知格式
    console.warn(`[VideoGen] Unknown endpoint types for ${model}:`, endpointTypes, '→ fallback to name-based');
  }

  // 2. Fallback: 按模型名推断
  const m = model.toLowerCase();
  if (m.includes('seedance') || m.startsWith('doubao-seedance')) return 'volc';
  if (m.includes('wan')) return 'wan';
  if (m.includes('kling')) return 'kling';
  return 'unified';
}

// ==================== 通用错误处理 ====================

function handleVideoSubmitError(
  status: number,
  errorText: string,
  keyManager?: { handleError: (status: number) => boolean },
): never {
  if (keyManager?.handleError(status)) {
    console.log('[VideoGen] Rotated to next API key due to error', status);
  }
  let errorMessage = `视频 API 错误: ${status}`;
  try {
    const errorJson = JSON.parse(errorText);
    errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
  } catch { /* ignore */ }
  if (status === 401 || status === 403) throw new Error('API Key 无效或已过期');
  if (status === 429) throw new Error('API 请求过于频繁，请稍后重试');
  throw new Error(errorMessage);
}

// ==================== 视频生成主入口 ====================

// Call video generation API — 根据模型自动路由到正确的 MemeFast API 格式
export async function callVideoGenerationApi(
  apiKey: string,
  prompt: string,
  duration: number,
  aspectRatio: string,
  imageWithRoles: Array<{ url: string; role: 'first_frame' | 'last_frame' }>,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number) => boolean; getAvailableKeyCount: () => number; getTotalKeyCount: () => number },
  platform?: string,
  videoResolution?: '480p' | '720p' | '1080p',
  /** Seedance 2.0: 视频引用 URL 列表 (运镜/动作复刻) */
  videoRefs?: string[],
  /** Seedance 2.0: 音频引用 URL 列表 (节奏/BGM) */
  audioRefs?: string[],
  /** Seedance 2.0: 是否生成音频（默认 true） */
  enableAudio?: boolean,
  /** Seedance 2.0: 是否锁定运镜（默认 false） */
  cameraFixed?: boolean,
): Promise<string> {
  const featureConfig = getFeatureConfig('video_generation');
  const resolvedPlatform = platform || featureConfig?.platform;
  if (!resolvedPlatform) {
    throw new Error('请先在设置中配置视频生成服务映射');
  }
  const model = featureConfig?.models?.[0];
  if (!model) {
    throw new Error('请先在设置中配置视频生成模型');
  }
  const videoBaseUrl = featureConfig?.baseUrl?.replace(/\/+$/, '');
  if (!videoBaseUrl) {
    throw new Error('请先在设置中配置视频生成服务映射');
  }

  // 根据元数据/模型名检测 API 格式并路由
  const format = detectVideoApiFormat(model);
  console.log('[VideoGen] Detected API format:', { model, format, platform: resolvedPlatform });

  switch (format) {
    case 'volc':
      return callVolcVideoApi(apiKey, prompt, videoBaseUrl, model, aspectRatio, imageWithRoles, videoResolution, duration, cameraFixed, onProgress, keyManager, videoRefs, audioRefs);
    case 'wan':
      return callWanVideoApi(apiKey, prompt, videoBaseUrl, model, imageWithRoles, videoResolution, duration, enableAudio, onProgress, keyManager);
    case 'kling':
      return callKlingVideoApi(apiKey, prompt, videoBaseUrl, model, aspectRatio, imageWithRoles, duration, onProgress, keyManager);
    default:
      // 统一格式: grok, veo, sora, luma, runway, 海螺, 即梦等
      return callUnifiedVideoApi(apiKey, prompt, videoBaseUrl, model, aspectRatio, imageWithRoles, videoResolution, onProgress, keyManager);
  }
}

// ==================== 视频统一格式 (grok/veo/seedance/sora/luma/即梦等) ====================
// MemeFast 文档: POST /v1/video/create + GET /v1/video/query?id=...

async function callUnifiedVideoApi(
  apiKey: string,
  prompt: string,
  baseUrl: string,
  model: string,
  aspectRatio: string,
  imageWithRoles: Array<{ url: string; role: 'first_frame' | 'last_frame' }>,
  videoResolution?: string,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number) => boolean },
): Promise<string> {
  // 提取首帧图片 URL
  const images: string[] = [];
  const firstFrame = imageWithRoles.find(img => img.role === 'first_frame');
  if (firstFrame?.url) images.push(firstFrame.url);

  const requestBody: Record<string, unknown> = {
    model,
    prompt,
    aspect_ratio: aspectRatio,
    size: (videoResolution || '720p').toUpperCase(),  // "720P" / "1080P"
    images,
  };

  console.log('[VideoGen] Unified format → POST /v1/video/create', { model, aspect_ratio: aspectRatio, size: requestBody.size });

  const submitResponse = await fetch(`${baseUrl}/v1/video/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    console.error('[VideoGen] Unified video submit error:', submitResponse.status, errorText);
    handleVideoSubmitError(submitResponse.status, errorText, keyManager);
  }

  const submitData = await submitResponse.json();
  console.log('[VideoGen] Unified submit response:', submitData);

  // 统一格式响应: { id, status, status_update_time }
  const taskId = submitData.id?.toString();
  if (!taskId) throw new Error('返回空的任务 ID');

  // 轮询: GET /v1/video/query?id=...
  const pollInterval = 5000;
  const maxAttempts = 180;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    onProgress?.(Math.min(20 + Math.floor((attempt / maxAttempts) * 80), 99));

    const queryUrl = new URL(`${baseUrl}/v1/video/query`);
    queryUrl.searchParams.set('id', taskId);

    const statusResponse = await fetch(queryUrl.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!statusResponse.ok) {
      if (statusResponse.status === 404) throw new Error('任务不存在');
      console.warn('[VideoGen] Unified query failed:', statusResponse.status);
      await new Promise(r => setTimeout(r, pollInterval));
      continue;
    }

    const statusData = await statusResponse.json();
    console.log(`[VideoGen] Unified task ${taskId} status:`, statusData);

    const status = (statusData.status ?? 'unknown').toString().toLowerCase();

    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      // 统一格式: video_url 在顶层
      const videoUrl = normalizeUrl(statusData.video_url) || normalizeUrl(statusData.result_url) || normalizeUrl(statusData.url);
      if (!videoUrl) throw new Error('任务完成但没有视频 URL');
      return videoUrl;
    }

    if (status === 'failed' || status === 'error') {
      const errorMsg = statusData.error || statusData.error_message || '视频生成失败';
      throw new Error(typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg));
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }
  throw new Error('视频生成超时');
}

// ==================== Volcengine 豆包/Seedance 格式 ====================
// MemeFast 文档: POST /volc/v1/contents/generations/tasks + GET /volc/v1/contents/generations/tasks/{taskId}
// 火山方舟文档: https://www.volcengine.com/docs/82379/1520757

async function callVolcVideoApi(
  apiKey: string,
  prompt: string,
  baseUrl: string,
  model: string,
  aspectRatio: string,
  imageWithRoles: Array<{ url: string; role: string }>,
  videoResolution?: string,
  duration?: number,
  cameraFixed?: boolean,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number) => boolean },
  /** Seedance 2.0: 视频引用 URL 列表 */
  videoRefs?: string[],
  /** Seedance 2.0: 音频引用 URL 列表 */
  audioRefs?: string[],
): Promise<string> {
  // 构建 content 数组（Volcengine 格式: text + image_url）
  const content: Array<Record<string, unknown>> = [];

  // 文本内容：prompt + 内联参数（--rs, --rt, --dur, --cf）
  let textContent = prompt;
  const resolution = (videoResolution || '720p').toLowerCase();
  textContent += ` --rs ${resolution}`;
  textContent += ` --rt ${aspectRatio}`;
  if (duration) textContent += ` --dur ${duration}`;
  if (cameraFixed !== undefined) textContent += ` --cf ${cameraFixed}`;

  content.push({ type: 'text', text: textContent });

  // 图片内容（首帧/尾帧）
  for (const img of imageWithRoles) {
    if (img.url) {
      content.push({
        type: 'image_url',
        image_url: { url: img.url },
        role: img.role,
      });
    }
  }

  // Seedance 2.0 多模态：视频引用（延长/编辑/运镜复刻等）
  if (videoRefs && videoRefs.length > 0) {
    for (const vUrl of videoRefs) {
      if (vUrl) {
        content.push({
          type: 'video_url',
          video_url: { url: vUrl },
        });
      }
    }
  }

  // Seedance 2.0 多模态：音频引用（BGM/卡点等）
  if (audioRefs && audioRefs.length > 0) {
    for (const aUrl of audioRefs) {
      if (aUrl) {
        content.push({
          type: 'audio_url',
          audio_url: { url: aUrl },
        });
      }
    }
  }

  const requestBody = { model, content };

  console.log('[VideoGen] Volc format → POST /volc/v1/contents/generations/tasks', {
    model,
    resolution,
    aspectRatio,
    duration,
    imageCount: imageWithRoles.filter(i => i.url).length,
  });

  const submitResponse = await fetch(`${baseUrl}/volc/v1/contents/generations/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    console.error('[VideoGen] Volc video submit error:', submitResponse.status, errorText);
    handleVideoSubmitError(submitResponse.status, errorText, keyManager);
  }

  const submitData = await submitResponse.json();
  console.log('[VideoGen] Volc submit response:', submitData);

  // Volcengine 响应: { id: "cgt-...", status: "submitted" }
  const taskId = submitData.id?.toString();
  if (!taskId) throw new Error('返回空的任务 ID');

  // 轮询: GET /volc/v1/contents/generations/tasks/{taskId}
  const pollInterval = 5000;
  const maxAttempts = 180; // 15分钟

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    onProgress?.(Math.min(20 + Math.floor((attempt / maxAttempts) * 80), 99));

    const statusResponse = await fetch(
      `${baseUrl}/volc/v1/contents/generations/tasks/${taskId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
      },
    );

    if (!statusResponse.ok) {
      if (statusResponse.status === 404) throw new Error('任务不存在');
      console.warn('[VideoGen] Volc query failed:', statusResponse.status);
      await new Promise(r => setTimeout(r, pollInterval));
      continue;
    }

    const statusData = await statusResponse.json();
    console.log(`[VideoGen] Volc task ${taskId} status:`, statusData);

    // Volcengine 状态: queued | running | succeeded | failed | expired | cancelled
    const status = (statusData.status ?? 'unknown').toString().toLowerCase();

    if (status === 'succeeded') {
      // Volcengine 响应: { content: { video_url: "..." } }
      const videoUrl = normalizeUrl(statusData.content?.video_url);
      if (!videoUrl) throw new Error('任务完成但没有视频 URL');
      return videoUrl;
    }

    if (status === 'failed' || status === 'expired' || status === 'cancelled') {
      const errorMsg = statusData.error?.message || statusData.error?.code || '视频生成失败';
      throw new Error(typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg));
    }

    // queued / running → 继续轮询
    await new Promise(r => setTimeout(r, pollInterval));
  }
  throw new Error('视频生成超时');
}

// ==================== 通义万象 wan 格式 ====================
// MemeFast 文档:
//   创建: POST /ali/bailian/api/v1/services/aigc/video-generation/video-synthesis
//   查询: GET  /alibailian/api/v1/tasks/{task_id}

async function callWanVideoApi(
  apiKey: string,
  prompt: string,
  baseUrl: string,
  model: string,
  imageWithRoles: Array<{ url: string; role: string }>,
  resolution?: string,
  duration?: number,
  enableAudio?: boolean,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number) => boolean },
): Promise<string> {
  const firstFrame = imageWithRoles.find(img => img.role === 'first_frame');

  const requestBody: Record<string, unknown> = {
    model,
    input: {
      prompt,
      ...(firstFrame?.url ? { img_url: firstFrame.url } : {}),
    },
    parameters: {
      resolution: (resolution || '480P').toUpperCase(),
      prompt_extend: true,
      ...(duration ? { duration: Math.max(3, Math.min(10, duration)) } : {}),
      audio: enableAudio !== false,
    },
  };

  console.log('[VideoGen] Wan format → POST /ali/bailian/api/v1/services/aigc/video-generation/video-synthesis', { model });

  const submitResponse = await fetch(
    `${baseUrl}/ali/bailian/api/v1/services/aigc/video-generation/video-synthesis`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
  );

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    console.error('[VideoGen] Wan video submit error:', submitResponse.status, errorText);
    handleVideoSubmitError(submitResponse.status, errorText, keyManager);
  }

  const submitData = await submitResponse.json();
  console.log('[VideoGen] Wan submit response:', submitData);

  // 百炼响应: { request_id, output: { task_id, task_status: "PENDING" } }
  const taskId = submitData.output?.task_id;
  if (!taskId) throw new Error('返回空的任务 ID');

  // 轮询: GET /alibailian/api/v1/tasks/{task_id}
  const pollInterval = 5000;
  const maxAttempts = 180;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    onProgress?.(Math.min(20 + Math.floor((attempt / maxAttempts) * 80), 99));

    const statusResponse = await fetch(
      `${baseUrl}/alibailian/api/v1/tasks/${taskId}`,
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      },
    );

    if (!statusResponse.ok) {
      if (statusResponse.status === 404) throw new Error('任务不存在');
      console.warn('[VideoGen] Wan query failed:', statusResponse.status);
      await new Promise(r => setTimeout(r, pollInterval));
      continue;
    }

    const statusData = await statusResponse.json();
    console.log(`[VideoGen] Wan task ${taskId} status:`, statusData);

    // 百炼响应: { output: { task_status: "SUCCEEDED", video_url: "..." } }
    const taskStatus = (statusData.output?.task_status ?? '').toUpperCase();

    if (taskStatus === 'SUCCEEDED') {
      const videoUrl = normalizeUrl(statusData.output?.video_url);
      if (!videoUrl) throw new Error('任务完成但没有视频 URL');
      return videoUrl;
    }

    if (taskStatus === 'FAILED') {
      throw new Error(statusData.output?.message || statusData.output?.error || '视频生成失败');
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }
  throw new Error('视频生成超时');
}

// ==================== Kling 可灵格式 ====================
// MemeFast 文档:
//   文生视频: POST /kling/v1/videos/text2video
//   图生视频: POST /kling/v1/videos/image2video
//   查询:     GET  /kling/v1/videos/generations/{task_id}

async function callKlingVideoApi(
  apiKey: string,
  prompt: string,
  baseUrl: string,
  model: string,
  aspectRatio: string,
  imageWithRoles: Array<{ url: string; role: string }>,
  duration?: number,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number) => boolean },
): Promise<string> {
  const firstFrame = imageWithRoles.find(img => img.role === 'first_frame');
  const isI2V = !!firstFrame?.url;

  const endpoint = isI2V
    ? `${baseUrl}/kling/v1/videos/image2video`
    : `${baseUrl}/kling/v1/videos/text2video`;

  // Kling 用 model_name 而不是 model
  const requestBody: Record<string, unknown> = {
    model_name: model,
    prompt,
    aspect_ratio: aspectRatio,
    duration: duration ? String(Math.min(10, Math.max(5, duration))) : '5',
    mode: 'std',
  };

  if (isI2V) {
    requestBody.image = firstFrame.url;
  }

  console.log('[VideoGen] Kling format →', isI2V ? 'image2video' : 'text2video', { model });

  const submitResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    console.error('[VideoGen] Kling video submit error:', submitResponse.status, errorText);
    handleVideoSubmitError(submitResponse.status, errorText, keyManager);
  }

  const submitData = await submitResponse.json();
  console.log('[VideoGen] Kling submit response:', submitData);

  // Kling 响应: { code, message, data: { task_id, task_status } }
  const taskId = submitData.data?.task_id;
  if (!taskId) throw new Error('返回空的任务 ID');

  // 轮询: GET /kling/v1/videos/generations/{task_id}
  const pollInterval = 5000;
  const maxAttempts = 180;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    onProgress?.(Math.min(20 + Math.floor((attempt / maxAttempts) * 80), 99));

    const statusResponse = await fetch(
      `${baseUrl}/kling/v1/videos/generations/${taskId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
      },
    );

    if (!statusResponse.ok) {
      if (statusResponse.status === 404) throw new Error('任务不存在');
      console.warn('[VideoGen] Kling query failed:', statusResponse.status);
      await new Promise(r => setTimeout(r, pollInterval));
      continue;
    }

    const statusData = await statusResponse.json();
    console.log(`[VideoGen] Kling task ${taskId} status:`, statusData);

    // Kling 响应: { data: { task_status: "succeed", task_result: { videos: [{ url }] } } }
    const taskStatus = (statusData.data?.task_status ?? '').toLowerCase();

    if (taskStatus === 'succeed') {
      const videos = statusData.data?.task_result?.videos;
      const videoUrl = normalizeUrl(videos?.[0]?.url);
      if (!videoUrl) throw new Error('任务完成但没有视频 URL');
      return videoUrl;
    }

    if (taskStatus === 'failed') {
      throw new Error(statusData.data?.task_status_msg || '视频生成失败');
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }
  throw new Error('视频生成超时');
}

// Save video to local and return the local URL
export async function saveVideoLocally(videoUrl: string, sceneId: number): Promise<string> {
  try {
    const filename = `scene_${sceneId + 1}_${Date.now()}.mp4`;
    const localUrl = await saveVideoToLocal(videoUrl, filename);
    console.log('[VideoGen] Video saved locally:', localUrl);
    return localUrl;
  } catch (e) {
    console.warn('[VideoGen] Failed to save video locally, using URL:', e);
    return videoUrl;
  }
}

/**
 * Extract the last frame from a video URL as base64 image
 * Uses video element + canvas for frame extraction
 * @param videoUrl - Video URL (HTTP or local)
 * @param seekOffset - Seconds before end to extract (default 0.1s from end)
 * @returns Base64 data URL of the frame, or null on failure
 */
export async function extractLastFrameFromVideo(
  videoUrl: string,
  seekOffset: number = 0.1
): Promise<string | null> {
  // local-image:// 是 Electron 注册的自定义协议，可以直接使用
  // 不需要转换为 file://
  const resolvedUrl = videoUrl;
  console.log('[VideoGen] Loading video for frame extraction:', resolvedUrl);
  
  return new Promise((resolve) => {
    const video = document.createElement('video');
    // local-image:// 是受信任的协议，不需要 crossOrigin
    if (!resolvedUrl.startsWith('local-image://') && !resolvedUrl.startsWith('file://')) {
      video.crossOrigin = 'anonymous';
    }
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    
    let hasResolved = false;
    let targetTime = -1; // -1 表示还未设置
    let isSeekStarted = false;
    
    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onloadeddata = null;
      video.oncanplaythrough = null;
      video.onseeked = null;
      video.onerror = null;
      video.ontimeupdate = null;
      video.pause();
      video.src = '';
      video.load();
    };
    
    const timeoutId = setTimeout(() => {
      if (!hasResolved) {
        hasResolved = true;
        console.warn('[VideoGen] extractLastFrameFromVideo timeout');
        cleanup();
        resolve(null);
      }
    }, 30000); // 30s timeout
    
    const captureFrame = () => {
      if (hasResolved) return;
      
      // 确保视频尺寸有效
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        console.warn('[VideoGen] Video dimensions not ready, waiting...');
        setTimeout(captureFrame, 100);
        return;
      }
      
      try {
        video.pause();
        
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        
        if (!ctx) {
          console.warn('[VideoGen] Cannot get canvas context');
          hasResolved = true;
          clearTimeout(timeoutId);
          cleanup();
          resolve(null);
          return;
        }
        
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        
        console.log('[VideoGen] Extracted last frame:', {
          width: canvas.width,
          height: canvas.height,
          duration: video.duration,
          currentTime: video.currentTime,
          targetWas: targetTime,
        });
        
        hasResolved = true;
        clearTimeout(timeoutId);
        cleanup();
        resolve(dataUrl);
      } catch (e) {
        console.warn('[VideoGen] Failed to extract frame:', e);
        hasResolved = true;
        clearTimeout(timeoutId);
        cleanup();
        resolve(null);
      }
    };
    
    // 开始 seek 的函数
    const startSeek = () => {
      if (hasResolved || isSeekStarted) return;
      
      const duration = video.duration;
      if (!duration || duration <= 0 || !isFinite(duration)) {
        console.warn('[VideoGen] Invalid video duration:', duration);
        return;
      }
      
      isSeekStarted = true;
      targetTime = Math.max(0.1, duration - seekOffset);
      console.log('[VideoGen] Starting seek, duration:', duration, 'target:', targetTime);
      
      video.currentTime = targetTime;
    };
    
    // 方法：使用 timeupdate 监听播放进度，当接近目标时间时捕获
    video.ontimeupdate = () => {
      if (hasResolved || targetTime < 0) return; // 未开始 seek 时忽略
      
      // 当播放到目标时间附近时捕获帧
      if (video.currentTime >= targetTime - 0.05) {
        console.log('[VideoGen] timeupdate reached target, currentTime:', video.currentTime, 'target:', targetTime);
        captureFrame();
      }
    };
    
    // 当 seek 完成时捕获
    video.onseeked = () => {
      if (hasResolved || targetTime < 0) return;
      console.log('[VideoGen] onseeked fired, currentTime:', video.currentTime, 'target:', targetTime);
      
      // 检查是否真的 seek 到了目标位置
      if (Math.abs(video.currentTime - targetTime) < 0.5) {
        // seek 成功，等待一下再捕获
        setTimeout(captureFrame, 200);
      } else {
        // seek 可能失败，尝试播放到目标位置
        console.log('[VideoGen] Seek may have failed, trying play approach...');
        video.playbackRate = 16; // 快速播放
        video.play().catch(() => {
          // 如果播放失败，直接捕获当前帧
          console.warn('[VideoGen] Play failed, capturing current frame');
          captureFrame();
        });
      }
    };
    
    // 当视频数据加载完成时尝试 seek
    video.onloadeddata = () => {
      if (hasResolved) return;
      console.log('[VideoGen] onloadeddata, readyState:', video.readyState, 'duration:', video.duration);
      startSeek();
    };
    
    // 当可以播放时也尝试 seek（备选）
    video.oncanplaythrough = () => {
      if (hasResolved) return;
      console.log('[VideoGen] oncanplaythrough, readyState:', video.readyState, 'duration:', video.duration);
      startSeek();
    };
    
    video.onerror = (e) => {
      if (!hasResolved) {
        hasResolved = true;
        console.warn('[VideoGen] Video load error:', e);
        clearTimeout(timeoutId);
        cleanup();
        resolve(null);
      }
    };
    
    video.src = resolvedUrl;
    video.load();
  });
}

// ==================== 聚鑫API Grok Video Generation ====================

/**
 * Convert aspect ratio to Grok format
 */
function toGrokAspectRatio(aspectRatio: string): string {
  // Grok supports: 2:3, 3:2, 1:1
  if (aspectRatio === '9:16' || aspectRatio === '3:4') return '2:3';
  if (aspectRatio === '1:1') return '1:1';
  // 16:9, 4:3, 21:9 → 3:2 (closest landscape)
  return '3:2';
}

/**
 * Call JuxinAPI (Grok) video generation API
 * API Documentation: https://juxinapi.apifox.cn/doc-7302525
 * 
 * Create video: POST /v1/video/create
 * Query task: GET /v1/video/query?id={taskId}
 */
export async function callJuxinVideoGenerationApi(
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  imageWithRoles: Array<{ url: string; role: 'first_frame' | 'last_frame' }>,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number) => boolean; getAvailableKeyCount: () => number; getTotalKeyCount: () => number },
  baseUrl?: string,
  model?: string
): Promise<string> {
  const apiBaseUrl = baseUrl?.replace(/\/+$/, '');
  if (!apiBaseUrl) {
    throw new Error('请先在设置中配置视频生成服务映射');
  }
  if (!model) {
    throw new Error('请先在设置中配置视频生成模型');
  }
  console.log('[VideoGen] Using JuxinAPI (Grok) for video generation');
  
  // Extract first frame URL for Grok
  const images: string[] = [];
  const firstFrame = imageWithRoles.find(img => img.role === 'first_frame');
  if (firstFrame?.url) {
    images.push(firstFrame.url);
  }
  
  const requestBody = {
    model,
    prompt,
    aspect_ratio: toGrokAspectRatio(aspectRatio),
    size: '720P', // Currently only 720P is supported
    images,
  };
  
  console.log('[VideoGen] Grok request:', requestBody);

  // Submit video generation request
  const submitResponse = await fetch(`${apiBaseUrl}/v1/video/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    console.error('[VideoGen] Grok video error:', submitResponse.status, errorText);
    
    if (keyManager?.handleError(submitResponse.status)) {
      console.log('[VideoGen] Rotated to next API key due to error', submitResponse.status);
    }
    
    let errorMessage = `Grok API failed: ${submitResponse.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
    } catch {
      // Ignore JSON parse errors
    }
    
    if (submitResponse.status === 401 || submitResponse.status === 403) {
      throw new Error('API Key 无效或已过期');
    }
    if (submitResponse.status === 429) {
      throw new Error('API 请求过于频繁，请稍后重试');
    }
    throw new Error(errorMessage);
  }

  const submitData = await submitResponse.json();
  console.log('[VideoGen] Grok submit response:', submitData);

  // Extract task ID from response
  const taskId = submitData.id;
  if (!taskId) {
    throw new Error('Grok API 返回空的任务 ID');
  }

  console.log('[VideoGen] Grok task ID:', taskId);

  // Poll for completion
  const pollInterval = 5000; // 5 seconds for Grok (longer video generation)
  const maxAttempts = 180; // 15 minutes max
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const progress = Math.min(20 + Math.floor((attempt / maxAttempts) * 80), 99);
    onProgress?.(progress);

    // Query task status
    const queryUrl = new URL(`${apiBaseUrl}/v1/video/query`);
    queryUrl.searchParams.set('id', taskId);

    const statusResponse = await fetch(queryUrl.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!statusResponse.ok) {
      if (statusResponse.status === 404) {
        throw new Error('任务不存在');
      }
      console.warn('[VideoGen] Grok query failed:', statusResponse.status);
      await new Promise(r => setTimeout(r, pollInterval));
      continue;
    }

    const statusData = await statusResponse.json();
    console.log(`[VideoGen] Grok task ${taskId} status:`, statusData);

    const status = (statusData.status ?? 'unknown').toString().toLowerCase();

    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      // Extract video URL
      const videoUrl = statusData.video_url || statusData.result_url || statusData.url;
      
      if (!videoUrl) {
        throw new Error('任务完成但没有视频 URL');
      }
      
      console.log('[VideoGen] Grok video completed:', videoUrl);
      return videoUrl;
    }

    if (status === 'failed' || status === 'error') {
      const errorMsg = statusData.error || statusData.error_message || '视频生成失败';
      throw new Error(typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg));
    }

    // Status is pending/processing, continue polling
    await new Promise(r => setTimeout(r, pollInterval));
  }
  
  throw new Error('视频生成超时');
}
