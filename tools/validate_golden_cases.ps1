Param(
  [Parameter(Mandatory = $false)]
  [string]$CasesFile = "golden_cases.json",

  [Parameter(Mandatory = $false)]
  [string]$EngineScript = "tools/run_billing_engine.ps1",

  [Parameter(Mandatory = $false)]
  [string]$EngineOutFile = "billing_engine_results.json"
)

$ErrorActionPreference = "Stop"

function Assert-Equal($Actual, $Expected, $Message) {
  if ($null -eq $Actual -and $null -eq $Expected) { return }
  if ($Actual -is [double] -or $Expected -is [double]) {
    $a = [double]$Actual
    $e = [double]$Expected
    if ([math]::Abs($a - $e) -gt 0.0000001) {
      throw "$Message. Actual=$a Expected=$e"
    }
    return
  }
  if ($Actual -ne $Expected) {
    throw "$Message. Actual=$Actual Expected=$Expected"
  }
}

function Convert-MbToKbCeil([double]$Mb, [int]$MbToKb) {
  return [long][math]::Ceiling($Mb * $MbToKb)
}

function Get-CoverageSpecificity($Coverage) {
  if ($null -eq $Coverage) { return 0 }
  if ($Coverage.type -eq "GLOBAL") { return 1 }
  if ($Coverage.type -eq "MCCMNC_ALLOWLIST") {
    if ($null -eq $Coverage.mccmnc) { return 2 }
    return 1000 + @($Coverage.mccmnc).Count
  }
  return 0
}

function Coverage-Includes($Coverage, [string]$VisitedMccMnc) {
  if ($null -eq $Coverage) { return $false }
  if ($Coverage.type -eq "GLOBAL") { return $true }
  if ($Coverage.type -eq "MCCMNC_ALLOWLIST") {
    return @($Coverage.mccmnc) -contains $VisitedMccMnc
  }
  return $false
}

function Select-MatchingPackage($CatalogPackages, $Subscriptions, [string]$VisitedMccMnc) {
  function Get-Pkg($Id) {
    if ($null -eq $CatalogPackages) { return $null }
    $prop = $CatalogPackages.PSObject.Properties[$Id]
    if ($null -eq $prop) { return $null }
    return $prop.Value
  }

  $subList = @($Subscriptions)
  $addOns = @($subList | Where-Object { $_.kind -eq "ADD_ON" })
  $mains = @($subList | Where-Object { $_.kind -eq "MAIN" })

  $addOnCandidates = @()
  foreach ($sub in $addOns) {
    $pkg = Get-Pkg $sub.package
    if ($null -eq $pkg) { continue }
    if (Coverage-Includes $pkg.coverage $VisitedMccMnc) {
      $addOnCandidates += [pscustomobject]@{ id = $sub.package; pkg = $pkg }
    }
  }

  if ($addOnCandidates.Count -gt 0) {
    $sorted = $addOnCandidates | Sort-Object -Property @{ Expression = { Get-CoverageSpecificity $_.pkg.coverage } ; Descending = $false }, @{ Expression = { $_.id } ; Descending = $false }
    return $sorted[0].id
  }

  foreach ($sub in $mains) {
    $pkg = Get-Pkg $sub.package
    if ($null -eq $pkg) { continue }
    if (Coverage-Includes $pkg.coverage $VisitedMccMnc) {
      return $sub.package
    }
  }

  return $null
}

function Resolve-PaygRatePerKb($MainPackage, [string]$VisitedMccMnc) {
  if ($null -eq $MainPackage) { return $null }
  if ($null -eq $MainPackage.payg) { return $null }
  if ($null -eq $MainPackage.payg.zones) { return $null }

  foreach ($zoneName in $MainPackage.payg.zones.PSObject.Properties.Name) {
    $zone = $MainPackage.payg.zones.$zoneName
    if ($null -eq $zone) { continue }
    if (@($zone.mccmnc) -contains $VisitedMccMnc) {
      return [double]$zone.ratePerKb
    }
  }

  return $null
}

function Evaluate-UsageMatch($Doc, $Case) {
  $pkgs = $Doc.catalog.packages
  $visited = $Case.context.usage.visitedMccMnc
  $totalMb = [double]$Case.context.usage.totalMb
  $matched = Select-MatchingPackage $pkgs $Case.context.subscriptions $visited

  Assert-Equal $matched $Case.expect.match.package "Case $($Case.id) matched package"
  Assert-Equal ([bool]($null -ne $matched)) ([bool]$Case.expect.inProfile) "Case $($Case.id) inProfile"
  Assert-Equal $Case.expect.deductFromPackage $matched "Case $($Case.id) deductFromPackage"

  $chargedKb = Convert-MbToKbCeil $totalMb $Doc.meta.unit.mbToKb
  Assert-Equal $chargedKb $chargedKb "Case $($Case.id) unit conversion sanity"
}

