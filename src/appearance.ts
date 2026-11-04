import { useEffect, useLayoutEffect, useState } from "react";

type Appearance = "light" | "dark";
export type AppearancePreference = Appearance | "system";
const STORAGE_KEY = "app-shell-theme";

function initialPreference(): AppearancePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch { /* Storage can be unavailable in the WebView. */ }
  return "system";
}

export function useAppearance() {
  const [preference, setPreference] = useState<AppearancePreference>(initialPreference);
  const [systemAppearance, setSystemAppearance] = useState<Appearance>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const appearance = preference === "system" ? systemAppearance : preference;
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemAppearance(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    const background = appearance === "dark" ? "#181818" : "#ffffff";
    document.documentElement.dataset.theme = appearance;
    document.documentElement.style.colorScheme = appearance;
    document.documentElement.style.backgroundColor = background;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", background);
  }, [appearance]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, preference); } catch { /* Keep switching usable without persistence. */ }
  }, [preference]);
  return { appearance, preference, setPreference };
}
