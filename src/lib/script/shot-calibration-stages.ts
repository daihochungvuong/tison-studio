// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * 5阶段分镜校准模块
 * 
 * 将 30+ 字段拆分为 5 个独立 AI 调用，避免推理模型 token 耗尽
 * 
 * Stage 1: 叙事骨架 (9 fields) — 景别/运动/时长 + 叙事分析
 * Stage 2: 视觉描述 (6 fields) — 中英文描述 + 角色 + 音频
 * Stage 3: 拍摄控制 (15 fields) — 灯光/景深/器材/角度/焦距等
 * Stage 4: 首帧提示词 (3 fields) — imagePrompt + needsEndFrame
 * Stage 5: 动态+尾帧提示词 (4 fields) — videoPrompt + endFramePrompt
 */

import { processBatched } from '@/lib/ai/batch-processor';
import { getStyleDescription, getMediaType } from '@/lib/constants/visual-styles';
import { buildCinematographyGuidance } from '@/lib/constants/cinematography-profiles';
import { getMediaTypeGuidance } from '@/lib/generation/media-type-tokens';

export interface ShotInputData {
  shotId: string;
  sourceText: string;
  actionSummary: string;
  dialogue?: string;
  characterNames?: string[];
  sceneLocation: string;
  sceneAtmosphere: string;
  sceneTime: string;
  sceneWeather?: string;
  architectureStyle?: string;
  colorPalette?: string;
  eraDetails?: string;
  lightingDesign?: string;
  currentShotSize?: string;
  currentCameraMovement?: string;
  currentDuration?: number;
}

export interface GlobalContext {
  title: string;
  genre?: string;
  era?: string;
  outline: string;
  characterBios: string;
  worldSetting?: string;
  themes?: string[];
  episodeTitle: string;
  episodeSynopsis?: string;
  episodeKeyEvents?: string[];
  episodeRawContent?: string;
  episodeSeason?: string;
  totalEpisodes?: number;
  currentEpisode?: number;
}

export interface CalibrationOptions {
  styleId?: string;
  cinematographyProfileId?: string;
}

/**
 * 5阶段分镜校准主函数
 */
