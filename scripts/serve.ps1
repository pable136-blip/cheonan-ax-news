<#
  천안 AX 인사이트 — 로컬/내부망 미리보기 서버

  이 사이트는 data/*.json 을 fetch() 로 불러오기 때문에 index.html 을 파일로 직접
  열면(file://) 브라우저 보안정책에 막혀 아무 데이터도 뜨지 않는다. 반드시 HTTP 로
  띄워야 한다. 별도 설치 없이 윈도우 기본 PowerShell 만으로 동작한다.

  사용법:
    powershell -ExecutionPolicy Bypass -File scripts\serve.ps1
    powershell -ExecutionPolicy Bypass -File scripts\serve.ps1 -Port 8080

  종료: 콘솔에서 Ctrl+C
#>
param(
  [int]$Port = 8000,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root "index.html"))) {
  Write-Error "index.html 을 찾을 수 없습니다. 이 스크립트는 프로젝트의 scripts\ 폴더 안에 있어야 합니다."
  exit 1
}

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".htm"  = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".md"   = "text/markdown; charset=utf-8"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".gif"  = "image/gif"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
  ".woff2"= "font/woff2"
  ".woff" = "font/woff"
  ".pdf"  = "application/pdf"
  ".txt"  = "text/plain; charset=utf-8"
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Error "포트 $Port 을(를) 열 수 없습니다. 다른 포트를 써 보세요:  -Port 8080"
  exit 1
}

Write-Host ""
Write-Host "  천안 AX 인사이트 미리보기" -ForegroundColor Cyan
Write-Host "  $prefix" -ForegroundColor Green
Write-Host "  문서 루트: $root"
Write-Host "  종료하려면 Ctrl+C"
Write-Host ""

if (-not $NoBrowser) { Start-Process $prefix | Out-Null }

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $rel = [uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
      if ($rel -eq '') { $rel = 'index.html' }
      $rel = $rel.Replace('/', '\')

      # 문서 루트 밖으로 나가는 경로(../ 등)는 거부한다.
      $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
      if (-not $full.StartsWith([System.IO.Path]::GetFullPath($root), [StringComparison]::OrdinalIgnoreCase)) {
        $res.StatusCode = 403; $res.Close(); continue
      }

      if (Test-Path $full -PathType Container) { $full = Join-Path $full "index.html" }

      if (Test-Path $full -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($full).ToLower()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
        $res.Headers.Add("Cache-Control", "no-store")
        $bytes = [System.IO.File]::ReadAllBytes($full)
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        Write-Host ("  200  " + $req.Url.AbsolutePath)
      } else {
        $res.StatusCode = 404
        $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $rel")
        $res.OutputStream.Write($msg, 0, $msg.Length)
        Write-Host ("  404  " + $req.Url.AbsolutePath) -ForegroundColor DarkYellow
      }
    } catch {
      try { $res.StatusCode = 500 } catch {}
      Write-Host ("  500  " + $_.Exception.Message) -ForegroundColor Red
    } finally {
      try { $res.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
