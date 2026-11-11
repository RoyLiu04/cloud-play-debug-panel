# xCloud Play 调试面板（非官方）

> **非官方项目**：与 Microsoft Corporation 无关联，未获其授权、认可或支持。文中出现的 `Xbox`、`xCloud`、`play.xbox.com` 等名称仅用于说明本脚本适用的页面与接口，商标归其权利人所有。

一个跑在 play.xbox.com 页面上的本地调试脚本：给出串流链路的实时读数（丢包 / RTT / 码率 / 分辨率 / 丢帧），并提供几个用于对照测试的本地开关（地区字段、机房排序、IPv4、画质档位）。

脚本只在本机浏览器内改写页面自身发出的请求与响应，不向任何第三方发送数据。仅供技术学习与研究，使用前请阅读文末的免责声明。

## 功能

| 功能 | 说明 |
| --- | --- |
| 区域字段改写 | 改写 `gears` / `xboxcomfd` 的 experimentation 响应中的 `trafficFilters.territory`、`market`，并校正 `territory` cookie，用于对照页面在不同地区判定输入下的行为 |
| 机房排序 | 改写 `offeringSettings.regions` 的 `isDefault` 与顺序，便于对比东京 / 首尔 / 美东 / 西欧几个数据中心的链路质量 |
| 强制 IPv4 | 剔除 ICE 候选里的 IPv6 地址，用于排查 v6 出口造成的链路劣化 |
| 画质档位 | 按 `settings.osName` 选择 1080p / 720p；「自动」模式下视口高度 ≤ 900 视为小屏，自动压到 720p（掌机不会被推 1440p） |
| 链路读数 | 顶部小药丸显示实时丢包率，展开可看 RTT、码率、分辨率、丢帧 |

## 工作原理

页面自己会发这几个请求，脚本只在 `fetch` / `XHR` 层读取并改写它们，不改动页面代码：

```
GET  gears.xboxservices.com/.../experimentation                 → 页面据此得到 marketAccessContext.physicalMarket
POST cloudgaming.gssv-play-*.xboxlive.com/v2/login/user         → 返回可用的串流数据中心列表
POST <dc>.core.gssv-play-*.xboxlive.com/v5/sessions/cloud/play  → 建会话参数（osName、regions 等）
GET  <dc>.core.../configuration、/ice                           → 媒体服务地址与 ICE 候选
```

这些改写只作用于本机浏览器发出的请求，服务端仍按自己的规则校验，因此是否生效取决于服务端策略，脚本不做任何保证。

## 安装

**Tampermonkey（Chrome / Edge / Firefox，推荐）**

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展（桌面版免费）
2. 打开本仓库的 `cloud-play-debug-panel.user.js`，点右上角 **Raw**，脚本管理器会自动弹出安装页
3. Edge 需要在扩展详情里打开「允许用户脚本」（部分版本还需开启「开发人员模式」）
4. macOS 上同样适用：装 Chrome 或 Edge，再装 Tampermonkey 即可

**手动**

把 `cloud-play-debug-panel.user.js` 的内容复制到脚本管理器里新建脚本即可。

> 安装后请删除/禁用其它同类脚本，同名逻辑重复注入会互相干扰。

> **从旧版升级**：本项目此前对外名为 `Xbox Cloud Gaming Unlock`（仓库 `xbox-cloud-unlock`），3.3.0 起统一改名。脚本的 `@name` 变了，脚本管理器会把它当成一个新脚本，请先在管理器里删掉旧的，再安装现在这个，否则两份脚本会同时注入页面。

### 关于 Safari

**Safari 上暂时不可用**，包括 App Store 的 Userscripts 扩展和 Tampermonkey for Safari（后者还需付费）。

原因不在脚本本身，而在这类扩展的执行环境：

- Safari 的扩展把脚本跑在**隔离世界（isolated world）**里，`window` 与页面主世界不是同一个对象。本脚本的核心是覆写页面主世界的 `window.fetch`、`RTCPeerConnection`，在隔离世界里改的是另一个 `fetch`，页面根本不会调用到，表现就是「装了但完全没反应」。
- 页面 CSP 为 `script-src 'self' 'nonce-…'`，没有 `unsafe-inline` / `unsafe-eval`，注入 `<script>` 或 `eval` 逃逸到主世界的路子也被封了。
- Chrome / Edge 的 Tampermonkey 支持 `world: 'MAIN'`，脚本可以直接在主世界执行，这是本脚本能工作的前提。

