# X Signal Sync

## 数据流

`~/.hermes/hermes-agent/scripts/x_signal_sync.py` 是 X 同步权威脚本。launchd 直接运行该脚本，读取 X 登录态和 KOL 配置，写入：

```text
~/.hermes/tmp/x_signal_sync_latest.json
```

`hotboard-feed-api` 消费该 JSON，把 X bookmarks / For You / Following / Likes 信号合并进 AI 热点看板 feed。

## 触发机制

- `launchd` 兜底：`ai.hermes.x-signal-sync`，每 6 小时运行一次，ProgramArguments 必须指向 `~/.hermes/hermes-agent/scripts/x_signal_sync.py`。
- 防回退守护：`ai.hermes.x-signal-health` 每 30 分钟运行 `scripts/monitor-x-signal-sync.sh`，当 launchd 路径回退到 `~/.hermes/tmp/x_signal_sync.py` 或 latest JSON 小于 300KB 时发送飞书告警。
- Hermes 内部触发：`~/.hermes/cron/jobs.json` 中存在 `x-bookmark-signal-sync-*` jobs，当前由 Hermes gateway cron 驱动；这些 job 的 prompt 收尾也必须运行 `python3 ~/.hermes/hermes-agent/scripts/x_signal_sync.py` 并刷新 latest JSON。

独立 `launchd` job 是冗余兜底，不替代也不禁用 Hermes 内部 cron。

## KOL 配置

KOL 白名单和抓取配置在：

```text
~/.hermes/hermes-agent/config/x_users.toml
```

## 排错

查看 launchd 兜底日志：

```bash
tail -f /tmp/hermes-logs/x-signal-sync.out.log
tail -f /tmp/hermes-logs/x-signal-sync.err.log
tail -f /tmp/hermes-logs/x-signal-monitor.out.log
tail -f /tmp/hermes-logs/x-signal-monitor.err.log
```

查看 latest JSON 是否刷新：

```bash
stat -f '%Sm %N' ~/.hermes/tmp/x_signal_sync_latest.json
python3 -m json.tool ~/.hermes/tmp/x_signal_sync_latest.json | head -80
```

查看 launchd 注册状态：

```bash
launchctl list | grep ai.hermes.x-signal-sync
launchctl list | grep ai.hermes.x-signal-health
```

手动触发一次：

```bash
launchctl start ai.hermes.x-signal-sync
```

安装或刷新 launchd 配置：

```bash
mkdir -p /tmp/hermes-logs
cp launchd/ai.hermes.x-signal-sync.plist ~/Library/LaunchAgents/ai.hermes.x-signal-sync.plist
cp launchd/ai.hermes.x-signal-health.plist ~/Library/LaunchAgents/ai.hermes.x-signal-health.plist
chmod 600 ~/Library/LaunchAgents/ai.hermes.x-signal-sync.plist ~/Library/LaunchAgents/ai.hermes.x-signal-health.plist
launchctl bootout gui/$(id -u)/ai.hermes.x-signal-sync || true
launchctl bootout gui/$(id -u)/ai.hermes.x-signal-health || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.x-signal-sync.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.x-signal-health.plist
launchctl kickstart -k gui/$(id -u)/ai.hermes.x-signal-sync
```
