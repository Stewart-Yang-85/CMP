Param(
  [Parameter(Mandatory = $false)]
  [string]$SupabaseUrl = $env:SUPABASE_URL,

  [Parameter(Mandatory = $false)]
  [string]$AnonKey = $env:SUPABASE_ANON_KEY,

  [Parameter(Mandatory = $false)]
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Load-DotEnvIfPresent([string]$FilePath) {
  if (-not (Test-Path $FilePath)) {
    return
  }

  $lines = Get-Content -Path $FilePath
  foreach ($line in $lines) {
    $trimmed = ([string]$line).Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
    if ($trimmed.StartsWith('#')) { continue }
    $idx = $trimmed.IndexOf('=')
    if ($idx -le 0) { continue }
    $key = $trimmed.Substring(0, $idx).Trim()
    $val = $trimmed.Substring($idx + 1).Trim()
    $val = $val.Trim('"')

    if ([string]::IsNullOrWhiteSpace($key)) { continue }
    $existing = $null
    try {
      $existing = (Get-Item -Path "Env:$key" -ErrorAction Stop).Value
    } catch {
      $existing = $null
    }
    if ([string]::IsNullOrWhiteSpace([string]$existing)) {
      Set-Item -Path "Env:$key" -Value $val
    }
  }
}

Load-DotEnvIfPresent (Join-Path (Get-Location) '.env')

if ([string]::IsNullOrWhiteSpace($SupabaseUrl)) {
  $SupabaseUrl = $env:SUPABASE_URL
}
if ([string]::IsNullOrWhiteSpace($AnonKey)) {
  $AnonKey = $env:SUPABASE_ANON_KEY
}

if ([string]::IsNullOrWhiteSpace($SupabaseUrl)) {
  throw "SUPABASE_URL is required (env var or -SupabaseUrl)"
}

if ([string]::IsNullOrWhiteSpace($AnonKey)) {
  throw "SUPABASE_ANON_KEY is required (env var or -AnonKey)"
}

$base = ""
if ($null -ne $SupabaseUrl) {
  $base = [string]$SupabaseUrl
}
$base = $base.Trim().Trim('"').TrimEnd('/')

if ($base -match "<|>") {
  throw "SUPABASE_URL is still a placeholder. Set it to a real project URL like https://xxxx.supabase.co"
}

if (-not ($base -match '^https://[A-Za-z0-9-]+\.supabase\.co$')) {
  throw ("SUPABASE_URL is invalid: {0}. Expected https://<project-ref>.supabase.co (no spaces/newlines)" -f $base)
}
$headers = @{
  apikey        = $AnonKey
  Authorization = "Bearer $AnonKey"
}

function Assert-Equal([double]$Actual, [double]$Expected, [string]$Message) {
  if ([math]::Abs($Actual - $Expected) -gt 0.00001) {
    throw "$Message. Actual=$Actual Expected=$Expected"
  }
}

$path = "$base/rest/v1/v_rating_results_golden"
$query = "select=calculation_id,amount&calculation_id=like.golden_case_*&order=calculation_id.asc"
$uriText = "$path`?$query"

$uri = $null
if (-not [System.Uri]::TryCreate($uriText, [System.UriKind]::Absolute, [ref]$uri)) {
  throw "无法构造有效的 URL：${uriText}"
}

if ($DryRun) {
  Write-Host "OK: $($uri.AbsoluteUri)" -ForegroundColor Green
  exit 0
}
$rows = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers

if ($null -eq $rows) { $rows = @() }
$count = @($rows).Count

if ($count -lt 8) {
  throw "Expected at least 8 golden rows in rating_results, got $count"
}

$sum = 0.0
foreach ($r in $rows) {
  $sum += [double]$r.amount
}

Assert-Equal $sum 512.0 "Sum(amount) for golden rows"

$rpcUri = "$base/rest/v1/rpc/get_golden_bill_summary"
$rpc = Invoke-RestMethod -Method Post -Uri $rpcUri -Headers $headers -ContentType "application/json" -Body "{}"
if ($null -eq $rpc -or @($rpc).Count -ne 1) {
  throw "Expected exactly 1 row from get_golden_bill_summary, got $(@($rpc).Count)"
}

$summary = @($rpc)[0]
Assert-Equal ([double]$summary.total_amount) 512.0 "golden bill summary total_amount"
if ([long]$summary.line_count -lt 8) {
  throw "Expected golden bill summary line_count >= 8, got $($summary.line_count)"
}

$listBody = @{ p_period = "2026-02"; p_status = $null; p_sort_by = "period"; p_sort_order = "desc"; p_limit = 20; p_offset = 0 } | ConvertTo-Json -Compress
$listUri = "$base/rest/v1/rpc/list_bills"
$list = Invoke-RestMethod -Method Post -Uri $listUri -Headers $headers -ContentType "application/json" -Body $listBody
if ($null -eq $list) {
  throw "list_bills returned null"
}
$items = $null
if ($list.items -ne $null) {
  $items = @($list.items)
} else {
  $items = @()
}
if (@($items).Count -lt 1) {
  throw "list_bills returned no items"
}
$first = $items[0]
if ([string]$first.period -ne "2026-02") {
  throw ("first.period {0} <> 2026-02" -f [string]$first.period)
}
if ([double]$first.totalAmount -ne 512) {
  throw ("first.totalAmount {0} <> 512" -f [double]$first.totalAmount)
}
$billId = [string]$first.billId
if ([string]::IsNullOrWhiteSpace($billId)) {
  throw "first.billId missing"
}
$getBody = @{ p_bill_id = $billId } | ConvertTo-Json -Compress
$getUri = "$base/rest/v1/rpc/get_bill"
$bill = Invoke-RestMethod -Method Post -Uri $getUri -Headers $headers -ContentType "application/json" -Body $getBody
if ($null -eq $bill) {
  throw "get_bill returned null"
}
if ([string]$bill.billId -ne $billId) {
  throw ("get_bill billId mismatch {0} <> {1}" -f [string]$bill.billId, $billId)
}
$filesBody = @{ p_bill_id = $billId } | ConvertTo-Json -Compress
$filesUri = "$base/rest/v1/rpc/get_bill_files"
$files = Invoke-RestMethod -Method Post -Uri $filesUri -Headers $headers -ContentType "application/json" -Body $filesBody
if ($null -eq $files) {
  throw "get_bill_files returned null"
}
if (-not ($files.PSObject.Properties.Name -contains "csvUrl")) {
  throw "get_bill_files missing csvUrl"
}
if (-not ($files.PSObject.Properties.Name -contains "pdfUrl")) {
  throw "get_bill_files missing pdfUrl"
}
Write-Host ("PASS: rating rows={0}, sum(amount)={1}, summary.total_amount={2}, summary.line_count={3}, billId={4}, files=ok" -f $count, $sum, $summary.total_amount, $summary.line_count, $billId) -ForegroundColor Green
