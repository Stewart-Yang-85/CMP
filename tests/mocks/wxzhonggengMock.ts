export type WxZhonggengMock = {
  activateSim: (iccid: string) => Promise<{ success: boolean }>
  suspendSim: (iccid: string) => Promise<{ success: boolean }>
  resumeSim: (iccid: string) => Promise<{ success: boolean }>
  getDailyUsage: (iccid: string, date: string) => Promise<{ iccid: string; date: string; totalBytes: number }>
}

export function createWxZhonggengMock(): WxZhonggengMock {
  return {
    activateSim: async () => ({ success: true }),
    suspendSim: async () => ({ success: true }),
    resumeSim: async () => ({ success: true }),
    getDailyUsage: async (iccid, date) => ({ iccid, date, totalBytes: 0 }),
  }
}
