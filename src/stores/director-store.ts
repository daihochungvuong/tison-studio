// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * Director Store
 * Manages AI screenplay generation and scene execution state
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createProjectScopedStorage } from '@/lib/project-storage';
import { DEFAULT_CINEMATOGRAPHY_PROFILE_ID } from '@/lib/constants/cinematography-profiles';
import type { 
  AIScreenplay, 
  AIScene, 
  SceneProgress, 
  GenerationConfig 
} from '@opencut/ai-core';
import type {
  LightingStyle,
  LightingDirection,
  ColorTemperature,
  DepthOfField,
  FocusTransition,
  CameraRig,
  MovementSpeed,
  AtmosphericEffect,
  EffectIntensity,
  PlaybackSpeed,
  ContinuityRef,
  CameraAngle,
  FocalLength,
  PhotographyTechnique,
} from '@/types/script';

// ==================== Types ====================

export type ScreenplayStatus = 'idle' | 'generating' | 'ready' | 'generating_images' | 'images_ready' | 'generating_videos' | 'completed' | 'error';

// Storyboard-specific status
export type StoryboardStatus = 'idle' | 'generating' | 'preview' | 'splitting' | 'editing' | 'error';

// Generation status for each scene (used for both image and video)
export type GenerationStatus = 'idle' | 'uploading' | 'generating' | 'completed' | 'failed';
// Alias for backward compatibility
export type VideoStatus = GenerationStatus;

// ==================== 预设常量（从 director-presets.ts 导入并重新导出） ====================
// 本地导入：用于本文件内的类型引用（SplitScene 等接口定义需要）
import type {
  ShotSizeType,
  DurationType,
  SoundEffectTag,
  EmotionTag,
} from './director-presets';
// 重新导出：保持向后兼容，现有的 import { SHOT_SIZE_PRESETS } from '@/stores/director-store' 继续可用
export {
  SHOT_SIZE_PRESETS,
  type ShotSizeType,
  DURATION_PRESETS,
  type DurationType,
  SOUND_EFFECT_PRESETS,
  type SoundEffectTag,
  LIGHTING_STYLE_PRESETS,
  LIGHTING_DIRECTION_PRESETS,
  COLOR_TEMPERATURE_PRESETS,
  DEPTH_OF_FIELD_PRESETS,
  FOCUS_TRANSITION_PRESETS,
  CAMERA_RIG_PRESETS,
  MOVEMENT_SPEED_PRESETS,
  ATMOSPHERIC_EFFECT_PRESETS,
  EFFECT_INTENSITY_PRESETS,
  PLAYBACK_SPEED_PRESETS,
  EMOTION_PRESETS,
  type EmotionTag,
  CAMERA_ANGLE_PRESETS,
  type CameraAngleType,
  FOCAL_LENGTH_PRESETS,
  type FocalLengthType,
  PHOTOGRAPHY_TECHNIQUE_PRESETS,
  type PhotographyTechniqueType,
  CAMERA_MOVEMENT_PRESETS,
  type CameraMovementType,
  SPECIAL_TECHNIQUE_PRESETS,
  type SpecialTechniqueType,
} from './director-presets';

// 分镜（原名 Split scene）
// 三层提示词设计：
// 1. 首帧提示词 (imagePrompt) - 静态画面描述，用于生成首帧图片
// 2. 尾帧提示词 (endFramePrompt) - 静态画面描述，用于生成尾帧图片（如果需要）
// 3. 视频提示词 (videoPrompt) - 动态动作描述，用于生成视频
export interface SplitScene {
  id: number;
  // 场景名称（如：山村学校）
  sceneName: string;
  // 场景地点（如：教室内部）
  sceneLocation: string;
  
  // ========== 首帧 (First Frame / Start State) ==========
  // 首帧图片（从分镜图切割得到，或 AI 生成）
  imageDataUrl: string;
  // 首帧图片的 HTTP URL（用于视频生成 API）
  imageHttpUrl: string | null;
  width: number;
  height: number;
  // 首帧图像提示词（英文，用于图像生成 API）
  // 重点：构图、光影、人物外观、起始姿势（静态描述）
  imagePrompt: string;
  // 首帧图像提示词（中文，用于用户显示/编辑）
  imagePromptZh: string;
  // 首帧生成状态
  imageStatus: GenerationStatus;
  imageProgress: number; // 0-100
  imageError: string | null;
  
  // ========== 尾帧 (End Frame / End State) ==========
  // 是否需要尾帧（AI 自动判断或用户手动设置）
  // 需要尾帧的场景：大幅位移、变身、镜头大幅转移、转场镜头、风格化视频
  // 不需要尾帧的场景：简单对话、微动作、开放式场景
  needsEndFrame: boolean;
  // 尾帧图片 URL (data URL 或本地路径)
  endFrameImageUrl: string | null;
  // 尾帧图片的 HTTP URL（用于视频生成 API 的视觉连续性）
  endFrameHttpUrl: string | null;
  // 尾帧来源：null=无 | upload=用户上传 | ai-generated=AI生成 | next-scene=下一分镜首帧 | video-extracted=从视频提取
  endFrameSource: 'upload' | 'ai-generated' | 'next-scene' | 'video-extracted' | null;
  // 尾帧图像提示词（英文，用于图像生成 API）
  // 重点：结束姿势、位置变化后的状态（静态描述）
  endFramePrompt: string;
  // 尾帧图像提示词（中文，用于用户显示/编辑）
  endFramePromptZh: string;
  // 尾帧生成状态
  endFrameStatus: GenerationStatus;
  endFrameProgress: number; // 0-100
  endFrameError: string | null;
  
  // ========== 视频动作 (Video Action / Movement) ==========
  // 视频动作提示词（英文，用于视频生成 API）
  // 重点：动作过程、镜头运动、氛围变化（动态描述）
  // 注意：不需要详细描述人物外观，因为已有首帧图片
  videoPrompt: string;
  // 视频动作提示词（中文，用于用户显示/编辑）
  videoPromptZh: string;
  // 视频生成状态
  videoStatus: GenerationStatus;
  videoProgress: number; // 0-100
  videoUrl: string | null;
  videoError: string | null;
  // 媒体库引用（用于拖拽到时间线）
  videoMediaId: string | null;
  
  // ========== 角色与情绪 ==========
  // 角色库选择（用于视频生成时的角色一致性）
  characterIds: string[];
  // 情绪标签（有序，用于视频氛围和语气控制）
  emotionTags: EmotionTag[];
  
  // ========== 剧本导入信息（参考用）==========
  // 对白/台词（用于配音和字幕）
  dialogue: string;
  // 动作描述（从剧本导入，用于参考）
  actionSummary: string;
  // 镜头运动描述（Dolly In, Pan Right, Static 等）
  cameraMovement: string;
  // 音效文本描述（从剧本导入）
  soundEffectText: string;
  
