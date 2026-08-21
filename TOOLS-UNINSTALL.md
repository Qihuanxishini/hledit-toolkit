# 测试工具安装与卸载备忘（内部）

> 本文件是浮浮酱的内部备忘，供后续卸载时参考，不包含真实个人信息。
> 用途：为 Go 的 `cgo` 提供 C 编译器，使 `go test -race ./...` 可运行。

## 为什么装

- 本机 Go 默认 `CGO_ENABLED=0`，`go test -race` 需要 cgo + 外部 C 编译器。
- 之前 `CGO_ENABLED=1` 时找不到 `gcc`，故安装 MSYS2 的 UCRT64 GCC。

## 装了什么

- **MSYS2**：Windows 上的类 Unix 工具链平台 + pacman 包管理器。
- **UCRT64 GCC**：`mingw-w64-ucrt-x86_64-gcc`（含 binutils、crt、gcc-libs 等依赖）。

## 关键路径

- MSYS2 根目录：`C:\msys64`
- GCC 可执行文件：`C:\msys64\ucrt64\bin\gcc.exe`
- 用户 PATH 新增：`C:\msys64\ucrt64\bin`
- 系统 PATH：未改动

## 验证结果

- `gcc --version` → 16.2.0
- `CGO_ENABLED=1 CC=gcc go test -race ./...` → 通过（161 项）
- `go vet ./...` → 通过

## 卸载步骤

### 1. 移除用户 PATH 中的条目

```powershell
$gccDir = "C:\msys64\ucrt64\bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($userPath -split ";" | Where-Object { $_ -and $_ -ne $gccDir })
[Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")
```

### 2. 卸载 MSYS2

- 方式 A（推荐）：用 winget 卸载
  ```powershell
  winget uninstall --id MSYS2.MSYS2
  ```
- 方式 B：直接删除 `C:\msys64` 目录（若 winget 卸载不干净）。

### 3. 验证

```powershell
Test-Path "C:\msys64"          # 应为 False
Test-Path "C:\msys64\ucrt64\bin\gcc.exe"  # 应为 False
[Environment]::GetEnvironmentVariable("Path", "User")  # 不应再含 msys64
```

## 卸载后影响

- `go test -race ./...` 将无法运行（回到 `CGO_ENABLED=0` 状态）。
- 普通 `go test ./...`、`go vet ./...`、`go build` 不受影响。
- 若后续需要 race 检查，需重新安装 GCC 或改用具备 GCC 的 CI 环境。