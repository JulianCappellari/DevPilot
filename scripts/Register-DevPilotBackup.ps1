[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')]
    [string]$At = '03:00',
    [string]$TaskName = 'DevPilot Backup',
    [switch]$Replace
)

$ErrorActionPreference = 'Stop'
$devPilotRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$devPilotNode = Get-Command node.exe -CommandType Application | Select-Object -First 1 -ExpandProperty Source
if (-not (Test-Path -LiteralPath (Join-Path $devPilotRoot 'node_modules/tsx/package.json'))) {
    throw 'Instalá las dependencias con npm ci antes de registrar el backup.'
}

$devPilotUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$devPilotTime = [datetime]::ParseExact($At, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
$taskAction = New-ScheduledTaskAction -Execute $devPilotNode -Argument '--env-file-if-exists=.env --import tsx apps/api/src/cli.ts backup' -WorkingDirectory $devPilotRoot
$taskOptions = @{
    TaskName = $TaskName
    Action = $taskAction
    Trigger = New-ScheduledTaskTrigger -Daily -At $devPilotTime
    Principal = New-ScheduledTaskPrincipal -UserId $devPilotUser -LogonType Interactive -RunLevel Limited
    Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
    Force = $Replace
}

if ($PSCmdlet.ShouldProcess($TaskName, "Registrar backup diario a las $At")) {
    Register-ScheduledTask @taskOptions | Out-Null
    Write-Output "Backup registrado: $TaskName"
}
