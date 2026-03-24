Param(
  [Parameter(Mandatory = $false)]
  [string]$CasesFile = "golden_cases.json",

  [Parameter(Mandatory = $false)]
  [string]$OutFile = "billing_engine_results.json"
)

$ErrorActionPreference = "Stop"

function Convert-MbToKbCeil([double]$Mb, [int]$MbToKb) {
  return [long][math]::Ceiling($Mb * $MbToKb)
}

function Coverage-Includes($Coverage, [string]$VisitedMccMnc) {
  if ($null -eq $Coverage) { return $false }
  if ($Coverage.type -eq "GLOBAL") { return $true }
  if ($Coverage.type -eq "MCCMNC_ALLOWLIST") {
    return @($Coverage.mccmnc) -contains $VisitedMccMnc
  }
  return $false
}

function Coverage-NarrownessScore($Coverage) {
  if ($null -eq $Coverage) { return 999999 }
  if ($Coverage.type -eq "GLOBAL") { return 999999 }
  if ($Coverage.type -eq "MCCMNC_ALLOWLIST") {
    if ($null -eq $Coverage.mccmnc) { return 999999 }
    return [int]@($Coverage.mccmnc).Count
  }
  return 999999
}

function Get-Pkg($CatalogPackages, [string]$Id) {
  if ($null -eq $CatalogPackages) { return $null }
  $prop = $CatalogPackages.PSObject.Properties[$Id]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

function Select-MatchingPackageId($CatalogPackages, $Subscriptions, [string]$VisitedMccMnc) {
  $subs = @($Subscriptions)

  $addOns = @($subs | Where-Object { $_.kind -eq "ADD_ON" })
  $addOnCandidates = @()
  foreach ($sub in $addOns) {
    $pkg = Get-Pkg $CatalogPackages $sub.package
    if ($null -eq $pkg) { continue }
    if (Coverage-Includes $pkg.coverage $VisitedMccMnc) {
      $addOnCandidates += [pscustomobject]@{ id = $sub.package; pkg = $pkg }
    }
  }

  if ($addOnCandidates.Count -gt 0) {
    $sorted = $addOnCandidates | Sort-Object -Property @{ Expression = { Coverage-NarrownessScore $_.pkg.coverage }; Descending = $false }, @{ Expression = { $_.id }; Descending = $false }
    return $sorted[0].id
  }

  $mains = @($subs | Where-Object { $_.kind -eq "MAIN" })
  foreach ($sub in $mains) {
    $pkg = Get-Pkg $CatalogPackages $sub.package
    if ($null -eq $pkg) { continue }
    if (Coverage-Includes $pkg.coverage $VisitedMccMnc) {
      return $sub.package
    }
  }

  return $null
}

function Resolve-PaygRatePerMb($MainPackage, [string]$VisitedMccMnc) {
  if ($null -eq $MainPackage) { return $null }
  if ($null -eq $MainPackage.payg) { return $null }
  if ($null -eq $MainPackage.payg.zones) { return $null }

  foreach ($zoneName in $MainPackage.payg.zones.PSObject.Properties.Name) {
    $zone = $MainPackage.payg.zones.$zoneName
    if ($null -eq $zone) { continue }
    if (@($zone.mccmnc) -contains $VisitedMccMnc) {
      return [double]$zone.ratePerMb
    }
  }

  return $null
}

$doc = Get-Content -Raw $CasesFile | ConvertFrom-Json
$mbToKb = [int]$doc.meta.unit.mbToKb
$catalogPackages = $doc.catalog.packages

$results = @()
foreach ($case in $doc.cases) {
  $out = [ordered]@{ id = $case.id; type = $case.type; actual = $null }
  switch ($case.type) {
    "usage_match" {
      $visited = $case.context.usage.visitedMccMnc
      $matchId = Select-MatchingPackageId $catalogPackages $case.context.subscriptions $visited
      $out.actual = [ordered]@{
        match = [ordered]@{ package = $matchId }
        inProfile = [bool]($null -ne $matchId)
        deductFromPackage = $matchId
        charge = [ordered]@{ type = "IN_PACKAGE"; amount = 0.0 }
        alerts = @()
      }
    }
    "overage_when_exhausted" {
      $visited = $case.context.usage.visitedMccMnc
      $totalMb = [double]$case.context.usage.totalMb
      $chargedMb = [double]$case.context.usage.totalMb
      $matchId = Select-MatchingPackageId $catalogPackages $case.context.subscriptions $visited

      $remainingMb = [double]$case.context.quota.remainingMb
      if ($remainingMb -lt 0) { $remainingMb = 0 }
      $billableMb = $chargedMb
      if ($billableMb -lt 0) { $billableMb = 0 }

      $pkg = $null
      if ($null -ne $matchId) { $pkg = Get-Pkg $catalogPackages $matchId }
      $rate = $null
      if ($null -ne $pkg -and $null -ne $pkg.overageRatePerMb) { $rate = [double]$pkg.overageRatePerMb }
      if ($null -eq $rate) { $rate = 0.0 }

      $overMb = $billableMb
      if ($remainingMb -gt 0) {
        $overMb = [math]::Max(0, ($billableMb - $remainingMb))
      }
      $amount = [math]::Round(($overMb * $rate), 2)

      $out.actual = [ordered]@{
        match = [ordered]@{ package = $matchId }
        inProfile = [bool]($null -ne $matchId)
        deductFromPackage = $matchId
        charge = [ordered]@{ type = "OVERAGE"; currency = $doc.meta.currency; ratePerMb = $rate; chargedMb = $chargedMb; amount = $amount }
        alerts = @()
      }
    }
    "inactive_usage" {
      $visited = $case.context.usage.visitedMccMnc
      $totalMb = [double]$case.context.usage.totalMb
      $chargedMb = $totalMb

      $mainSub = @($case.context.subscriptions | Where-Object { $_.kind -eq "MAIN" }) | Select-Object -First 1
      $mainPkg = $null
      if ($null -ne $mainSub) { $mainPkg = Get-Pkg $catalogPackages $mainSub.package }

      $rate = Resolve-PaygRatePerMb $mainPkg $visited
      if ($null -eq $rate) {
        $out.actual = [ordered]@{
          match = [ordered]@{ package = $null }
          inProfile = $false
          deductFromPackage = $null
          charge = [ordered]@{ type = "PAYG_RULE_MISSING"; amount = $null }
          alerts = @("INACTIVE_USAGE", "UNEXPECTED_ROAMING", "PAYG_RULE_MISSING")
        }
      } else {
        $amount = [math]::Round(($chargedMb * $rate), 2)
        $out.actual = [ordered]@{
          match = [ordered]@{ package = $null }
          inProfile = $false
          deductFromPackage = $null
          charge = [ordered]@{ type = "PAYG"; currency = $doc.meta.currency; ratePerMb = $rate; chargedMb = $chargedMb; amount = $amount }
          alerts = @("INACTIVE_USAGE", "UNEXPECTED_ROAMING")
        }
      }
    }
    "payg_out_of_profile" {
      $visited = $case.context.usage.visitedMccMnc
      $totalMb = [double]$case.context.usage.totalMb
      $chargedMb = $totalMb

      $matchId = Select-MatchingPackageId $catalogPackages $case.context.subscriptions $visited

      $mainSub = @($case.context.subscriptions | Where-Object { $_.kind -eq "MAIN" }) | Select-Object -First 1
      $mainPkg = $null
      if ($null -ne $mainSub) { $mainPkg = Get-Pkg $catalogPackages $mainSub.package }

      $rate = Resolve-PaygRatePerMb $mainPkg $visited
      if ($null -eq $rate) {
        $out.actual = [ordered]@{
          match = [ordered]@{ package = $matchId }
          inProfile = $false
          deductFromPackage = $null
          charge = [ordered]@{ type = "PAYG_RULE_MISSING"; amount = $null }
          alerts = @("UNEXPECTED_ROAMING", "PAYG_RULE_MISSING")
        }
      } else {
        $amount = [math]::Round(($chargedMb * $rate), 2)
        $out.actual = [ordered]@{
          match = [ordered]@{ package = $matchId }
          inProfile = $false
          deductFromPackage = $null
          charge = [ordered]@{ type = "PAYG"; currency = $doc.meta.currency; ratePerMb = $rate; chargedMb = $chargedMb; amount = $amount }
          alerts = @("UNEXPECTED_ROAMING")
        }
      }
    }
    "monthly_fee_high_water" {
      $states = @($case.context.stateTrajectory | ForEach-Object { $_.status })
      $hasActivated = $states -contains "ACTIVATED"
      $hasDeactivated = $states -contains "DEACTIVATED"
      if ($hasActivated) {
        $out.actual = [ordered]@{ chargeType = "MONTHLY_FEE"; amount = [double]$case.context.monthlyFee }
      } elseif ($hasDeactivated) {
        $out.actual = [ordered]@{ chargeType = "DEACTIVATED_MONTHLY_FEE"; amount = [double]$case.context.deactivatedMonthlyFee }
      } else {
        $out.actual = [ordered]@{ chargeType = "NO_CHARGE"; amount = 0.0 }
      }
    }
    "late_cdr_adjustment" {
      $status = $case.context.bill.status
      if ($status -eq "PUBLISHED") {
        $out.actual = [ordered]@{ adjustment = [ordered]@{ status = "DRAFT"; type = "DEBIT"; currency = $doc.meta.currency } }
      } else {
        $out.actual = [ordered]@{ adjustment = $null }
      }
    }
    Default {
      throw "Unsupported case type: $($case.type)"
    }
  }
  $results += [pscustomobject]$out
}

$payload = [ordered]@{ meta = $doc.meta; generatedAt = (Get-Date).ToString("o"); results = $results }
$payload | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $OutFile
Write-Host "Wrote $($results.Count) results to $OutFile"