  // ========== 视频参数 ==========
  // 景别类型（影响视觉提示词）
  shotSize: ShotSizeType | null;
  // 视频时长（API 参数，5秒或10秒）
  duration: DurationType;
  // 环境声描述（拼入提示词）
  ambientSound: string;
  // 音效标签（拼入提示词）- 旧字段，保留兼容
  soundEffects: SoundEffectTag[];
  
  // ========== 音频开关（控制是否拼入视频生成提示词） ==========
  audioAmbientEnabled?: boolean;   // 环境音开关，默认 true
  audioSfxEnabled?: boolean;       // 音效开关，默认 true
  audioDialogueEnabled?: boolean;  // 对白开关，默认 true
  audioBgmEnabled?: boolean;       // 背景音乐开关，默认 false（禁止）
  backgroundMusic?: string;        // 背景音乐描述文本
  
  // ========== 分镜位置信息 ==========
  row: number;
  col: number;
  sourceRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  
  // ========== 场景库关联（用于参考图） ==========
  // 首帧场景关联
  sceneLibraryId?: string;           // 场景库 ID
  viewpointId?: string;              // 视角 ID (如 'sofa', 'dining')
  subViewId?: string;                // 四视图子场景 ID (如 '正面', '背面')
  sceneReferenceImage?: string;      // 场景背景参考图 URL
  
  // 尾帧场景关联（可能与首帧不同）
  endFrameSceneLibraryId?: string;   // 尾帧场景库 ID
  endFrameViewpointId?: string;      // 尾帧视角 ID
  endFrameSubViewId?: string;        // 尾帧四视图子场景 ID
  endFrameSceneReferenceImage?: string; // 尾帧场景背景参考图 URL
  
  // ========== 叙事驱动设计（基于《电影语言的语法》） ==========
  narrativeFunction?: string;        // 叙事功能：铺垫/升级/高潮/转折/过渡/尾声
  shotPurpose?: string;              // 镜头目的：为什么用这个镜头
  visualFocus?: string;              // 视觉焦点：观众应该看什么（按顺序）
  cameraPosition?: string;           // 机位描述：摄影机相对于人物的位置
  characterBlocking?: string;        // 人物布局：人物在画面中的位置关系
  rhythm?: string;                   // 节奏描述：这个镜头的节奏感
  visualDescription?: string;        // 详细的画面描述
  
  // ========== 💡 灯光师 (Gaffer) — 每个分镜独立 ==========
  lightingStyle?: LightingStyle;           // 灯光风格
  lightingDirection?: LightingDirection;   // 主光源方向
  colorTemperature?: ColorTemperature;     // 色温
  lightingNotes?: string;                  // 灯光补充说明
  
  // ========== 🔍 跟焦员 (Focus Puller) — 每个分镜独立 ==========
  depthOfField?: DepthOfField;             // 景深
  focusTarget?: string;                    // 焦点目标: "人物面部" / "桌上的信封"
  focusTransition?: FocusTransition;       // 转焦动作
  
  // ========== 🎥 器材组 (Camera Rig) — 每个分镜独立 ==========
  cameraRig?: CameraRig;                   // 拍摄器材类型
  movementSpeed?: MovementSpeed;           // 运动速度
  
  // ========== 🌧️ 特效师 (On-set SFX) — 每个分镜独立 ==========
  atmosphericEffects?: AtmosphericEffect[]; // 氛围特效（可多选）
  effectIntensity?: EffectIntensity;       // 特效强度
  
  // ========== ⬜️ 速度控制 (Speed Ramping) — 每个分镜独立 ==========
  playbackSpeed?: PlaybackSpeed;           // 播放速度
  
  // ========== 📰 拍摄角度 / 焦距 / 摄影技法 — 每个分镜独立 ==========
  cameraAngle?: CameraAngle;               // 拍摄角度
  focalLength?: FocalLength;               // 镜头焦距
  photographyTechnique?: PhotographyTechnique; // 摄影技法
  
  // ========== 🎬 特殊拍摄手法 — 每个分镜独立 ==========
  specialTechnique?: string;               // 特殊拍摄手法（希区柯克变焦、子弹时间等）
  
  // ========== 📋 场记/连戏 (Continuity) — 每个分镜独立 ==========
  continuityRef?: ContinuityRef;           // 连戏参考
  
  // 首帧来源（用于标记）
  imageSource?: 'ai-generated' | 'upload' | 'storyboard';
  
  // ========== 视角切换历史记录 ==========
  // 首帧视角切换历史
  startFrameAngleSwitchHistory?: Array<{
    imageUrl: string;
    angleLabel: string;
    timestamp: number;
  }>;
  // 尾帧视角切换历史
  endFrameAngleSwitchHistory?: Array<{
    imageUrl: string;
    angleLabel: string;
    timestamp: number;
  }>;
}

// 预告片时长类型
export type TrailerDuration = 10 | 30 | 60;

// 预告片配置
export interface TrailerConfig {
  duration: TrailerDuration;  // 秒
  shotIds: string[];          // 挑选的分镜 ID 列表（引用剧本中的 Shot ID）
  generatedAt?: number;       // 生成时间
  status: 'idle' | 'generating' | 'completed' | 'error';
  error?: string;
}

// Per-project director data
export interface DirectorProjectData {
  // Storyboard state (new workflow)
  storyboardImage: string | null;
  storyboardImageMediaId: string | null;
  storyboardStatus: StoryboardStatus;
  storyboardError: string | null;
  splitScenes: SplitScene[];
  projectFolderId: string | null;
  storyboardConfig: {
    aspectRatio: '16:9' | '9:16';
    resolution: '2K' | '4K' | '1K';
    videoResolution: '480p' | '720p' | '1080p';
    sceneCount: number;
    storyPrompt: string;
    /** 直接存储的视觉风格预设 ID（如 '2d_ghibli'），用于精确反查 */
    visualStyleId?: string;
    styleTokens?: string[];
    characterReferenceImages?: string[];
    characterDescriptions?: string[];
  };
  // Legacy screenplay (for backward compatibility)
  screenplay: AIScreenplay | null;
  screenplayStatus: ScreenplayStatus;
  screenplayError: string | null;
  
  // ========== 预告片功能 ==========
  trailerConfig: TrailerConfig;
  trailerScenes: SplitScene[];  // 预告片专用的分镜编辑列表
  
  // ========== 摄影风格档案（项目级） ==========
  cinematographyProfileId?: string;   // 选中的摄影风格预设 ID（如 'film-noir'）
}

interface DirectorState {
  // Active project tracking
  activeProjectId: string | null;
  
  // Per-project data storage
  projects: Record<string, DirectorProjectData>;
  
  // Scene progress map (sceneId -> progress) - transient, not persisted
  sceneProgress: Map<number, SceneProgress>;
  
  // Generation config - global
  config: GenerationConfig;
  
  // UI state - global
  isExpanded: boolean;
  selectedSceneId: number | null;
}

interface DirectorActions {
  // Project management
  setActiveProjectId: (projectId: string | null) => void;
  ensureProject: (projectId: string) => void;
  getProjectData: (projectId: string) => DirectorProjectData;
  
