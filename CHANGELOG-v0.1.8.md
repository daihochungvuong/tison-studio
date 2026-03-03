# v0.1.8 更新日志

## 版本信息
- **版本号**: 0.1.7 → 0.1.8
- **更新日期**: 2026-02-26
- **涉及文件**: 12 个文件，322 行新增，178 行删除

---

## 一、Bug 修复

### 1. 导演面板右侧栏按钮不可见（Bug #3）
- **文件**: `src/components/panels/director/context-panel.tsx`
- **问题**: 场景列表中的操作按钮（添加到分镜、发送场景、添加镜头）使用了 `opacity-0 group-hover:opacity-100`，导致按钮默认隐藏，在某些环境下 hover 失效，用户无法看到或点击按钮。
- **修复**: 移除 `opacity-0 group-hover:opacity-100`，改为 `shrink-0`，按钮始终可见。
- **影响范围**: 3 处按钮（第 773、786、828 行附近）

### 2. 导演面板合并生成——风格与分辨率问题（Bug #1 & #2）
- **文件**: `src/components/panels/director/split-scenes.tsx`、`src/lib/ai/image-generator.ts`
- **结论**: 经与闭源版本（`G:\moyin-creator`）逐行对比，代码逻辑完全一致，非代码 Bug。根因为演示项目（"灌篮少女"）的场景提示词中包含动漫风格描述词，与风格设定产生冲突。
- **处理**: 已将所有尝试修改回退至与闭源版本完全一致。

---

## 二、新功能 & 体验优化

### 3. 魔因API供应商——令牌分组配置醒目提示
- **文件**: `src/components/api-manager/AddProviderDialog.tsx`
- **改动**: 选择魔因API平台时，在 API Key 输入区域下方显示红色背景（`bg-red-600`）、白色文字的醒目提示框，提醒用户创建令牌时必须添加以下 4 个分组：
  - **图片**: 限时特价、优质gemini
  - **视频**: 官转、auto
- **样式**: `rounded-md bg-red-600 p-3 text-xs text-white`，标题使用 `font-bold text-sm`

### 4. 魔因API默认功能绑定自动配置
- **文件**: `src/components/panels/SettingsPanel.tsx`
- **改动**: 当编辑/保存魔因API供应商时，自动为以下功能绑定默认模型：
  - `script_analysis` → `deepseek-v3.2`
  - `character_generation` → `gemini-3-pro-image-preview`
  - `video_generation` → `doubao-seedance-1-5-pro-251215`
  - `image_understanding` → `gemini-2.5-flash`
- **触发时机**: 供应商保存时自动应用，无需手动配置

### 5. 功能绑定推荐文案更新
- **文件**: `src/components/api-manager/FeatureBindingPanel.tsx`
- **改动**: 更新了魔因API的功能绑定推荐说明文案

---

## 三、图片生成 — SSE 响应兼容性增强

### 6. image-generator 响应解析增强
- **文件**: `src/lib/ai/image-generator.ts`
- **问题**: 部分 API 返回的响应为 SSE（Server-Sent Events）`data:` 格式而非标准 JSON，导致解析失败。
- **改动**:
  - 请求体新增 `stream: false` 参数
  - 新增鲁棒性解析逻辑：先尝试标准 JSON 解析，失败后尝试从 SSE `data:` 行中提取并重建完整响应
  - 支持 delta 模式的增量内容拼接
  - 解析失败时提供明确错误信息

---

## 四、API 路由 & 端点映射扩展

### 7. Kling 相关端点映射扩展
- **文件**: `src/lib/api-key-manager.ts`
- **改动**: 图片和视频端点映射新增多个端点类型：
  - 图片端点新增: `gemini`、`kling生图`、`omni-image`、`文生图`
  - 视频端点新增: Kling 相关映射

### 8. 视频 API 格式路由优化
- **文件**: `src/components/panels/director/use-video-generation.ts`
- **改动**: `detectVideoApiFormat` 函数将 `seedance`/`doubao` 模型识别为 `volc`（火山引擎）格式

### 9. 自由创作面板 Kling & 火山引擎路由增强
- **文件**: `src/lib/freedom/freedom-api.ts`
- **改动**:
  - Kling 图片路由检测增强：支持通过模型前缀或精确端点名（`Kling生图`、`omni-image`、`文生图`）匹配
  - 视频路由检测增强：`seedance`/`doubao` 归类为 `volc` 格式
  - 火山引擎视频内容组装优化：上传时包含首帧/尾帧图片

---

## 五、数据迁移 & 存储优化

### 10. api-config-store 多版本迁移重构
- **文件**: `src/stores/api-config-store.ts`
- **改动**: 重构了完整的多版本数据迁移链：
  - **v0/v1 → v2**: `apiKeys` 迁移为 `providers` 结构，设置默认值
  - **v2 → v3**: 确保 `providers` 和 `bindings` 存在
  - **v3/v4**: 确保 RunningHub/AppId 对齐
  - **v4/v5 → v6**: 功能绑定从 `string` 转换为 `string[]`（多选支持）
  - **v6/v7**: 移除废弃供应商，清理绑定关系
  - **v8 → v9**: 绑定键格式从 `platform:model` 转换为 `id:model`，处理歧义
  - 最终确保 `featureBindings` 存在且值为规范化的 `string[]` 格式
  - 维护 `imageHostProviders` 数据完整性
  - 各迁移步骤均包含详细日志输出

---

## 六、图床配置优化

### 11. 添加图床对话框默认值优化
- **文件**: `src/components/image-host-manager/AddImageHostDialog.tsx`
- **改动**: 默认预设初始化从硬编码 `imgbb` 改为使用预设值，扩展了默认启用参数

### 12. 图床对话框保存按钮被遮挡修复
- **文件**: `src/components/image-host-manager/AddImageHostDialog.tsx`
- **问题**: 图床添加对话框中高级配置参数较多，在低分辨率屏幕下内容超出视口高度，导致底部的保存/取消按钮不可见，用户无法完成配置。
- **修复**: `DialogContent` 添加 `max-h-[85vh] flex flex-col` 限制最大高度；内容区域添加 `overflow-y-auto` 使其可滚动，保存按钮始终固定在底部可见。

---

## 涉及文件清单

| # | 文件路径 | 改动类型 |
|---|---------|---------|
| 1 | `package.json` | 版本号 → 0.1.8 |
| 2 | `src/components/api-manager/AddProviderDialog.tsx` | 新增魔因API提示 |
| 3 | `src/components/api-manager/FeatureBindingPanel.tsx` | 推荐文案更新 |
| 4 | `src/components/image-host-manager/AddImageHostDialog.tsx` | 默认值优化 |
| 5 | `src/components/panels/SettingsPanel.tsx` | 自动绑定 + 版本号 |
| 6 | `src/components/panels/director/context-panel.tsx` | 按钮可见性修复 |
| 7 | `src/components/panels/director/split-scenes.tsx` | 回退至闭源版本 |
| 8 | `src/components/panels/director/use-video-generation.ts` | 视频格式路由 |
| 9 | `src/lib/ai/image-generator.ts` | SSE 响应兼容 |
| 10 | `src/lib/api-key-manager.ts` | 端点映射扩展 |
| 11 | `src/lib/freedom/freedom-api.ts` | Kling/火山路由 |
| 12 | `src/stores/api-config-store.ts` | 迁移链重构 |
