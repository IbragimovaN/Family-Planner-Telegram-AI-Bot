import { useCallback, useEffect, useSyncExternalStore } from "react";

export type Route = "home" | "family" | "tasks" | "shopping" | "shopping/history" | `shopping/history/${string}`;
function snapshot(): Route {
  const path = window.location.hash.slice(2);
  return /^(family|tasks|shopping|shopping\/history(?:\/[a-zA-Z0-9-]+)?)$/.test(path) ? path as Route : "home";
}
function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  return () => { window.removeEventListener("popstate", listener); window.removeEventListener("hashchange", listener); };
}
export function navigate(route: Route, replace = false) {
  const url = new URL(window.location.href);
  url.hash = route === "home" ? "/" : `/${route}`;
  window.history[replace ? "replaceState" : "pushState"]({ planner: true }, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export function useNavigation() {
  const route = useSyncExternalStore(subscribe, snapshot);
  const back = useCallback(() => {
    navigate(route.startsWith("shopping/history/") ? "shopping/history" : route === "shopping/history" ? "shopping" : "home", true);
  }, [route]);
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>("[data-screen-heading]");
    heading?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [route]);
  return { route, navigate, back };
}

export function useTelegramBack(visible: boolean, back: () => void) {
  useEffect(() => {
    const button = window.Telegram?.WebApp.BackButton;
    if (!button) return;
    if (visible) { button.show(); button.onClick(back); }
    else button.hide();
    return () => { button.offClick(back); button.hide(); };
  }, [visible, back]);
}
