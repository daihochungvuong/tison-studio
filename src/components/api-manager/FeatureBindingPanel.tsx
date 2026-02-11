// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
"use client";

/**
 * Feature Binding Panel (Multi-Select Mode)
 * 品牌分类模型选择 — 仿 MemeFast pricing 页面
 * 一级：品牌 pill（带 SVG logo + 模型数）
 * 二级：模型列表（checkbox 多选）
 */

import { useMemo, useState } from "react";
import { useAPIConfigStore, type AIFeature } from "@/stores/api-config-store";
import { parseApiKeys, classifyModelByName, type ModelCapability } from "@/lib/api-key-manager";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FileText,
  Image,
  Video,
  ScanEye,
  Link2,
  Check,
  X,
  AlertCircle,
  ChevronUp,
  ChevronDown,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { extractBrandFromModel, getBrandInfo } from "@/lib/brand-mapping";
import { getBrandIcon } from "./brand-icons";

/**
 * 供应商选项 - 每个功能可选的平台 + 模型
 */
interface ProviderOption {
  platform: string;
  name: string;
  model: string;
}

interface ProviderGroup {
  platform: string;
  name: string;
  options: ProviderOption[];
}

interface FeatureMeta {
  key: AIFeature;
  name: string;
  description: string;
  icon: ReactNode;
  requiredCapability?: ModelCapability;
  /** 推荐模型提示（蓝色高亮） */
  recommendation?: string;
}

const FEATURE_CONFIGS: FeatureMeta[] = [
  {
    key: "script_analysis",
    name: "剧本分析 / 对话",
    description: "将故事文本分解为结构化剧本",
    icon: <FileText className="h-4 w-4" />,
    requiredCapability: "text",
  },
  {
    key: "character_generation",
    name: "图片生成",
    description: "生成角色和场景参考图",
    icon: <Image className="h-4 w-4" />,
    requiredCapability: "image_generation",
    recommendation: "💎 推荐使用 gemini-3-pro-image-preview（Nano Banana）— 画质优秀、一致性好",
  },
  {
    key: "video_generation",
    name: "视频生成",
    description: "将图片转换为视频",
    icon: <Video className="h-4 w-4" />,
    requiredCapability: "video_generation",
    recommendation: "🧪 测试推荐 doubao-seedream-4-5-251128 — 适合快速验证流程",
  },
  {
    key: "image_understanding",
    name: "图片理解",
    description: "分析图片内容生成描述",
    icon: <ScanEye className="h-4 w-4" />,
    requiredCapability: "vision",
  },
];

function getOptionKey(option: ProviderOption): string {
  return `${option.platform}:${option.model}`;
}

function parseOptionKey(key: string): { platform: string; model: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  const platform = key.slice(0, idx);
  const model = key.slice(idx + 1);
  if (!platform || !model) return null;
  return { platform, model };
}

const DEFAULT_PLATFORM_CAPABILITIES: Record<string, ModelCapability[]> = {
  memefast: ["text", "vision", "image_generation", "video_generation"],
  // RunningHub is used for specialized tools; do not expose it as a default vision/chat provider.
  runninghub: ["image_generation"],
};

/**
 * 模型级别能力映射
 * 精确控制每个模型在服务映射中的可选范围
 * 未列出的模型将 fallback 到平台级别能力
 */
