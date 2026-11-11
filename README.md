# Dream C++ Debugger (GDB)

<p align="center">
  <img src="media/icon.png" width="96" height="96" alt="Dream C++ Debugger Icon" />
</p>

<p align="center">
  <strong>现代简洁的 VS Code C/C++ GDB 调试器扩展</strong><br/>
  零配置一键编译调试 · 现代化侧边栏工作台 · STL / 数组图形化条带 · 条件断点 · <code>stdin</code> 测试数据注入 · 行内变量实时预览
</p>

---

## ✨ 核心特性

### 1. 零配置一键编译 & GDB 调试
告别繁琐易错的 `launch.json` 与 `tasks.json` 配置。只需打开任意 `.cpp` / `.c` 源文件：
- 点击编辑器右上角或左侧面板的 **`编译并开始 GDB 调试`** 按钮。
- 自动调用 `g++ -g -O0`（可自定义编译器和参数）生成带调试符号的程序，并在后台通过 **`gdb --interpreter=mi2`** 启动调试会话。
- 编译出错时自动解析 GCC/Clang 报错行号，同步展示在侧边栏卡片与 VS Code 原生 **问题 (Problems)** 面板中，点击即可跳转对应代码行。

### 2. 侧边栏输入输出与右侧调试台
点击活动栏中的 **Dream C++ Debugger** 图标使用编译、输入输出；开始调试后会自动在右侧打开调试台：
- **状态头与单步传输控制栏**：清晰展示当前调试状态（`就绪 Ready` / `运行中 Running` / `已暂停 Paused` / `已结束 Exited`），配备 **继续 (`F5`)**、**单步跳过 (`F10`)**、**单步进入 (`F11`)**、**单步跳出 (`Shift+F11`)**、**重启** 与 **停止 (`Shift+F5`)** 快捷按钮。
- **局部变量 & STL/数组可视化**：
  - 自动解包原生 `std::vector`、`std::string` 与 C/C++ 数组（即使系统未配置 GDB Python Pretty-Printer 也能完美读取底层 `_M_start` / `_M_finish` 与 `_M_dataplus`）。
  - 对于一维数组与 `std::vector`，自动在变量卡片下方渲染 **`[index] -> value` 视觉化数组条带**。
  - 长数组和 `vector` 点击条带末尾的 **…**，在弹窗中按 32 项分页查看并逐项修改；不提供截断容器的整体赋值。简单局部变量名的监视项也支持此功能。
  - `std::string` 和 `char` 数组可逐字节修改：输入单字节字符、`\n` 等转义或 `0x00`–`0xFF`。索引按字节而非 Unicode 字符计算，修改 UTF-8 某个字节可能产生无效文本。
  - 分页仅支持已初始化的一维 C 数组和 libstdc++ `std::vector`（不包括 `vector<bool>`）、`std::string`；运行状态或栈帧改变后须重新打开。
  - 暂停时右击 `vector` 元素，选择**删除、左侧插入或右侧插入**；分页弹窗和简单局部变量名的监视项同样支持。空 `vector` 可点击“添加首个元素”。支持默认分配器的基本整数/浮点、`char` 和 `std::string` 元素；不支持 `vector<bool>`、嵌套容器、自定义元素或分配器。`vector<std::string>` 暂不支持直接修改已有元素。固定长度数组不提供插入或删除。
  - `std::string` 的字符条带和分页弹窗也支持右键删除、左侧插入或右侧插入；空字符串可添加首个内容。插入可输入文本（包括 UTF-8）、转义或 `0x00`–`0xFF` 字节；索引和删除按**字节**计算，删除或在多字节字符内部插入可能破坏 UTF-8 编码。
  - 这些操作会通过 GDB 在被调试程序中调用 C++ 辅助函数，可能分配内存并使原有迭代器、指针和引用失效（删除也可能使相关引用失效）；目标平台或 GDB 禁止函数调用时会报错。调试编译会额外链接该辅助代码，快速运行及 C 编译不受影响。
  - 单步执行后发生变化的变量自动高亮标记 **`已更新`**，点击变量右侧 `✎` 按钮可在运行暂停时直接修改内存中变量的值。
- **监视表达式 (`Watch`)**：支持添加任意 C++ 表达式（如 `dp[i][j]`、`*ptr`）以及 GDB 数组切片语法（如 `arr[0]@10`），实时同步求值并支持数组可视化。
- **标准输入/输出 (`stdin & stdout`) 一体化卡片**：
  - 专为包含 `cin` / `scanf` 的 C++ 程序设计：在侧边栏文本框内直接粘贴多行测试输入样例，启动调试或点击 **`⚡ 运行`** 时自动重定向注入程序标准输入，并实时捕获 `stdout / stderr` 输出。
- **调用栈 (`Call Stack`) 与条件断点管理**：
  - 实时展示递归或函数调用链（`#0`, `#1`, ...），点击任意栈帧立即切换上下文并跳转到对应源码行。
  - 与 VS Code 编辑器行号左侧红点断点双向同步，支持开关断点、查看命中次数（`×N`）以及设置 **条件断点**（如 `i == 5 && sum > 20`）。
- **交互式 GDB 命令台 & CPU 寄存器面板**：支持在右侧调试台直接执行原生 GDB 命令（如 `p x`、`x/8xw &arr`、`info locals`、`bt`），并实时展示通用 CPU 寄存器（`rax`, `rbx`, `rsp`, `rip` 等）。

