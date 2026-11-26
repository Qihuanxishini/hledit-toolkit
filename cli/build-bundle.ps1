param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$utf8 = [Text.UTF8Encoding]::new($false)
$root = $PSScriptRoot
$target = 'x86_64-pc-windows-msvc'
$targetDir = Join-Path $root 'target'
$bundle = Join-Path $root '../pi-hledit-diff/bin'
$binary = Join-Path $bundle 'hledit.exe'
$stampPath = Join-Path $bundle 'hledit.build.json'
$licensePath = Join-Path $bundle 'THIRD-PARTY-LICENSES.txt'

function Get-TextDigest([string]$Text) {
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($Text))).ToLowerInvariant()
}
function Get-SourceDigest {
    $files = @('Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build-bundle.ps1')
    $files += Get-ChildItem -LiteralPath (Join-Path $root 'src') -Recurse -File -Filter '*.rs' |
        ForEach-Object { [IO.Path]::GetRelativePath($root, $_.FullName).Replace('\', '/') }
    [Array]::Sort($files, [StringComparer]::Ordinal)
    $records = foreach ($file in $files) {
        # [喵喵喵]: 忽略 checkout 的 CRLF 转换，不把绝对工作区路径写入来源指纹。
        $text = [IO.File]::ReadAllText((Join-Path $root $file)).Replace("`r`n", "`n")
        $file + ':' + (Get-TextDigest $text)
    }
    Get-TextDigest ($records -join "`n")
}

function Assert-WritableIntegrity([string]$Path) {
    if (-not $IsWindows) { return }
    if (-not ('Hledit.BuildIntegrity' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
namespace Hledit {
    public static class BuildIntegrity {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        static extern uint GetNamedSecurityInfoW(string name, int type, uint info,
            IntPtr owner, IntPtr group, IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetAce(IntPtr acl, int index, out IntPtr ace);
        [DllImport("kernel32.dll")]
        static extern IntPtr LocalFree(IntPtr memory);
        public static void Assert(string path) {
            IntPtr acl, descriptor;
            uint error = GetNamedSecurityInfoW(path, 1, 0x10,
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out acl, out descriptor);
            if (error != 0) throw new Win32Exception((int)error, "Read integrity label: " + path);
            try {
                if (acl == IntPtr.Zero) return;
                int count = (ushort)Marshal.ReadInt16(acl, 4);
                for (int i = 0; i < count; i++) {
                    IntPtr ace;
                    if (!GetAce(acl, i, out ace)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (Marshal.ReadByte(ace) != 0x11 || (Marshal.ReadByte(ace, 1) & 8) != 0) continue;
                    string sid = new SecurityIdentifier(IntPtr.Add(ace, 8)).Value;
                    int level = int.Parse(sid.Substring(sid.LastIndexOf('-') + 1));
                    if (level < 8192) throw new InvalidOperationException(
                        "Integrity below Medium: " + path + ". Low-integrity executables cannot write normal user files; review the deployment directory labels. No permissions were changed.");
                }
            } finally { LocalFree(descriptor); }
        }
    }
}
'@
    }
    [Hledit.BuildIntegrity]::Assert([IO.Path]::GetFullPath($Path))
}

# [喵喵喵]: MIC 标签不进入 Git 或文件哈希；普通用户运行 Low exe 时仍会被禁止写入 Medium 文件。
Assert-WritableIntegrity (Join-Path $root '..')
Assert-WritableIntegrity $bundle

$sourceDigest = Get-SourceDigest
if ($VerifyOnly) {
    Assert-WritableIntegrity $binary
    $stamp = [IO.File]::ReadAllText($stampPath) | ConvertFrom-Json
    $binaryDigest = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    $licenseDigest = (Get-FileHash -LiteralPath $licensePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($stamp.schema -ne 1 -or $stamp.sourceSha256 -cne $sourceDigest -or
        $stamp.binarySha256 -cne $binaryDigest -or $stamp.licensesSha256 -cne $licenseDigest) {
        throw 'bundled CLI, licenses, or source fingerprint is stale; run cli/build-bundle.ps1 and review all generated artifacts'
    }
    Write-Output 'Bundled CLI source fingerprint, binary SHA-256, and licenses match; Windows integrity labels checked where applicable.'
    exit 0
}
if (-not $IsWindows) { throw 'The bundled CLI must be built on Windows x64.' }
$oldFlags = $env:RUSTFLAGS
Push-Location $root
try {
    # [喵喵喵]: 静态 CRT 保持单 exe 部署；链接器随 Rust 固定，平台库差异不伪装成跨主机可复现构建。
    $env:RUSTFLAGS = '-C target-feature=+crt-static -C linker=rust-lld -C link-arg=/Brepro'
    & cargo build --release --locked --target $target --target-dir $targetDir
    if ($LASTEXITCODE -ne 0) { throw 'Rust release build failed' }
    $builtBinary = Join-Path $targetDir "$target/release/hledit.exe"
    Assert-WritableIntegrity $builtBinary
    $metadataText = & cargo metadata --locked --format-version 1 --filter-platform $target
    if ($LASTEXITCODE -ne 0) { throw 'Cargo metadata failed' }
    $metadata = ($metadataText -join "`n") | ConvertFrom-Json
    $notices = [Collections.Generic.List[string]]::new()
    $notices.Add("Third-party notices for hledit`n`nRust standard library: MIT OR Apache-2.0.`nCopyright (c) The Rust Project Contributors.`nThe MIT and Apache-2.0 texts reproduced below also apply to the Rust standard library.")
    foreach ($package in ($metadata.packages | Where-Object name -ne 'hledit' | Sort-Object name, version)) {
        $directory = Split-Path -Parent $package.manifest_path
        $licenses = @(Get-ChildItem -LiteralPath $directory -File | Where-Object { $_.Name -match '^(LICENSE|COPYING|COPYRIGHT)' } | Sort-Object Name)
        if ($licenses.Count -eq 0) { throw "No license text found for $($package.name)" }
        $notices.Add("===== $($package.name) $($package.version) ($($package.license)) =====")
        foreach ($license in $licenses) {
            $notices.Add("--- $($license.Name) ---`n" + [IO.File]::ReadAllText($license.FullName).Replace("`r`n", "`n"))
        }
    }
    # [喵喵喵]: 只覆盖本脚本负责的制品，不清理 bin 中其他文件。
    Copy-Item -LiteralPath $builtBinary -Destination $binary -Force
    Assert-WritableIntegrity $binary
    [IO.File]::WriteAllText($licensePath, ($notices -join "`n`n").TrimEnd("`r", "`n") + "`n", $utf8)
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $bundle 'LICENSE.hledit.txt') -Force
    $rustVersion = & rustc --version
    if ($LASTEXITCODE -ne 0) { throw 'Cannot identify Rust compiler' }
    $stamp = [ordered]@{
        schema = 1
        sourceSha256 = $sourceDigest
        binarySha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
        licensesSha256 = (Get-FileHash -LiteralPath $licensePath -Algorithm SHA256).Hash.ToLowerInvariant()
        rustc = $rustVersion
        target = $target
    }
    [IO.File]::WriteAllText($stampPath, ($stamp | ConvertTo-Json) + "`n", $utf8)
} finally {
    $env:RUSTFLAGS = $oldFlags
    Pop-Location
}
