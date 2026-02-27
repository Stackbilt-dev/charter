param(
  [string]$TaskName = "StackbiltDocsOssSync",
  [string]$DailyAt = "09:17",
  [string]$WslDistro = "",
  [string]$RepoPath = "/mnt/c/Users/kover/Documents/digitalcsa-kit"
)

$logPath = "$RepoPath/logs/docs-oss-auto.log"
$cmdCore = "cd $RepoPath && mkdir -p logs && pnpm run docs:oss:auto >> $logPath 2>&1"

if ([string]::IsNullOrWhiteSpace($WslDistro)) {
  $wslArgs = "-e bash -lc `"$cmdCore`""
} else {
  $wslArgs = "-d $WslDistro -e bash -lc `"$cmdCore`""
}

$action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument $wslArgs
$trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Auto-sync OSS docs from digitalcsa-kit to stackbilt_docs_v2 and push" `
  -Force | Out-Null

Write-Host "Installed/updated scheduled task: $TaskName"
Write-Host "Schedule: daily at $DailyAt"
Write-Host "Command: wsl.exe $wslArgs"
