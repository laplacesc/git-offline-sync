import { useEffect, useState } from "react";

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
  useEffect(() => {
    document.documentElement.dataset.theme = appearance;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", appearance === "dark" ? "#1c1e22" : "#f4f5f7");
  }, [appearance]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, preference); } catch { /* Keep the current session usable. */ }
  }, [preference]);
  return { appearance, preference, setPreference };
}