function Evaluate-PaygOutOfProfile($Doc, $Case) {
  $pkgs = $Doc.catalog.packages
  $visited = $Case.context.usage.visitedMccMnc
  $totalMb = [double]$Case.context.usage.totalMb

  $mainSub = @($Case.context.subscriptions | Where-Object { $_.kind -eq "MAIN" }) | Select-Object -First 1
  $mainPkg = $null
  if ($null -ne $mainSub) {
    $prop = $pkgs.PSObject.Properties[$mainSub.package]
    if ($null -ne $prop) { $mainPkg = $prop.Value }
  }

  $matched = Select-MatchingPackage $pkgs $Case.context.subscriptions $visited
  Assert-Equal $matched $null "Case $($Case.id) should be out-of-profile"

  $chargedKb = Convert-MbToKbCeil $totalMb $Doc.meta.unit.mbToKb
  $rate = Resolve-PaygRatePerKb $mainPkg $visited
  if ($null -eq $rate) {
    Assert-Equal $Case.expect.charge.type "PAYG_RULE_MISSING" "Case $($Case.id) payg missing"
    if (@($Case.expect.alerts) -notcontains "PAYG_RULE_MISSING") {
      throw "Case $($Case.id) expected PAYG_RULE_MISSING alert"
    }
    return
  }

  $amount = [math]::Round(($chargedKb * $rate), 2)

  Assert-Equal $Case.expect.charge.type "PAYG" "Case $($Case.id) charge type"
  Assert-Equal ([double]$Case.expect.charge.ratePerKb) $rate "Case $($Case.id) ratePerKb"
  Assert-Equal ([long]$Case.expect.charge.chargedKb) $chargedKb "Case $($Case.id) chargedKb"
  Assert-Equal ([double]$Case.expect.charge.amount) $amount "Case $($Case.id) amount"
  if (@($Case.expect.alerts) -notcontains "UNEXPECTED_ROAMING") {
    throw "Case $($Case.id) expected UNEXPECTED_ROAMING alert"
  }
}

function Evaluate-MonthlyFeeHighWater($Case) {
  $states = @($Case.context.stateTrajectory | ForEach-Object { $_.status })
  $hasActivated = $states -contains "ACTIVATED"
  $hasDeactivated = $states -contains "DEACTIVATED"
  if ($hasActivated) {
    Assert-Equal $Case.expect.chargeType "MONTHLY_FEE" "Case $($Case.id) chargeType"
    Assert-Equal ([double]$Case.expect.amount) ([double]$Case.context.monthlyFee) "Case $($Case.id) amount"
    return
  }
  if ($hasDeactivated) {
    Assert-Equal $Case.expect.chargeType "DEACTIVATED_MONTHLY_FEE" "Case $($Case.id) chargeType"
    Assert-Equal ([double]$Case.expect.amount) ([double]$Case.context.deactivatedMonthlyFee) "Case $($Case.id) amount"
    return
  }
  throw "Case $($Case.id) trajectory has no billable status"
}

function Evaluate-LateCdrAdjustment($Case) {
  if ($Case.context.bill.status -ne "PUBLISHED") {
    throw "Case $($Case.id) expects a published bill"
  }
  Assert-Equal $Case.expect.adjustment.status "DRAFT" "Case $($Case.id) adjustment status"
  Assert-Equal $Case.expect.adjustment.type "DEBIT" "Case $($Case.id) adjustment type"
}

$doc = Get-Content -Raw $CasesFile | ConvertFrom-Json

if (Test-Path $EngineScript) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $EngineScript -CasesFile $CasesFile -OutFile $EngineOutFile | Out-Null
  if (-not (Test-Path $EngineOutFile)) {
    throw "Engine output file not found: $EngineOutFile"
  }
}

$engineMap = @{}
if (Test-Path $EngineOutFile) {
  $engine = Get-Content -Raw $EngineOutFile | ConvertFrom-Json
  foreach ($r in @($engine.results)) {
    $engineMap[$r.id] = $r.actual
  }
}
$failures = @()

