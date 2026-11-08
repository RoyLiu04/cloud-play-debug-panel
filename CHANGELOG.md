# Changelog

## 3.0.1 — 2026-11-08

修复 Steam Deck / Game Mode 下进入串流后面板消失、药丸半透明且点不动的问题。

- 面板改为跟随 `document.fullscreenElement` 挂载，并监听 `fullscreenchange` 实时搬迁；退出全屏自动回到 `body`
- 串流中（已建立 `RTCPeerConnection`）不再执行遮挡判定，药丸保持不透明且可点击
- 遮挡判定新增尺寸过滤：覆盖七成视口的容器视为串流画面本体，不再被误判为站点对话框

## 3.0.0 — 2026-11-08

首个公开版本。

- 地区解锁：改写 experimentation 响应的 `trafficFilters.territory` / `market`，校正 `territory` cookie
- 串流设置：数据中心固定、强制 IPv4、画质档位（1080p / 720p）
- 界面：右下角小药丸 + 可折叠卡片，可拖动、进游戏自动收起、站点弹窗时自动让开
- 隐私：不读取页面文本、不保留接口响应体、不劫持 `console`
