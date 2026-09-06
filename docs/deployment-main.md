# 从 `main` 启动与回滚

MusicGPT 的受监督入口是仓库根目录的 `npm run dev`（Windows 双击 `一键启动.cmd` 也会进入同一入口）。入口会通过 `git worktree list` 找到当前注册在 `main` 分支上的工作树，确认目标确实是 `main`，然后才从该目录启动 NCM、API 和 Web。启动器也只会复用 `/health` 明确报告 `checkout: main` 的现有实例，不会继续使用旧的 `musicgpt-v2` 服务。

## 部署前

1. 在 `main` 工作树执行 `npm.cmd run deployment:check`，确认输出的 checkout 和 release。
2. `.env`、`state/` 和 QQ 登录状态都是本机私有数据。部署脚本只读取它们，不创建、不复制也不覆盖它们；不要使用 `git clean`，也不要把它们加入 Git。
3. 记录当前提交，作为回滚依据：`git rev-parse HEAD`。
4. 执行 `npm.cmd install`、`npm.cmd test`、`npm.cmd run typecheck` 和 `npm.cmd run build`。

## Windows 监督器配置

任务计划程序、NSSM 或其他监督器应固定使用以下配置：

- 程序：`C:\Program Files\nodejs\npm.cmd`（若 Node 安装在别处，以 `where npm.cmd` 的结果为准）
- 参数：`run dev`
- 起始位置：`D:\MusicGPT`
- 失败时：延迟 10 秒重启，最多 3 次；持续失败时停止重启并保留日志

不要把起始位置设为 `D:\MusicGPT\.worktrees\musicgpt-v2`。更新监督器后停止旧实例，再启动新实例；不要让两个 checkout 同时竞争 3001、8787 和 5173 端口。

## 就绪确认

启动日志会打印实际 checkout 和 Git release。随后运行：

```powershell
$env:MUSICGPT_EXPECT_RELEASE = git -C D:\MusicGPT rev-parse HEAD
npm.cmd run health
Remove-Item Env:MUSICGPT_EXPECT_RELEASE
```

检查会同时验证 NCM `/inner/version`、API `/health` 的 release，以及 Web 根页面。只有三项全部通过才算就绪。

## 回滚

若新版本未通过就绪检查，先停止监督器，然后在 `main` 上为错误提交创建反向提交：

```powershell
git -C D:\MusicGPT revert --no-edit <bad-commit>
npm.cmd --prefix D:\MusicGPT install
npm.cmd --prefix D:\MusicGPT run build
```

重新启动监督器并重复带 `MUSICGPT_EXPECT_RELEASE` 的健康检查。`git revert` 不删除 `.env`、SQLite、QQ 登录状态或其他被忽略的本地数据，也保留完整的部署与回滚历史。若多个提交需要回滚，先在独立工作树验证反向提交，再合入 `main`。
