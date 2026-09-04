<#
  천안 AX 인사이트 — GitHub 저장소 연결 + 첫 배포

  사전 준비(웹에서 3분):
    1) github.com/new 에서 저장소 생성 — Public, README/gitignore 체크 없이 빈 저장소로
    2) 저장소 Settings > Pages > Source: Deploy from a branch > main / (root)
    3) 저장소 Settings > Actions > General > Workflow permissions
       > Read and write permissions   ← 매일 자동 수집 커밋에 필요

  사용법:
    powershell -ExecutionPolicy Bypass -File scripts\publish.ps1 -Account kklique -Repo cheonan-ax-news

  첫 push 때 브라우저 로그인 창(Git Credential Manager)이 한 번 뜬다.
#>
param(
  [Parameter(Mandatory = $true)][string]$Account,
  [string]$Repo = "cheonan-ax-news",
  [switch]$UseSsh
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path", "User")

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "git 을 찾을 수 없습니다. 새 PowerShell 창에서 다시 실행해 보세요."
  exit 1
}
if (-not (Test-Path (Join-Path $root ".git"))) {
  Write-Error "이 폴더는 git 저장소가 아닙니다: $root"
  exit 1
}

$url = if ($UseSsh) { "git@github.com:$Account/$Repo.git" } else { "https://github.com/$Account/$Repo.git" }

# 이미 origin 이 있으면 주소만 바꾼다(재실행해도 안전하게).
if (git remote | Select-String -Quiet "^origin$") {
  Write-Host "  기존 origin 을 $url 로 변경합니다." -ForegroundColor Yellow
  git remote set-url origin $url
} else {
  git remote add origin $url
}

Write-Host ""
Write-Host "  저장소 : $url" -ForegroundColor Cyan
Write-Host "  브랜치 : $(git branch --show-current)"
Write-Host "  커밋   : $(git rev-list --count HEAD)개"
Write-Host ""

git push -u origin main
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Error @"
push 실패. 흔한 원인:
  - 저장소를 아직 안 만들었거나 이름/계정이 다름  → github.com/$Account/$Repo 접속해 확인
  - 저장소를 README 포함으로 만들어 원격에 커밋이 있음
      → git pull --rebase origin main  후 다시 실행
  - 로그인 취소 → 다시 실행하면 로그인 창이 다시 뜸
"@
  exit 1
}

Write-Host ""
Write-Host "  배포 완료. Pages 빌드에 1~2분 걸립니다." -ForegroundColor Green
Write-Host "  주소: https://$Account.github.io/$Repo/" -ForegroundColor Green
Write-Host "  진행 상황: https://github.com/$Account/$Repo/actions"
Write-Host ""