  // Screenplay management
  setScreenplay: (screenplay: AIScreenplay | null) => void;
  setScreenplayStatus: (status: ScreenplayStatus) => void;
  setScreenplayError: (error: string | null) => void;
  
  // Scene editing
  updateScene: (sceneId: number, updates: Partial<AIScene>) => void;
  deleteScene: (sceneId: number) => void;
  deleteAllScenes: () => void;
  
  // Scene progress
  updateSceneProgress: (sceneId: number, progress: Partial<SceneProgress>) => void;
  setSceneProgress: (sceneId: number, progress: SceneProgress) => void;
  clearSceneProgress: () => void;
  
  // Config
  updateConfig: (config: Partial<GenerationConfig>) => void;
  
  // UI
  setExpanded: (expanded: boolean) => void;
  setSelectedScene: (sceneId: number | null) => void;
  
  // Storyboard actions (new workflow)
  setStoryboardImage: (imageUrl: string | null, mediaId?: string | null) => void;
  setStoryboardStatus: (status: StoryboardStatus) => void;
  setStoryboardError: (error: string | null) => void;
  setProjectFolderId: (folderId: string | null) => void;
  setSplitScenes: (scenes: SplitScene[]) => void;
  
  // 首帧提示词更新（静态画面描述）
  updateSplitSceneImagePrompt: (sceneId: number, prompt: string, promptZh?: string) => void;
  // 视频提示词更新（动作过程描述）
  updateSplitSceneVideoPrompt: (sceneId: number, prompt: string, promptZh?: string) => void;
  // 尾帧提示词更新（静态画面描述）
  updateSplitSceneEndFramePrompt: (sceneId: number, prompt: string, promptZh?: string) => void;
  // 设置是否需要尾帧
  updateSplitSceneNeedsEndFrame: (sceneId: number, needsEndFrame: boolean) => void;
  // 兼容旧 API：更新视频提示词（实际上更新 videoPrompt）
  updateSplitScenePrompt: (sceneId: number, prompt: string, promptZh?: string) => void;
  
  updateSplitSceneImage: (sceneId: number, imageDataUrl: string, width?: number, height?: number, httpUrl?: string) => void;
  updateSplitSceneImageStatus: (sceneId: number, updates: Partial<Pick<SplitScene, 'imageStatus' | 'imageProgress' | 'imageError'>>) => void;
  updateSplitSceneVideo: (sceneId: number, updates: Partial<Pick<SplitScene, 'videoStatus' | 'videoProgress' | 'videoUrl' | 'videoError' | 'videoMediaId'>>) => void;
  // 尾帧图片上传/更新
  updateSplitSceneEndFrame: (sceneId: number, imageUrl: string | null, source?: 'upload' | 'ai-generated' | 'next-scene' | 'video-extracted', httpUrl?: string | null) => void;
  // 尾帧生成状态更新
  updateSplitSceneEndFrameStatus: (sceneId: number, updates: Partial<Pick<SplitScene, 'endFrameStatus' | 'endFrameProgress' | 'endFrameError'>>) => void;
  // 角色库、情绪标签更新方法
  updateSplitSceneCharacters: (sceneId: number, characterIds: string[]) => void;
  updateSplitSceneEmotions: (sceneId: number, emotionTags: EmotionTag[]) => void;
  // 景别、时长、环境声、音效更新方法
  updateSplitSceneShotSize: (sceneId: number, shotSize: ShotSizeType | null) => void;
  updateSplitSceneDuration: (sceneId: number, duration: DurationType) => void;
  updateSplitSceneAmbientSound: (sceneId: number, ambientSound: string) => void;
  updateSplitSceneSoundEffects: (sceneId: number, soundEffects: SoundEffectTag[]) => void;
  // 场景库关联更新方法
  updateSplitSceneReference: (sceneId: number, sceneLibraryId?: string, viewpointId?: string, referenceImage?: string, subViewId?: string) => void;
  updateSplitSceneEndFrameReference: (sceneId: number, sceneLibraryId?: string, viewpointId?: string, referenceImage?: string, subViewId?: string) => void;
  // 通用字段更新方法（用于双击编辑）
  updateSplitSceneField: (sceneId: number, field: keyof SplitScene, value: any) => void;
  // 视角切换历史记录
  addAngleSwitchHistory: (sceneId: number, type: 'start' | 'end', historyItem: { imageUrl: string; angleLabel: string; timestamp: number }) => void;
  deleteSplitScene: (sceneId: number) => void;
  setStoryboardConfig: (config: Partial<DirectorState['storyboardConfig']>) => void;
  resetStoryboard: () => void;
  
  // Mode 2: Add scenes from script directly (skip storyboard generation)
  addScenesFromScript: (scenes: Array<{
    promptZh: string;
    promptEn?: string;
    // 三层提示词系统 (Seedance 1.5 Pro)
    imagePrompt?: string;      // 首帧提示词（英文）
    imagePromptZh?: string;    // 首帧提示词（中文）
    videoPrompt?: string;      // 视频提示词（英文）
    videoPromptZh?: string;    // 视频提示词（中文）
    endFramePrompt?: string;   // 尾帧提示词（英文）
    endFramePromptZh?: string; // 尾帧提示词（中文）
    needsEndFrame?: boolean;   // 是否需要尾帧
    characterIds?: string[];
    emotionTags?: EmotionTag[];
    shotSize?: ShotSizeType | null;
    duration?: number;
    ambientSound?: string;
    soundEffects?: SoundEffectTag[];
    soundEffectText?: string;
    dialogue?: string;
    actionSummary?: string;
    cameraMovement?: string;
    sceneName?: string;
    sceneLocation?: string;
    // 场景库关联（自动匹配）
    sceneLibraryId?: string;
    viewpointId?: string;
    sceneReferenceImage?: string;
    // 叙事驱动设计（基于《电影语言的语法》）
    narrativeFunction?: string;
    shotPurpose?: string;
    visualFocus?: string;
    cameraPosition?: string;
    characterBlocking?: string;
    rhythm?: string;
    visualDescription?: string;
    // 拍摄控制（灯光/焦点/器材/特效/速度）— 每个分镜独立
    lightingStyle?: LightingStyle;
    lightingDirection?: LightingDirection;
    colorTemperature?: ColorTemperature;
    lightingNotes?: string;
    depthOfField?: DepthOfField;
    focusTarget?: string;
    focusTransition?: FocusTransition;
    cameraRig?: CameraRig;
    movementSpeed?: MovementSpeed;
    atmosphericEffects?: AtmosphericEffect[];
    effectIntensity?: EffectIntensity;
    playbackSpeed?: PlaybackSpeed;
    // 拍摄角度 / 焦距 / 技法
    cameraAngle?: CameraAngle;
    focalLength?: FocalLength;
    photographyTechnique?: PhotographyTechnique;
    // 特殊拍摄手法
    specialTechnique?: string;
  }>) => void;
  