所以请用 Chromium 系浏览器（Chrome / Edge / Brave 等）或 Firefox。

## 使用

- **小药丸**：默认停在**屏幕顶部正中**，只显示实时丢包率（绿 <2%，黄 <5%，红 >5%）。单击展开，按住可拖动（位置会被记住），**双击回到顶部正中**。
- **卡片**：展开时向下生长，药丸本身不移动。内容为链路读数（丢包 / RTT / 码率 / 分辨率 / 丢帧）、一行异常提示，以及下面四个设置按钮。
- **状态行**：只有「实际 ≠ 设定」时才出现（例如 `territory` cookie 或 IP 判定与设定地区不一致、cookie 缺失）。一致时整行隐藏，不重复按钮上已有的信息。
- **按钮点开选值**（点一下列出全部选项，点中哪一个就是哪一个，不用一个个轮过去），按钮上会直接显示当前值，末尾的 ▾ 表示可展开：
  - `数据中心`：自动 / 东京 / 首尔 / 美东 / 西欧。自动模式下显示服务端实际分配的机房，如 `自动·CKR`（进一局后才会出现，列表页显示 `自动`）。选中后**下一局开游戏生效，不必刷新**
  - `画质`：自动 / 1080p / 720p。**「自动」会看屏幕**：视口高度 ≤ 900（Steam Deck 掌机的 800p、笔记本 768p）自动按 720p 推流并显示 `自动·720p`；大屏不改写，进串流后显示站点实际协商到的分辨率，如 `自动·1080p`。手动选了 1080p / 720p 则始终按手动值。同样下一局生效
  - `IPv4`：强制 / 关（点一下切换）
  - `商店地区`：日本 / 美国 / 韩国 / 波兰 / 巴西 / 关闭改写，**选中后刷新一次页面**（只刷一次，不用循环点）。这一项只影响页面读取到的商店 / 市场字段，与账号本身所在地区无关
- **复制报告**：只包含版本、地区配置、链路统计与最近错误消息，供反馈问题时附上。
- 进入串流后卡片会自动收起，药丸始终可点；站点弹出对话框并压到面板时，面板自动让开，不会挡住「设置」和左侧边栏。

## 常见问题

**列表为空 / 页面提示市场不支持**

先确认「商店地区」与你要测试的地区一致，改完刷新一次页面；仍为空说明服务端按当前出口网络做了判定，客户端侧没有可调项。

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

## 参考项目

本项目的接口字段与改写位置来自下面两个开源项目，在此致谢：

- **[redphx/better-xcloud](https://github.com/redphx/better-xcloud)** —— 功能增强脚本。本项目的 `offeringSettings.regions` 排序改写、`settings.osName` 画质档位、`x-ms-device-info` 设备信息覆写、gssv 请求拦截方式均参考其实现（`src/utils/xcloud-interceptor.ts`、`src/utils/region.ts`）。
- **[darkchaox/xbox-cloud-gaming-optimizer](https://github.com/darkchaox/xbox-cloud-gaming-optimizer)** —— 旧版页面的地区判定改写与串流优化脚本，也是本项目最初的起点；其思路在新版页面上失效，本项目针对新架构重写了拦截点。

新版 `play.xbox.com` 是 React Router 7 SSR 应用，`trafficFilters.territory` 改写、`marketAccessContext.physicalMarket` 覆写、请求头改写这几处是针对新架构新增的，两个上游项目都还没有对应实现。

## 隐私

- 脚本不向任何第三方发送数据，不做统计上报。
- 不读取页面文本、不保留接口响应体、不访问账号信息。
- 「复制报告」的内容仅限：版本、地区配置、`territory` 判定结果、串流统计（数据中心/IPv4/画质）、QoS 采样、请求状态码、最近错误消息。

## 免责声明

- 本项目是个人学习与研究性质的**第三方非官方**脚本，与 Microsoft Corporation 无任何关联，未获其授权、认可或支持；相关商标、服务名称归其权利人所有。
- 脚本按「现状」提供，不对可用性、稳定性与适配性作任何明示或暗示的担保。
- 使用前请自行确认你的使用行为符合所在地法律法规，以及你所使用服务的用户协议与相关规则；使用风险与后果由使用者自行承担。
- 若相关权利方认为本项目存在不当之处，请通过 [Issues](https://github.com/RoyLiu04/cloud-play-debug-panel/issues) 联系，我会及时修改或下架。

## License

[MIT](LICENSE)
