export {};
declare global {
  interface Window {
    Telegram?: { WebApp: {
      initData: string; ready(): void; expand(): void;
      initDataUnsafe?: { user?: { allows_write_to_pm?: boolean } };
      isVersionAtLeast?(version: string): boolean;
      openTelegramLink?(url: string): void;
      requestWriteAccess?(callback: (allowed: boolean) => void): void;
    } };
  }
}
