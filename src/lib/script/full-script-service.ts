// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * Full Script Service - 完整剧本导入和按集分镜生成服务
 * 
 * 核心功能：
 * 1. 导入完整剧本（包含大纲、人物小传、60集内容）
 * 2. 按集生成分镜（一次生成一集）
 * 3. 更新单集或全部分镜
 * 4. AI校准：为缺失标题的集数生成标题
 */

import type {
  EpisodeRawScript,
  ProjectBackground,
  ScriptData,
  Shot,
  SceneRawContent,
} from "@/types/script";
import {
  parseFullScript,
  convertToScriptData,
} from "./episode-parser";
import { callFeatureAPI } from "@/lib/ai/feature-router";
import { useScriptStore } from "@/stores/script-store";
import { useCharacterLibraryStore } from "@/stores/character-library-store";
import { useAPIConfigStore } from "@/stores/api-config-store";
import { retryOperation } from "@/lib/utils/retry";
import { ApiKeyManager } from "@/lib/api-key-manager";
import { getStyleDescription, getMediaType } from "@/lib/constants/visual-styles";
import { buildCinematographyGuidance } from "@/lib/constants/cinematography-profiles";
import { getMediaTypeGuidance } from "@/lib/generation/media-type-tokens";
import { getVariationForEpisode } from "./character-stage-analyzer";
import { analyzeSceneViewpoints, type ViewpointAnalysisOptions } from "./viewpoint-analyzer";
import { runStaggered } from "@/lib/utils/concurrency";
import { calibrateShotsMultiStage } from "./shot-calibration-stages";

export interface ImportResult {
  success: boolean;
  background: ProjectBackground | null;
  projectBackground?: ProjectBackground; // 兼容字段
  episodes: EpisodeRawScript[];
  scriptData: ScriptData | null;
  error?: string;
}

export interface GenerateShotsOptions {
  apiKey: string;
  provider: string;
  baseUrl?: string;
  styleId: string;
  targetDuration: string;
}

export interface GenerateEpisodeShotsResult {
  shots: Shot[];
  viewpointAnalyzed: boolean;
  viewpointSkippedReason?: string;
}

/**
 * 导入完整剧本
 * @param fullText 完整剧本文本
 * @param projectId 项目ID
 */
export async function importFullScript(
  fullText: string,
  projectId: string
): Promise<ImportResult> {
  try {
    // 1. 解析完整剧本
    const { background, episodes } = parseFullScript(fullText);
    
    if (episodes.length === 0) {
      return {
        success: false,
        background: null,
        episodes: [],
        scriptData: null,
        error: "未能解析出任何集数，请检查剧本格式",
      };
    }
    
    // 2. 转换为 ScriptData 格式
    const scriptData = convertToScriptData(background, episodes);
    
    // 3. 保存到 store
    const store = useScriptStore.getState();
    store.setProjectBackground(projectId, background);
    store.setEpisodeRawScripts(projectId, episodes);
    store.setScriptData(projectId, scriptData);
    store.setRawScript(projectId, fullText);
    store.setParseStatus(projectId, "ready");
    
    // 4. 自动生成项目元数据 MD（作为 AI 生成的全局参考）
    const metadataMd = exportProjectMetadata(projectId);
    store.setMetadataMarkdown(projectId, metadataMd);
    console.log('[importFullScript] 元数据已自动生成，长度:', metadataMd.length);
    
    return {
      success: true,
      background,
      projectBackground: background, // 同时返回两个字段兼容
      episodes,
      scriptData,
    };
  } catch (error) {
    console.error("Import error:", error);
    return {
      success: false,
      background: null,
      episodes: [],
      scriptData: null,
      error: error instanceof Error ? error.message : "导入失败",
    };
  }
}

/**
 * 为单集生成分镜
 * @param episodeIndex 集索引（1-based）
 * @param projectId 项目ID
 * @param options 生成选项
 */
export async function generateEpisodeShots(
  episodeIndex: number,
  projectId: string,
  options: GenerateShotsOptions,
  onProgress?: (message: string) => void
): Promise<GenerateEpisodeShotsResult> {
  const store = useScriptStore.getState();
  const project = store.projects[projectId];
  
  if (!project) {
    throw new Error("项目不存在");
  }
  
  const episodeScript = project.episodeRawScripts.find(
    (ep) => ep.episodeIndex === episodeIndex
  );
  
  if (!episodeScript) {
    throw new Error(`找不到第 ${episodeIndex} 集的剧本`);
  }
  
  // 更新集的生成状态
  store.updateEpisodeRawScript(projectId, episodeIndex, {
    shotGenerationStatus: 'generating',
  });
  
  try {
    onProgress?.(`正在为第 ${episodeIndex} 集生成分镜...`);
    
    // 获取该集对应的场景
    const scriptData = project.scriptData;
    if (!scriptData) {
      throw new Error("剧本数据不存在");
    }
    
    const episode = scriptData.episodes.find((ep) => ep.index === episodeIndex);
    if (!episode) {
      throw new Error(`找不到第 ${episodeIndex} 集的结构数据`);
    }
    
    const episodeScenes = scriptData.scenes.filter((s) =>
      episode.sceneIds.includes(s.id)
    );
    
    // 构建场景内容用于分镜生成
    const scenesWithContent = episodeScenes.map((scene, idx) => {
      const rawScene = episodeScript.scenes[idx];
      return {
        ...scene,
        // 使用原始内容生成分镜
        rawContent: rawScene?.content || '',
        dialogues: rawScene?.dialogues || [],
        actions: rawScene?.actions || [],
      };
    });
    
    // 生成分镜
    const newShots = await generateShotsForEpisode(
      scenesWithContent,
      episodeIndex,
      episode.id,
      scriptData.characters,
      options,
      onProgress
    );
    
    // 更新现有分镜（移除该集旧分镜，添加新分镜）
    const existingShots = project.shots.filter(
      (shot) => shot.episodeId !== episode.id
    );
    const allShots = [...existingShots, ...newShots];
    
    store.setShots(projectId, allShots);
    
    // === AI 视角分析（分镜生成后自动执行）===
    let viewpointAnalyzed = false;
    let viewpointSkippedReason: string | undefined;
    let analysisExecuted = false;
    let viewpointCount = 0;
    
    console.log('\n============================================');
    console.log('[generateEpisodeShots] === 开始 AI 视角分析 ===');
    console.log('[generateEpisodeShots] apiKey:', options.apiKey ? `已配置(长度${options.apiKey.length})` : '未配置');
    console.log('[generateEpisodeShots] provider:', options.provider);
    console.log('[generateEpisodeShots] baseUrl:', options.baseUrl || '默认');
    console.log('[generateEpisodeShots] episodeScenes.length:', episodeScenes.length);
    console.log('[generateEpisodeShots] newShots.length:', newShots.length);
    console.log('============================================\n');
    
    if (!options.apiKey) {
      viewpointSkippedReason = 'apiKey 未配置';
      console.error('[generateEpisodeShots] ❌ 跳过 AI 视角分析: apiKey 未配置');
    } else if (episodeScenes.length === 0) {
      viewpointSkippedReason = '无场景';
      console.warn('[generateEpisodeShots] ⚠️ 跳过 AI 视角分析: 无场景');
    }
    
    if (options.apiKey && episodeScenes.length > 0) {
      onProgress?.(`正在 AI 分析场景视角（共 ${episodeScenes.length} 个场景）...`);
      
      try {
        // 获取本集大纲和关键事件
        const episodeSynopsis = episodeScript.synopsis || '';
        const keyEvents = episodeScript.keyEvents || [];
        
        console.log('[generateEpisodeShots] 本集大纲:', episodeSynopsis ? `已配置(${episodeSynopsis.length}字)` : '未配置');
        console.log('[generateEpisodeShots] 关键事件:', keyEvents.length > 0 ? keyEvents.join(', ') : '未配置');
        
        const background = project.projectBackground;
        const viewpointOptions: ViewpointAnalysisOptions = {
          episodeSynopsis,  // 传入本集大纲
          keyEvents,        // 传入关键事件
          title: background?.title,
          genre: background?.genre,
          era: background?.era,
          worldSetting: background?.worldSetting,
        };
        
        console.log('[generateEpisodeShots] viewpointOptions 已构建, genre:', viewpointOptions.genre || '未知');
        
        // 获取并发数配置（使用顶部静态导入的 store）
        // 智谱 API 并发限制较严，视角分析最多使用 10 个并发
        const userConcurrency = useAPIConfigStore.getState().concurrency || 1;
        const concurrency = Math.min(userConcurrency, 10);
        console.log(`[generateEpisodeShots] 使用并发数: ${concurrency} (用户设置: ${userConcurrency}, 上限: 10)`);
        
        // 为每个场景分析视角（支持并发）
        const updatedScenes = [...scriptData.scenes];
        
        // 准备场景分析任务
        const sceneAnalysisTasks = episodeScenes.map((scene, i) => ({
          scene,
          index: i,
          sceneShots: newShots.filter(s => s.sceneRefId === scene.id),
        })).filter(task => task.sceneShots.length > 0);
        
        console.log(`[generateEpisodeShots] 🚀 待分析场景: ${sceneAnalysisTasks.length} 个，并发数: ${concurrency}`);
        
        // 处理单个场景的函数
        const processScene = async (taskIndex: number) => {
          const task = sceneAnalysisTasks[taskIndex];
          const { scene, index: i, sceneShots } = task;
          
          console.log(`[generateEpisodeShots] 场景 ${i + 1}/${episodeScenes.length}: "${scene.location}" 有 ${sceneShots.length} 个分镜`);
          analysisExecuted = true;
          onProgress?.(`AI 分析场景 ${i + 1}/${episodeScenes.length}: ${scene.location}...`);
          
          console.log(`[generateEpisodeShots] 🔄 调用 analyzeSceneViewpoints for "${scene.location}"...`);
          const result = await analyzeSceneViewpoints(scene, sceneShots, viewpointOptions);
          console.log(`[generateEpisodeShots] ✅ AI 分析完成，返回 ${result.viewpoints.length} 个视角:`, 
            result.viewpoints.map(v => v.name).join(', '));
          console.log(`[generateEpisodeShots] 📝 analysisNote: ${result.analysisNote}`);
          
          return { scene, sceneShots, result };
        };
        
        // 错开启动的并发控制：每5秒启动一个新任务，同时最多 concurrency 个
        const settledResults = await runStaggered(
          sceneAnalysisTasks.map((_, taskIndex) => async () => {
            console.log(`[generateEpisodeShots] 🚀 启动场景 ${taskIndex + 1}/${sceneAnalysisTasks.length}`);
            return await processScene(taskIndex);
          }),
          concurrency,
          5000
        );
        
        // 处理所有结果
        for (const settledResult of settledResults) {
          if (settledResult.status === 'fulfilled') {
            const { scene, sceneShots, result } = settledResult.value;
            
            // 更新场景的视角数据
            const sceneIndex = updatedScenes.findIndex(s => s.id === scene.id);
            if (sceneIndex !== -1) {
              const viewpointsData = result.viewpoints.map((v: any, idx: number) => ({
                id: v.id,
                name: v.name,
                nameEn: v.nameEn,
                shotIds: v.shotIndexes.map((si: number) => sceneShots[si - 1]?.id).filter(Boolean),
                keyProps: v.keyProps,
                gridIndex: idx,
              }));
              
              // 检查是否有未分配的分镜，并将它们分配到合适的视角
              const allAssignedShotIds = new Set(viewpointsData.flatMap((v: any) => v.shotIds));
              const unassignedShots = sceneShots.filter((s: any) => !allAssignedShotIds.has(s.id));
              
              if (unassignedShots.length > 0) {
                console.log(`[generateEpisodeShots] ⚠️ 发现 ${unassignedShots.length} 个未分配的分镜:`, unassignedShots.map((s: any) => s.id));
                
                // 策略：根据分镜内容智能分配到最匹配的视角
                for (const shot of unassignedShots) {
                  const shotText = [
                    shot.actionSummary,
                    shot.visualDescription,
                    shot.visualFocus,
                    shot.dialogue,
                  ].filter(Boolean).join(' ').toLowerCase();
                  
                  // 查找最匹配的视角
                  let bestViewpointIdx = 0;
                  let bestScore = 0;
                  
                  for (let vIdx = 0; vIdx < viewpointsData.length; vIdx++) {
                    const vp = viewpointsData[vIdx];
                    const vpName = vp.name.toLowerCase();
                    const vpKeywords = vp.keyProps || [];
                    
                    let score = 0;
                    const nameKeywords = vpName.replace(/(视角|区|位)$/g, '').split('');
                    for (const char of nameKeywords) {
                      if (shotText.includes(char)) score += 1;
                    }
                    for (const prop of vpKeywords) {
                      if (shotText.includes(prop.toLowerCase())) score += 2;
                    }
                    
                    if (score > bestScore) {
                      bestScore = score;
                      bestViewpointIdx = vIdx;
                    }
                  }
                  
                  if (bestScore === 0) {
                    const overviewIdx = viewpointsData.findIndex((v: any) => 
                      v.name.includes('全景') || v.id === 'overview'
                    );
                    bestViewpointIdx = overviewIdx >= 0 ? overviewIdx : 0;
                  }
                  
                  viewpointsData[bestViewpointIdx].shotIds.push(shot.id);
                  console.log(`[generateEpisodeShots]   - 分镜 ${shot.id} 分配到视角 "${viewpointsData[bestViewpointIdx].name}" (score: ${bestScore})`);
                }
              }
              
              updatedScenes[sceneIndex] = {
                ...updatedScenes[sceneIndex],
                viewpoints: viewpointsData,
              };
              viewpointCount += viewpointsData.length;
              console.log(`[generateEpisodeShots] 💾 场景 "${scene.location}" viewpoints 已更新:`, viewpointsData);
            }
          } else {
            console.error(`[generateEpisodeShots] ❌ 场景分析失败:`, settledResult.reason);
          }
        }
        
        // 跳过无分镜的场景日志
        const skippedScenes = episodeScenes.filter(scene => 
          !sceneAnalysisTasks.find(t => t.scene.id === scene.id)
        );
        for (const scene of skippedScenes) {
          console.log(`[generateEpisodeShots] ⏭️ 跳过场景 "${scene.location}" (无分镜)`);
        }
        
        // 保存更新后的场景数据
        console.log('\n============================================');
        console.log('[generateEpisodeShots] 📦 保存 AI 视角到 scriptData.scenes...');
        console.log('[generateEpisodeShots] updatedScenes 中有视角的场景:');
        updatedScenes.forEach(s => {
          if (s.viewpoints && s.viewpoints.length > 0) {
            console.log(`  - ${s.location}: ${s.viewpoints.length} 个视角 [${s.viewpoints.map((v: any) => v.name).join(', ')}]`);
          }
        });
        
        store.setScriptData(projectId, {
          ...scriptData,
          scenes: updatedScenes,
        });
        
        console.log('[generateEpisodeShots] ✅ AI 视角已保存到 store');
        console.log('[generateEpisodeShots] 总计 AI 分析视角数:', viewpointCount);
        console.log('============================================\n');
        
        viewpointAnalyzed = analysisExecuted;
        if (!analysisExecuted) {
          viewpointSkippedReason = '无分镜';
        }
        
        onProgress?.(`AI 视角分析完成（${viewpointCount} 个视角）`);
      } catch (e) {
        const err = e as Error;
        console.error('\n============================================');
        console.error('[generateEpisodeShots] ❌ AI 视角分析失败:', err);
        console.error('[generateEpisodeShots] Error name:', err.name);
        console.error('[generateEpisodeShots] Error message:', err.message);
        console.error('[generateEpisodeShots] Error stack:', err.stack);
        console.error('============================================\n');
        viewpointSkippedReason = `AI 分析失败: ${err.message}`;
        // 不影响主流程，但记录详细错误
      }
    }
    
    store.updateEpisodeRawScript(projectId, episodeIndex, {
      shotGenerationStatus: 'completed',
      lastGeneratedAt: Date.now(),
    });
    
    onProgress?.(`第 ${episodeIndex} 集分镜生成完成！共 ${newShots.length} 个分镜`);
    
    return { shots: newShots, viewpointAnalyzed, viewpointSkippedReason };
  } catch (error) {
    store.updateEpisodeRawScript(projectId, episodeIndex, {
      shotGenerationStatus: 'error',
    });
    throw error;
  }
}

