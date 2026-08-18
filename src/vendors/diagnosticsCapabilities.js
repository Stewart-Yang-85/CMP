export const WXZHONGGENG_DIAGNOSTICS_CAPABILITIES = {
  connectivityStatus: 'UPSTREAM_PARTIAL',
  visitedNetwork: 'LOCAL_ASSEMBLE',
  visitedNetworkRecords: 'LOCAL_ASSEMBLE',
  cancelLocation: 'NOT_SUPPORTED',
}

const DEFAULT_DIAGNOSTICS_CAPABILITIES = {
  connectivityStatus: 'NOT_SUPPORTED',
  visitedNetwork: 'LOCAL_ASSEMBLE',
  visitedNetworkRecords: 'LOCAL_ASSEMBLE',
  cancelLocation: 'NOT_SUPPORTED',
}

export function getDiagnosticsCapabilities(adapter) {
  if (adapter?.diagnosticsCapabilities) return adapter.diagnosticsCapabilities
  if (String(adapter?.supplierKey ?? '').toLowerCase() === 'wxzhonggeng') {
    return WXZHONGGENG_DIAGNOSTICS_CAPABILITIES
  }
  return DEFAULT_DIAGNOSTICS_CAPABILITIES
}

export function getDiagnosticsCapability(adapter, operation) {
  return getDiagnosticsCapabilities(adapter)[operation]
}