### 3. 编辑器深度增强
- **当前执行行高亮与箭头指示**：暂停时以柔和琥珀色高亮当前执行行，并在行尾内联显示当前作用域主要变量的实时值（如 `// i = 3 │ total = 7 │ n = 5`）。
- **鼠标悬停实时求值 (`Hover Evaluation`)**：调试暂停时将鼠标悬停在代码中的变量或表达式上，自动通过 GDB 计算并弹出类型与当前值提示框。
- **原生 DAP 调试器兼容 (`type: "dream-cpp-gdb"`)**：同时注册了标准 VS Code Debug Adapter，既能直接在侧边栏一键调试，也支持通过标准 `launch.json` 启动。

---

## ⌨️ 快捷键一览

| 功能 | Windows / Linux | macOS | 触发条件 |
| :--- | :--- | :--- | :--- |
| 编译并启动 GDB 调试 | `Ctrl + Shift + F5` | `Cmd + Shift + F5` | C / C++ 编辑器激活 |
| 继续运行 (Continue) | `F5` | `F5` | GDB 暂停状态 |
| 单步跳过 (Step Over) | `F10` | `F10` | GDB 暂停状态 |
| 单步进入 (Step Into) | `F11` | `F11` | GDB 暂停状态 |
| 单步跳出 (Step Out) | `Shift + F11` | `Shift + F11` | GDB 暂停状态 |
| 运行到光标处 (Run to Cursor) | `Ctrl + F10` | `Cmd + F10` | C / C++ 编辑器激活 |
| 停止调试 (Stop) | `Shift + F5` | `Shift + F5` | GDB 调试进行中 |

---

## ⚙️ 扩展配置项 (`Settings`)

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `dreamCppDebug.gdbPath` | `string` | `"gdb"` | GDB 可执行文件路径（如 `gdb` 或 `C:\mingw64\bin\gdb.exe`） |
| `dreamCppDebug.compilerPath` | `string` | `"g++"` | C++ 编译器可执行文件路径（`.c` 文件会自动回退到 `gcc`） |
| `dreamCppDebug.compileFlags` | `array` | `["-g", "-O0", "-std=c++17"]` | 编译参数（自动确保包含 `-g` 调试符号） |
| `dreamCppDebug.stopAtMain` | `boolean` | `true` | 启动调试后是否默认在 `main` 函数入口处自动暂停 |
| `dreamCppDebug.showInlineValues` | `boolean` | `true` | 在编辑器当前暂停行尾内联展示局部变量实时值 |
| `dreamCppDebug.enableHoverEval` | `boolean` | `true` | 调试暂停时将鼠标悬停在代码变量上自动通过 GDB 求值 |
| `dreamCppDebug.maxArrayPreview` | `number` | `16` | 侧边栏数组与 `std::vector` 可视化条带默认预览的最大元素数 |

---

## 🛠️ 环境要求与安装

1. 确保系统已安装 **GCC (`g++`)** 与 **GDB (`gdb`)** 并已加入系统环境变量 `PATH`：
   - **Linux (Ubuntu/Debian)**：`sudo apt install build-essential gdb`
   - **Windows**：安装 [MinGW-w64 / MSYS2](https://www.msys2.org/) 并确保 `g++.exe` 与 `gdb.exe` 所在 `bin` 目录位于 `PATH` 中。
   - **macOS**：安装带签名配置的 GDB 或在设置中指定 `gdbPath`。
2. 在 VS Code 中加载本扩展目录（按 `F5` 启动扩展开发宿主），或通过 `.vsix` 安装包离线安装。

## 安全与输出限制

- 扩展需要受信任的工作区。编译器、GDB、监视表达式和被调试程序会以当前用户权限运行；本扩展不是沙箱，不要在本机执行不可信的代码或 GDB 命令。
- 输入文件必须是普通文件，预览异步读取最多 512 字节；超过 2 MiB 的源码跳过声明扫描，可能不能准确提示变量尚未初始化。
- 快速运行在超时或停止时尝试终止进程组（Windows 使用 taskkill 进程树）。主动脱离进程组、已经孤立的后代进程或系统拒绝终止时仍可能存活，不能替代操作系统沙箱或资源限制。
- 内存中保留的输出限制为约 1 Mi 字符，超出时保留较新的内容并显示截断提示。GDB 输出重定向文件超过 32 MiB 时会在轮询发现后停止调试；由于存在轮询延迟，这不是硬性磁盘配额。请使用操作系统级隔离和资源限制运行不可信程序。
- 每次编译生成独立的 `.dream-debug/build-*` 目录，不自动删除已有构建；确认不再需要时可手动清理该目录。
- 当无法确认字符串容量或数组大小时，修改操作会安全失败；过长的字符串赋值在 GDB 的正常 `assign` 不可用时可能被拒绝。
- Windows 下包含 `" % ! ^ & | < >` 的 GDB 输入文件路径或程序参数会被拒绝，避免有歧义的命令行解析。

## 🧪 运行测试

本仓库内置了針對 GDB/MI2 协议解析器、C++ STL 容器解包器、编译器诊断解析以及真实 `g++` + `gdb` 端到端调试流程的自动化测试套件：

```bash
npm test
```

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源，作者 **wudream813**。