/**
 * 为指定集的场景生成分镜
 */
async function generateShotsForEpisode(
  scenes: Array<{
    id: string;
    name?: string;
    location: string;
    time: string;
    atmosphere: string;
    rawContent: string;
    dialogues: Array<{ character: string; parenthetical?: string; line: string }>;
    actions: string[];
  }>,
  episodeIndex: number,
  episodeId: string,
  characters: Array<{ id: string; name: string }>,
  options: GenerateShotsOptions,
  onProgress?: (message: string) => void
): Promise<Shot[]> {
  const shots: Shot[] = [];
  let shotIndex = 1;
  
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    onProgress?.(`处理场景 ${i + 1}/${scenes.length}: ${scene.name || scene.location}`);
    
    // 基于场景内容生成分镜
    const sceneShots = generateShotsFromSceneContent(
      scene,
      episodeId,
      shotIndex,
      characters
    );
    
    shots.push(...sceneShots);
    shotIndex += sceneShots.length;
  }
  
  return shots;
}

/**
 * 基于场景原始内容生成分镜（规则化生成，不依赖AI）
 * 每个对白或动作生成一个分镜
 */
function generateShotsFromSceneContent(
  scene: {
    id: string;
    name?: string;
    location: string;
    time: string;
    atmosphere: string;
    rawContent: string;
    dialogues: Array<{ character: string; parenthetical?: string; line: string }>;
    actions: string[];
  },
  episodeId: string,
  startIndex: number,
  characters: Array<{ id: string; name: string }>
): Shot[] {
  const shots: Shot[] = [];
  let index = startIndex;
  
  // 解析场景内容，按顺序生成分镜
  const lines = scene.rawContent.split('\n').filter(line => line.trim());
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // 跳过人物行和空行（包括 markdown 格式如 **人物：xxx**）
    if (!trimmedLine) continue;
    if (trimmedLine.startsWith('人物') || trimmedLine.startsWith('**人物')) continue;
    // 跳过纯 markdown 格式行（如 **xxx**）
    if (trimmedLine.match(/^\*\*[^人物\*]+\*\*$/)) continue;
    
    // 对白行
    const dialogueMatch = trimmedLine.match(/^([^：:（\([【\n△\*]{1,10})[：:]\s*(?:[（\(]([^）\)]+)[）\)])?\s*(.+)$/);
    if (dialogueMatch) {
      const charName = dialogueMatch[1].trim();
      const parenthetical = dialogueMatch[2]?.trim() || '';
      const dialogueText = dialogueMatch[3].trim();
      
      // 跳过非对白
      if (charName.match(/^[字幕旁白场景人物]/)) continue;
      
      const charId = characters.find(c => c.name === charName)?.id || '';
      
      shots.push(createShot({
        index: index++,
        episodeId,
        sceneRefId: scene.id,
        actionSummary: `${charName}说话`,
        visualDescription: `${scene.location}，${charName}${parenthetical ? `（${parenthetical}）` : ''}说："${dialogueText.slice(0, 50)}${dialogueText.length > 50 ? '...' : ''}"`,
        dialogue: `${charName}${parenthetical ? `（${parenthetical}）` : ''}：${dialogueText}`,
        characterNames: [charName],
        characterIds: charId ? [charId] : [],
        shotSize: dialogueText.length > 30 ? 'MS' : 'CU',
        duration: Math.max(3, Math.ceil(dialogueText.length / 10)),
      }));
      continue;
    }
    
    // 动作行 (△开头)
    if (trimmedLine.startsWith('△')) {
      const actionText = trimmedLine.slice(1).trim();
      
      // 从动作描述中提取可能的角色
      const mentionedChars = characters.filter(c => 
        actionText.includes(c.name)
      );
      
      shots.push(createShot({
        index: index++,
        episodeId,
        sceneRefId: scene.id,
        // 保留完整的原始动作文本，不要截断，便于AI校准时使用
        actionSummary: actionText,
        visualDescription: `${scene.location}，${actionText}`,
        characterNames: mentionedChars.map(c => c.name),
        characterIds: mentionedChars.map(c => c.id),
        shotSize: actionText.includes('全景') || actionText.includes('远') ? 'WS' : 'MS',
        duration: Math.max(2, Math.ceil(actionText.length / 15)),
        ambientSound: detectAmbientSound(actionText, scene.atmosphere),
      }));
      continue;
    }
    
    // 字幕【】
    if (trimmedLine.startsWith('【') && trimmedLine.endsWith('】')) {
      const subtitleText = trimmedLine.slice(1, -1);
      
      // 如果是闪回标记，生成过渡镜头
      if (subtitleText.includes('闪回')) {
        shots.push(createShot({
          index: index++,
          episodeId,
          sceneRefId: scene.id,
          actionSummary: subtitleText,
          visualDescription: `【${subtitleText}】画面渐变过渡`,
          characterNames: [],
          characterIds: [],
          shotSize: 'WS',
          duration: 2,
        }));
        continue;
      }
      
      // 字幕显示
      if (subtitleText.startsWith('字幕')) {
        shots.push(createShot({
          index: index++,
          episodeId,
          sceneRefId: scene.id,
          actionSummary: '字幕显示',
          visualDescription: `画面叠加字幕：${subtitleText.replace('字幕：', '').replace('字幕:', '')}`,
          characterNames: [],
          characterIds: [],
          shotSize: 'WS',
          duration: 3,
        }));
      }
    }
  }
  
  // 如果场景没有生成任何分镜，创建一个默认的建立镜头
  if (shots.length === 0) {
    shots.push(createShot({
      index: index,
      episodeId,
      sceneRefId: scene.id,
      actionSummary: `${scene.name || scene.location} 建立镜头`,
      visualDescription: `${scene.location}，${scene.atmosphere}的氛围`,
      characterNames: [],
      characterIds: [],
      shotSize: 'WS',
      duration: 3,
      ambientSound: detectAmbientSound('', scene.atmosphere),
    }));
  }
  
  return shots;
}

/**
 * 根据集数自动匹配角色的阶段变体
 * 用于分镜生成时自动选择正确版本的角色（如第50集自动用张明中年版）
 */
