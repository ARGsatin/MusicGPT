# ADR 0002: MusicCatalog、结构化品味与全天计划

- 状态：Accepted
- 日期：2026-08-15

## Context

v1 的数字歌曲 ID、网易云直连调用和一次性 10 首队列无法表达 QQ 音乐版本、跨平台回退、人工品味规则或全天上下文。把每个平台继续扩展成 `ncm_daily / qq_daily / ...` 组合枚举也会让推荐与播放逻辑持续分叉。

## Decision

1. 用 `trackKey = <source>:<sourceId>` 标识曲源版本，用 `recordingKey` 标识录音。跨平台仅在规范化歌名、歌手一致且时长相差不超过 5 秒时自动合并；缺少时长或存在冲突时保守拆分。
2. `MusicCatalog` 是唯一曲源深模块，公开 `sync / search / recommend / resolvePlayback / getLyrics`。网易云与 QQ 音乐只作为内部 adapter；推荐候选独立存储 `provider` 与 `discovery`。
3. SQLite 是事实源。v2 迁移前复制数据库备份，保留曲库事实、反馈、聊天、记忆和设置；重建队列与推荐缓存。一个兼容周期内，裸数字或纯数字字符串按网易云 ID 解释。
4. `state/library.json`、`state/taste.md` 和 `state/routine.json` 是本地可观察投影。系统只修改 `taste.md` 的 `musicgpt:auto` 区；人工 YAML 无效时沿用最后有效规则。
5. 全天计划由四个约 2 小时的时段构成。排序使用 30% 品味、30% 上下文、20% 熟悉度、10% 曲源、10% 探索多样性，再应用人工规则和反馈冷却。队列只读取全天计划的滚动窗口。此项已由 ADR 0003 取代。

## Consequences

- QQ Cookie 只能存在于忽略目录 `state/qqmusic/`，不能进入前端响应、日志、SQLite 或导出文件。
- 一首 QQ 曲目不可播放时，Catalog 先尝试同一录音的网易云版本；全部失败后进入冷却并从全天计划补位。
- `period / weather / routine` 只用于推荐上下文，不得写入歌曲固有标签证据。
- QQ 的非官方接口可能失效，但故障不能阻塞网易云、聊天、本地画像或已生成的全天计划。
