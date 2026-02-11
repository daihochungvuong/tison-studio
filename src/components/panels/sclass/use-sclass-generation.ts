// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * use-sclass-generation.ts — S级 Seedance 2.0 视频生成 Hook
 *
 * 核心功能：
 * 1. generateGroupVideo(group) — 单组生成：收集 @引用 → 构建多模态请求 → 调用 API → 轮询
 * 2. generateAllGroups() — 批量生成：逐组串行，各组独立生成
 * 3. generateSingleShot(sceneId) — 单镜生成（兼容模式）
 * 4. 自动上传 base64/local 图片到 HTTP URL
 * 5. 生成状态实时同步到 sclass-store
 */

import { useCallback, useRef } from "react";
import { toast } from "sonner";
import {
  useSClassStore,
  type ShotGroup,
  type AssetRef,
  type GenerationRecord,
  type SClassAspectRatio,
  type SClassResolution,
  type SClassDuration,
  type VideoGenStatus,
} from "@/stores/sclass-store";
import { useDirectorStore, useActiveDirectorProject, type SplitScene } from "@/stores/director-store";
import { useCharacterLibraryStore } from "@/stores/character-library-store";
import { useSceneStore } from "@/stores/scene-store";
import {
  getFeatureConfig,
  getFeatureNotConfiguredMessage,
} from "@/lib/ai/feature-router";
import {
  callVideoGenerationApi,
  buildImageWithRoles,
  convertToHttpUrl,
  saveVideoLocally,
  isContentModerationError,
} from "../director/use-video-generation";
import {
  buildGroupPrompt,
  collectAllRefs,
  mergeToGridImage,
  SEEDANCE_LIMITS,
  type GroupPromptResult,
} from "./sclass-prompt-builder";

// ==================== Types ====================

export interface GroupGenerationResult {
  groupId: string;
  success: boolean;
  videoUrl: string | null;
  error: string | null;
}

export interface BatchGenerationProgress {
  total: number;
  completed: number;
  current: string | null;
  results: GroupGenerationResult[];
}

// ==================== Hook ====================

