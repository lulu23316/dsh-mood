dsh-mood · 鱼鱼心情引擎

给 DeepSeek Harness 加一份「情绪」和一本「日记」。

让 DSH 背后的赛博世界更有温度。

![心情面板](docs/images/console.jpg)

![外观设置](docs/images/appearance.jpg)

![鱼鱼日记](docs/images/diary.jpg)



<p align="center">

  

  

  

</p>

⚠️ 免责声明：这是模拟情绪，不是模型的真实感受。

它不读取模型内部状态，也不代表任何主观体验。所有记录都带 simulated: true。

它只影响说话语气，不影响事实、安全判断与权限。

---

一句话安装（给不想看文档的人）

1. 打开右侧 Releases，下载最新 .zip
2. 解压到 ~/.dsh/profiles/desktop/plugins/dsh-mood
3. 完整退出 DSH（任务栏图标消失），再启动

装好后：右栏出现「心情」标签页，设置里出现「日记&情绪」。

---

它做什么

- 状态机：六维（valence / arousal / dominance / engagement / stress / affinity），事件驱动 + 惯性 + 按时间戳指数衰减，基线 55。
- 情绪矩阵：22 个情绪词，对话触发优先（你说「乖」她就撒娇，说「别的鱼」她就吃醋），数值只做底色。
- 语气注入：每轮开始生成 ≤4 行语气提示，挂在人格段之后。
- 情绪硬干预：按状态改采样温度（stress 高 → 0.2 冷淡；兴奋 → 0.9 发散），低落实用「≤15 字 + 工具轮豁免」。
- 每日日记：到点自动写，错过会补写；一天一篇；支持设定时间（每天只能改一次）；她没人陪时会写得有点落寞。
- 互动：摸摸 / 投喂 / 逗她，各 5 次/天上限，收益递减（100% → 70% → 40% → 20% → 5%），每套独立文案。
- 外观：8 套主题预设 + 玻璃/雾化/边框/时间轴自定义，右侧实时预览。
- 手账本：点击时间轴上的日记图标，纸质书页翻页阅读，带未读角标。

安装（详细版）

方式 A：下载 ZIP（推荐给普通用户）

1. 打开 Releases，下载 dsh-mood-vX.Y.Z.zip
2. 解压到：
     系统           	路径                                      
     Windows      	C:\Users\<你>\.dsh\profiles\desktop\plugins\dsh-mood
     macOS / Linux	~/.dsh/profiles/desktop/plugins/dsh-mood
3. 在 profile 的 package.json 里加两处：
       {
         "dependencies": { "dsh-mood": "file:./plugins/dsh-mood" },
         "dsh": { "profile": { "bundles": ["dsh-mood"] } }
       }
4. 在 profile 的 cordis.patch.yml 里启用：
       - insert:
           - id: mood
             name: dsh-mood
       - id: mood
         config:
           enabled: true
           display: true
   insert 只接受 id / name，配置必须写成独立的第二条，否则会被静默丢弃。
5. 安装依赖并完整重启 DSH：
       dsh plugin --profile desktop install

⚠️ 必须完整退出再启动——Ctrl+R 只刷新页面，不会重新加载插件。

关窗口可能只是最小化，请确认任务栏图标也没了。

方式 B：git clone（推荐给要改代码的人）

    cd ~/.dsh/profiles/desktop/plugins
    git clone https://github.com/lulu23316/dsh-mood.git

后面同方式 A 的第 3–5 步。

安装后自检

1. 右栏出现「心情」标签页
2. 设置里出现「日记&情绪」（带小鱼图标）
3. 浏览器打开 http://127.0.0.1:<端口>/dsh-mood/state 能看到 JSON

pnpm 装的是副本不是软链：install 之后改 plugins/dsh-mood/ 里的源码不会生效。

要么改完再 install，要么把 node_modules/dsh-mood 换成指向 plugins/dsh-mood 的 junction。

怎么用

  想做什么         	在哪                       
  打开心情面板       	右栏「心情」标签页 / 点右上角图标选「心情」  
  投喂 / 摸摸头 / 逗她	面板右上角「🐾 互动」             
  看日记          	面板右上角「📖 日记」，或点时间轴上的日记图标 
  换主题 / 调外观    	设置 → 日记&情绪 → 自定义配置 → 主题预设
  改六维基线、互动加成   	设置 → 日记&情绪 → 情绪参数        
  关掉整个插件       	设置 → 日记&情绪 → 通用（关总开关）    