  // Workflow actions (these will trigger worker commands)
  startScreenplayGeneration: (prompt: string, images?: File[]) => void;
  startImageGeneration: () => void;      // Step 1: Generate images only
  startVideoGeneration: () => void;      // Step 2: Generate videos from images
  retrySceneImage: (sceneId: number) => void;  // Retry single scene image
  retryScene: (sceneId: number) => void;
  cancelAll: () => void;
  reset: () => void;
  
  // Worker callbacks (called by WorkerBridge)
  onScreenplayGenerated: (screenplay: AIScreenplay) => void;
  onSceneProgressUpdate: (sceneId: number, progress: SceneProgress) => void;
  onSceneImageCompleted: (sceneId: number, imageUrl: string) => void;  // Image only
  onSceneCompleted: (sceneId: number, mediaId: string) => void;         // Video completed
  onSceneFailed: (sceneId: number, error: string) => void;
  onAllImagesCompleted: () => void;   // All images done, ready for review
  onAllCompleted: () => void;          // All videos done
  
  // ========== 预告片功能 ==========
  setTrailerDuration: (duration: TrailerDuration) => void;
  setTrailerScenes: (scenes: SplitScene[]) => void;
  setTrailerConfig: (config: Partial<TrailerConfig>) => void;
  clearTrailer: () => void;
  
  // ========== 摄影风格档案 ==========
  setCinematographyProfileId: (profileId: string | undefined) => void;
}

type DirectorStore = DirectorState & DirectorActions;

// ==================== Default Config ====================

const defaultConfig: GenerationConfig = {
  styleTokens: ['anime style', 'manga art', '2D animation', 'cel shaded'],
  qualityTokens: ['high quality', 'detailed', 'professional'],
  negativePrompt: 'blurry, low quality, watermark, realistic, photorealistic, 3D render',
  aspectRatio: '9:16',
  imageSize: '1K',
  videoSize: '480p',
  sceneCount: 5,
  concurrency: 1,
  imageProvider: 'memefast',
  videoProvider: 'memefast',
  chatProvider: 'memefast',
};

// ==================== Default Project Data ====================

const defaultProjectData = (): DirectorProjectData => ({
  storyboardImage: null,
  storyboardImageMediaId: null,
  storyboardStatus: 'idle',
  storyboardError: null,
  splitScenes: [],
  projectFolderId: null,
  storyboardConfig: {
    aspectRatio: '9:16',
    resolution: '2K',
    videoResolution: '480p',
    sceneCount: 5,
    storyPrompt: '',
    styleTokens: [],
    characterReferenceImages: [],
    characterDescriptions: [],
  },
  screenplay: null,
  screenplayStatus: 'idle',
  screenplayError: null,
  // 预告片默认值
  trailerConfig: {
    duration: 30,
    shotIds: [],
    status: 'idle',
  },
  trailerScenes: [],
  // 摄影风格档案：使用经典电影摄影作为默认基准
  cinematographyProfileId: DEFAULT_CINEMATOGRAPHY_PROFILE_ID,
});

// ==================== Initial State ====================

const initialState: DirectorState = {
  activeProjectId: null,
  projects: {},
  sceneProgress: new Map(),
  config: defaultConfig,
  isExpanded: true,
  selectedSceneId: null,
};

// ==================== Store ====================

// Helper to get current project data
const getCurrentProject = (state: DirectorState): DirectorProjectData | null => {
  if (!state.activeProjectId) return null;
  return state.projects[state.activeProjectId] || null;
};

