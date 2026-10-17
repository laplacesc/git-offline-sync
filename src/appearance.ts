import { useEffect, useLayoutEffect, useState } from "react";

type Appearance = "light" | "dark";
export type AppearancePreference = Appearance | "system";
const STORAGE_KEY = "app-shell-theme";

function initialPreference(): AppearancePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch { /* WebView storage may be unavailable; the switch still works. */ }
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
    document.documentElement.dataset.theme = appearance;
    document.documentElement.style.colorScheme = appearance;
    document.documentElement.style.backgroundColor = appearance === "dark" ? "#0b1322" : "#f8f4eb";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", appearance === "dark" ? "#0b1322" : "#f8f4eb");
  }, [appearance]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, preference); } catch { /* Keep the current session usable. */ }
  }, [preference]);
  return { appearance, preference, setPreference };
}