foreach ($case in $doc.cases) {
  try {
    if ($engineMap.ContainsKey($case.id)) {
      $actual = $engineMap[$case.id]
      if ($case.type -eq "usage_match" -or $case.type -eq "payg_out_of_profile" -or $case.type -eq "inactive_usage") {
        Assert-Equal $actual.match.package $case.expect.match.package "Case $($case.id) matched package"
        Assert-Equal ([bool]$actual.inProfile) ([bool]$case.expect.inProfile) "Case $($case.id) inProfile"
        Assert-Equal $actual.deductFromPackage $case.expect.deductFromPackage "Case $($case.id) deductFromPackage"
        Assert-Equal $actual.charge.type $case.expect.charge.type "Case $($case.id) charge type"
        if ($case.expect.charge.type -eq "PAYG") {
          Assert-Equal ([double]$actual.charge.ratePerKb) ([double]$case.expect.charge.ratePerKb) "Case $($case.id) ratePerKb"
          Assert-Equal ([long]$actual.charge.chargedKb) ([long]$case.expect.charge.chargedKb) "Case $($case.id) chargedKb"
          Assert-Equal ([double]$actual.charge.amount) ([double]$case.expect.charge.amount) "Case $($case.id) amount"
        }
        if ($case.expect.charge.type -eq "OVERAGE") {
          Assert-Equal ([double]$actual.charge.ratePerKb) ([double]$case.expect.charge.ratePerKb) "Case $($case.id) ratePerKb"
          Assert-Equal ([long]$actual.charge.chargedKb) ([long]$case.expect.charge.chargedKb) "Case $($case.id) chargedKb"
          Assert-Equal ([double]$actual.charge.amount) ([double]$case.expect.charge.amount) "Case $($case.id) amount"
        }
      } elseif ($case.type -eq "overage_when_exhausted") {
        Assert-Equal $actual.match.package $case.expect.match.package "Case $($case.id) matched package"
        Assert-Equal ([bool]$actual.inProfile) ([bool]$case.expect.inProfile) "Case $($case.id) inProfile"
        Assert-Equal $actual.deductFromPackage $case.expect.deductFromPackage "Case $($case.id) deductFromPackage"
        Assert-Equal $actual.charge.type $case.expect.charge.type "Case $($case.id) charge type"
        Assert-Equal ([double]$actual.charge.ratePerKb) ([double]$case.expect.charge.ratePerKb) "Case $($case.id) ratePerKb"
        Assert-Equal ([long]$actual.charge.chargedKb) ([long]$case.expect.charge.chargedKb) "Case $($case.id) chargedKb"
        Assert-Equal ([double]$actual.charge.amount) ([double]$case.expect.charge.amount) "Case $($case.id) amount"
      } elseif ($case.type -eq "monthly_fee_high_water") {
        Assert-Equal $actual.chargeType $case.expect.chargeType "Case $($case.id) chargeType"
        Assert-Equal ([double]$actual.amount) ([double]$case.expect.amount) "Case $($case.id) amount"
      } elseif ($case.type -eq "late_cdr_adjustment") {
        if ($null -eq $case.expect.adjustment) {
          if ($null -ne $actual.adjustment) {
            throw "Case $($case.id) expected adjustment=null"
          }
        } else {
          Assert-Equal $actual.adjustment.status $case.expect.adjustment.status "Case $($case.id) adjustment status"
          Assert-Equal $actual.adjustment.type $case.expect.adjustment.type "Case $($case.id) adjustment type"
        }
      } else {
        throw "Unknown case type: $($case.type)"
      }
    } else {
      switch ($case.type) {
        "usage_match" { Evaluate-UsageMatch $doc $case }
        "payg_out_of_profile" { Evaluate-PaygOutOfProfile $doc $case }
        "monthly_fee_high_water" { Evaluate-MonthlyFeeHighWater $case }
        "late_cdr_adjustment" { Evaluate-LateCdrAdjustment $case }
        Default { throw "Unknown case type: $($case.type)" }
      }
    }
    Write-Host "PASS $($case.id)" -ForegroundColor Green
  } catch {
    $failures += [pscustomobject]@{ id = $case.id; error = $_.Exception.Message }
    Write-Host "FAIL $($case.id): $($_.Exception.Message)" -ForegroundColor Red
  }
}

if ($failures.Count -gt 0) {
  Write-Host "\nSummary:" -ForegroundColor Yellow
  $failures | ForEach-Object { Write-Host "- $($_.id): $($_.error)" -ForegroundColor Yellow }
  exit 1
}

Write-Host "\nAll golden cases passed." -ForegroundColor Green
