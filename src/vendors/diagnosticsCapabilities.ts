export type DiagnosticsCapabilityMode =
  | 'UPSTREAM_FULL'
  | 'UPSTREAM_PARTIAL'
  | 'LOCAL_ASSEMBLE'
  | 'NOT_SUPPORTED'

export type DiagnosticsOperation =
  | 'connectivityStatus'
  | 'visitedNetwork'
  | 'visitedNetworkRecords'
  | 'cancelLocation'

export type DiagnosticsCapabilities = Record<DiagnosticsOperation, DiagnosticsCapabilityMode>

export const WXZHONGGENG_DIAGNOSTICS_CAPABILITIES: DiagnosticsCapabilities = {
  connectivityStatus: 'UPSTREAM_PARTIAL',
  visitedNetwork: 'LOCAL_ASSEMBLE',
  visitedNetworkRecords: 'LOCAL_ASSEMBLE',
  cancelLocation: 'NOT_SUPPORTED',
}

const DEFAULT_DIAGNOSTICS_CAPABILITIES: DiagnosticsCapabilities = {
  connectivityStatus: 'NOT_SUPPORTED',
  visitedNetwork: 'LOCAL_ASSEMBLE',
  visitedNetworkRecords: 'LOCAL_ASSEMBLE',
  cancelLocation: 'NOT_SUPPORTED',
}

export function getDiagnosticsCapabilities(adapter: {
  supplierKey?: string
  diagnosticsCapabilities?: DiagnosticsCapabilities
}): DiagnosticsCapabilities {
  if (adapter.diagnosticsCapabilities) return adapter.diagnosticsCapabilities
  if (String(adapter.supplierKey ?? '').toLowerCase() === 'wxzhonggeng') {
    return WXZHONGGENG_DIAGNOSTICS_CAPABILITIES
  }
  return DEFAULT_DIAGNOSTICS_CAPABILITIES
}

export function getDiagnosticsCapability(
  adapter: { supplierKey?: string; diagnosticsCapabilities?: DiagnosticsCapabilities },
  operation: DiagnosticsOperation,
): DiagnosticsCapabilityMode {
  return getDiagnosticsCapabilities(adapter)[operation]
}