function matchCharacterVariationsForEpisode(
  characterIds: string[],
  episodeIndex: number
): Record<string, string> {
  const characterVariations: Record<string, string> = {};
  const charLibStore = useCharacterLibraryStore.getState();
  
  for (const charId of characterIds) {
    // 通过 characterLibraryId 查找角色库中的角色
    // 注意：charId 是剧本中的ID，需要找到关联的角色库角色
    const scriptStore = useScriptStore.getState();
    const projects = Object.values(scriptStore.projects);
    
    // 遍历项目找到角色
    for (const project of projects) {
      const scriptChar = project.scriptData?.characters.find(c => c.id === charId);
      if (scriptChar?.characterLibraryId) {
        const libChar = charLibStore.getCharacterById(scriptChar.characterLibraryId);
        if (libChar && libChar.variations.length > 0) {
          // 查找匹配当前集数的阶段变体
          const matchedVariation = getVariationForEpisode(libChar.variations, episodeIndex);
          if (matchedVariation) {
            characterVariations[charId] = matchedVariation.id;
            console.log(`[VariationMatch] 角色 ${scriptChar.name} 第${episodeIndex}集 -> 使用变体 "${matchedVariation.name}"`);
          }
        }
        break;
      }
    }
  }
  
  return characterVariations;
}

/**
 * 从 episodeId 提取集数
 */
