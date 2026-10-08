export {};
declare global {
  interface Window {
    Telegram?: { WebApp: {
      initData: string; ready(): void; expand(): void;
      colorScheme?: "light" | "dark";
      viewportStableHeight?: number;
      onEvent?(event: string, callback: () => void): void;
      offEvent?(event: string, callback: () => void): void;
      BackButton?: { show(): void; hide(): void; onClick(callback: () => void): void; offClick(callback: () => void): void };
      initDataUnsafe?: { user?: { allows_write_to_pm?: boolean } };
      isVersionAtLeast?(version: string): boolean;
      openTelegramLink?(url: string): void;
      requestWriteAccess?(callback: (allowed: boolean) => void): void;
    } };
  }
}