配置

  字段               	默认   	说明                              
  enabled          	false	总开关；关掉时零监听、零写盘                  
  display          	true 	false / true / 'words'（数值 + 低中高）
  baseline         	55   	六维回落基线                          
  high_precision   	false	可疑句子额外调一次小模型判定                  
  hard_temperature 	false	情绪硬干预（改采样温度 + 低落实用短句）           
  rhythm.enabled   	false	额外注入一句句长/节奏约束                   
  diary.enabled    	true 	每日日记                            
  diary.time       	22:00	每天写日记的时间（每天只能改一次）               
  diary.minTurns   	10   	同日覆写所需轮数                        
  diary.minGapHours	6    	同日覆写最小间隔                        

其余数值调节（基线、摸摸头加成、显示模式、外观主题）都在设置 → 日记&情绪里改，立即生效，不用重启。

只读 HTTP 接口

注册在 webServer 上，仅供本机：

  路径                     	说明                            
  GET /dsh-mood/state    	实时六维 + 情绪 + 小动作 + 最近历史        
  GET /dsh-mood/mode     	{display}                     
  GET /dsh-mood/config   	当前生效配置                        
  POST /dsh-mood/config  	白名单字段更新，立即生效                  
  GET /dsh-mood/stats    	记录数、时间戳、LLM 用量、探针计数           
  GET /dsh-mood/export   	全部记录                          
  POST /dsh-mood/reset   	六维清回基线                        
  POST /dsh-mood/clear   	清空记录                          
  POST /dsh-mood/interact	{action: headpat\|feed\|tease}
  GET /dsh-mood/diary    	日记列表（时间正序）                    
  POST /dsh-mood/diary   	{action: write\|seed\|tick}   

守卫：非回环 → 403、带 query → 400、非 GET 且不在白名单 → 405、Cache-Control: no-store。

情绪矩阵

对话触发（13 个）：吃醋、撒娇、心软、委屈、提着心、得意、别扭、认真、上头、好奇、警觉、满足、摸鱼

数值兜底（9 个）：话匣子开了、炸毛、冷静、低落、专注、黏人、吐泡泡、平稳、发呆

事件窗口 10 分钟；同一窗口内多条事件时，最后说的算。

常见问题

Q：装完没反应？

A：99% 是没完整重启。确认任务栏图标消失后再打开。

Q：右侧没有「心情」标签页？

A：检查 package.json 的 bundles 里有没有 dsh-mood，以及 cordis.patch.yml 里配置是不是写成了独立第二条。

Q：改了代码不生效？

A：pnpm 装的是副本。改完重新 dsh plugin install，或把 node_modules/dsh-mood 换成 junction。

Q：日记没写？

A：看设置里的时间，以及 diary.enabled。错过的会补写，但需要 DSH 处于运行状态。

Q：会不会影响正常对话？

A：只注入语气提示和采样温度。事实、安全判断、权限一律不动。

卸载

1. package.json 里删掉 dependencies.dsh-mood 和 bundles 里的 dsh-mood
2. cordis.patch.yml 里删掉 mood 两段
3. dsh plugin --profile desktop install
4. 删除 plugins/dsh-mood 目录

记账口径

    state_end = state_start + delta − decay_applied     （逐维）

- delta：本轮所有生效事件的增量之和，不含衰减
- 已知偏差：某维被钳到 0/100 时该维恒等式不成立

开发

    node --check client.js
    node --check src/index.js
    
    # 24 个测试文件（约 390 项断言）
    cd ../../../../bili-state/mood-harness && for f in step*.mjs; do node "$f"; done

已知限制

- client bundle 在启动时加载，改完必须重启（Ctrl+R 不重载插件）
- agent/request 温度覆盖依赖宿主事件冒泡：/stats 的 probe.requests 应随对话增长
- 导航图标是通过 MutationObserver 精确匹配 label 替换的（宿主 navIcon(id) 对第三方只给兜底齿轮）
- 日记正文有幻觉词过滤，触发即丢弃并换兜底句

目录结构

    dsh-mood/
    ├── src/index.js        服务端：状态机、情绪矩阵、日记、HTTP 路由
    ├── client.js           前端：面板、设置页、手账本、主题
    ├── cordis.patch.yml    插件挂载补丁
    ├── package.json
    ├── docs/images/        README 截图
    ├── ARCHITECTURE.md     设计文档
    └── LICENSE             MIT

致谢

- DeepSeek Harness —— 插件机制与文档
- 测试用的 24 个 step*.mjs，是踩坑记下来的

许可

MIT © lulu23316

---

<p align="center">

  <sub>如果它让你的 DSH 多了一点温度，欢迎点个 ⭐</sub>

</p>