const MODEL_CAPABILITIES: Record<string, ModelCapability[]> = {
  // ---- 对话/文本模型 ----
  'glm-4.7': ['text', 'function_calling'],
  'glm-4.6v': ['text', 'vision'],
  'deepseek-v3': ['text'],
  'deepseek-v3.2': ['text'],
  'deepseek-r1': ['text', 'reasoning'],
  'kimi-k2': ['text'],
  'MiniMax-M2.1': ['text'],
  'qwen3-max': ['text'],
  'qwen3-max-preview': ['text'],
  'gemini-2.0-flash': ['text'],
  'gemini-3-flash-preview': ['text'],
  'gemini-3-pro-preview': ['text'],
  'claude-haiku-4-5-20251001': ['text', 'vision'],

  // ---- 图片生成模型 ----
  'cogview-3-plus': ['image_generation'],
  'gemini-imagen': ['image_generation'],
  'gemini-3-pro-image-preview': ['image_generation'],
  'gpt-image-1.5': ['image_generation'],

  // ---- 视频生成模型 ----
  'cogvideox': ['video_generation'],
  'gemini-veo': ['video_generation'],
  'doubao-seedance-1-5-pro': ['video_generation'],
  'doubao-seedance-1-5-pro-251215': ['video_generation'],
  'doubao-seedream-4-5-251128': ['video_generation'],
  'veo3.1': ['video_generation'],
  'sora-2-all': ['video_generation'],
  'wan2.6-i2v': ['video_generation'],
  'grok-video-3': ['video_generation'],
  'grok-video-3-10s': ['video_generation'],

  // ---- 图片理解/视觉模型 ----
  'doubao-vision': ['vision'],

  // ---- RunningHub 特殊模型 ----
  '2009613632530812930': ['image_generation'],
};

function providerSupportsCapability(
  provider: { platform: string; capabilities?: ModelCapability[] },
  required?: ModelCapability
): boolean {
  if (!required) return true;

  const explicitCaps = provider.capabilities && provider.capabilities.length > 0
    ? provider.capabilities
    : undefined;

  const caps = explicitCaps || DEFAULT_PLATFORM_CAPABILITIES[provider.platform];

  // If we still don't know, treat as "unknown" and allow selection.
  if (!caps || caps.length === 0) return true;

  return caps.includes(required);
}

/**
 * 检查特定模型是否支持所需能力
 * 优先级：硬编码映射 → 平台元数据(model_type/tags) → 模型名称推断 → 平台级别 fallback
 */
function modelSupportsCapability(
  modelName: string,
  provider: { platform: string; capabilities?: ModelCapability[] },
  required?: ModelCapability,
  modelType?: string,     // "文本" | "图像" | "音视频" | "检索"
  modelTagsList?: string[] // ["对话","识图","工具"]
): boolean {
  if (!required) return true;

  // 1. 硬编码映射（精确控制少量预设模型）
  const modelCaps = MODEL_CAPABILITIES[modelName];
  if (modelCaps) {
    return modelCaps.includes(required);
  }

  // 2. 平台元数据（来自 /api/pricing_new 的 model_type + tags）
  if (modelType) {
    switch (required) {
      case 'text':
        return modelType === '文本';
      case 'image_generation':
        return modelType === '图像';
      case 'video_generation':
        // 音视频类中只筛选带“视频”标签的（排除纯音频/TTS/音乐）
        return modelType === '音视频' && (modelTagsList?.some(t => t.includes('视频')) ?? false);
      case 'vision':
        // 识图能力跨 model_type，只看 tags 是否含“识图”或“多模态”
        return modelTagsList?.some(t => t.includes('识图') || t.includes('多模态')) ?? false;
      case 'embedding':
        return modelType === '检索';
      default:
        break;
    }
  }

  // 3. 模型名称模式推断（非 MemeFast 的其他供应商）
  const inferred = classifyModelByName(modelName);
  if (inferred.length > 0) {
    return inferred.includes(required);
  }

  // 4. 平台级别 fallback
  return providerSupportsCapability(provider, required);
}