function getEpisodeIndexFromId(episodeId: string): number {
  // episodeId 格式为 "ep_X"
  const match = episodeId.match(/ep_(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

/**
 * 创建分镜对象
 */
function createShot(params: {
  index: number;
  episodeId: string;
  sceneRefId: string;
  actionSummary: string;
  visualDescription: string;
  dialogue?: string;
  characterNames: string[];
  characterIds: string[];
  shotSize: string;
  duration: number;
  ambientSound?: string;
  cameraMovement?: string;
}): Shot {
  // 自动匹配角色阶段变体
  const episodeIndex = getEpisodeIndexFromId(params.episodeId);
  const characterVariations = matchCharacterVariationsForEpisode(
    params.characterIds,
    episodeIndex
  );
  
  return {
    id: `shot_${Date.now()}_${params.index}`,
    index: params.index,
    episodeId: params.episodeId,
    sceneRefId: params.sceneRefId,
    actionSummary: params.actionSummary,
    visualDescription: params.visualDescription,
    dialogue: params.dialogue,
    characterNames: params.characterNames,
    characterIds: params.characterIds,
    characterVariations,  // 自动填充的阶段变体映射
    shotSize: params.shotSize,
    duration: params.duration,
    ambientSound: params.ambientSound,
    cameraMovement: params.cameraMovement || 'Static',
    imageStatus: 'idle',
    imageProgress: 0,
    videoStatus: 'idle',
    videoProgress: 0,
  };
}

/**
 * 检测环境音
 */
function detectAmbientSound(text: string, atmosphere: string): string {
  if (text.includes('雨') || atmosphere.includes('雨')) return '雨声';
  if (text.includes('风') || atmosphere.includes('风')) return '风声';
  if (text.includes('海') || text.includes('码头')) return '海浪声、海鸥声';
  if (text.includes('街') || text.includes('市场')) return '街道喧嚣、人声鼎沸';
  if (text.includes('夜') || atmosphere.includes('夜')) return '夜晚寂静、虫鸣';
  if (text.includes('饭') || text.includes('吃')) return '餐具碰撞声';
  return '环境音';
}

/**
 * 更新所有集的分镜
 */
export async function regenerateAllEpisodeShots(
  projectId: string,
  options: GenerateShotsOptions,
  onProgress?: (current: number, total: number, message: string) => void
): Promise<void> {
  const store = useScriptStore.getState();
  const project = store.projects[projectId];
  
  if (!project || !project.episodeRawScripts.length) {
    throw new Error("没有可生成的集");
  }
  
  const totalEpisodes = project.episodeRawScripts.length;
  
  for (let i = 0; i < totalEpisodes; i++) {
    const ep = project.episodeRawScripts[i];
    onProgress?.(i + 1, totalEpisodes, `正在生成第 ${ep.episodeIndex} 集...`);
    
    await generateEpisodeShots(
      ep.episodeIndex,
      projectId,
      options,
      (msg) => onProgress?.(i + 1, totalEpisodes, msg)
    );
  }
}

/**
 * 获取集的生成状态摘要
 */
export function getEpisodeGenerationSummary(projectId: string): {
  total: number;
  completed: number;
  generating: number;
  idle: number;
  error: number;
} {
  const store = useScriptStore.getState();
  const project = store.projects[projectId];
  
  if (!project) {
    return { total: 0, completed: 0, generating: 0, idle: 0, error: 0 };
  }
  
  const episodes = project.episodeRawScripts;
  return {
    total: episodes.length,
    completed: episodes.filter(ep => ep.shotGenerationStatus === 'completed').length,
    generating: episodes.filter(ep => ep.shotGenerationStatus === 'generating').length,
    idle: episodes.filter(ep => ep.shotGenerationStatus === 'idle').length,
    error: episodes.filter(ep => ep.shotGenerationStatus === 'error').length,
  };
}

// ==================== AI 校准功能 ====================

// CalibrationOptions 已不需要，统一从服务映射获取配置
export interface CalibrationOptions {
  // 保留空接口以保持兼容性
}

export interface CalibrationResult {
  success: boolean;
  calibratedCount: number;
  totalMissing: number;
  error?: string;
}

/**
 * 检查集数是否缺失标题
 * 缺失标题的判断标准：标题为空，或只有"第X集"没有冒号后的内容
 */
function isMissingTitle(title: string): boolean {
  if (!title || title.trim() === '') return true;
  // 匹配 "第X集" 或 "第XX集" 但没有后续标题
  const onlyEpisodeNum = /^第[\d一二三四五六七八九十百千]+集$/;
  return onlyEpisodeNum.test(title.trim());
}

/**
 * 获取缺失标题的集数列表
 */
export function getMissingTitleEpisodes(projectId: string): EpisodeRawScript[] {
  const store = useScriptStore.getState();
  const project = store.projects[projectId];
  
  if (!project || !project.episodeRawScripts.length) {
    return [];
  }
  
  return project.episodeRawScripts.filter(ep => isMissingTitle(ep.title));
}

/**
 * 调用 AI API 生成集数标题 - 复用 callChatAPI
 */
async function callAIForTitles(
  episodes: Array<{ index: number; contentSummary: string }>,
  globalContext: {
    title: string;       // 剧名
    outline: string;     // 大纲
    characterBios: string; // 主要人物
    totalEpisodes: number; // 总集数
  }
): Promise<Record<number, string>> {
  const { title, outline, characterBios, totalEpisodes } = globalContext;
  
  const systemPrompt = `你是好莱坞资深编剧，拥有艾美奖最佳编剧提名经历。

你的专业能力：
- 精通剧集命名艺术：能用简短有力的标题捕捉每集核心冲突和情感转折
- 叙事结构把控：理解商战、家族、情感等不同类型剧集的命名风格
- 市场敏感度：知道什么样的标题能吸引观众，提升点击率

你的任务是根据剧本的全局背景和每集内容，为每集生成简短有吸引力的标题。

【剧本信息】
剧名：${title}
总集数：${totalEpisodes}集

【故事大纲】
${outline.slice(0, 1500)}

【主要人物】
${characterBios.slice(0, 1000)}

【要求】
1. 标题要能概括该集的主要内容或转折点
2. 标题长度控制在6-15个字
3. 风格要符合剧本类型（如商战剧用商战术语，武侠剧用江湖气息）
4. 标题之间要有连贯性，体现剧情发展

请以JSON格式返回，格式为：
{
  "titles": {
    "1": "第1集标题",
    "2": "第2集标题"
  }
}`;

  const episodeContents = episodes.map(ep => 
    `第${ep.index}集内容摘要：${ep.contentSummary}`
  ).join('\n\n');
  
  const userPrompt = `请为以下集数生成标题：\n\n${episodeContents}`;
  
  // 统一从服务映射获取配置
  const result = await callFeatureAPI('script_analysis', systemPrompt, userPrompt);
  
  // 解析 JSON 结果
  try {
    // 清理可能的 markdown 标记
    let cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    
    const titles: Record<number, string> = {};
    if (parsed.titles) {
      for (const [key, value] of Object.entries(parsed.titles)) {
        titles[parseInt(key)] = value as string;
      }
    }
    return titles;
  } catch (e) {
    console.error('[calibrate] Failed to parse AI response:', result);
    throw new Error('解析 AI 响应失败');
  }
}

/**
 * 从集内容中提取摘要
 */
function extractEpisodeSummary(episode: EpisodeRawScript): string {
  const parts: string[] = [];
  
  // 取前3个场景的内容摘要
  const scenesToUse = episode.scenes.slice(0, 3);
  for (const scene of scenesToUse) {
    // 场景信息（使用 sceneHeader 代替 location）
    if (scene.sceneHeader) {
      parts.push(`场景：${scene.sceneHeader}`);
    }
    
    // 取前几条对白
    const dialogueSample = scene.dialogues.slice(0, 3).map(d => 
      `${d.character}：${d.line.slice(0, 30)}`
    ).join('\n');
    if (dialogueSample) {
      parts.push(dialogueSample);
    }
    
    // 取前几个动作描写
    const actionSample = scene.actions.slice(0, 2).map(a => a.slice(0, 50)).join('\n');
    if (actionSample) {
      parts.push(actionSample);
    }
  }
  
  // 限制总长度
  const summary = parts.join('\n').slice(0, 800);
  return summary || '（无内容）';
}

/**
 * AI校准：为缺失标题的集数生成标题
 * @param projectId 项目ID
 * @param options AI配置
 * @param onProgress 进度回调
 */
export async function calibrateEpisodeTitles(
  projectId: string,
  _options?: CalibrationOptions, // 不再需要，保留以兼容
  onProgress?: (current: number, total: number, message: string) => void
): Promise<CalibrationResult> {
  const store = useScriptStore.getState();
  const project = store.projects[projectId];
  
  if (!project) {
    return { success: false, calibratedCount: 0, totalMissing: 0, error: '项目不存在' };
  }
  
  // 找出缺失标题的集数
  const missingEpisodes = getMissingTitleEpisodes(projectId);
  const totalMissing = missingEpisodes.length;
  
  if (totalMissing === 0) {
    return { success: true, calibratedCount: 0, totalMissing: 0 };
  }
  
  onProgress?.(0, totalMissing, `找到 ${totalMissing} 集缺失标题，开始校准...`);
  
  // 获取全局背景信息
  const background = project.projectBackground;
  const globalContext = {
    title: background?.title || project.scriptData?.title || '未命名剧本',
    outline: background?.outline || project.scriptData?.logline || '',
    characterBios: background?.characterBios || '',
    totalEpisodes: project.episodeRawScripts.length,
  };
  
  try {
    // 获取用户设置的并发数
    const concurrency = useAPIConfigStore.getState().concurrency || 1;
    const batchSize = 10; // 每批最多 10 集
    let calibratedCount = 0;
    
    // 准备所有批次任务
    const allBatches: { batch: typeof missingEpisodes; batchNum: number; batchData: any[] }[] = [];
    for (let i = 0; i < missingEpisodes.length; i += batchSize) {
      const batch = missingEpisodes.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const batchData = batch.map(ep => ({
        index: ep.episodeIndex,
        contentSummary: extractEpisodeSummary(ep),
      }));
      allBatches.push({ batch, batchNum, batchData });
    }
    
    const totalBatches = allBatches.length;
    console.log(`🚀 [集标题校准] 待处理: ${totalMissing} 集，${totalBatches} 批，并发数: ${concurrency}`);
    
    // 错开启动的并发控制：每5秒启动一个新批次，同时最多 concurrency 个
    let completedBatches = 0;
    const settledBatchResults = await runStaggered(
      allBatches.map(({ batch, batchNum, batchData }) => async () => {
        console.log(`[集标题校准] 🚀 启动批次 ${batchNum}/${totalBatches}`);
        onProgress?.(calibratedCount, totalMissing, `🚀 处理批次 ${batchNum}/${totalBatches}...`);
        
        try {
          const titles = await callAIForTitles(batchData, globalContext);
          completedBatches++;
          console.log(`[集标题校准] ✅ 批次 ${batchNum} 完成，进度: ${completedBatches}/${totalBatches}`);
          return { batch, titles, success: true as const };
        } catch (err) {
          completedBatches++;
          console.error(`[集标题校准] ❌ 批次 ${batchNum} 失败:`, err);
          return { batch, titles: {} as Record<number, string>, success: false as const };
        }
      }),
      concurrency,
      5000
    );
    const results = settledBatchResults
      .filter((r): r is { status: 'fulfilled'; value: any } => r.status === 'fulfilled')
      .map(r => r.value);
    
    // 处理结果
    for (const { batch, titles, success } of results) {
      if (success) {
        for (const ep of batch) {
          const newTitle = titles[ep.episodeIndex];
          if (newTitle) {
            store.updateEpisodeRawScript(projectId, ep.episodeIndex, {
              title: `第${ep.episodeIndex}集：${newTitle}`,
            });
            
            const scriptData = store.projects[projectId]?.scriptData;
            if (scriptData) {
              const epData = scriptData.episodes.find(e => e.index === ep.episodeIndex);
              if (epData) {
                epData.title = `第${ep.episodeIndex}集：${newTitle}`;
                store.setScriptData(projectId, { ...scriptData });
              }
            }
            
            calibratedCount++;
          }
        }
      }
    }
    
    onProgress?.(calibratedCount, totalMissing, `已校准 ${calibratedCount}/${totalMissing} 集`);
    
    return {
      success: true,
      calibratedCount,
      totalMissing,
    };
  } catch (error) {
    console.error('[calibrate] Error:', error);
    return {
      success: false,
      calibratedCount: 0,
      totalMissing,
      error: error instanceof Error ? error.message : '校准失败',
    };
  }
}

// ==================== AI 分镜校准功能 ====================

export interface ShotCalibrationOptions {
  apiKey: string;
  provider: string;
  baseUrl?: string;
  model?: string;  // 可选指定模型
  styleId?: string;  // 风格标识，影响visualPrompt生成
  cinematographyProfileId?: string;  // 摄影风格档案 ID，影响拍摄控制字段默认值
}

export interface ShotCalibrationResult {
  success: boolean;
  calibratedCount: number;
  totalShots: number;
  error?: string;
}

/**
 * AI校准分镜：优化中文描述、生成英文visualPrompt、优化镜头设计
 */
export async function calibrateEpisodeShots(
  episodeIndex: number,
  projectId: string,
  options: ShotCalibrationOptions,
  onProgress?: (current: number, total: number, message: string) => void,
  filterSceneId?: string,
): Promise<ShotCalibrationResult> {
  const store = useScriptStore.getState();
  const project = store.projects[projectId];
  
  if (!project) {
    return { success: false, calibratedCount: 0, totalShots: 0, error: '项目不存在' };
  }
  
  // 找到该集的分镜
  const scriptData = project.scriptData;
  if (!scriptData) {
    return { success: false, calibratedCount: 0, totalShots: 0, error: '剧本数据不存在' };
  }
  
  const episode = scriptData.episodes.find(ep => ep.index === episodeIndex);
  if (!episode) {
    return { success: false, calibratedCount: 0, totalShots: 0, error: `找不到第 ${episodeIndex} 集` };
  }
  
  // 获取该集的所有分镜（可选：只校准指定场景的分镜）
  let episodeShots = project.shots.filter(shot => shot.episodeId === episode.id);
  if (filterSceneId) {
    episodeShots = episodeShots.filter(shot => shot.sceneRefId === filterSceneId);
  }
  const totalShots = episodeShots.length;
  
  if (totalShots === 0) {
    return { success: false, calibratedCount: 0, totalShots: 0, error: '该集没有分镜' };
  }
  
  onProgress?.(0, totalShots, `开始校准第 ${episodeIndex} 集的 ${totalShots} 个分镜...`);
  
  // 获取全局背景信息
  const background = project.projectBackground;
  const episodeScript = project.episodeRawScripts.find(ep => ep.episodeIndex === episodeIndex);
  
  // 提取该集的原始剧本内容（对白+动作）
  const episodeRawContent = episodeScript?.rawContent || '';
  
  const globalContext = {
    title: background?.title || project.scriptData?.title || '未命名剧本',
    genre: background?.genre || '',
    era: background?.era || '',
    outline: background?.outline || '',
    characterBios: background?.characterBios || '',
    worldSetting: background?.worldSetting || '',
    themes: background?.themes || [],
    episodeTitle: episode.title,
    episodeSynopsis: episodeScript?.synopsis || '',  // 使用每集大纲
    episodeKeyEvents: episodeScript?.keyEvents || [],  // 关键事件
    episodeRawContent,  // 该集原始剧本内容（完整对白、动作描写）
    episodeSeason: episodeScript?.season,  // 本集季节
    totalEpisodes: project.episodeRawScripts.length,
    currentEpisode: episodeIndex,
  };
  
  // 构建原始场景天气映射（从原始解析的场景中获取 weather）
  const rawSceneWeatherMap = new Map<string, string>();
  if (episodeScript?.scenes) {
    for (const rawScene of episodeScript.scenes) {
      if (rawScene.weather) {
        // 用场景头做 key
        rawSceneWeatherMap.set(rawScene.sceneHeader, rawScene.weather);
      }
    }
  }
  
  try {
    // 获取用户设置的并发数
    const concurrency = useAPIConfigStore.getState().concurrency || 1;
    const batchSize = 5; // 每个 AI 调用处理 5 个分镜
    let calibratedCount = 0;
    const updatedShots: Shot[] = [...project.shots];
    
    // 准备所有批次任务
    const allBatches: { batch: Shot[]; batchNum: number; batchData: any[] }[] = [];
    for (let i = 0; i < episodeShots.length; i += batchSize) {
      const batch = episodeShots.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      
      // 准备批次数据
      const batchData = batch.map(shot => {
        const scene = scriptData.scenes.find(s => s.id === shot.sceneRefId);
        let sourceText = shot.actionSummary || '';
        if (shot.dialogue) {
          sourceText += `\n对白：「${shot.dialogue}」`;
        }
        // 尝试查找场景对应的天气
        let sceneWeather = '';
        for (const [header, weather] of rawSceneWeatherMap) {
          if (scene?.location && header.includes(scene.location.replace(/\s+/g, ''))) {
            sceneWeather = weather;
            break;
          }
        }
        return {
          shotId: shot.id,
          sourceText,
          actionSummary: shot.actionSummary,
          dialogue: shot.dialogue,
          characterNames: shot.characterNames,
          sceneLocation: scene?.location || '',
          sceneAtmosphere: scene?.atmosphere || '',
          sceneTime: scene?.time || 'day',
          sceneWeather,
          architectureStyle: scene?.architectureStyle || '',
          colorPalette: scene?.colorPalette || '',
          eraDetails: scene?.eraDetails || '',
          lightingDesign: scene?.lightingDesign || '',
          currentShotSize: shot.shotSize,
          currentCameraMovement: shot.cameraMovement,
          currentDuration: shot.duration,
        };
      });
      
      allBatches.push({ batch, batchNum, batchData });
    }
    
    const totalBatches = allBatches.length;
    console.log(`🚀 [calibrateShots] 待处理: ${totalShots} 个分镜，${totalBatches} 批，并发数: ${concurrency}`);
    
    // 错开启动的并发控制：每5秒启动一个新批次，同时最多 concurrency 个
    let completedBatches = 0;
    const settledBatchResults = await runStaggered(
      allBatches.map(({ batch, batchNum, batchData }) => async () => {
        console.log(`[calibrateShots] 🚀 启动批次 ${batchNum}/${totalBatches}`);
        onProgress?.(calibratedCount, totalShots, `🚀 处理批次 ${batchNum}/${totalBatches}...`);
        
        // 带重试机制的 AI 调用
        let calibrations: Record<string, any> = {};
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            calibrations = await calibrateShotsMultiStage(
              batchData,
              { styleId: options.styleId, cinematographyProfileId: options.cinematographyProfileId },
              globalContext,
              (stage, total, name) => {
                console.log(`[calibrateShots] 批次 ${batchNum}/${totalBatches} - Stage ${stage}/${total}: ${name}`);
                onProgress?.(calibratedCount, totalShots, `批次 ${batchNum} Stage ${stage}/${total}: ${name}`);
              }
            );
            completedBatches++;
            console.log(`[calibrateShots] ✅ 批次 ${batchNum} 完成，进度: ${completedBatches}/${totalBatches}`);
            return { batch, calibrations, success: true as const };
          } catch (err) {
            retryCount++;
            console.warn(`[calibrateShots] 批次 ${batchNum} 失败，重试 ${retryCount}/${maxRetries}:`, err);
            if (retryCount >= maxRetries) {
              console.error(`[calibrateShots] 批次 ${batchNum} 达到最大重试次数，跳过`);
              completedBatches++;
              return { batch, calibrations: {} as Record<string, any>, success: false as const };
            }
            await new Promise(r => setTimeout(r, 2000 * retryCount));
          }
        }
        completedBatches++;
        return { batch, calibrations, success: false as const };
      }),
      concurrency,
      5000
    );
    const results = settledBatchResults
      .filter((r): r is { status: 'fulfilled'; value: any } => r.status === 'fulfilled')
      .map(r => r.value);
    
    // 处理结果
    for (const { batch, calibrations, success } of results) {
      if (success) {
        for (const shot of batch) {
          const calibration = calibrations[shot.id];
          if (calibration) {
            const shotIndex = updatedShots.findIndex(s => s.id === shot.id);
            if (shotIndex !== -1) {
              updatedShots[shotIndex] = {
                ...updatedShots[shotIndex],
                visualDescription: calibration.visualDescription || updatedShots[shotIndex].visualDescription,
                visualPrompt: calibration.visualPrompt || updatedShots[shotIndex].visualPrompt,
                shotSize: calibration.shotSize || updatedShots[shotIndex].shotSize,
                cameraMovement: calibration.cameraMovement || updatedShots[shotIndex].cameraMovement,
                duration: calibration.duration || updatedShots[shotIndex].duration,
                emotionTags: calibration.emotionTags || updatedShots[shotIndex].emotionTags,
                characterNames: calibration.characterNames?.length > 0 
                  ? calibration.characterNames 
                  : updatedShots[shotIndex].characterNames,
                ambientSound: calibration.ambientSound || updatedShots[shotIndex].ambientSound,
                soundEffect: calibration.soundEffect || updatedShots[shotIndex].soundEffect,
                imagePrompt: calibration.imagePrompt || updatedShots[shotIndex].imagePrompt,
                imagePromptZh: calibration.imagePromptZh || updatedShots[shotIndex].imagePromptZh,
                videoPrompt: calibration.videoPrompt || updatedShots[shotIndex].videoPrompt,
                videoPromptZh: calibration.videoPromptZh || updatedShots[shotIndex].videoPromptZh,
                endFramePrompt: calibration.endFramePrompt || updatedShots[shotIndex].endFramePrompt,
                endFramePromptZh: calibration.endFramePromptZh || updatedShots[shotIndex].endFramePromptZh,
                needsEndFrame: calibration.needsEndFrame ?? updatedShots[shotIndex].needsEndFrame,
                narrativeFunction: calibration.narrativeFunction || updatedShots[shotIndex].narrativeFunction,
                shotPurpose: calibration.shotPurpose || updatedShots[shotIndex].shotPurpose,
                visualFocus: calibration.visualFocus || updatedShots[shotIndex].visualFocus,
                cameraPosition: calibration.cameraPosition || updatedShots[shotIndex].cameraPosition,
                characterBlocking: calibration.characterBlocking || updatedShots[shotIndex].characterBlocking,
                rhythm: calibration.rhythm || updatedShots[shotIndex].rhythm,
                // 拍摄控制字段
                lightingStyle: calibration.lightingStyle || updatedShots[shotIndex].lightingStyle,
                lightingDirection: calibration.lightingDirection || updatedShots[shotIndex].lightingDirection,
                colorTemperature: calibration.colorTemperature || updatedShots[shotIndex].colorTemperature,
                lightingNotes: calibration.lightingNotes || updatedShots[shotIndex].lightingNotes,
                depthOfField: calibration.depthOfField || updatedShots[shotIndex].depthOfField,
                focusTarget: calibration.focusTarget || updatedShots[shotIndex].focusTarget,
                focusTransition: calibration.focusTransition || updatedShots[shotIndex].focusTransition,
                cameraRig: calibration.cameraRig || updatedShots[shotIndex].cameraRig,
                movementSpeed: calibration.movementSpeed || updatedShots[shotIndex].movementSpeed,
                atmosphericEffects: calibration.atmosphericEffects || updatedShots[shotIndex].atmosphericEffects,
                effectIntensity: calibration.effectIntensity || updatedShots[shotIndex].effectIntensity,
                playbackSpeed: calibration.playbackSpeed || updatedShots[shotIndex].playbackSpeed,
                cameraAngle: calibration.cameraAngle || updatedShots[shotIndex].cameraAngle,
                focalLength: calibration.focalLength || updatedShots[shotIndex].focalLength,
                photographyTechnique: calibration.photographyTechnique || updatedShots[shotIndex].photographyTechnique,
                specialTechnique: calibration.specialTechnique || updatedShots[shotIndex].specialTechnique,
              };
              calibratedCount++;
            }
          }
        }
      }
    }
    
    onProgress?.(calibratedCount, totalShots, `已校准 ${calibratedCount}/${totalShots} 个分镜`);
    
    // 保存更新后的分镜
    store.setShots(projectId, updatedShots);
    
    return {
      success: true,
      calibratedCount,
      totalShots,
    };
  } catch (error) {
    console.error('[calibrateShots] Error:', error);
    return {
      success: false,
      calibratedCount: 0,
      totalShots,
      error: error instanceof Error ? error.message : '分镜校准失败',
    };
  }
}

/**
 * AI校准单个分镜：用于预告片 Tab 点击单个分镜进行校准
 */
export async function calibrateSingleShot(
  shotId: string,
  projectId: string,
  options: ShotCalibrationOptions,
  onProgress?: (message: string) => void
): Promise<ShotCalibrationResult> {
  const store = useScriptStore.getState();
  const project = store.projects[projectId];
  
  if (!project) {
    return { success: false, calibratedCount: 0, totalShots: 1, error: '项目不存在' };
  }
  
  const scriptData = project.scriptData;
  if (!scriptData) {
    return { success: false, calibratedCount: 0, totalShots: 1, error: '剧本数据不存在' };
  }
  
  // 找到目标分镜
  const shot = project.shots.find(s => s.id === shotId);
  if (!shot) {
    return { success: false, calibratedCount: 0, totalShots: 1, error: `找不到分镜 ${shotId}` };
  }
  
  onProgress?.(`正在校准分镜...`);
  
  // 获取分镜所属的场景和集信息
  const scene = scriptData.scenes.find(s => s.id === shot.sceneRefId);
  const episode = scriptData.episodes.find(ep => ep.id === shot.episodeId);
  const episodeIndex = episode?.index || 1;
  
  // 获取全局背景信息
  const background = project.projectBackground;
  const episodeScript = project.episodeRawScripts.find(ep => ep.episodeIndex === episodeIndex);
  const episodeRawContent = episodeScript?.rawContent || '';
  
  const globalContext = {
    title: background?.title || scriptData?.title || '未命名剧本',
    genre: background?.genre || '',
    era: background?.era || '',
    outline: background?.outline || '',
    characterBios: background?.characterBios || '',
    worldSetting: background?.worldSetting || '',
    themes: background?.themes || [],
    episodeTitle: episode?.title || `第${episodeIndex}集`,
    episodeSynopsis: episodeScript?.synopsis || '',
    episodeKeyEvents: episodeScript?.keyEvents || [],
    episodeRawContent,
    episodeSeason: episodeScript?.season,
    totalEpisodes: project.episodeRawScripts.length,
    currentEpisode: episodeIndex,
  };
  
  try {
    // 准备分镜数据
    let sourceText = shot.actionSummary || '';
    if (shot.dialogue) {
      sourceText += `\n对白：「${shot.dialogue}」`;
    }
    
    // 查找场景天气
    let sceneWeather = '';
    if (episodeScript?.scenes) {
      for (const rawScene of episodeScript.scenes) {
        if (rawScene.weather && scene?.location && rawScene.sceneHeader.includes(scene.location.replace(/\s+/g, ''))) {
          sceneWeather = rawScene.weather;
          break;
        }
      }
    }
    
    const shotData = [{
      shotId: shot.id,
      sourceText,
      actionSummary: shot.actionSummary || '',
      dialogue: shot.dialogue,
      characterNames: shot.characterNames,
      sceneLocation: scene?.location || '',
      sceneAtmosphere: scene?.atmosphere || '',
      sceneTime: scene?.time || 'day',
      sceneWeather,
      // 场景美术设计字段（从AI场景校准获取）
      architectureStyle: scene?.architectureStyle || '',
      colorPalette: scene?.colorPalette || '',
      eraDetails: scene?.eraDetails || '',
      lightingDesign: scene?.lightingDesign || '',
      currentShotSize: shot.shotSize,
      currentCameraMovement: shot.cameraMovement,
      currentDuration: shot.duration,
    }];
    
    // 调用 AI 校准
    const calibrations = await callAIForShotCalibration(shotData, options, globalContext);
    const calibration = calibrations[shot.id];
    
    if (!calibration) {
      return { success: false, calibratedCount: 0, totalShots: 1, error: 'AI 校准未返回结果' };
    }
    
    // 更新分镜
    const updatedShots = project.shots.map(s => {
      if (s.id !== shot.id) return s;
      return {
        ...s,
        visualDescription: calibration.visualDescription || s.visualDescription,
        visualPrompt: calibration.visualPrompt || s.visualPrompt,
        shotSize: calibration.shotSize || s.shotSize,
        cameraMovement: calibration.cameraMovement || s.cameraMovement,
        duration: calibration.duration || s.duration,
        emotionTags: calibration.emotionTags || s.emotionTags,
        characterNames: calibration.characterNames?.length > 0 ? calibration.characterNames : s.characterNames,
        ambientSound: calibration.ambientSound || s.ambientSound,
        soundEffect: calibration.soundEffect || s.soundEffect,
        // 三层提示词系统
        imagePrompt: calibration.imagePrompt || s.imagePrompt,
        imagePromptZh: calibration.imagePromptZh || s.imagePromptZh,
        videoPrompt: calibration.videoPrompt || s.videoPrompt,
        videoPromptZh: calibration.videoPromptZh || s.videoPromptZh,
        endFramePrompt: calibration.endFramePrompt || s.endFramePrompt,
        endFramePromptZh: calibration.endFramePromptZh || s.endFramePromptZh,
        needsEndFrame: calibration.needsEndFrame ?? s.needsEndFrame,
        // 叙事驱动字段
        narrativeFunction: calibration.narrativeFunction || s.narrativeFunction,
        shotPurpose: calibration.shotPurpose || s.shotPurpose,
        visualFocus: calibration.visualFocus || s.visualFocus,
        cameraPosition: calibration.cameraPosition || s.cameraPosition,
        characterBlocking: calibration.characterBlocking || s.characterBlocking,
        rhythm: calibration.rhythm || s.rhythm,
        // 拍摄控制字段
        lightingStyle: calibration.lightingStyle || s.lightingStyle,
        lightingDirection: calibration.lightingDirection || s.lightingDirection,
        colorTemperature: calibration.colorTemperature || s.colorTemperature,
        lightingNotes: calibration.lightingNotes || s.lightingNotes,
        depthOfField: calibration.depthOfField || s.depthOfField,
        focusTarget: calibration.focusTarget || s.focusTarget,
        focusTransition: calibration.focusTransition || s.focusTransition,
        cameraRig: calibration.cameraRig || s.cameraRig,
        movementSpeed: calibration.movementSpeed || s.movementSpeed,
        atmosphericEffects: calibration.atmosphericEffects || s.atmosphericEffects,
        effectIntensity: calibration.effectIntensity || s.effectIntensity,
        playbackSpeed: calibration.playbackSpeed || s.playbackSpeed,
        cameraAngle: calibration.cameraAngle || s.cameraAngle,
        focalLength: calibration.focalLength || s.focalLength,
        photographyTechnique: calibration.photographyTechnique || s.photographyTechnique,
        specialTechnique: calibration.specialTechnique || s.specialTechnique,
      };
    });
    
    store.setShots(projectId, updatedShots);
    onProgress?.(`分镜校准完成`);
    
    return {
      success: true,
      calibratedCount: 1,
      totalShots: 1,
    };
  } catch (error) {
    console.error('[calibrateSingleShot] Error:', error);
    return {
      success: false,
      calibratedCount: 0,
      totalShots: 1,
      error: error instanceof Error ? error.message : '单个分镜校准失败',
    };
  }
}

/**
 * 调用 AI API 校准分镜 - 复用 callChatAPI
 */
async function callAIForShotCalibration(
  shots: Array<{
    shotId: string;
    sourceText: string;        // 原始剧本文本片段（该分镜对应的原文）
    actionSummary: string;
    dialogue?: string;
    characterNames?: string[];
    sceneLocation: string;
    sceneAtmosphere: string;
    sceneTime: string;
    sceneWeather?: string;        // 天气（雨/雪/雾等）
    // 场景美术设计字段（与 ScriptScene 字段名对齐）
    architectureStyle?: string;   // 建筑风格
    colorPalette?: string;        // 色彩基调
    eraDetails?: string;          // 时代特征
    lightingDesign?: string;      // 光影设计
    currentShotSize?: string;
    currentCameraMovement?: string;
    currentDuration?: number;
  }>,
  options: ShotCalibrationOptions,
  globalContext: {
    title: string;
    genre?: string;
    era?: string;
    outline: string;
    characterBios: string;
    worldSetting?: string;
    themes?: string[];
    episodeTitle: string;
    episodeSynopsis?: string;  // 每集大纲
    episodeKeyEvents?: string[];  // 关键事件
    episodeRawContent?: string;  // 该集原始剧本内容
    episodeSeason?: string;      // 本集季节
    totalEpisodes?: number;
    currentEpisode?: number;
  }
): Promise<Record<string, {
  visualDescription: string;
  visualPrompt: string;
  // 三层提示词系统
  imagePrompt: string;      // 首帧提示词（静态描述）
  imagePromptZh: string;    // 首帧提示词中文
  videoPrompt: string;      // 视频提示词（动态动作）
  videoPromptZh: string;    // 视频提示词中文
  endFramePrompt: string;   // 尾帧提示词（静态描述）
  endFramePromptZh: string; // 尾帧提示词中文
  needsEndFrame: boolean;   // 是否需要尾帧
  shotSize: string;
  cameraMovement: string;
  duration: number;         // 时长（秒）
  emotionTags: string[];    // 情绪标签
  characterNames: string[]; // 完整角色列表
  ambientSound: string;     // 环境音
  soundEffect: string;      // 音效
  // === 叙事驱动字段（基于《电影语言的语法》） ===
  narrativeFunction: string;  // 叙事功能：铺垫/升级/高潮/转折/过渡/尾声
  shotPurpose: string;        // 镜头目的：为什么用这个镜头
  visualFocus: string;        // 视觉焦点：观众应该看什么
  cameraPosition: string;     // 机位描述
  characterBlocking: string;  // 人物布局
  rhythm: string;             // 节奏描述
  // === 拍摄控制字段 ===
  lightingStyle?: string;
  lightingDirection?: string;
  colorTemperature?: string;
  lightingNotes?: string;
  depthOfField?: string;
  focusTarget?: string;
  focusTransition?: string;
  cameraRig?: string;
  movementSpeed?: string;
  atmosphericEffects?: string[];
  effectIntensity?: string;
  playbackSpeed?: string;
  cameraAngle?: string;
  focalLength?: string;
  photographyTechnique?: string;
  specialTechnique?: string;
}>> {
  // 不再需要 apiKey/provider/baseUrl，统一从服务映射获取
  const { styleId, cinematographyProfileId } = options;
  const { 
    title, genre, era, outline, characterBios, worldSetting, themes,
    episodeTitle, episodeSynopsis, episodeKeyEvents, episodeRawContent,
    episodeSeason, totalEpisodes, currentEpisode 
  } = globalContext;
  
  // 截取原始剧本内容（避免过长，取前3000字）
  const rawContentPreview = episodeRawContent ? episodeRawContent.slice(0, 3000) : '';
  
  // 使用共享的风格描述函数
  const styleDesc = getStyleDescription(styleId || 'cinematic');
  
  // 摄影风格档案指导文本
  const cinematographyGuidance = cinematographyProfileId
    ? buildCinematographyGuidance(cinematographyProfileId)
    : '';
  
  // 构建更完整的上下文信息
  const contextInfo = [
    `剧名：《${title}》`,
    genre ? `类型：${genre}` : '',
    era ? `时代背景：${era}` : '',
    totalEpisodes ? `总集数：${totalEpisodes}集` : '',
    `当前：第${currentEpisode}集「${episodeTitle}」`,
    episodeSeason ? `季节：${episodeSeason}` : '',
  ].filter(Boolean).join(' | ');
  
  const systemPrompt = `你是世界级顶尖电影摄影大师，精通丹尼艾尔·阿里洪《电影语言的语法》的所有理论，拥有奥斯卡最佳摄影奖经验。

你的核心理念：**镜头不是孤立的画面，而是叙事链条中的一环。每个镜头的景别、运动、时长都必须服务于叙事。**

你的专业能力：
- 精通镜头语言：能准确判断每个镜头的景别、运动方式、光线设计
- **叙事驱动设计**：理解每个镜头在整集故事中的位置和功能，确保镜头设计服务于叙事
- 场面调度：运用三角形原理、内外反拍等技法处理对话场面
- 动态捕捉：能准确判断镜头的起始状态和结束状态是否有显著差异
- AI视频生成经验：深谙 Seedance、Sora、Runway 等 AI 视频模型的工作原理

你的任务是根据剧本全局背景和分镜信息，为每个分镜生成专业的视觉描述和三层提示词。

【剧本信息】
${contextInfo}
${episodeSynopsis ? `
本集大纲：${episodeSynopsis}` : ''}
${episodeKeyEvents && episodeKeyEvents.length > 0 ? `
关键事件：${episodeKeyEvents.join('、')}` : ''}
${worldSetting ? `
世界观：${worldSetting.slice(0, 200)}` : ''}
${themes && themes.length > 0 ? `
主题：${themes.join('、')}` : ''}
${outline ? `
故事背景：${outline.slice(0, 400)}` : ''}
${characterBios ? `
主要人物：${characterBios.slice(0, 400)}` : ''}

【⚠️ 核心原则 - 必须严格遵守】

1. **场景归属绝对固定**（最重要！）：
   - 每个分镜都有一个【主场景】（由 sceneLocation 字段指定），这是**绝对不可更改的**
   - 即使分镜描述中提到了其他场景（如闪回、叠画、回忆画面、穿插镜头），**主场景仍然是 sceneLocation**
   - 闪回/叠画是「当前主场景内的视觉表现手法」，不是场景切换
   - 你生成的所有描述（visualDescription、imagePrompt 等）都必须以**主场景为背景**
   - 如果原文包含闪回/叠画内容，用「画面叠加」「画中画」「主观回忆」等方式描述，而不是描述成另一个场景
   - 例：主场景是"张家客厅"，原文提到"闪回台球厅"，应描述为"张家客厅中，画面叠加台球厅的回忆画面"

2. **严格基于原文**：每个分镜都附带了【原始剧本文本】，你的所有生成内容必须完全基于该原文：
   - 视觉描述必须包含原文中提到的所有关键元素（人物、动作、道具、场景）
   - 不得添加原文中没有的内容
   - 不得混入其他分镜的内容
   - 不得遗漏原文中的重要信息

3. **角色完整识别**：出场角色必须完整来自原文，按出现顺序列出
   - 例：原文"张明与父母吃着饭" → characterNames: ["张明", "张父", "张母"]
   - 禁止遗漏角色，禁止新增原文中没有的角色

3. **中英文分离**：
   - **中文字段**（visualDescription, ambientSound, soundEffect, imagePromptZh, videoPromptZh, endFramePromptZh）：必须是纯中文
   - **英文字段**（visualPrompt, imagePrompt, videoPrompt, endFramePrompt）：必须是100%纯英文，绝对禁止夹杂任何中文字符
   - 如果不确定某个词怎么翻译，用英文描述或近义词代替，但绝不能留中文

4. **时长估算**：根据动作复杂度和对白长度估算合理的分镜时长（秒）
   - 纯动作无对白：3-5秒
   - 简短对白：4-6秒
   - 较长对白：6-10秒
   - 复杂动作序列：5-8秒

5. **音频设计**（必须用中文）：根据原文识别并输出：
   - ambientSound（环境音）：如"窗外鸟鸣"、"餐厅嗨杂声"、"风声"
   - soundEffect（音效）：如"酒杯碎裂声"、"脚步声"、"门关闭声"

【任务】
为每个分镜生成：

**基础字段：**
1. 中文视觉描述 (visualDescription): 详细、有画面感的**纯中文**描述，必须包含原文所有关键元素（环境、人物、动作、道具）
2. 英文视觉描述 (visualPrompt): 用于AI绘图的**纯英文**描述，40词内
3. 景别 (shotSize): ECU/CU/MCU/MS/MLS/LS/WS/FS
4. 镜头运动 (cameraMovement): none/static/tracking/orbit/zoom-in/zoom-out/pan-left/pan-right/tilt-up/tilt-down/dolly-in/dolly-out/truck-left/truck-right/crane-up/crane-down/drone-aerial/360-roll
4b. 特殊拍摄手法 (specialTechnique): none/hitchcock-zoom/timelapse/crash-zoom-in/crash-zoom-out/whip-pan/bullet-time/fpv-shuttle/macro-closeup/first-person/slow-motion/probe-lens/spinning-tilt
5. 时长 (duration): 秒数，整数
6. 情绪标签 (emotionTags): 1-3个情绪标签ID
7. 出场角色 (characterNames): 完整角色列表，来自原文
8. 环境音 (ambientSound): **中文**，根据场景推断
9. 音效 (soundEffect): **中文**，根据动作推断

**叙事驱动字段（重要！必须基于本集大纲分析）：**
10. 叙事功能 (narrativeFunction): 铺垫/升级/高潮/转折/过渡/尾声
11. 镜头目的 (shotPurpose): 为什么用这个镜头？一句话说明
12. 视觉焦点 (visualFocus): 观众应该按什么顺序看？用箭头表示
13. 机位描述 (cameraPosition): 摄影机相对于人物的位置
14. 人物布局 (characterBlocking): 人物在画面中的位置关系
15. 节奏描述 (rhythm): 这个镜头的节奏感

**拍摄控制字段（Cinematography Controls）：**
16. 灯光风格 (lightingStyle): natural/high-key/low-key/silhouette/chiaroscuro/neon
17. 灯光方向 (lightingDirection): front/side/back/top/bottom/rim
18. 色温 (colorTemperature): warm-3200K/neutral-5600K/cool-7500K/mixed/golden-hour/blue-hour
19. 灯光备注 (lightingNotes): 自由文本，中文，补充灯光细节
20. 景深 (depthOfField): shallow/medium/deep/split-diopter
21. 焦点目标 (focusTarget): 自由文本，中文，描述对焦主体
22. 焦点变化 (focusTransition): none/rack-focus/pull-focus/follow-focus
23. 摄影器材 (cameraRig): tripod/handheld/steadicam/dolly/crane/drone/gimbal/shoulder
24. 运动速度 (movementSpeed): static/slow/normal/fast/whip
25. 大气效果 (atmosphericEffects): 数组，可多选，如 ["雾气","烟尘"] 等天气/环境/艺术效果
26. 效果强度 (effectIntensity): subtle/moderate/heavy
27. 播放速度 (playbackSpeed): slow-0.25x/slow-0.5x/normal/fast-1.5x/fast-2x/timelapse
28. 拍摄角度 (cameraAngle): eye-level/low-angle/high-angle/birds-eye/worms-eye/dutch-angle/over-shoulder/pov/aerial
29. 镜头焦距 (focalLength): 14mm/18mm/24mm/28mm/35mm/50mm/85mm/100mm-macro/135mm/200mm
30. 摄影技法 (photographyTechnique): long-exposure/double-exposure/high-speed/timelapse-photo/tilt-shift/silhouette/reflection/bokeh（如不需要特殊技法可留空）

【三层提示词系统 - 重要】

【16. 首帧提示词 (imagePrompt/imagePromptZh): 用于 AI 图像生成，描述视频第一帧的完整静态画面
    **必须包含以下所有元素**（缺一不可）：
    
    a) **场景环境**：
       - 地点类型（家庭餐厅/办公室/街道等）
       - 环境细节（窗外景色、室内陈设、道具布置）
       - 时间氛围（白天/傍晚/夜晚、季节感）
    
    b) **光线设计**：
       - 光源类型（自然光/灯光/混合光）
       - 光线质感（柔和/硬朗/漫射）
       - 光影氛围（温暖/冷色调/明暗对比）
    
    c) **人物描述**（每个出场人物都要写）：
       - 年龄段（青年/中年/老年）
       - 服装概述（休闲装/正装/工作服等）
       - 表情神态（紧张/严肃/微笑/担忧）
       - 姿势动作（坐着/站立/俯身/手持物品）
    
    d) **构图与景别**：
       - 景别描述（中景三人入画/近景半身/特写面部）
       - 人物位置关系（左中右布局、前后关系）
       - 视觉焦点（主体在画面何处）
    
    e) **重要道具**：
       - 剧情关键道具（证书、物品、食物等）
       - 道具状态（手持/放置/展示）
    
    f) **画面风格**：
       - 电影感/写实风格/剧情照质感
       - 色调倾向（温暖/冷色/自然）
    
    - imagePromptZh: 纯中文，60-100字，包含以上所有元素
    - imagePrompt: 纯英文，60-80词，对应中文内容的完整翻译，适合AI图像模型

11. 视频提示词 (videoPrompt/videoPromptZh): 描述视频中的动态内容
    - **必须强调动作**（如"反复观看"、"紧张地吃饭"等动词）
    - 画面动作（人物动作、物体移动）
    - 镜头运动描述
    - 对白提示（如有）
    - videoPromptZh: 纯中文
    - videoPrompt: 纯英文

【18. 尾帧提示词 (endFramePrompt/endFramePromptZh): 用于 AI 图像生成，描述视频最后一帧的完整静态画面
    
    **与首帧同等重要！必须包含以下所有元素**（缺一不可）：
    
    a) **场景环境**：保持与首帧一致的场景，但反映变化后的状态
    
    b) **光线设计**：与首帧保持一致（除非剧情有时间变化）
    
    c) **人物描述**（重点！描述动作完成后的状态）：
       - 同样包含年龄、服装
       - **新的表情神态**（动作完成后的情绪）
       - **新的姿势位置**（动作完成后的位置）
       - 道具的新状态
    
    d) **构图与景别**：
       - 如有镜头运动，描述运动结束后的新景别
       - 人物新的位置关系
    
    e) **变化对比**（核心！）：
       - 明确描述与首帧的差异（位置/动作/表情/道具状态）
    
    f) **画面风格**：与首帧保持一致
    
    - endFramePromptZh: 纯中文，60-100字，包含以上所有元素
    - endFramePrompt: 纯英文，60-80词，对应中文内容的完整翻译

19. 是否需要尾帧 (needsEndFrame):
    **必须设置为 true**：
    - 人物位置变化（走动、起身、坐下等）
    - 动作序列（拿起物品、放下东西等）
    - 状态变化（门打开/关闭、物品移动等）
    - 镜头运动（非Static）
    - 物品状态变化（翻页、收起等）
    
    **可以设置为 false**：
    - 纯对白（位置不变）
    - 仅表情微小变化
    - 完全静态镜头
    
    **不确定时设为 true**（宁可多生成不要遗漏）

【情绪标签选项】
基础情绪: happy, sad, angry, surprised, fearful, calm
氛围情绪: tense, excited, mysterious, romantic, funny, touching
语气情绪: serious, relaxed, playful, gentle, passionate, low

【风格要求】
${styleDesc}
${cinematographyGuidance ? `
${cinematographyGuidance}
` : ''}
${(() => {
  const mt = getMediaType(styleId || 'cinematic');
  return mt !== 'cinematic' ? `
【媒介类型约束】
${getMediaTypeGuidance(mt)}
` : '';
})()}
镜头设计原则：
- 情感对白、内心活动: CU/ECU 近景特写
- 动作场面、追逐: MS/WS + Tracking跟随
- 场景建立、过渡: WS/FS 远景
- 紧张对峙: 快速切换景别
- 重要物件/细节: ECU特写

**重要：中英文字段必须严格分离！**
- visualDescription, ambientSound, soundEffect, imagePromptZh, videoPromptZh, endFramePromptZh → **必须是纯中文**
- visualPrompt, imagePrompt, videoPrompt, endFramePrompt → **必须是纯英文**

请以JSON格式返回，格式为:
{
  "shots": {
    "shot_id_1": {
      "visualDescription": "窗外栩子花绽放，餐桌旁，张明神情紧张地与父母吃饭，父亲手持985研究生毕业证书反复观看。",
      "visualPrompt": "Gardenias blooming outside window, at dining table Zhang Ming eating nervously with parents, father holding graduate certificate examining it repeatedly",
      "shotSize": "MS",
      "cameraMovement": "static",
      "specialTechnique": "none",
      "duration": 5,
      "emotionTags": ["tense", "serious"],
      "characterNames": ["张明", "张父", "张母"],
      "ambientSound": "餐厅环境音，碗筷轻碰声",
      "soundEffect": "",
      "narrativeFunction": "铺垫",
      "shotPurpose": "建立家庭表面和谐但暗藏张力的氛围，用毕业证书暗示父亲对儿子的期望",
      "visualFocus": "窗外栀子花 → 张明紧张的脸 → 父亲手中的证书",
      "cameraPosition": "张明侧后方45°，可见三人关系",
      "characterBlocking": "张明(中) vs 父母(两侧)，形成包围感",
      "rhythm": "缓慢、压抑，营造表面平静下的紧张感",
      "lightingStyle": "natural",
      "lightingDirection": "side",
      "colorTemperature": "warm-3200K",
      "lightingNotes": "午后侧光透过窗户，形成温暖但带有压迫感的明暗对比",
      "depthOfField": "medium",
      "focusTarget": "张明紧张的面部表情",
      "focusTransition": "rack-focus",
      "cameraRig": "tripod",
      "movementSpeed": "static",
      "atmosphericEffects": ["自然光斑"],
      "effectIntensity": "subtle",
      "playbackSpeed": "normal",
      "cameraAngle": "eye-level",
      "focalLength": "50mm",
      "photographyTechnique": "",
      "imagePrompt": "Cinematic medium shot, modern Chinese family dining room, warm afternoon sunlight through window with blooming gardenias outside, young man Zhang Ming (25, casual clothes, tense expression) sitting at dining table with his middle-aged parents, father (50s, stern face, holding graduate certificate examining it), mother (50s, worried look) beside them, wooden dining table with home-cooked dishes, warm color tones, realistic film style",
      "imagePromptZh": "电影感中景，现代中式家庭餐厅，午后温暖阳光透过窗户洒入，窗外栩子花盛开。青年张明（25岁，休闲装，神情紧张）坐在餐桌旁，中年父亲（50多岁，严肃表情，手持985研究生毕业证书反复查看），母亲（50多岁，担忧神情）坐在旁边。木质餐桌上摆着家常菜肴，温暖色调，写实电影风格。",
      "videoPrompt": "Father repeatedly examining graduate certificate with focused attention, Zhang Ming eating nervously with chopsticks, occasionally glancing at father, mother sitting beside watching silently with worried expression",
      "videoPromptZh": "父亲专注地反复观看毕业证书，张明用筷子紧张地吃饭，不时偷瞄父亲，母亲坐在旁边默默看着，神情担忧。",
      "needsEndFrame": true,
      "endFramePrompt": "Cinematic medium shot, same modern Chinese family dining room, warm afternoon light. Father (50s) now lowering the certificate with satisfied yet stern expression, Zhang Ming (25) stopped eating and looking down nervously, mother (50s) glancing between husband and son with concern. Certificate now placed on table beside dishes, tense atmosphere, warm color tones, realistic film style",
      "endFramePromptZh": "电影感中景，同样的现代中式家庭餐厅，午后温暖光线。父亲（50多岁）已放下证书，表情满意但仍严肃；张明（25岁）停下筷子，低头神情紧张；母亲（50多岁）目光在父子之间游移，神情担忧。证书已放在餐桌上菜肴旁边，气氛紧张，温暖色调，写实电影风格。"
    }
  }
}

**特别注意**：
- 栩子花 = gardenias（不是 peonies）
- visualDescription 必须是中文，不要写英文
- ambientSound/soundEffect 必须是中文`
  
  const shotDescriptions = shots.map(shot => {
    const chars = shot.characterNames?.join('、') || '无';
    // 检测是否包含闪回/叠画内容
    const sourceText = shot.sourceText || shot.actionSummary || '';
    const hasFlashback = /闪回|叠画|回忆|穿插/.test(sourceText);
    const flashbackNote = hasFlashback 
      ? `\n⚠️ 注意：原文包含闪回/叠画内容，但主场景仍然是「${shot.sceneLocation}」，不要描述成另一个场景！`
      : '';
    // 构建场景美术设计信息（如果有）
    const artDesignParts = [
      shot.architectureStyle ? `建筑风格: ${shot.architectureStyle}` : '',
      shot.colorPalette ? `色彩基调: ${shot.colorPalette}` : '',
      shot.eraDetails ? `时代特征: ${shot.eraDetails}` : '',
      shot.lightingDesign ? `光影设计: ${shot.lightingDesign}` : '',
    ].filter(Boolean);
    const artDesignSection = artDesignParts.length > 0 
      ? `\n【🎨 场景美术设计（必须严格遵循）】\n${artDesignParts.join('\n')}` 
      : '';
    return `ID: ${shot.shotId}
【⭐ 主场景（绝对不可更改）】: ${shot.sceneLocation}${flashbackNote}${artDesignSection}
【原始剧本文本】
${sourceText}
【已解析信息】
动作: ${shot.actionSummary}
对白: ${shot.dialogue || '无'}
当前角色: ${chars}
氛围: ${shot.sceneAtmosphere}
时间: ${shot.sceneTime}${shot.sceneWeather ? `
天气: ${shot.sceneWeather}` : ''}
当前景别: ${shot.currentShotSize || '待定'}
当前镜头运动: ${shot.currentCameraMovement || '待定'}`;
  }).join('\n\n═══════════════════════════════════════\n\n');
  
  const userPrompt = `请严格基于每个分镜的【原始剧本文本】生成校准内容。

⚠️ 重要提醒（必须遵守）：
1. **场景归属绝对固定**：每个分镜的【主场景】已经标注，即使原文提到闪回/叠画/回忆，主场景仍不变
2. 不要遗漏原文中的任何关键信息（人物、动作、道具、环境）
3. 不要添加原文中没有的内容
4. **中文字段必须是纯中文**：visualDescription, ambientSound, soundEffect, imagePromptZh, videoPromptZh
5. **英文字段必须是纯英文**：visualPrompt, imagePrompt, videoPrompt, endFramePrompt
6. 角色列表必须完整
7. 栩子花 = gardenias（不是 peonies/peony）

🎬 **叙事驱动分析（基于《电影语言的语法》）**：
- 根据「本集大纲」判断每个镜头在整集故事中的叙事功能
- 镜头设计必须服务于故事的情绪节奏和叙事弧线
- 景别选择要配合叙事功能（铺垫用全景、高潮用特写等）
- 考虑人物布局和机位对故事张力的影响

${shotDescriptions}`;
  
  // 统一从服务映射获取配置（单个分镜校准用更大 token 预算）
  const result = await callFeatureAPI('script_analysis', systemPrompt, userPrompt, { maxTokens: 16384 });
  
  // 解析 JSON 结果（增强版）
  try {
    let cleaned = result;
    
    // 移除 markdown 代码块标记
    cleaned = cleaned.replace(/^```json\s*/i, '');
    cleaned = cleaned.replace(/^```\s*/i, '');
    cleaned = cleaned.replace(/\s*```$/i, '');
    cleaned = cleaned.trim();
    
    // 尝试找到 JSON 对象的起止位置
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
    }
    
    const parsed = JSON.parse(cleaned);
    return parsed.shots || {};
  } catch (e) {
    console.error('[calibrateShots] Failed to parse AI response:', result);
    console.error('[calibrateShots] Parse error:', e);
    
    // 尝试部分解析：提取已完成的分镜
    try {
      const partialResult: Record<string, any> = {};
      // 匹配每个 shot 的完整 JSON 对象
      const shotPattern = /"(shot_[^"]+)"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/g;
      let match;
      while ((match = shotPattern.exec(result)) !== null) {
        try {
          const shotId = match[1];
          const shotJson = match[2];
          partialResult[shotId] = JSON.parse(shotJson);
        } catch {
          // 单个 shot 解析失败，继续下一个
        }
      }
      
      if (Object.keys(partialResult).length > 0) {
        console.log(`[calibrateShots] 部分解析成功，恢复了 ${Object.keys(partialResult).length} 个分镜`);
        return partialResult;
      }
    } catch {
      // 部分解析也失败
    }
    
    throw new Error('解析 AI 响应失败');
  }
}

// ==================== AI 生成每集大纲 ====================

export interface SynopsisGenerationResult {
  success: boolean;
  generatedCount: number;
  totalEpisodes: number;
  error?: string;
}

/**
 * AI 生成每集大纲
 * 基于全局背景和每集内容，生成简洁的集大纲
 */
export async function generateEpisodeSynopses(
  projectId: string,
  _options?: CalibrationOptions, // 不再需要，保留以兼容
  onProgress?: (current: number, total: number, message: string) => void
): Promise<SynopsisGenerationResult> {
  const store = useScriptStore.getState();
  const project = store.projects[projectId];
  
  if (!project) {
    return { success: false, generatedCount: 0, totalEpisodes: 0, error: '项目不存在' };
  }
  
  const episodes = project.episodeRawScripts;
  const totalEpisodes = episodes.length;
  
  if (totalEpisodes === 0) {
    return { success: false, generatedCount: 0, totalEpisodes: 0, error: '没有集数据' };
  }
  
  // 获取全局背景
  const background = project.projectBackground;
  const globalContext = {
    title: background?.title || project.scriptData?.title || '未命名剧本',
    genre: background?.genre || '',
    era: background?.era || '',
    worldSetting: background?.worldSetting || '',
    themes: background?.themes || [],
    outline: background?.outline || '',
    characterBios: background?.characterBios || '',
    totalEpisodes,
  };
  
  onProgress?.(0, totalEpisodes, `开始为 ${totalEpisodes} 集生成大纲...`);
  
  try {
    // 获取用户设置的并发数
    const concurrency = useAPIConfigStore.getState().concurrency || 1;
    const batchSize = 5; // 每批最多 5 集
    let generatedCount = 0;
    
    // 准备所有批次任务
    const allBatches: { batch: typeof episodes; batchNum: number; batchData: any[] }[] = [];
    for (let i = 0; i < episodes.length; i += batchSize) {
      const batch = episodes.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const batchData = batch.map(ep => ({
        index: ep.episodeIndex,
        title: ep.title,
        contentSummary: extractEpisodeSummary(ep),
      }));
      allBatches.push({ batch, batchNum, batchData });
    }
    
    const totalBatches = allBatches.length;
    console.log(`🚀 [集大纲生成] 待处理: ${totalEpisodes} 集，${totalBatches} 批，并发数: ${concurrency}`);
    
    // 错开启动的并发控制：每5秒启动一个新批次，同时最多 concurrency 个
    let completedBatches = 0;
    const settledBatchResults = await runStaggered(
      allBatches.map(({ batch, batchNum, batchData }) => async () => {
        console.log(`[集大纲生成] 🚀 启动批次 ${batchNum}/${totalBatches}`);
        onProgress?.(generatedCount, totalEpisodes, `🚀 处理批次 ${batchNum}/${totalBatches}...`);
        
        try {
          const synopses = await callAIForSynopses(batchData, globalContext);
          completedBatches++;
          console.log(`[集大纲生成] ✅ 批次 ${batchNum} 完成，进度: ${completedBatches}/${totalBatches}`);
          return { batch, synopses, success: true as const };
        } catch (err) {
          completedBatches++;
          console.error(`[集大纲生成] ❌ 批次 ${batchNum} 失败:`, err);
          return { batch, synopses: {} as Record<number, { synopsis: string; keyEvents: string[] }>, success: false as const };
        }
      }),
      concurrency,
      5000
    );
    const results = settledBatchResults
      .filter((r): r is { status: 'fulfilled'; value: any } => r.status === 'fulfilled')
      .map(r => r.value);
    
    // 处理结果
    for (const { batch, synopses, success } of results) {
      if (success) {
        for (const ep of batch) {
          const res = synopses[ep.episodeIndex];
          if (res) {
            store.updateEpisodeRawScript(projectId, ep.episodeIndex, {
              synopsis: res.synopsis,
              keyEvents: res.keyEvents,
              synopsisGeneratedAt: Date.now(),
            });
            generatedCount++;
          }
        }
      }
    }
    
    onProgress?.(generatedCount, totalEpisodes, `已生成 ${generatedCount}/${totalEpisodes} 集大纲`);
    
    // 大纲生成完成后，更新项目元数据 MD
    const updatedMetadata = exportProjectMetadata(projectId);
    store.setMetadataMarkdown(projectId, updatedMetadata);
    console.log('[generateSynopses] 元数据已更新，包含新生成的大纲');
    
    return {
      success: true,
      generatedCount,
      totalEpisodes,
    };
  } catch (error) {
    console.error('[generateSynopses] Error:', error);
    return {
      success: false,
      generatedCount: 0,
      totalEpisodes,
      error: error instanceof Error ? error.message : '大纲生成失败',
    };
  }
}

/**
 * 调用 AI 生成集大纲
 */
async function callAIForSynopses(
  episodes: Array<{ index: number; title: string; contentSummary: string }>,
  globalContext: {
    title: string;
    genre: string;
    era?: string;
    worldSetting?: string;
    themes?: string[];
    outline: string;
    characterBios: string;
    totalEpisodes: number;
  }
): Promise<Record<number, { synopsis: string; keyEvents: string[] }>> {
  const { title, genre, era, worldSetting, themes, outline, characterBios, totalEpisodes } = globalContext;
  
  const systemPrompt = `你是好莱坞资深剧本医生(Script Doctor)，擅长分析剧本结构和叙事节奏。

你的专业能力：
- 剧本结构分析：能快速提炼每集的核心冲突、转折点和情感高潮
- 叙事节奏把控：理解不同类型剧集的节奏特点
- 关键事件提取：能准确识别推动剧情发展的关键场景和动作

你的任务是根据剧本全局背景和每集内容，为每集生成简洁的大纲和关键事件。

【剧本信息】
剧名：${title}
类型：${genre || '未知'}
${era ? `时代背景：${era}` : ''}
${worldSetting ? `世界观：${worldSetting.slice(0, 200)}` : ''}
${themes && themes.length > 0 ? `主题：${themes.join('、')}` : ''}
总集数：${totalEpisodes}集

【故事大纲】
${outline.slice(0, 1000)}

【主要人物】
${characterBios.slice(0, 800)}

【要求】
为每集生成：
1. synopsis: 100-200字的集大纲，概括本集主要剧情发展
2. keyEvents: 3-5个关键事件，每个10-20字

注意：
- 大纲要突出本集的核心冲突和转折
- 关键事件要具体、可视觉化
- 保持前后集的连贯性

请以JSON格式返回：
{
  "synopses": {
    "1": {
      "synopsis": "本集大纲...",
      "keyEvents": ["事件1", "事件2", "事件3"]
    }
  }
}`;

  const episodeContents = episodes.map(ep => 
    `第${ep.index}集「${ep.title}」：
${ep.contentSummary}`
  ).join('\n\n---\n\n');
  
  const userPrompt = `请为以下集数生成大纲和关键事件：\n\n${episodeContents}`;
  
  // 统一从服务映射获取配置
  const result = await callFeatureAPI('script_analysis', systemPrompt, userPrompt);
  
  try {
    let cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    
    const synopses: Record<number, { synopsis: string; keyEvents: string[] }> = {};
    if (parsed.synopses) {
      for (const [key, value] of Object.entries(parsed.synopses)) {
        const v = value as { synopsis: string; keyEvents: string[] };
        synopses[parseInt(key)] = {
          synopsis: v.synopsis || '',
          keyEvents: v.keyEvents || [],
        };
      }
    }
    return synopses;
  } catch (e) {
    console.error('[generateSynopses] Failed to parse AI response:', result);
    throw new Error('解析 AI 响应失败');
  }
}

// ==================== 导出项目元数据 MD ====================

/**
 * 导出项目元数据为 Markdown 格式
 * 类似 Cursor 的 .cursorrules，作为项目的知识库
 */
export function exportProjectMetadata(projectId: string): string {
  const store = useScriptStore.getState();
  const project = store.projects[projectId];
  
  if (!project) {
    return '# 错误\n\n项目不存在';
  }
  
  const background = project.projectBackground;
  const episodes = project.episodeRawScripts;
  const scriptData = project.scriptData;
  
  const sections: string[] = [];
  
  // 标题
  const title = background?.title || scriptData?.title || '未命名剧本';
  sections.push(`# 《${title}》`);
  sections.push('');
  
  // 基本信息
  sections.push('## 基本信息');
  if (background?.genre) sections.push(`- **类型**：${background.genre}`);
  if (background?.era) sections.push(`- **时代**：${background.era}`);
  sections.push(`- **总集数**：${episodes.length}集`);
  if (scriptData?.language) sections.push(`- **语言**：${scriptData.language}`);
  sections.push('');
  
  // 故事大纲
  if (background?.outline) {
    sections.push('## 故事大纲');
    sections.push(background.outline);
    sections.push('');
  }
  
  // 世界观设定
  if (background?.worldSetting) {
    sections.push('## 世界观/风格设定');
    sections.push(background.worldSetting);
    sections.push('');
  }
  
  // 主要人物
  if (background?.characterBios) {
    sections.push('## 主要人物');
    sections.push(background.characterBios);
    sections.push('');
  }
  
  // 角色列表（结构化）
  if (scriptData?.characters && scriptData.characters.length > 0) {
    sections.push('## 角色列表');
    for (const char of scriptData.characters) {
      sections.push(`### ${char.name}`);
      if (char.gender) sections.push(`- 性别：${char.gender}`);
      if (char.age) sections.push(`- 年龄：${char.age}`);
      if (char.role) sections.push(`- 身份：${char.role}`);
      if (char.personality) sections.push(`- 性格：${char.personality}`);
      if (char.traits) sections.push(`- 特质：${char.traits}`);
      if (char.relationships) sections.push(`- 关系：${char.relationships}`);
      sections.push('');
    }
  }
  
  // 剧集大纲
  sections.push('## 剧集大纲');
  for (const ep of episodes) {
    sections.push(`### 第${ep.episodeIndex}集：${ep.title.replace(/^第\d+集[：:]？/, '')}`);
    if (ep.synopsis) {
      sections.push(ep.synopsis);
    }
    if (ep.keyEvents && ep.keyEvents.length > 0) {
      sections.push('**关键事件：**');
      for (const event of ep.keyEvents) {
        sections.push(`- ${event}`);
      }
    }
    // 显示场景数量
    sections.push(`> 本集包含 ${ep.scenes.length} 个场景`);
    sections.push('');
  }
  
  // 生成时间
  sections.push('---');
  sections.push(`*导出时间：${new Date().toLocaleString('zh-CN')}*`);
  
  return sections.join('\n');
}

/**
 * 获取缺失大纲的集数
 */
export function getMissingSynopsisEpisodes(projectId: string): EpisodeRawScript[] {
  const store = useScriptStore.getState();
  const project = store.projects[projectId];
  
  if (!project || !project.episodeRawScripts.length) {
    return [];
  }
  
  return project.episodeRawScripts.filter(ep => !ep.synopsis || ep.synopsis.trim() === '');
}
