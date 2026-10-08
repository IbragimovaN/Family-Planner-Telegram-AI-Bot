import { useEffect, type ReactNode } from "react";

export default function TelegramShell({ children }: { children: ReactNode }) {
  useEffect(() => {
    const app = window.Telegram?.WebApp;
    if (!app?.initData) return;
    const root = document.documentElement;
    const update = () => {
      root.dataset.telegramTheme = app.colorScheme || "light";
      if (app.viewportStableHeight && app.viewportStableHeight > 0) root.style.setProperty("--app-height", `${app.viewportStableHeight}px`);
    };
    update(); app.expand();
    app.onEvent?.("themeChanged", update);
    app.onEvent?.("viewportChanged", update);
    return () => {
      app.offEvent?.("themeChanged", update); app.offEvent?.("viewportChanged", update);
      delete root.dataset.telegramTheme; root.style.removeProperty("--app-height");
    };
  }, []);
  return children;
}
