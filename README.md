# Xbox Cloud Gaming Unlock

让新版 [play.xbox.com](https://play.xbox.com) 在受限地区可以正常打开游戏列表并进入串流，附带串流链路的几个可调项和一个不挡界面的实时丢包读数。

> 脚本只在本机浏览器里改写请求与响应，不向外发送任何数据。仅供学习研究，使用前请阅读文末免责声明。

## 功能

| 功能 | 说明 |
| --- | --- |
| 地区解锁 | 改写 `gears` / `xboxcomfd` 的 experimentation 响应（`trafficFilters.territory`、`market`），并校正 `territory` cookie，让播放页不再把当前出口 IP 判成「不支持的市场」 |
| 数据中心固定 | 改写 `offeringSettings.regions` 的 `isDefault` 与顺序，把想用的数据中心排到队首 |
| 强制 IPv4 | 剔除 ICE 候选里的 IPv6 地址，避免走国际段更差的 v6 出口 |
| 画质档位 | 按 `settings.osName` 选择 1080p / 720p |
| 链路读数 | 右下角小药丸显示实时丢包率，展开可看 RTT、码率、分辨率、丢帧 |

## 工作原理

页面自己会发这几个请求，脚本只在 `fetch` / `XHR` 层改写它们，不修改页面代码：

```
GET  gears.xboxservices.com/.../experimentation                 → 决定 marketAccessContext.physicalMarket
POST cloudgaming.gssv-play-*.xboxlive.com/v2/login/user         → 决定可用的串流数据中心
POST <dc>.core.gssv-play-*.xboxlive.com/v5/sessions/cloud/play  → 建立会话
GET  <dc>.core.../configuration、/ice                           → 媒体服务地址与 ICE 候选
```

## 安装

**Tampermonkey（Chrome / Edge）**

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 打开本仓库的 `xbox-cloud-unlock.user.js`，点右上角 **Raw**，脚本管理器会自动弹出安装页
3. Edge 需要在扩展详情里打开「允许用户脚本」（部分版本还需开启「开发人员模式」）

**Userscripts（Safari / macOS）**

1. 从 App Store 安装 Userscripts 扩展并在 Safari 设置里授权
2. 打开 raw 链接，按提示导入

**手动**

把 `xbox-cloud-unlock.user.js` 的内容复制到脚本管理器里新建脚本即可。

> 安装后请删除/禁用其它同类脚本，同名逻辑重复注入会互相干扰。

## 使用

- **小药丸**：右下角常显，只显示实时丢包率（绿 <2%，黄 <5%，红 >5%）。单击展开，按住可拖动，位置会被记住。
- **卡片**：显示地区与 `territory` 判定、丢包 / RTT / 码率 / 分辨率 / 丢帧，以及一行提示（有异常才出现）。
- **按钮循环切换**（点一下换下一个值，改完下一局开游戏生效，不必刷新）：
  - `数据中心`：自动 → 东京 → 首尔 → 美东 → 西欧
  - `画质`：自动 → 1080p → 720p
  - `IPv4`：强制 / 关
  - `地区`：日本 → 美国 → 韩国 → 波兰 → 巴西 → 关闭（切换后页面会刷新一次）
- **复制报告**：只包含版本、地区配置、链路统计与最近错误消息，供反馈问题时附上。
- 进入串流后卡片会自动收起；站点弹出对话框并压到面板时，面板自动让开，不会挡住「设置」和左侧边栏。

## 常见问题

**列表为空 / 提示「不支持的市场」**
地区需要设为支持云游戏的市场（日本、美国、韩国等），设完刷新一次页面。

**能进游戏但画面卡、提示数据包丢失**
1. `数据中心` 换成东京再开一局，对比丢包与 RTT；
2. `IPv4` 保持「强制」；
3. 仍然丢包就 `画质` 降到 720p。

这三步都试过、丢包仍在 5% 以上，说明是出口链路本身的问题（跨境 UDP 实时流常见），客户端侧已无可调项。

**面板不见了 / 拖到屏幕外**
在控制台执行 `localStorage.removeItem('xcu.pos')` 后刷新。

**想恢复默认设置**
控制台执行 `localStorage.clear()` 后刷新（会一并清掉其它站点设置，谨慎使用）；或只删 `xcu.` 开头的键。

## 兼容性

针对 2026-11 的页面结构（`web-app-version: hotfix-1.0.2611.0612`）编写。站点大改版后选择器与接口可能变化，需要相应调整。

## 隐私

- 脚本不向任何第三方发送数据，不做统计上报。
- 不读取页面文本、不保留接口响应体、不访问账号信息。
- 「复制报告」的内容仅限：版本、地区配置、`territory` 判定结果、串流统计（数据中心/IPv4/画质）、QoS 采样、请求状态码、最近错误消息。

## 免责声明

本项目仅供学习与研究使用。绕过地区限制可能违反微软服务条款，可能导致账号受限；由此产生的一切后果由使用者自行承担，作者不提供任何担保。

## License

[MIT](LICENSE)