export function useSClassGeneration() {
  const abortRef = useRef(false);

  // ========== Store access ==========

  const {
    activeProjectId,
    getProjectData,
    updateGroupVideoStatus,
    addGroupHistory,
    updateSingleShotVideo,
    updateConfig,
    updateShotGroup,
    addShotGroup,
  } = useSClassStore();

  const projectData = useActiveDirectorProject();
  const splitScenes = projectData?.splitScenes || [];
  const characters = useCharacterLibraryStore((s) => s.characters);
  const scenes = useSceneStore((s) => s.scenes);

  // ========== Helpers ==========

  /** 获取组内场景列表 */
  const getGroupScenes = useCallback(
    (group: ShotGroup): SplitScene[] => {
      return group.sceneIds
        .map((id: number) => splitScenes.find((s: SplitScene) => s.id === id))
        .filter(Boolean) as SplitScene[];
    },
    [splitScenes]
  );

  /** 将 @引用中的图片 URL 转为 HTTP URL */
  const prepareImageUrls = useCallback(
    async (
      refs: AssetRef[]
    ): Promise<Array<{ url: string; role: "first_frame" | "last_frame" }>> => {
      const imageWithRoles: Array<{
        url: string;
        role: "first_frame" | "last_frame";
      }> = [];

      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        const httpUrl = ref.httpUrl || (await convertToHttpUrl(ref.localUrl));
        if (httpUrl) {
          // 第一张图作为 first_frame，其余仅作为参考
          imageWithRoles.push({
            url: httpUrl,
            role: i === 0 ? "first_frame" : "first_frame",
          });
        }
      }

      return imageWithRoles;
    },
    []
  );

  // ========== 单组生成 ==========

  const generateGroupVideo = useCallback(
    async (
      group: ShotGroup,
      options?: {
        /** 进度回调 */
        onProgress?: (progress: number) => void;
        /** 构建完格子图+prompt 后，询问用户是否继续生成视频；返回 false 则中止 */
        confirmBeforeGenerate?: () => Promise<boolean>;
        /** 前组视频 URL（链式重试时传入，用于衔接前后组视频） */
        prevVideoUrl?: string;
      }
    ): Promise<GroupGenerationResult> => {
      const projectId = activeProjectId;
      if (!projectId) {
        return {
          groupId: group.id,
          success: false,
          videoUrl: null,
          error: "无活跃项目",
        };
      }

      // 1. 获取 API 配置
      const featureConfig = getFeatureConfig("video_generation");
      if (!featureConfig) {
        const msg = getFeatureNotConfiguredMessage("video_generation");
        return {
          groupId: group.id,
          success: false,
          videoUrl: null,
          error: msg,
        };
      }

      const apiKey = featureConfig.keyManager.getCurrentKey() || "";
      const sclassProjectData = getProjectData(projectId);
      const sclassConfig = sclassProjectData.config;

      // 1b. 从 director-store 直读共享配置（单一数据源，避免双 store 同步问题）
      const directorState = useDirectorStore.getState();
      const directorProject = directorState.projects[directorState.activeProjectId || ''];
      const storyboardConfig = directorProject?.storyboardConfig;
      const aspectRatio = (storyboardConfig?.aspectRatio || '16:9') as SClassAspectRatio;
      const videoResolution = (storyboardConfig?.videoResolution || '720p') as SClassResolution;
      const styleTokens = storyboardConfig?.styleTokens;

      // 2. 获取组内场景
      const groupScenes = getGroupScenes(group);
      if (groupScenes.length === 0) {
        return {
          groupId: group.id,
          success: false,
          videoUrl: null,
          error: "组内无场景",
        };
      }

      // 3. 设置生成中状态
      updateGroupVideoStatus(group.id, {
        videoStatus: "generating",
        videoProgress: 0,
        videoError: null,
      });

      try {
      // 4. 从组内分镜聚合音频/运镜设置
        const isExtendOrEdit = group.generationType === 'extend' || group.generationType === 'edit';
        const hasAnyDialogue = groupScenes.some(s => s.audioDialogueEnabled !== false && s.dialogue?.trim());
        const hasAnyAmbient = groupScenes.some(s => s.audioAmbientEnabled !== false);
        const hasAnySfx = groupScenes.some(s => s.audioSfxEnabled !== false);
        const enableAudio = hasAnyDialogue || hasAnyAmbient || hasAnySfx;
        const enableLipSync = hasAnyDialogue;

        // camerafixed: 全部分镜运镜为 Static 或为空 → 锁定运镜
        const allStaticCamera = groupScenes.every(s => {
          const cm = (s.cameraMovement || '').toLowerCase().trim();
          return !cm || cm === 'static' || cm === '固定' || cm === '静止';
        });

        // 4b. 构建格子图（合并首帧 或 复用缓存）
        // 延长/编辑组跳过格子图 — 它们的首帧参考来自 sourceVideoUrl
        let gridImageRef: AssetRef | null = null;

        if (!isExtendOrEdit) {
          const sceneIds = group.sceneIds;

          // 检查是否可复用缓存的九宫格图
          const cachedGridUrl = sclassProjectData.lastGridImageUrl;
          const cachedSceneIds = sclassProjectData.lastGridSceneIds;
          const canReuseGrid = cachedGridUrl &&
            cachedSceneIds &&
            sceneIds.length === cachedSceneIds.length &&
            sceneIds.every((id, i) => id === cachedSceneIds[i]);

          // 收集组内分镜的首帧图片
          const firstFrameUrls = groupScenes
            .map(s => s.imageDataUrl || s.imageHttpUrl || '')
            .filter(Boolean);

          if (firstFrameUrls.length > 0) {
            let gridDataUrl: string;
            if (canReuseGrid) {
              // 复用步骤③保存的原始九宫格图
              gridDataUrl = cachedGridUrl!;
              console.log('[SClassGen] 复用缓存九宫格图:', gridDataUrl.substring(0, 60));
            } else {
              // 重新合并首帧为格子图
              gridDataUrl = await mergeToGridImage(firstFrameUrls, aspectRatio);
              console.log('[SClassGen] 已合并', firstFrameUrls.length, '张首帧为格子图');
            }

            gridImageRef = {
              id: 'grid_image',
              type: 'image',
              tag: '@图片1',
              localUrl: gridDataUrl,
              httpUrl: gridDataUrl.startsWith('http') ? gridDataUrl : null,
              fileName: 'grid_image.png',
              fileSize: 0,
              duration: null,
              purpose: 'grid_image',
            };
          }
        }

        // 4c. 构建 prompt（传入格子图引用 + 风格 tokens）
        const promptResult: GroupPromptResult = buildGroupPrompt({
          group,
          scenes: groupScenes,
          characters,
          sceneLibrary: scenes,
          styleTokens: styleTokens || undefined,
          aspectRatio,
          enableLipSync,
          gridImageRef,
        });

        if (promptResult.refs.overLimit) {
          console.warn(
            "[SClassGen] 素材超限:",
            promptResult.refs.limitWarnings
          );
        }

        // 4d. 保存格子图 + prompt 到 group（用于 UI 预览/复制）
        updateShotGroup(group.id, {
          gridImageUrl: gridImageRef?.localUrl || null,
          lastPrompt: promptResult.prompt || null,
        });

        // 4e. 确认是否继续生成视频（用户可在此处仅预览格子图/prompt 后中止）
        if (options?.confirmBeforeGenerate) {
          const proceed = await options.confirmBeforeGenerate();
          if (!proceed) {
            // 用户取消，重置状态但保留 gridImageUrl + lastPrompt
            updateGroupVideoStatus(group.id, {
              videoStatus: 'idle',
              videoProgress: 0,
            });
            return {
              groupId: group.id,
              success: false,
              videoUrl: null,
              error: null,
            };
          }
        }

        // 5. 收集图片引用 → 转 HTTP URL
        const imageRefs = promptResult.refs.images;
        const imageWithRoles = await prepareImageUrls(imageRefs);

        // 5b. 收集视频/音频引用 → 转 HTTP URL（Seedance 2.0 多模态输入）
        const videoRefUrls: string[] = [];
        // 前组视频衔接（链式重试时传入）— 延长/编辑组已在 refs.videos 中携带 sourceVideoUrl，跳过
        if (!isExtendOrEdit && options?.prevVideoUrl) {
          const prevHttpUrl = await convertToHttpUrl(options.prevVideoUrl).catch(() => "");
          if (prevHttpUrl) videoRefUrls.push(prevHttpUrl);
        }
        for (const vRef of promptResult.refs.videos) {
          const httpUrl = vRef.httpUrl || (await convertToHttpUrl(vRef.localUrl).catch(() => ""));
          if (httpUrl) videoRefUrls.push(httpUrl);
        }
        const audioRefUrls: string[] = [];
        for (const aRef of promptResult.refs.audios) {
          const httpUrl = aRef.httpUrl || (await convertToHttpUrl(aRef.localUrl).catch(() => ""));
          if (httpUrl) audioRefUrls.push(httpUrl);
        }

        updateGroupVideoStatus(group.id, { videoProgress: 10 });

        // 6. 调用视频生成 API
        const prompt =
          promptResult.prompt || `Multi-shot video: ${group.name}`;
        const duration = Math.max(
          SEEDANCE_LIMITS.minDuration,
          Math.min(SEEDANCE_LIMITS.maxDuration, group.totalDuration || sclassConfig.defaultDuration)
        );

        console.log("[SClassGen] Generating group video:", {
          groupId: group.id,
          groupName: group.name,
          scenesCount: groupScenes.length,
          promptLength: prompt.length,
          imagesCount: imageWithRoles.length,
          videoRefsCount: videoRefUrls.length,
          audioRefsCount: audioRefUrls.length,
          duration,
          aspectRatio,
          videoResolution,
        });

        const videoUrl = await callVideoGenerationApi(
          apiKey,
          prompt,
          duration,
          aspectRatio,
          imageWithRoles,
          (progress) => {
            const mappedProgress = 10 + Math.floor(progress * 0.85);
            updateGroupVideoStatus(group.id, {
              videoProgress: mappedProgress,
            });
            options?.onProgress?.(mappedProgress);
          },
          featureConfig.keyManager,
          featureConfig.platform,
          videoResolution,
          videoRefUrls.length > 0 ? videoRefUrls : undefined,
          audioRefUrls.length > 0 ? audioRefUrls : undefined,
          enableAudio,
          allStaticCamera,
        );

        // 7. 保存视频到本地
        const localUrl = await saveVideoLocally(
          videoUrl,
          group.sceneIds[0] || 0
        );

        // 8. 更新状态 → 完成
        updateGroupVideoStatus(group.id, {
          videoStatus: "completed",
          videoProgress: 100,
          videoUrl: localUrl,
          videoError: null,
        });

        // 9. 记录历史
        const record: GenerationRecord = {
          id: `gen_${Date.now()}_${group.id}`,
          timestamp: Date.now(),
          prompt,
          videoUrl: localUrl,
          status: "completed",
          error: null,
          assetRefs: [
            ...promptResult.refs.images,
            ...promptResult.refs.videos,
            ...promptResult.refs.audios,
          ],
          config: {
            aspectRatio,
            resolution: videoResolution,
            duration: duration as SClassDuration,
          },
        };
        addGroupHistory(group.id, record);

        return {
          groupId: group.id,
          success: true,
          videoUrl: localUrl,
          error: null,
        };
      } catch (error) {
        const err = error as Error;
        const errorMsg = err.message || "视频生成失败";
        const isModeration = isContentModerationError(err);

        console.error("[SClassGen] Group generation failed:", err);

        updateGroupVideoStatus(group.id, {
          videoStatus: "failed",
          videoProgress: 0,
          videoError: isModeration ? `内容审核未通过: ${errorMsg}` : errorMsg,
        });

        return {
          groupId: group.id,
          success: false,
          videoUrl: null,
          error: errorMsg,
        };
      }
    },
    [
      activeProjectId,
      getProjectData,
      getGroupScenes,
      characters,
      scenes,
      updateGroupVideoStatus,
      addGroupHistory,
      prepareImageUrls,
      updateShotGroup,
      addShotGroup,
    ]
  );

  // ========== 批量生成（逐组串行 + 尾帧传递） ==========

  const generateAllGroups = useCallback(
    async (
      onBatchProgress?: (progress: BatchGenerationProgress) => void
    ): Promise<GroupGenerationResult[]> => {
      const projectId = activeProjectId;
      if (!projectId) {
        toast.error("无活跃项目");
        return [];
      }

      const projectData = getProjectData(projectId);
      const groups = projectData.shotGroups;

      if (groups.length === 0) {
        toast.error("没有镜头组");
        return [];
      }

      // 过滤需要生成的组（idle 或 failed）
      const groupsToGenerate = groups.filter(
        (g) => g.videoStatus === "idle" || g.videoStatus === "failed"
      );

      if (groupsToGenerate.length === 0) {
        toast.info("所有镜头组已生成或正在生成中");
        return [];
      }

      abortRef.current = false;
      const results: GroupGenerationResult[] = [];

      toast.info(
        `开始逐组生成 ${groupsToGenerate.length} 个镜头组视频...`
      );

      for (let i = 0; i < groupsToGenerate.length; i++) {
        if (abortRef.current) {
          toast.warning("已中止批量生成");
          break;
        }

        const group = groupsToGenerate[i];

        onBatchProgress?.({
          total: groupsToGenerate.length,
          completed: i,
          current: group.id,
          results,
        });

        const result = await generateGroupVideo(group, {
          onProgress: (progress) => {
            onBatchProgress?.({
              total: groupsToGenerate.length,
              completed: i,
              current: group.id,
              results,
            });
          },
        });

        results.push(result);

        if (result.success) {
          toast.success(
            `组 ${i + 1}/${groupsToGenerate.length} 「${group.name}」生成完成`
          );
        } else {
          toast.error(
            `组 ${i + 1}/${groupsToGenerate.length} 「${group.name}」失败: ${result.error}`
          );
        }
      }

      onBatchProgress?.({
        total: groupsToGenerate.length,
        completed: groupsToGenerate.length,
        current: null,
        results,
      });

      const successCount = results.filter((r) => r.success).length;
      const failCount = results.filter((r) => !r.success).length;
      if (failCount === 0) {
        toast.success(`全部 ${successCount} 个镜头组生成完成 🎬`);
      } else {
        toast.warning(
          `生成完毕：${successCount} 成功，${failCount} 失败`
        );
      }

      return results;
    },
    [activeProjectId, getProjectData, generateGroupVideo]
  );

  // ========== 单镜生成（兼容模式） ==========

  const generateSingleShot = useCallback(
    async (sceneId: number): Promise<boolean> => {
      const scene = splitScenes.find((s: SplitScene) => s.id === sceneId);
      if (!scene) {
        toast.error("未找到分镜");
        return false;
      }

      const featureConfig = getFeatureConfig("video_generation");
      if (!featureConfig) {
        toast.error(getFeatureNotConfiguredMessage("video_generation"));
        return false;
      }

      const apiKey = featureConfig.keyManager.getCurrentKey() || "";
      const projectId = activeProjectId;
      if (!projectId) return false;

      // 从 director-store 直读共享配置（与 generateGroupVideo 保持一致）
      const dirState = useDirectorStore.getState();
      const dirProj = dirState.projects[dirState.activeProjectId || ''];
      const sbConfig = dirProj?.storyboardConfig;
      const singleAspectRatio = (sbConfig?.aspectRatio || '16:9') as SClassAspectRatio;
      const singleVideoRes = (sbConfig?.videoResolution || '720p') as SClassResolution;

      updateSingleShotVideo(sceneId, {
        videoStatus: "generating",
        videoProgress: 0,
        videoError: null,
      });

      try {
        // 构建 imageWithRoles
        const firstFrameUrl = scene.imageDataUrl || scene.imageHttpUrl || undefined;
        const imageWithRoles = await buildImageWithRoles(
          firstFrameUrl,
          undefined
        );

        const prompt =
          scene.videoPrompt ||
          scene.videoPromptZh ||
          `分镜 ${scene.id + 1} 视频`;
        const duration = Math.max(4, Math.min(15, scene.duration || 5));

        const videoUrl = await callVideoGenerationApi(
          apiKey,
          prompt,
          duration,
          singleAspectRatio,
          imageWithRoles,
          (progress) => {
            updateSingleShotVideo(sceneId, { videoProgress: progress });
          },
          featureConfig.keyManager,
          featureConfig.platform,
          singleVideoRes
        );

        const localUrl = await saveVideoLocally(videoUrl, sceneId);

        updateSingleShotVideo(sceneId, {
          videoStatus: "completed",
          videoProgress: 100,
          videoUrl: localUrl,
          videoError: null,
        });

        toast.success(`分镜 ${sceneId + 1} 生成完成`);
        return true;
      } catch (error) {
        const err = error as Error;
        updateSingleShotVideo(sceneId, {
          videoStatus: "failed",
          videoProgress: 0,
          videoError: err.message,
        });
        toast.error(`分镜 ${sceneId + 1} 生成失败: ${err.message}`);
        return false;
      }
    },
    [
      splitScenes,
      activeProjectId,
      getProjectData,
      updateSingleShotVideo,
    ]
  );

  // ========== 中止 ==========

  const abortGeneration = useCallback(() => {
    abortRef.current = true;
    toast.info("正在中止生成...");
  }, []);

  // ========== 重试单组 ==========

  const retryGroup = useCallback(
    async (groupId: string): Promise<GroupGenerationResult | null> => {
      const projectId = activeProjectId;
      if (!projectId) return null;

      const projectData = getProjectData(projectId);
      const group = projectData.shotGroups.find((g) => g.id === groupId);
      if (!group) return null;

      // 重置状态
      updateGroupVideoStatus(groupId, {
        videoStatus: "idle",
        videoProgress: 0,
        videoError: null,
      });

      // 查找前组的 videoUrl（链式衔接）
      let prevVideoUrl: string | undefined;
      const allGroups = projectData.shotGroups;
      const idx = allGroups.findIndex(g => g.id === groupId);
      if (idx > 0 && allGroups[idx - 1].videoUrl) {
        prevVideoUrl = allGroups[idx - 1].videoUrl!;
      }

      return generateGroupVideo(group, { prevVideoUrl });
    },
    [activeProjectId, getProjectData, updateGroupVideoStatus, generateGroupVideo]
  );

  // ========== 链式延长 ==========

  /**
   * 基于已完成组创建延长子组并生成视频
   *
   * @param sourceGroupId 来源组 ID（必须已完成且有 videoUrl）
   * @param extendDuration 延长时长 (4-15s)
   * @param direction 延长方向
   * @param description 用户补充描述（可选）
   */
  const generateChainExtension = useCallback(
    async (
      sourceGroupId: string,
      extendDuration: number = 10,
      direction: 'backward' | 'forward' = 'backward',
      description?: string,
    ): Promise<GroupGenerationResult | null> => {
      const projectId = activeProjectId;
      if (!projectId) {
        toast.error('无活跃项目');
        return null;
      }

      const pd = getProjectData(projectId);
      const sourceGroup = pd.shotGroups.find(g => g.id === sourceGroupId);
      if (!sourceGroup || !sourceGroup.videoUrl) {
        toast.error('源组无已完成视频，无法延长');
        return null;
      }

      // 创建延长子组
      const childId = `extend_${Date.now()}_${sourceGroupId.substring(0, 8)}`;
      const childGroup: ShotGroup = {
        id: childId,
        name: `${sourceGroup.name} - 延长`,
        sceneIds: [...sourceGroup.sceneIds],
        sortIndex: sourceGroup.sortIndex + 0.5,
        totalDuration: Math.max(4, Math.min(15, extendDuration)),
        videoStatus: 'idle',
        videoProgress: 0,
        videoUrl: null,
        videoMediaId: null,
        videoError: null,
        gridImageUrl: null,
        lastPrompt: null,
        mergedPrompt: description || null,
        history: [],
        videoRefs: [],
        audioRefs: [],
        generationType: 'extend',
        extendDirection: direction,
        sourceGroupId,
        sourceVideoUrl: sourceGroup.videoUrl,
      };

      addShotGroup(childGroup);
      toast.info(`已创建延长子组「${childGroup.name}」`);

      return generateGroupVideo(childGroup);
    },
    [activeProjectId, getProjectData, addShotGroup, generateGroupVideo]
  );

  return {
    generateGroupVideo,
    generateAllGroups,
    generateSingleShot,
    abortGeneration,
    retryGroup,
    generateChainExtension,
  };
}