export const useDirectorStore = create<DirectorStore>()(
  persist(
    (set, get) => ({
      ...initialState,

  // Project management
  setActiveProjectId: (projectId) => {
    set({ activeProjectId: projectId });
    if (projectId) {
      get().ensureProject(projectId);
    }
  },
  
  ensureProject: (projectId) => {
    const { projects } = get();
    if (projects[projectId]) return;
    set({
      projects: { ...projects, [projectId]: defaultProjectData() },
    });
  },
  
  getProjectData: (projectId) => {
    const { projects } = get();
    return projects[projectId] || defaultProjectData();
  },

  // Screenplay management
  setScreenplay: (screenplay) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...projects[activeProjectId],
          screenplay,
          screenplayError: null,
        },
      },
    });
  },
  
  setScreenplayStatus: (status) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...projects[activeProjectId],
          screenplayStatus: status,
        },
      },
    });
  },
  
  setScreenplayError: (error) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const currentProject = projects[activeProjectId];
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...currentProject,
          screenplayError: error,
          screenplayStatus: error ? 'error' : currentProject?.screenplayStatus || 'idle',
        },
      },
    });
  },

  // Scene editing
  updateScene: (sceneId, updates) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    if (!project?.screenplay) return;
    
    const updatedScenes = project.screenplay.scenes.map(scene => 
      scene.sceneId === sceneId ? { ...scene, ...updates } : scene
    );
    
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...project,
          screenplay: {
            ...project.screenplay,
            scenes: updatedScenes,
            updatedAt: Date.now(),
          },
        },
      },
    });
  },
  
  // Delete a single scene
  deleteScene: (sceneId) => {
    const { activeProjectId, projects, sceneProgress } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    if (!project?.screenplay) return;
    
    const remainingScenes = project.screenplay.scenes.filter(scene => scene.sceneId !== sceneId);
    const renumberedScenes = remainingScenes.map((scene, index) => ({
      ...scene,
      sceneId: index + 1,
    }));
    
    const newProgressMap = new Map<number, SceneProgress>();
    remainingScenes.forEach((scene, index) => {
      const oldProgress = sceneProgress.get(scene.sceneId);
      if (oldProgress) {
        newProgressMap.set(index + 1, { ...oldProgress, sceneId: index + 1 });
      }
    });
    
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...project,
          screenplay: {
            ...project.screenplay,
            scenes: renumberedScenes,
            updatedAt: Date.now(),
          },
        },
      },
      sceneProgress: newProgressMap,
    });
    
    console.log('[DirectorStore] Deleted scene', sceneId, 'remaining:', renumberedScenes.length);
  },
  
  // Delete all scenes and reset to idle
  deleteAllScenes: () => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...projects[activeProjectId],
          screenplay: null,
          screenplayStatus: 'idle',
          screenplayError: null,
        },
      },
      sceneProgress: new Map(),
      selectedSceneId: null,
    });
    console.log('[DirectorStore] Deleted all scenes, reset to idle');
  },

  // Scene progress
  updateSceneProgress: (sceneId, partialProgress) => {
    const current = get().sceneProgress.get(sceneId);
    const updated = current 
      ? { ...current, ...partialProgress }
      : { 
          sceneId, 
          status: 'pending' as const, 
          stage: 'idle' as const, 
          progress: 0, 
          ...partialProgress 
        };
    
    set((state) => {
      const newMap = new Map(state.sceneProgress);
      newMap.set(sceneId, updated);
      return { sceneProgress: newMap };
    });
  },
  
  setSceneProgress: (sceneId, progress) => {
    set((state) => {
      const newMap = new Map(state.sceneProgress);
      newMap.set(sceneId, progress);
      return { sceneProgress: newMap };
    });
  },
  
  clearSceneProgress: () => set({ sceneProgress: new Map() }),

  // Config
  updateConfig: (partialConfig) => set((state) => ({
    config: { ...state.config, ...partialConfig }
  })),

  // UI
  setExpanded: (expanded) => set({ isExpanded: expanded }),
  setSelectedScene: (sceneId) => set({ selectedSceneId: sceneId }),

  // Storyboard actions (new workflow) - Project-aware
  setStoryboardImage: (imageUrl, mediaId) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...projects[activeProjectId],
          storyboardImage: imageUrl,
          storyboardImageMediaId: mediaId ?? null,
        },
      },
    });
  },
  
  setStoryboardStatus: (status) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...projects[activeProjectId],
          storyboardStatus: status,
        },
      },
    });
  },
  
  setProjectFolderId: (folderId) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...projects[activeProjectId],
          projectFolderId: folderId,
        },
      },
    });
  },
  
  setStoryboardError: (error) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const currentProject = projects[activeProjectId];
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...currentProject,
          storyboardError: error,
          storyboardStatus: error ? 'error' : currentProject?.storyboardStatus || 'idle',
        },
      },
    });
  },
  
  setSplitScenes: (scenes) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    
    // Ensure all scenes have all fields initialized with defaults
    const initialized = scenes.map(s => ({
      ...s,
      // 场景基本信息
      sceneName: (s as any).sceneName ?? '',
      sceneLocation: (s as any).sceneLocation ?? '',
      
      // ========== 首帧相关 ==========
      imageHttpUrl: (s as any).imageHttpUrl ?? null,
      // 首帧提示词（新增）
      imagePrompt: (s as any).imagePrompt ?? s.videoPrompt ?? '',
      imagePromptZh: (s as any).imagePromptZh ?? s.videoPromptZh ?? s.videoPrompt ?? '',
      // 首帧生成状态
      imageStatus: s.imageStatus || 'completed' as const,
      imageProgress: s.imageProgress ?? 100,
      imageError: s.imageError ?? null,
      
      // ========== 尾帧相关 ==========
      // 是否需要尾帧（新增，默认 false）
      needsEndFrame: (s as any).needsEndFrame ?? false,
      endFrameImageUrl: s.endFrameImageUrl ?? null,
      endFrameHttpUrl: (s as any).endFrameHttpUrl ?? null,
      endFrameSource: s.endFrameSource ?? null,
      // 尾帧提示词（新增）
      endFramePrompt: (s as any).endFramePrompt ?? '',
      endFramePromptZh: (s as any).endFramePromptZh ?? '',
      // 尾帧生成状态（新增）
      endFrameStatus: (s as any).endFrameStatus || 'idle' as const,
      endFrameProgress: (s as any).endFrameProgress ?? 0,
      endFrameError: (s as any).endFrameError ?? null,
      
      // ========== 视频相关 ==========
      videoPromptZh: s.videoPromptZh ?? s.videoPrompt ?? '',
      videoStatus: s.videoStatus || 'idle' as const,
      videoProgress: s.videoProgress ?? 0,
      videoUrl: s.videoUrl ?? null,
      videoError: s.videoError ?? null,
      videoMediaId: s.videoMediaId ?? null,
      
      // ========== 角色与情绪 ==========
      characterIds: s.characterIds ?? [],
      emotionTags: s.emotionTags ?? [],
      
      // ========== 剧本导入信息 ==========
      dialogue: s.dialogue ?? '',
      actionSummary: s.actionSummary ?? '',
      cameraMovement: s.cameraMovement ?? '',
      soundEffectText: (s as any).soundEffectText ?? '',
      
      // ========== 视频参数 ==========
      shotSize: s.shotSize ?? null,
      duration: s.duration ?? 5,
      ambientSound: s.ambientSound ?? '',
      soundEffects: s.soundEffects ?? [],
      
      // ========== 灯光师 (Gaffer) — 每个分镜独立 ==========
      lightingStyle: s.lightingStyle ?? undefined,
      lightingDirection: s.lightingDirection ?? undefined,
      colorTemperature: s.colorTemperature ?? undefined,
      lightingNotes: s.lightingNotes ?? undefined,
      
      // ========== 跟焦员 (Focus Puller) — 每个分镜独立 ==========
      depthOfField: s.depthOfField ?? undefined,
      focusTarget: s.focusTarget ?? undefined,
      focusTransition: s.focusTransition ?? undefined,
      
      // ========== 器材组 (Camera Rig) — 每个分镜独立 ==========
      cameraRig: s.cameraRig ?? undefined,
      movementSpeed: s.movementSpeed ?? undefined,
      
      // ========== 特效师 (On-set SFX) — 每个分镜独立 ==========
      atmosphericEffects: s.atmosphericEffects ?? undefined,
      effectIntensity: s.effectIntensity ?? undefined,
      
      // ========== 速度控制 (Speed Ramping) — 每个分镜独立 ==========
      playbackSpeed: s.playbackSpeed ?? undefined,
      
      // ========== 特殊拍摄手法 — 每个分镜独立 ==========
      specialTechnique: s.specialTechnique ?? undefined,
      
      // ========== 场记/连戏 (Continuity) — 每个分镜独立 ==========
      continuityRef: s.continuityRef ?? undefined,
    }));
    
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...projects[activeProjectId],
          splitScenes: initialized,
        },
      },
    });
  },
  
  // ========== 三层提示词更新方法 ==========
  
  // 更新首帧提示词（静态画面描述）
  updateSplitSceneImagePrompt: (sceneId, prompt, promptZh) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { 
        ...scene, 
        imagePrompt: prompt,
        imagePromptZh: promptZh !== undefined ? promptZh : scene.imagePromptZh,
      } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },
  
  // 更新视频提示词（动作过程描述）
  updateSplitSceneVideoPrompt: (sceneId, prompt, promptZh) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { 
        ...scene, 
        videoPrompt: prompt,
        videoPromptZh: promptZh !== undefined ? promptZh : scene.videoPromptZh,
      } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },
  
  // 更新尾帧提示词（静态画面描述）
  updateSplitSceneEndFramePrompt: (sceneId, prompt, promptZh) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { 
        ...scene, 
        endFramePrompt: prompt,
        endFramePromptZh: promptZh !== undefined ? promptZh : scene.endFramePromptZh,
      } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },
  
  // 设置是否需要尾帧
  updateSplitSceneNeedsEndFrame: (sceneId, needsEndFrame) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { ...scene, needsEndFrame } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },
  
  // 兼容旧 API：更新视频提示词（实际上更新 videoPrompt）
  updateSplitScenePrompt: (sceneId, prompt, promptZh) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { 
        ...scene, 
        videoPrompt: prompt,
        videoPromptZh: promptZh !== undefined ? promptZh : scene.videoPromptZh,
      } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },

  // 更新分镜图片
  // 注意：当图片变化时，如果没有传入新的 httpUrl，应该清除旧的 httpUrl
  // 这样可以避免用户从素材库选择新图片后，旧的 HTTP URL 仍然被使用
  // 关键：同时清除 imageSource，避免视频生成时错误地使用旧的 imageHttpUrl
  updateSplitSceneImage: (sceneId, imageDataUrl, width, height, httpUrl) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { 
        ...scene, 
        imageDataUrl,
        // 如果显式传入 httpUrl（包括空字符串），使用它；否则设置为 null 强制清除
        // 使用 null 而不是 undefined，确保覆盖旧值
        imageHttpUrl: httpUrl !== undefined ? (httpUrl || null) : null,
        // 如果没有传入 httpUrl，清除 imageSource 标记，避免视频生成时误判
        imageSource: httpUrl ? 'ai-generated' : undefined,
        imageStatus: 'completed' as const,
        imageProgress: 100,
        imageError: null,
        ...(width !== undefined && { width }),
        ...(height !== undefined && { height }),
      } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },

  updateSplitSceneImageStatus: (sceneId, updates) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { ...scene, ...updates } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },

  updateSplitSceneVideo: (sceneId, updates) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { ...scene, ...updates } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },

  // 更新尾帧图片（支持多种来源）
  // 注意：当尾帧变化时，如果没有传入新的 httpUrl，应该清除旧的 httpUrl
  updateSplitSceneEndFrame: (sceneId, imageUrl, source, httpUrl) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { 
        ...scene, 
        endFrameImageUrl: imageUrl,
        // 如果显式传入 httpUrl，使用它；否则清空（因为尾帧已变化或删除）
        endFrameHttpUrl: httpUrl !== undefined ? httpUrl : (imageUrl ? undefined : null),
        endFrameSource: imageUrl ? (source || 'upload') : null,
        endFrameStatus: imageUrl ? 'completed' as const : 'idle' as const,
        endFrameProgress: imageUrl ? 100 : 0,
        endFrameError: null,
      } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },
  
  // 更新尾帧生成状态
  updateSplitSceneEndFrameStatus: (sceneId, updates) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { ...scene, ...updates } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },

  updateSplitSceneCharacters: (sceneId, characterIds) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { ...scene, characterIds } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },

  updateSplitSceneEmotions: (sceneId, emotionTags) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { ...scene, emotionTags } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },

  updateSplitSceneShotSize: (sceneId, shotSize) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { ...scene, shotSize } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },

  updateSplitSceneDuration: (sceneId, duration) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { ...scene, duration } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },

  updateSplitSceneAmbientSound: (sceneId, ambientSound) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { ...scene, ambientSound } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },

  updateSplitSceneSoundEffects: (sceneId, soundEffects) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { ...scene, soundEffects } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },

  // 场景库关联更新方法（首帧）
  updateSplitSceneReference: (sceneId, sceneLibraryId, viewpointId, referenceImage, subViewId) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId
        ? { ...scene, sceneLibraryId, viewpointId, subViewId, sceneReferenceImage: referenceImage }
        : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
    console.log('[DirectorStore] Updated scene reference for shot', sceneId, ':', sceneLibraryId, viewpointId, subViewId);
  },

  // 场景库关联更新方法（尾帧）
  updateSplitSceneEndFrameReference: (sceneId, sceneLibraryId, viewpointId, referenceImage, subViewId) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId
        ? { ...scene, endFrameSceneLibraryId: sceneLibraryId, endFrameViewpointId: viewpointId, endFrameSubViewId: subViewId, endFrameSceneReferenceImage: referenceImage }
        : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
    console.log('[DirectorStore] Updated end frame scene reference for shot', sceneId, ':', sceneLibraryId, viewpointId, subViewId);
  },

  // 通用字段更新方法（用于双击编辑）
  updateSplitSceneField: (sceneId, field, value) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene =>
      scene.id === sceneId ? { ...scene, [field]: value } : scene
    );
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },
  
  // 视角切换历史记录更新方法
  addAngleSwitchHistory: (sceneId, type, historyItem) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const updated = project.splitScenes.map(scene => {
      if (scene.id !== sceneId) return scene;
      if (type === 'start') {
        const history = scene.startFrameAngleSwitchHistory || [];
        return { ...scene, startFrameAngleSwitchHistory: [...history, historyItem] };
      } else {
        const history = scene.endFrameAngleSwitchHistory || [];
        return { ...scene, endFrameAngleSwitchHistory: [...history, historyItem] };
      }
    });
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: updated },
      },
    });
  },
  
  deleteSplitScene: (sceneId) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const remaining = project.splitScenes.filter(s => s.id !== sceneId);
    const renumbered = remaining.map((s, idx) => ({ ...s, id: idx }));
    set({
      projects: {
        ...projects,
        [activeProjectId]: { ...project, splitScenes: renumbered },
      },
    });
    console.log('[DirectorStore] Deleted split scene', sceneId, 'remaining:', renumbered.length);
  },
  
  setStoryboardConfig: (partialConfig) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...project,
          storyboardConfig: { ...project.storyboardConfig, ...partialConfig },
        },
      },
    });
  },
  
  resetStoryboard: () => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...projects[activeProjectId],
          storyboardImage: null,
          storyboardImageMediaId: null,
          storyboardStatus: 'idle',
          storyboardError: null,
          splitScenes: [],
        },
      },
    });
    console.log('[DirectorStore] Reset storyboard state for project', activeProjectId);
  },

  // Mode 2: Add scenes from script directly (skip storyboard, generate images individually)
  addScenesFromScript: (scenes) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    const splitScenes = project?.splitScenes || [];
    const startId = splitScenes.length > 0 ? Math.max(...splitScenes.map(s => s.id)) + 1 : 1;
    
    const newScenes: SplitScene[] = scenes.map((scene, index) => ({
      id: startId + index,
      sceneName: scene.sceneName || '',
      sceneLocation: scene.sceneLocation || '',
      imageDataUrl: '',
      imageHttpUrl: null,
      width: 0,
      height: 0,
      // 三层提示词系统：优先使用专门的三层提示词，否则回退到旧的 promptEn/promptZh
      imagePrompt: scene.imagePrompt || scene.promptEn || '',
      imagePromptZh: scene.imagePromptZh || scene.promptZh || '',
      videoPrompt: scene.videoPrompt || scene.promptEn || '',
      videoPromptZh: scene.videoPromptZh || scene.promptZh,
      endFramePrompt: scene.endFramePrompt || '',
      endFramePromptZh: scene.endFramePromptZh || '',
      needsEndFrame: scene.needsEndFrame || false,
      row: 0,
      col: 0,
      sourceRect: { x: 0, y: 0, width: 0, height: 0 },
      endFrameImageUrl: null,
      endFrameHttpUrl: null,
      endFrameSource: null,
      endFrameStatus: 'idle' as const,
      endFrameProgress: 0,
      endFrameError: null,
      characterIds: scene.characterIds || [],
      emotionTags: scene.emotionTags || [],
      shotSize: scene.shotSize || null,
      duration: scene.duration || 5,
      ambientSound: scene.ambientSound || '',
      soundEffects: scene.soundEffects || [],
      soundEffectText: scene.soundEffectText || '',
      dialogue: scene.dialogue || '',
      actionSummary: scene.actionSummary || '',
      cameraMovement: scene.cameraMovement || '',
      // 音频开关默认全部开启（背景音乐默认关闭）
      audioAmbientEnabled: true,
      audioSfxEnabled: true,
      audioDialogueEnabled: true,
      audioBgmEnabled: false,
      backgroundMusic: scene.backgroundMusic || '',
      // 场景库关联（自动匹配）
      sceneLibraryId: scene.sceneLibraryId,
      viewpointId: scene.viewpointId,
      sceneReferenceImage: scene.sceneReferenceImage,
      // 叙事驱动设计（基于《电影语言的语法》）
      narrativeFunction: scene.narrativeFunction || '',
      shotPurpose: scene.shotPurpose || '',
      visualFocus: scene.visualFocus || '',
      cameraPosition: scene.cameraPosition || '',
      characterBlocking: scene.characterBlocking || '',
      rhythm: scene.rhythm || '',
      visualDescription: scene.visualDescription || '',
      // 拍摄控制（灯光/焦点/器材/特效/速度）— 每个分镜独立
      lightingStyle: scene.lightingStyle,
      lightingDirection: scene.lightingDirection,
      colorTemperature: scene.colorTemperature,
      lightingNotes: scene.lightingNotes,
      depthOfField: scene.depthOfField,
      focusTarget: scene.focusTarget,
      focusTransition: scene.focusTransition,
      cameraRig: scene.cameraRig,
      movementSpeed: scene.movementSpeed,
      atmosphericEffects: scene.atmosphericEffects,
      effectIntensity: scene.effectIntensity,
      playbackSpeed: scene.playbackSpeed,
      // 特殊拍摄手法
      specialTechnique: scene.specialTechnique,
      // 拍摄角度 / 焦距 / 摄影技法
      cameraAngle: scene.cameraAngle,
      focalLength: scene.focalLength,
      photographyTechnique: scene.photographyTechnique,
      imageStatus: 'idle' as const,
      imageProgress: 0,
      imageError: null,
      videoStatus: 'idle' as const,
      videoProgress: 0,
      videoUrl: null,
      videoError: null,
      videoMediaId: null,
    }));
    
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...project,
          splitScenes: [...splitScenes, ...newScenes],
          storyboardStatus: 'editing',
        },
      },
    });
    
    console.log('[DirectorStore] Added', newScenes.length, 'scenes from script, total:', splitScenes.length + newScenes.length);
  },

  // Workflow actions
  startScreenplayGeneration: (prompt, images) => {
    set({ 
      screenplayStatus: 'generating', 
      screenplayError: null,
      screenplay: null,
    });
    
    // WorkerBridge will handle the actual generation
    // This is called from the UI, which will also call workerBridge.generateScreenplay()
    console.log('[DirectorStore] Starting screenplay generation for:', prompt.substring(0, 50));
  },

  // Step 1: Start generating images only
  startImageGeneration: () => {
    const { screenplay } = get();
    if (!screenplay) {
      console.error('[DirectorStore] No screenplay to generate images');
      return;
    }
    
    set({ screenplayStatus: 'generating_images' });
    
    // Initialize progress for all scenes (image stage)
    const progressMap = new Map<number, SceneProgress>();
    for (const scene of screenplay.scenes) {
      progressMap.set(scene.sceneId, {
        sceneId: scene.sceneId,
        status: 'pending',
        stage: 'image',
        progress: 0,
      });
    }
    set({ sceneProgress: progressMap });
    
    console.log('[DirectorStore] Starting image generation for', screenplay.scenes.length, 'scenes');
  },
  
  // Step 2: Start generating videos from confirmed images
  startVideoGeneration: () => {
    const { screenplay, sceneProgress } = get();
    if (!screenplay) {
      console.error('[DirectorStore] No screenplay to generate videos');
      return;
    }
    
    set({ screenplayStatus: 'generating_videos' });
    
    // Update progress for video stage (keep existing imageUrl)
    const progressMap = new Map<number, SceneProgress>();
    for (const scene of screenplay.scenes) {
      const existing = sceneProgress.get(scene.sceneId);
      progressMap.set(scene.sceneId, {
        sceneId: scene.sceneId,
        status: 'pending',
        stage: 'video',
        progress: 50, // Start at 50% since image is done
        imageUrl: existing?.imageUrl,
      });
    }
    set({ sceneProgress: progressMap });
    
    console.log('[DirectorStore] Starting video generation for', screenplay.scenes.length, 'scenes');
  },
  
  // Retry generating image for a single scene
  retrySceneImage: (sceneId) => {
    get().updateSceneProgress(sceneId, {
      status: 'pending',
      stage: 'image',
      progress: 0,
      imageUrl: undefined,
      error: undefined,
    });
    console.log('[DirectorStore] Retrying image for scene', sceneId);
  },

  retryScene: (sceneId) => {
    get().updateSceneProgress(sceneId, {
      status: 'pending',
      stage: 'idle',
      progress: 0,
      error: undefined,
    });
    console.log('[DirectorStore] Retrying scene', sceneId);
  },

  cancelAll: () => {
    set({ 
      screenplayStatus: get().screenplay ? 'ready' : 'idle',
    });
    
    // Mark all generating scenes as failed
    const { sceneProgress } = get();
    for (const [sceneId, progress] of sceneProgress) {
      if (progress.status === 'generating' || progress.status === 'pending') {
        get().updateSceneProgress(sceneId, {
          status: 'failed',
          error: 'Cancelled by user',
        });
      }
    }
    
    console.log('[DirectorStore] Cancelled all operations');
  },

  reset: () => set(initialState),

  // Worker callbacks
  onScreenplayGenerated: (screenplay) => {
    set({ 
      screenplay, 
      screenplayStatus: 'ready',
      screenplayError: null,
    });
    console.log('[DirectorStore] Screenplay generated:', screenplay.title);
  },

  onSceneProgressUpdate: (sceneId, progress) => {
    get().setSceneProgress(sceneId, progress);
  },

  // Called when a scene's image is generated
  onSceneImageCompleted: (sceneId, imageUrl) => {
    // In image-only mode, 100% means image is done
    // Progress will be reset to 50% when video generation starts
    get().updateSceneProgress(sceneId, {
      status: 'completed',
      stage: 'image',
      progress: 100, // 100% for image generation step
      imageUrl,
    });
    
    // Update scene with imageUrl
    const { screenplay } = get();
    if (screenplay) {
      get().updateScene(sceneId, { imageUrl });
    }
    
    // Check if all images are done
    const { sceneProgress } = get();
    if (screenplay) {
      const allImagesDone = screenplay.scenes.every(scene => {
        const progress = sceneProgress.get(scene.sceneId);
        return progress?.imageUrl || progress?.status === 'failed';
      });
      
      if (allImagesDone) {
        get().onAllImagesCompleted();
      }
    }
    
    console.log('[DirectorStore] Scene image completed:', sceneId, imageUrl?.substring(0, 50));
  },

  onSceneCompleted: (sceneId, mediaId) => {
    get().updateSceneProgress(sceneId, {
      status: 'completed',
      stage: 'done',
      progress: 100,
      mediaId,
      completedAt: Date.now(),
    });
    
    // Check if all scenes are done
    const { sceneProgress, screenplay } = get();
    if (screenplay) {
      const allDone = screenplay.scenes.every(scene => {
        const progress = sceneProgress.get(scene.sceneId);
        return progress?.status === 'completed' || progress?.status === 'failed';
      });
      
      if (allDone) {
        get().onAllCompleted();
      }
    }
    
    console.log('[DirectorStore] Scene completed:', sceneId, 'mediaId:', mediaId);
  },

  onSceneFailed: (sceneId, error) => {
    get().updateSceneProgress(sceneId, {
      status: 'failed',
      error,
    });
    console.error('[DirectorStore] Scene failed:', sceneId, error);
  },

  // All images generated, ready for user review
  onAllImagesCompleted: () => {
    set({ screenplayStatus: 'images_ready' });
    console.log('[DirectorStore] All images completed, ready for review');
  },

  onAllCompleted: () => {
    set({ screenplayStatus: 'completed' });
    console.log('[DirectorStore] All scenes completed');
  },
  
  // ========== 预告片功能实现 ==========
  
  setTrailerDuration: (duration) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...project,
          trailerConfig: {
            ...project.trailerConfig,
            duration,
          },
        },
      },
    });
    console.log('[DirectorStore] Trailer duration set to:', duration);
  },
  
  setTrailerScenes: (scenes) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...project,
          trailerScenes: scenes,
          trailerConfig: {
            ...project.trailerConfig,
            generatedAt: Date.now(),
            status: 'completed',
          },
        },
      },
    });
    console.log('[DirectorStore] Trailer scenes set:', scenes.length, 'scenes');
  },
  
  setTrailerConfig: (config) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...project,
          trailerConfig: {
            ...project.trailerConfig,
            ...config,
          },
        },
      },
    });
    console.log('[DirectorStore] Trailer config updated:', config);
  },
  
  clearTrailer: () => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...project,
          trailerConfig: {
            duration: 30,
            shotIds: [],
            status: 'idle',
          },
          trailerScenes: [],
        },
      },
    });
    console.log('[DirectorStore] Trailer cleared');
  },
  
  // ========== 摄影风格档案 ==========
  
  setCinematographyProfileId: (profileId) => {
    const { activeProjectId, projects } = get();
    if (!activeProjectId) return;
    const project = projects[activeProjectId];
    set({
      projects: {
        ...projects,
        [activeProjectId]: {
          ...project,
          cinematographyProfileId: profileId,
        },
      },
    });
    console.log('[DirectorStore] Cinematography profile set to:', profileId);
  },
    }),
    {
      name: 'moyin-director-store',
      storage: createJSONStorage(() => createProjectScopedStorage('director')),
      partialize: (state) => {
        // Helper: strip base64 data from a string field (keep local-image:// and https://)
        const stripBase64 = (val: string | null | undefined): string | null | undefined => {
          if (!val) return val;
          if (typeof val === 'string' && val.startsWith('data:')) return '';
          return val;
        };

        // Strip base64 from SplitScene to avoid 100MB+ JSON persistence
        const stripScene = (s: SplitScene): SplitScene => ({
          ...s,
          imageDataUrl: (stripBase64(s.imageDataUrl) ?? '') as string,
          endFrameImageUrl: stripBase64(s.endFrameImageUrl) as string | null,
          sceneReferenceImage: stripBase64(s.sceneReferenceImage) as string | undefined,
          endFrameSceneReferenceImage: stripBase64(s.endFrameSceneReferenceImage) as string | undefined,
        });

        const pid = state.activeProjectId;
        
        // Only serialize the active project's data (not all projects)
        let projectData = null;
        if (pid && state.projects[pid]) {
          const proj = state.projects[pid];
          projectData = {
            ...proj,
            storyboardImage: (stripBase64(proj.storyboardImage) ?? null) as string | null,
            splitScenes: proj.splitScenes.map(stripScene),
            trailerScenes: proj.trailerScenes.map(stripScene),
          };
        }

        return {
          activeProjectId: pid,
          projectData,
          config: state.config,
          // Don't persist: sceneProgress (Map), UI state
        };
      },
      merge: (persisted: any, current: any) => {
        if (!persisted) return current;
        
        // Legacy format: has `projects` as Record (from old monolithic file)
        if (persisted.projects && typeof persisted.projects === 'object') {
          return { ...current, ...persisted };
        }
        
        // New per-project format: has `projectData` for single project
        const { activeProjectId: pid, projectData, config } = persisted;
        const updates: any = { ...current };
        if (config) updates.config = config;
        if (pid) updates.activeProjectId = pid;
        if (pid && projectData) {
          updates.projects = { ...current.projects, [pid]: projectData };
        }
        return updates;
      },
    }
  )
);

