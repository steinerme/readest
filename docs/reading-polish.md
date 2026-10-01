# Reading UI polish — 第一阶段

基线：`6e567ef`（Readest 0.12.10）

分支：`ui/reading-polish`

这是对真实应用组件的渐进改造，不是另建展示页面，也不代表已达到微信读书全部体验水准。

## 已实施

### 书架
- 搜索栏采用主题色衍生的中性色、轻边框及明确的键盘焦点。
- 网格书名为 13px、最多两行，封面与文字间距更舒展。
- 收敛封面阴影，保留拟物书脊的直角选项。
- 书籍按压为轻微缩放，选择遮罩常驻并以透明度切换，不再挂载后瞬现。
- 空书架文案字号和留白重新平衡。
- 不改排序、导入、同步、批量选择或虚拟列表实现。

### 阅读器
- 顶栏只做合成属性动效，不再插值安全区 margin-top。
- 工具栏进入 260ms、退出 180ms；顶栏隐藏时上移 8px。
- 字体、配色、进度面板使用 16px 位移与淡入淡出，关闭可见性延迟到退场结束，而不是立即 invisible。
- 保持面板挂载和可测高度，兼容悬浮听书播放器的位置计算。
- 隐藏工具栏、面板添加 inert 与 aria-hidden，防止不可见按钮参与键盘焦点。
- 原有 safe-area、RTL、主题与桌面布局逻辑保留。

### 通用设置弹层
- 专属 `.reading-dialog` 样式，不覆盖其他模态组件。
- 手机轻滑入，桌面轻缩放；关闭保留 300ms 内容窗口。
- 拖拽关闭时长限制在 140–260ms，避免高速手势导致过短闪跳。
- 修复旧拖拽清理定时器干扰快速重开的风险；卸载取消定时器。
- 重开在首次绘制前恢复半屏高度与拖拽样式，保留安全区 padding。
- JS 与 CSS 同时尊重减少动态效果和电纸书偏好。

## 验证结果

- 最终单次回归：9 个文件、108 项测试通过（包含新增弹层 13 项、阅读面板 6 项、顶栏新增 2 项）。
- 另一次相关回归：搜索、选择模式、导航、批注导入导出等 6 个文件、36 项通过；它们运行在最终弹层收尾之前，不计入最终 108 项。
- 全项目 TypeScript 检查通过，使用仓库根依赖 TypeScript 5.9.3：
  `node node_modules/typescript/bin/tsc --noEmit -p apps/readest-app/tsconfig.json`
- 18 个新增/修改源码与测试文件 `biome check` 通过；`git diff --check` 通过。
- 真实 WebView 中，以编译后的项目 CSS 验证阅读面板与弹层：打开、关闭中间态、快速反向、关闭最终 hidden、电纸书零动画、面板高度不变。使用 Web Animations API 推进真实 CSS 动画时间，避免后台帧节流影响结果。
- 新增 `reading-polish.browser.test.ts` 供正常 Playwright 环境执行。当前设备未安装 Playwright Chromium，未把这份测试计为自动化通过；上述 CSS 浏览器检查为独立夹具验证，不是完整应用端到端验收。

## 尚未验证／环境限制

- 已启动真实 Next.js Web 服务并获得 `/library` HTTP 200，浏览器曾实际渲染空书架。
- 内置示例书下载报 File is empty；测试文件导入和随后热更新未完成可靠的有书书架／阅读器端到端验证。不能将空书架截图当作完整体验验收。
- Android PRoot 下 Turbopack 报 Invalid symlink；原生 TypeScript 7 存在 pnpm 硬链接路径解析问题。Web 本地预览使用 webpack，并在 node_modules 的 OpenNext 适配器临时跳过 workerd 初始化；没有修改仓库 Next 配置或依赖锁文件。该临时环境修改不在交付补丁内，不能用来验证云端功能。
- 尚未生成 APK、IPA、桌面安装包；未做原生设备帧率测量、真实手势回归或生产构建。
- 本轮未实现书封到阅读页面的共享元素转场，也未改翻页引擎、同步逻辑和阅读主题内容样式。

## 在常规开发机验证

按项目 CONTRIBUTING.md 准备 Node/pnpm/Tauri 环境及子模块，执行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @readest/readest-app setup-vendors
pnpm dev-web
pnpm --filter @readest/readest-app test --run
pnpm --filter @readest/readest-app test:browser -- src/__tests__/styles/reading-polish.browser.test.ts
```

手工验收：手机竖/横屏、桌面、深色、RTL、电纸书、减少动态效果；长书名、多书滚动、选择模式；打开书籍、调字号、切换面板、关闭与快速重开；半屏设置弹层拖拽取消和关闭；听书悬浮条位置；返回书架滚动恢复。

## 回退／应用补丁

补丁基于上述确切提交，应用前确保工作区干净：

```sh
git apply --check readest-reading-polish.patch
git apply readest-reading-polish.patch
# 回退（没有后续冲突修改时）
git apply -R --check readest-reading-polish.patch
git apply -R readest-reading-polish.patch
```

保留 Readest 原有 AGPL-3.0 许可及署名。
