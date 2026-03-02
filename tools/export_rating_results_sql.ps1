Param(
  [Parameter(Mandatory = $false)]
  [string]$CasesFile = "golden_cases.json",

  [Parameter(Mandatory = $false)]
  [string]$EngineScript = "tools/run_billing_engine.ps1",

  [Parameter(Mandatory = $false)]
  [string]$EngineOutFile = "billing_engine_results.json",

  [Parameter(Mandatory = $false)]
  [string]$OutSqlFile = "fixtures/rating_results_golden.sql"
)

$ErrorActionPreference = "Stop"

function Convert-MbToKbCeil([double]$Mb, [int]$MbToKb) {
  return [long][math]::Ceiling($Mb * $MbToKb)
}

if (-not (Test-Path $CasesFile)) {
  throw "Cases file not found: $CasesFile"
}

$casesDoc = Get-Content -Raw $CasesFile | ConvertFrom-Json
$mbToKb = [int]$casesDoc.meta.unit.mbToKb
$currency = [string]$casesDoc.meta.currency

if (Test-Path $EngineScript) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $EngineScript -CasesFile $CasesFile -OutFile $EngineOutFile | Out-Null
}

if (-not (Test-Path $EngineOutFile)) {
  throw "Engine output not found: $EngineOutFile"
}

$engineDoc = Get-Content -Raw $EngineOutFile | ConvertFrom-Json
$engineMap = @{}
foreach ($r in @($engineDoc.results)) {
  $engineMap[$r.id] = $r.actual
}

if (-not (Test-Path (Split-Path -Parent $OutSqlFile))) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutSqlFile) | Out-Null
}

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("BEGIN;")

foreach ($c in @($casesDoc.cases)) {
  $type = [string]$c.type
  if (@("usage_match", "payg_out_of_profile", "overage_when_exhausted", "inactive_usage") -notcontains $type) {
    continue
  }

  if (-not $engineMap.ContainsKey($c.id)) {
    throw "Engine result missing for case: $($c.id)"
  }

  $actual = $engineMap[$c.id]
  $visited = [string]$c.context.usage.visitedMccMnc
  $totalMb = [double]$c.context.usage.totalMb
  $chargedKb = Convert-MbToKbCeil $totalMb $mbToKb

  $classification = [string]$actual.charge.type
  $amount = $null
  $rate = $null
  $outCurrency = $null
  if ($null -ne $actual.charge.amount) { $amount = [double]$actual.charge.amount }
  if ($null -ne $actual.charge.ratePerKb) { $rate = [double]$actual.charge.ratePerKb }
  if ($null -ne $actual.charge.currency) { $outCurrency = [string]$actual.charge.currency } else { $outCurrency = $currency }

  $inputRef = "golden:$($c.id)"
  if ($null -ne $c.context.lateUsage -and $null -ne $c.context.lateUsage.inputRef) {
    $inputRef = [string]$c.context.lateUsage.inputRef
  }

  $amountSql = if ($null -eq $amount) { "0" } else { $amount.ToString("0.00", [System.Globalization.CultureInfo]::InvariantCulture) }
  $rateSql = if ($null -eq $rate) { "NULL" } else { $rate.ToString("0.########", [System.Globalization.CultureInfo]::InvariantCulture) }
  $currencySql = if ([string]::IsNullOrWhiteSpace($outCurrency)) { "NULL" } else { "'" + $outCurrency.Replace("'", "''") + "'" }

  $calcId = "golden_case_$($c.id)"

  $lines.Add(
    "INSERT INTO rating_results (calculation_id, iccid, visited_mccmnc, input_ref, classification, charged_kb, rate_per_kb, amount, currency) VALUES (" +
    "'" + $calcId.Replace("'", "''") + "'," +
    "'" + ([string]$c.context.sim.iccid).Replace("'", "''") + "'," +
    "'" + $visited.Replace("'", "''") + "'," +
    "'" + $inputRef.Replace("'", "''") + "'," +
    "'" + $classification.Replace("'", "''") + "'," +
    $chargedKb + "," +
    $rateSql + "," +
    $amountSql + "," +
    $currencySql +
    ");"
  )
}

$lines.Add("COMMIT;")

Set-Content -Encoding UTF8 -Path $OutSqlFile -Value ($lines -join "`n")
Write-Host "Wrote SQL to $OutSqlFile"