export async function calibrateShotsMultiStage(
  shots: ShotInputData[],
  options: CalibrationOptions,
  globalContext: GlobalContext,
  onStageProgress?: (stage: number, totalStages: number, stageName: string) => void
): Promise<Record<string, any>> {
  const { styleId, cinematographyProfileId } = options;
  const {
    title, genre, era, episodeTitle, episodeSynopsis, episodeKeyEvents,
    totalEpisodes, currentEpisode, episodeSeason
  } = globalContext;

  const styleDesc = getStyleDescription(styleId || 'cinematic');
  const cinematographyGuidance = cinematographyProfileId
    ? buildCinematographyGuidance(cinematographyProfileId)
    : '';
  const contextLine = [
    `《${title}》`, genre || '', era || '',
    totalEpisodes ? `共${totalEpisodes}集` : '',
    `第${currentEpisode}集「${episodeTitle}」`,
    episodeSeason || '',
  ].filter(Boolean).join(' | ');

  // 媒介类型约束（非电影风格时追加）
  const mt = getMediaType(styleId || 'cinematic');
  const mediaTypeHint = mt !== 'cinematic' ? `\n【媒介类型】${getMediaTypeGuidance(mt)}` : '';

  // JSON 解析辅助
  function parseStageJSON(raw: string): Record<string, any> {
    let cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
    }
    const parsed = JSON.parse(cleaned);
    return parsed.shots || parsed || {};
  }

  // 通用 Stage 执行器：使用 processBatched 自动分批（30+ shots 时自动拆分 sub-batch）
  async function runStage(
    stageName: string,
    buildPrompts: (batch: ShotInputData[]) => { system: string; user: string },
    outputTokensPerItem: number,
    maxTokens: number,
  ): Promise<void> {
    console.log(`[MultiStage] ${stageName}`);
    const { results, failedBatches } = await processBatched<ShotInputData, Record<string, any>>({
      items: shots,
      feature: 'script_analysis',
      buildPrompts,
      parseResult: (raw, batch) => {
        const shotsResult = parseStageJSON(raw);
        const result = new Map<string, Record<string, any>>();
        for (const item of batch) {
          if (shotsResult[item.shotId]) {
            result.set(item.shotId, shotsResult[item.shotId]);
          }
        }
        return result;
      },
      estimateItemOutputTokens: () => outputTokensPerItem,
      apiOptions: { maxTokens },
    });

    for (const shot of shots) {
      const stageResult = results.get(shot.shotId);
      if (stageResult) {
        Object.assign(merged[shot.shotId], stageResult);
      }
    }
    if (failedBatches > 0) {
      console.warn(`[MultiStage] ${stageName}: ${failedBatches} 批次失败`);
    }
  }

  // 初始化合并结果
  const merged: Record<string, any> = {};
  for (const shot of shots) {
    merged[shot.shotId] = {};
  }

  // ===================== Stage 1: 叙事骨架 =====================
  onStageProgress?.(1, 5, '叙事骨架');
  console.log('[MultiStage] Stage 1/5: 叙事骨架');

  const s1System = `你是电影叙事分析师，精通镜头语言和叙事结构。分析每个分镜的叙事功能并确定镜头参数。

${contextLine}${episodeSynopsis ? `\n本集大纲：${episodeSynopsis}` : ''}${episodeKeyEvents?.length ? `\n关键事件：${episodeKeyEvents.join('、')}` : ''}

为每个分镜输出 JSON：
- shotSize: ECU/CU/MCU/MS/MLS/LS/WS/FS
- cameraMovement: none/static/tracking/orbit/zoom-in/zoom-out/pan-left/pan-right/tilt-up/tilt-down/dolly-in/dolly-out/truck-left/truck-right/crane-up/crane-down/drone-aerial/360-roll
- specialTechnique: none/hitchcock-zoom/timelapse/crash-zoom-in/crash-zoom-out/whip-pan/bullet-time/fpv-shuttle/macro-closeup/first-person/slow-motion/probe-lens/spinning-tilt
- duration: 秒数(整数)，纯动作3-5秒/简短对白4-6秒/长对白6-10秒/复杂动作5-8秒
- narrativeFunction: 铺垫/升级/高潮/转折/过渡/尾声
- shotPurpose: 一句话说明（中文）
- visualFocus: 视觉焦点顺序（用→表示）
- cameraPosition: 机位描述（中文）
- characterBlocking: 人物布局（中文）
- rhythm: 节奏感（中文）

格式：{"shots":{"shot_id":{...}}}`

  try {
    await runStage('Stage 1/5: 叙事骨架', (batch) => {
      const userShots = batch.map(s => {
        const chars = s.characterNames?.join('、') || '无';
        return `ID: ${s.shotId}\n场景: ${s.sceneLocation} | 时间: ${s.sceneTime}${s.sceneWeather ? ` | 天气: ${s.sceneWeather}` : ''}\n原文: ${s.sourceText || s.actionSummary}${s.dialogue ? `\n对白: 「${s.dialogue}」` : ''}\n角色: ${chars} | 氛围: ${s.sceneAtmosphere}\n当前: 景别=${s.currentShotSize || '?'} 运动=${s.currentCameraMovement || '?'}`;
      }).join('\n\n---\n\n');
      return { system: s1System, user: `分析以下分镜：\n\n${userShots}` };
    }, 200, 4096);
  } catch (e) {
    console.error('[MultiStage] Stage 1 failed:', e);
  }

  // ===================== Stage 2: 视觉描述 + 音频 =====================
  onStageProgress?.(2, 5, '视觉描述');
  console.log('[MultiStage] Stage 2/5: 视觉描述');

  const s2System = `你是影视视觉描述师。基于原始剧本文本和叙事分析，生成视觉描述和音频设计。

⚠️ 规则：
- 场景归属绝对固定：主场景不可更改，闪回用"画面叠加"描述
- 角色列表必须完整来自原文，不增不减
- visualDescription: 纯中文，详细画面描述
- visualPrompt: 纯英文，40词内，AI绘图用
- emotionTags 选项: happy/sad/angry/surprised/fearful/calm/tense/excited/mysterious/romantic/funny/touching/serious/relaxed/playful/gentle/passionate/low
- ambientSound/soundEffect: 纯中文

格式：{"shots":{"shot_id":{"visualDescription":"","visualPrompt":"","characterNames":[],"emotionTags":[],"ambientSound":"","soundEffect":""}}}`;

  try {
    await runStage('Stage 2/5: 视觉描述', (batch) => {
      const userShots = batch.map(s => {
        const prev = merged[s.shotId] || {};
        const hasFlashback = /闪回|叠画|回忆|穿插/.test(s.sourceText || '');
        return `ID: ${s.shotId}\n【主场景（不可更改）】: ${s.sceneLocation}${hasFlashback ? ' ⚠️含闪回，主场景不变！' : ''}\n原文: ${s.sourceText || s.actionSummary}${s.dialogue ? `\n对白: 「${s.dialogue}」` : ''}\n角色: ${s.characterNames?.join('、') || '无'}\n叙事: 景别=${prev.shotSize || '?'} | 功能=${prev.narrativeFunction || '?'} | 目的=${prev.shotPurpose || '?'}\n焦点: ${prev.visualFocus || '?'} | 布局: ${prev.characterBlocking || '?'}`;
      }).join('\n\n---\n\n');
      return { system: s2System, user: `请生成视觉描述：\n\n${userShots}` };
    }, 200, 4096);
  } catch (e) {
    console.error('[MultiStage] Stage 2 failed:', e);
  }

  // ===================== Stage 3: 拍摄控制 =====================
  onStageProgress?.(3, 5, '拍摄控制');
  console.log('[MultiStage] Stage 3/5: 拍摄控制');

  const s3System = `你是电影摄影指导(DP)。根据视觉描述确定专业拍摄参数。${cinematographyGuidance ? `\n\n${cinematographyGuidance}` : ''}

为每个分镜输出：
- lightingStyle: natural/high-key/low-key/silhouette/chiaroscuro/neon
- lightingDirection: front/side/back/top/bottom/rim
- colorTemperature: warm-3200K/neutral-5600K/cool-7500K/mixed/golden-hour/blue-hour
- lightingNotes: 中文灯光细节
- depthOfField: shallow/medium/deep/split-diopter
- focusTarget: 中文对焦主体
- focusTransition: none/rack-focus/pull-focus/follow-focus
- cameraRig: tripod/handheld/steadicam/dolly/crane/drone/gimbal/shoulder
- movementSpeed: static/slow/normal/fast/whip
- atmosphericEffects: 数组（中文），如["雾气"]
- effectIntensity: subtle/moderate/heavy
- playbackSpeed: slow-0.25x/slow-0.5x/normal/fast-1.5x/fast-2x/timelapse
- cameraAngle: eye-level/low-angle/high-angle/birds-eye/worms-eye/dutch-angle/over-shoulder/pov/aerial
- focalLength: 14mm/18mm/24mm/28mm/35mm/50mm/85mm/100mm-macro/135mm/200mm
- photographyTechnique: long-exposure/double-exposure/high-speed/timelapse-photo/tilt-shift/silhouette/reflection/bokeh (可留空)

格式：{"shots":{"shot_id":{...}}}`;

  try {
    await runStage('Stage 3/5: 拍摄控制', (batch) => {
      const userShots = batch.map(s => {
        const prev = merged[s.shotId] || {};
        const artParts = [
          s.architectureStyle ? `建筑:${s.architectureStyle}` : '',
          s.colorPalette ? `色彩:${s.colorPalette}` : '',
          s.eraDetails ? `时代:${s.eraDetails}` : '',
          s.lightingDesign ? `光影:${s.lightingDesign}` : '',
        ].filter(Boolean);
        return `ID: ${s.shotId}\n场景: ${s.sceneLocation} | 时间: ${s.sceneTime}${s.sceneWeather ? ` | 天气:${s.sceneWeather}` : ''}\n景别: ${prev.shotSize || '?'} | 运动: ${prev.cameraMovement || '?'} | 节奏: ${prev.rhythm || '?'}\n视觉描述: ${prev.visualDescription || '?'}${artParts.length ? `\n场景美术: ${artParts.join(' | ')}` : ''}`;
      }).join('\n\n---\n\n');
      return { system: s3System, user: `请确定拍摄参数：\n\n${userShots}` };
    }, 200, 4096);
  } catch (e) {
    console.error('[MultiStage] Stage 3 failed:', e);
  }

  // ===================== Stage 4: 首帧提示词 =====================
  onStageProgress?.(4, 5, '首帧提示词');
  console.log('[MultiStage] Stage 4/5: 首帧提示词');

  const s4System = `你是AI图像生成专家。根据视觉描述和拍摄参数，生成首帧提示词。

${styleDesc}${mediaTypeHint}

imagePrompt (纯英文, 60-80词) 和 imagePromptZh (纯中文, 60-100字) 必须包含：
a) 场景环境（地点+环境细节+时间氛围）
b) 光线设计（光源+质感+氛围）
c) 人物描述（年龄+服装+表情+姿势，每个角色都写）
d) 构图与景别（景别+人物位置关系+焦点）
e) 重要道具（关键道具+状态）
f) 画面风格（电影感/色调）

⚠️ imagePrompt 必须100%纯英文，禁止任何中文字符
⚠️ imagePromptZh 必须纯中文

needsEndFrame 判断：
- true: 人物位置变化/动作序列/物品状态变化/镜头运动(非Static)
- false: 纯对白+位置不变/仅微表情
- 不确定时设 true

格式：{"shots":{"shot_id":{"imagePrompt":"","imagePromptZh":"","needsEndFrame":true}}}`;

  try {
    await runStage('Stage 4/5: 首帧提示词', (batch) => {
      const userShots = batch.map(s => {
        const prev = merged[s.shotId] || {};
        return `ID: ${s.shotId}\n景别: ${prev.shotSize || '?'} | 角度: ${prev.cameraAngle || '?'} | 焦距: ${prev.focalLength || '?'}\n运动: ${prev.cameraMovement || '?'}\n视觉描述: ${prev.visualDescription || '?'}\n角色: ${(prev.characterNames || s.characterNames || []).join('、')}\n灯光: ${prev.lightingStyle || '?'}, ${prev.lightingDirection || '?'}, ${prev.colorTemperature || '?'}\n景深: ${prev.depthOfField || '?'} | 焦点: ${prev.focusTarget || '?'}\n大气: ${(prev.atmosphericEffects || []).join(',')}${prev.lightingNotes ? `\n灯光备注: ${prev.lightingNotes}` : ''}`;
      }).join('\n\n---\n\n');
      return { system: s4System, user: `请生成首帧提示词：\n\n${userShots}` };
    }, 400, 8192);
  } catch (e) {
    console.error('[MultiStage] Stage 4 failed:', e);
  }

  // ===================== Stage 5: 动态 + 尾帧提示词 =====================
  onStageProgress?.(5, 5, '动态+尾帧提示词');
  console.log('[MultiStage] Stage 5/5: 动态+尾帧提示词');

  const s5System = `你是AI视频生成专家。根据首帧画面，生成视频动作描述和尾帧画面。

videoPrompt (纯英文) / videoPromptZh (纯中文)：
- 描述视频中的动态动作（人物动作、物体移动、镜头运动）
- 强调动词，描述运动过程

endFramePrompt (纯英文, 60-80词) / endFramePromptZh (纯中文, 60-100字)：
仅当 needsEndFrame=true 时生成，否则设为空字符串。
- 描述动作完成后的最终画面
- 包含与首帧相同的场景环境和光线
- 重点描述与首帧的差异（新位置/新姿势/新表情/道具新状态）
- 保持与首帧相同的画面风格

⚠️ 英文字段100%纯英文，中文字段纯中文

格式：{"shots":{"shot_id":{"videoPrompt":"","videoPromptZh":"","endFramePrompt":"","endFramePromptZh":""}}}`;

  try {
    await runStage('Stage 5/5: 动态+尾帧', (batch) => {
      const userShots = batch.map(s => {
        const prev = merged[s.shotId] || {};
        return `ID: ${s.shotId}\n时长: ${prev.duration || '?'}秒 | 运动: ${prev.cameraMovement || '?'}\nneedsEndFrame: ${prev.needsEndFrame ?? true}\n动作: ${s.actionSummary || '?'}${s.dialogue ? `\n对白: 「${s.dialogue}」` : ''}\n首帧(EN): ${prev.imagePrompt || '?'}\n首帧(ZH): ${prev.imagePromptZh || '?'}`;
      }).join('\n\n---\n\n');
      return { system: s5System, user: `请生成视频和尾帧提示词：\n\n${userShots}` };
    }, 400, 8192);
  } catch (e) {
    console.error('[MultiStage] Stage 5 failed:', e);
  }

  console.log('[MultiStage] 全部 5 阶段完成，已校准字段:', Object.keys(merged[shots[0]?.shotId] || {}).length);
  return merged;
}
