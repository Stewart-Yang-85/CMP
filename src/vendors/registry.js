/** Re-export compiled registry (canonical implementation is registry.ts). */
export {
  createSupplierAdapter,
  createSupplierAdapterFromIntegration,
  getSupplierCapabilities,
  negotiateChangePlanStrategy,
  resolveAdapterForSupplier,
  checkOperationSupported,
} from '../../dist/vendors/registry.js'