export function FeatureBindingPanel() {
  const {
    providers,
    featureBindings,
    modelTypes,
    modelTags,
    toggleFeatureBinding,
    getFeatureBindings,
  } = useAPIConfigStore();
  
  // 跟踪展开/折叠状态
  const [expandedFeatures, setExpandedFeatures] = useState<Set<AIFeature>>(new Set());

  const configuredPlatforms = useMemo(() => {
    const set = new Set<string>();
    for (const p of providers) {
      if (parseApiKeys(p.apiKey).length > 0) {
        set.add(p.platform);
      }
    }
    return set;
  }, [providers]);

  const isProviderConfigured = (platform: string): boolean => {
    return configuredPlatforms.has(platform);
  };

  const optionsByFeature = useMemo(() => {
    const map: Partial<Record<AIFeature, ProviderOption[]>> = {};

    for (const feature of FEATURE_CONFIGS) {
      const opts: ProviderOption[] = [];

      for (const provider of providers) {
        const models = (provider.model || [])
          .map((m) => m.trim())
          .filter((m) => m.length > 0);

        for (const model of models) {
          // 使用平台元数据 (model_type/tags) 进行精确分类
          const mType = modelTypes[model];
          const mTags = modelTags[model];
          if (!modelSupportsCapability(model, provider, feature.requiredCapability, mType, mTags)) continue;
          opts.push({
            platform: provider.platform,
            name: provider.name,
            model,
          });
        }
      }

      // Prefer configured providers first for better UX.
      opts.sort((a, b) => {
        const aConfigured = configuredPlatforms.has(a.platform);
        const bConfigured = configuredPlatforms.has(b.platform);
        if (aConfigured !== bConfigured) return aConfigured ? -1 : 1;
        if (a.name !== b.name) return a.name.localeCompare(b.name);
        return a.model.localeCompare(b.model);
      });

      map[feature.key] = opts;
    }

    return map;
  }, [providers, configuredPlatforms]);

  // 计算已配置的功能数（至少有一个有效绑定）
  const configuredCount = useMemo(() => {
    return FEATURE_CONFIGS.filter((feature) => {
      const bindings = getFeatureBindings(feature.key);
      if (bindings.length === 0) return false;
      
      // 检查是否至少有一个有效的绑定
      const options = optionsByFeature[feature.key] || [];
      return bindings.some(binding => {
        const parsed = parseOptionKey(binding);
        if (!parsed) return false;
        const bindingKey = `${parsed.platform}:${parsed.model}`;
        const existsInOptions = options.some((o) => getOptionKey(o) === bindingKey);
        return existsInOptions && configuredPlatforms.has(parsed.platform);
      });
    }).length;
  }, [featureBindings, optionsByFeature, configuredPlatforms, getFeatureBindings]);

  // 切换单个模型的选中状态
  const handleToggleBinding = (feature: FeatureMeta, optionKey: string) => {
    const parsed = parseOptionKey(optionKey);
    if (!parsed) return;
    toggleFeatureBinding(feature.key, optionKey);
  };
  
  // 切换展开/折叠
  const toggleExpanded = (feature: AIFeature) => {
    setExpandedFeatures(prev => {
      const newSet = new Set(prev);
      if (newSet.has(feature)) {
        newSet.delete(feature);
      } else {
        newSet.add(feature);
      }
      return newSet;
    });
  };

  // 按品牌分组（品牌分类 UI）
  const brandGroupsByFeature = useMemo(() => {
    const result: Partial<Record<AIFeature, Array<{ brandId: string; options: ProviderOption[] }>>> = {};

    for (const feature of FEATURE_CONFIGS) {
      const opts = optionsByFeature[feature.key] || [];
      const brandMap = new Map<string, ProviderOption[]>();

      for (const opt of opts) {
        const brandId = extractBrandFromModel(opt.model);
        if (!brandMap.has(brandId)) brandMap.set(brandId, []);
        brandMap.get(brandId)!.push(opt);
      }

      // 排序：模型数多的品牌在前
      const sorted = [...brandMap.entries()]
        .map(([brandId, options]) => ({ brandId, options }))
        .sort((a, b) => b.options.length - a.options.length);

      result[feature.key] = sorted;
    }

    return result;
  }, [optionsByFeature]);

  // 每个 feature 选中的品牌过滤器
  const [selectedBrand, setSelectedBrand] = useState<Record<string, string | null>>({});
  // 每个 feature 的搜索关键词
  const [searchQuery, setSearchQuery] = useState<Record<string, string>>({});

  return (
    <div className="p-6 border border-border rounded-xl bg-card space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-foreground flex items-center gap-2">
          <Link2 className="h-4 w-4" />
          服务映射
        </h3>
        <span className="text-xs text-muted-foreground">
          已配置: {configuredCount}/{FEATURE_CONFIGS.length}
        </span>
      </div>

      {/* Service Mapping Table - Multi-Select */}
      <div className="grid gap-3">
        {FEATURE_CONFIGS.map((feature) => {
          const options = optionsByFeature[feature.key] || [];
          const currentBindings = getFeatureBindings(feature.key);
          const isExpanded = expandedFeatures.has(feature.key);
          
          // 检查是否至少有一个有效的绑定
          const validBindings = currentBindings.filter(binding => {
            const parsed = parseOptionKey(binding);
            if (!parsed) return false;
            const bindingKey = `${parsed.platform}:${parsed.model}`;
            const existsInOptions = options.some((o) => getOptionKey(o) === bindingKey);
            return existsInOptions && isProviderConfigured(parsed.platform);
          });
          const configured = validBindings.length > 0;

          return (
            <div
              key={feature.key}
              className={cn(
                "rounded-lg border transition-all",
                configured
                  ? "bg-primary/5 border-primary/30"
                  : "bg-destructive/5 border-destructive/30"
              )}
            >
              {/* Header - Click to expand */}
              <div 
                className="flex items-center gap-4 p-4 cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => toggleExpanded(feature.key)}
              >
                {/* Service Info */}
                <div className="flex items-center gap-3 flex-1">
                  <div
                    className={cn(
                      "p-2 rounded-lg",
                      configured
                        ? "bg-primary/10 text-primary"
                        : "bg-destructive/10 text-destructive"
                    )}
                  >
                    {feature.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Label className="font-medium text-foreground cursor-pointer">
                        {feature.name}
                      </Label>
                      {configured ? (
                        <Check className="h-3 w-3 text-primary shrink-0" />
                      ) : (
                        <X className="h-3 w-3 text-destructive shrink-0" />
                      )}
                      {validBindings.length > 0 && (
                        <span className="text-xs bg-primary/20 text-primary px-1.5 py-0.5 rounded">
                          {validBindings.length} 个模型
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {feature.description}
                    </p>
                  </div>
                </div>

                {/* Expand/Collapse Icon */}
                <div className="shrink-0">
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </div>
              
              {/* Expanded: Brand-categorized model selection */}
              {isExpanded && (
                <div className="px-4 pb-4 pt-0 border-t border-border/50">
                  {options.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2">
                      暂无可选模型（请先在 API 服务商里配置模型列表）
                    </p>
                  ) : (
                    <div className="space-y-3 pt-3">
                      <p className="text-xs text-muted-foreground">
                        可多选，请求将按轮询分配到各模型（间隔 3 秒）
                      </p>

                      {/* 推荐模型提示 */}
                      {feature.recommendation && (
                        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-blue-500/10 border border-blue-500/30">
                          <span className="text-xs font-medium text-blue-600 dark:text-blue-400 leading-relaxed">
                            {feature.recommendation}
                          </span>
                        </div>
                      )}

                      {/* Search */}
                      <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                        <input
                          type="text"
                          placeholder="搜索模型名称..."
                          value={searchQuery[feature.key] || ''}
                          onChange={(e) => setSearchQuery(prev => ({ ...prev, [feature.key]: e.target.value }))}
                          className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
                        />
                      </div>

                      {/* Brand Pills */}
                      {(() => {
                        const brands = brandGroupsByFeature[feature.key] || [];
                        const activeBrand = selectedBrand[feature.key] || null;
                        const query = (searchQuery[feature.key] || '').toLowerCase();

                        // 过滤后的模型列表
                        const filteredOptions = options.filter(o => {
                          if (query && !o.model.toLowerCase().includes(query)) return false;
                          if (activeBrand && extractBrandFromModel(o.model) !== activeBrand) return false;
                          return true;
                        });

                        return (
                          <>
                            <div className="flex flex-wrap gap-1.5">
                              {/* 全部品牌 */}
                              <button
                                type="button"
                                onClick={() => setSelectedBrand(prev => ({ ...prev, [feature.key]: null }))}
                                className={cn(
                                  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
                                  !activeBrand
                                    ? "bg-primary/10 border-primary/40 text-primary"
                                    : "bg-muted/30 border-border hover:bg-accent/50 text-muted-foreground"
                                )}
                              >
                                全部品牌
                                <span className={cn(
                                  "text-[10px] px-1 py-0.5 rounded-full min-w-[18px] text-center",
                                  !activeBrand ? "bg-primary/20" : "bg-muted"
                                )}>
                                  {options.length}
                                </span>
                              </button>

                              {brands.map(({ brandId, options: brandOpts }) => {
                                const info = getBrandInfo(brandId);
                                const isActive = activeBrand === brandId;
                                return (
                                  <button
                                    key={brandId}
                                    type="button"
                                    onClick={() => setSelectedBrand(prev => ({
                                      ...prev,
                                      [feature.key]: isActive ? null : brandId,
                                    }))}
                                    className={cn(
                                      "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
                                      isActive
                                        ? "bg-primary/10 border-primary/40 text-primary"
                                        : "bg-muted/30 border-border hover:bg-accent/50 text-muted-foreground"
                                    )}
                                  >
                                    <span className="shrink-0">{getBrandIcon(brandId, 14)}</span>
                                    {info.displayName}
                                    <span className={cn(
                                      "text-[10px] px-1 py-0.5 rounded-full min-w-[18px] text-center",
                                      isActive ? "bg-primary/20" : "bg-muted"
                                    )}>
                                      {brandOpts.length}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>

                            {/* Model List */}
                            <div className="space-y-1 max-h-[280px] overflow-y-auto">
                              {filteredOptions.length === 0 ? (
                                <p className="text-xs text-muted-foreground py-2 text-center">
                                  无匹配模型
                                </p>
                              ) : (
                                filteredOptions.map((option) => {
                                  const optionKey = getOptionKey(option);
                                  const optionConfigured = isProviderConfigured(option.platform);
                                  const isSelected = currentBindings.includes(optionKey);
                                  const brandId = extractBrandFromModel(option.model);

                                  return (
                                    <label
                                      key={optionKey}
                                      className={cn(
                                        "flex items-center gap-3 p-2 rounded-md cursor-pointer transition-colors",
                                        isSelected
                                          ? "bg-primary/10 border border-primary/30"
                                          : "hover:bg-accent/50 border border-transparent",
                                        !optionConfigured && "opacity-50"
                                      )}
                                    >
                                      <Checkbox
                                        checked={isSelected}
                                        onCheckedChange={() => handleToggleBinding(feature, optionKey)}
                                        disabled={!optionConfigured}
                                      />
                                      <span className="shrink-0">{getBrandIcon(brandId, 14)}</span>
                                      <span className="text-xs font-mono text-foreground">
                                        {option.model}
                                      </span>
                                      <span className="text-[10px] text-muted-foreground ml-auto">
                                        {option.name}
                                      </span>
                                    </label>
                                  );
                                })
                              )}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Status Summary */}
      {configuredCount < FEATURE_CONFIGS.length && (
        <div className="flex items-start gap-3 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
          <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <div className="text-xs">
            <p className="font-medium text-destructive">
              部分服务未配置
            </p>
            <p className="text-muted-foreground mt-1">
              请在上方为每个功能选择「供应商/模型」，并确保对应供应商已填写 API Key。
            </p>
          </div>
        </div>
      )}

      {/* Help text */}
      <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-lg space-y-2">
        <p>
          <strong>💡 多模型轮询：</strong>
          每个功能可选择多个模型，请求将按顺序分配到各模型（每次间隔 3 秒），避免单一 API 限流。
        </p>
        <p>
          <strong>📌 说明：</strong>
          可选项来自「API 服务商」里配置的模型列表，点击展开后可多选。
        </p>
      </div>
    </div>
  );
}
