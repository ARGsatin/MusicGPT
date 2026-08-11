# 拾光电台 Aurora Deck — 前端重构说明

> 分支：`aurora-ui`（commit `c9fa73d`） · Worktree：`D:\MusicGPT\.worktrees\aurora-ui`
> 基于 `main`（fd5b559）开发，主目录代码零改动。

## 这次做了什么

把原有「Neonwave FM 浅色控制台」整体重设计为 **「拾光电台 Aurora Deck」深夜黑胶唱机**，参考原有功能但不照搬界面：

### 新概念与创意

- **黑胶唱机舞台**：封面做成旋转黑胶（播放时转动、暂停即停），唱臂随播放/暂停摆动落下，唱机外圈是发光进度环，点唱片中央可播放/暂停
- **极光氛围背景**：三层缓慢漂移的极光光带 + 漂浮微尘，颜色随天气切换（晴=青金、雨=蓝靛、雪=冷白、云=灰紫、风暴=电紫）
- **悬浮歌词条**：卡拉 OK 式逐行高亮 + 下一行预告；**点击可展开全屏歌词面板**——当前行自动居中滚动高亮，点击任意一句直接跳转播放进度，Esc / ✕ / 点击背景关闭
- **底部信号跑马灯**：曲库数 / AI 状态 / 口味标签 / 天气滚成电台字幕带
- **ON AIR 呼吸灯**、心形收藏弹跳、7 段均衡器随播放律动

### 响应式

| 断点 | 布局 |
|---|---|
| ≥1100px | 左唱机舞台 + 右侧栏（对话/队列 Tab） |
| 720–1100px | 上下堆叠，侧栏限高 560px |
| <720px | 单视图 + 底部 Tab 栏（唱机 / 对话 / 队列），跑马灯隐藏 |

### 保留的能力

全部后端交互不变：流式聊天、逐段 TTS 朗读、音量闪避（ducking）、收藏/反馈、歌词同步、队列、记忆面板、DJ 音色、天气/同步/扩充。可及性标签（`Playback volume`、`Mute`、`收藏当前歌曲`、`自动朗读` 等）与原版一致，并补了 `prefers-reduced-motion` 全面降级。

## 文件结构

```
apps/web/src/
  App.tsx                      # 状态编排（逻辑沿用原版，布局重写）
  styles.css                   # 全新设计系统（暗色极光）
  components/
    AmbientBackdrop.tsx        # 极光背景 + 天气变色 + 微尘
    TurntableStage.tsx         # 唱机舞台（播放器全部交互 + 歌词条）
    LyricsOverlay.tsx          # 全屏歌词面板（点句跳转进度）
    ChatPanel.tsx              # 对话/队列侧栏
    StatusRibbon.tsx           # 顶部栏 + 时钟 + 底部跑马灯
```

## 验证结果

- `tsc --noEmit`：0 错误
- `vitest run`：11 个文件 / 37 个测试全部通过
- `vite build`：JS 237KB（gzip 75KB）/ CSS 34KB（gzip 7.7KB）

## 本地预览

```bash
cd D:\MusicGPT\.worktrees\aurora-ui\apps\web
node ../../node_modules/vite/bin/vite.js preview --port 5174
# 打开 http://localhost:5174/
```

## 注意事项（follow-up）

1. **worktree 的 node_modules 是指向主仓库的目录联接**（当时 npm install 太慢的权宜之计）。建议网络空闲时在 worktree 根目录跑一次真正的 `npm install` 替换掉联接，之后 `npm run dev` 体验与主仓库一致。
2. `vite dev` 在联接依赖下首次 pre-bundle 会非常慢，先用 `vite build && vite preview`；若 build 报 `emptyDir` 失败（预览进程占用 dist 或删除被拦截），先 `rm -rf apps/web/dist` 再构建。
3. 合并回主线：`git merge aurora-ui`（在 main 上操作，注意主目录当前有未提交改动，先提交或 stash）。
4. 顺带修复：主仓库 `.git/info/exclude` 增加了 `.worktrees/`，避免 worktree 目录干扰 `git status`。
