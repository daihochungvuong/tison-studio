# Changelog

## v0.1.3 — 重大修复：角色一致性+生成稳定性大提升，批量性更加顺畅

### ⭐ S级板块 — 分镜卡片架构升级 (split-scene-card)

```
分镜卡片 (split-scene-card)
│
├─ [角色库] → characterIds ──────────────────┐
├─ [场景参考] → sceneReferenceImage ─────────┤  自动收集
├─ [从素材库] → imageDataUrl (替换首帧) ─────┤
├─ [AI生成] → imageDataUrl (生成首帧) ───────┤
│                                             ▼
│                              GroupRefManager (@引用素材)
│                              ├── 图片: 角色+场景+首帧 (自动, ≤9)
│                              ├── 视频: 运镜参考 (手动上传, ≤3)
│                              └── 音频: BGM参考 (手动上传, ≤3)
│                                             │
│                                             ▼
│                              collectAllRefs() → 组装 API 请求
│                              ├── @Image1 = 格子图 / 首帧
│                              ├── @Image2~9 = 角色+场景参考
│                              ├── @Video1~3 = 运镜参考
│                              └── @Audio1~3 = BGM
│                                             │
│                                             ▼
└──────────────── S级视频生成 (Seedance 2.0 API) ◀─────────┘
```

### 🎯 核心改进

- **角色一致性大幅提升**：分镜卡片自动收集角色参考图 + 场景参考 + 首帧，统一打包至 GroupRefManager
- **生成稳定性增强**：collectAllRefs() 智能组装 API 请求，自动遵守 Seedance 2.0 参数约束（≤9图 + ≤3视频 + ≤3音频，prompt≤5000字符）
- **批量生成更加顺畅**：优化并发队列与错误恢复机制

### 🐛 修复

- 修复导演板块右侧栏在默认窗口尺寸下不可见的问题（ResizablePanel `min-w-0`）
- 清理废弃供应商（dik3, nanohajimi, apimart, zhipu），添加 v6→v7 数据迁移，已持久化的旧数据自动清除
- 功能绑定面板优化：多选模式、模型分类与搜索

### 🏗️ 架构优化

- **多模态引用管理**：GroupRefManager 统一管理图片/视频/音频引用素材
- **首帧图网格拼接**：N×N 策略自动拼接多角色/场景参考
- **供应商系统精简**：仅保留魔因API (memefast) + RunningHub 两个核心供应商
- 移除全部废弃供应商代码与 UI

### 📦 其他

- 移除 `out/` 构建产物的 git 跟踪
- 内置演示项目（灌篮少女）数据播种机制
- 侧边栏新增帮助链接入口

---

## v0.1.2

- 初始开源版本
- 五大板块：剧本 → 角色 → 场景 → 导演 → S级
- 多供应商 AI 调度 + API Key 轮询
- Seedance 2.0 集成
- Electron + React + TypeScript 技术栈