// ==================== Selectors ====================

/**
 * Get current active project data (for reading splitScenes, storyboardImage, etc.)
 */
export const useActiveDirectorProject = (): DirectorProjectData | null => {
  return useDirectorStore((state) => {
    if (!state.activeProjectId) return null;
    return state.projects[state.activeProjectId] || null;
  });
};

/**
 * Get progress for a specific scene
 */
export const useSceneProgress = (sceneId: number): SceneProgress | undefined => {
  return useDirectorStore((state) => state.sceneProgress.get(sceneId));
};

/**
 * Get overall progress (0-100)
 */
export const useOverallProgress = (): number => {
  return useDirectorStore((state) => {
    const { screenplay, sceneProgress } = state;
    if (!screenplay || screenplay.scenes.length === 0) return 0;
    
    let total = 0;
    for (const scene of screenplay.scenes) {
      const progress = sceneProgress.get(scene.sceneId);
      total += progress?.progress ?? 0;
    }
    return Math.round(total / screenplay.scenes.length);
  });
};

/**
 * Check if any scene is currently generating
 */
export const useIsGenerating = (): boolean => {
  return useDirectorStore((state) => {
    for (const progress of state.sceneProgress.values()) {
      if (progress.status === 'generating') return true;
    }
    return false;
  });
};

/**
 * Get count of completed scenes
 */
export const useCompletedScenesCount = (): number => {
  return useDirectorStore((state) => {
    let count = 0;
    for (const progress of state.sceneProgress.values()) {
      if (progress.status === 'completed') count++;
    }
    return count;
  });
};

/**
 * Get count of failed scenes
 */
export const useFailedScenesCount = (): number => {
  return useDirectorStore((state) => {
    let count = 0;
    for (const progress of state.sceneProgress.values()) {
      if (progress.status === 'failed') count++;
    }
    return count;
  });
};
