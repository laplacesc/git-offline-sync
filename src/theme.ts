import { useLayoutEffect } from "react";
import type { Theme } from "./api";

/** Apply the saved preference to the whole document, including portal content. */
export function useTheme(theme: Theme = "system"): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (theme === "light" || theme === "dark") {
      root.dataset.theme = theme;
      return () => { delete root.dataset.theme; };
    }

    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    function updateTheme() {
      root.dataset.theme = systemTheme.matches ? "dark" : "light";
    }
    updateTheme();
    systemTheme.addEventListener("change", updateTheme);
    return () => {
      systemTheme.removeEventListener("change", updateTheme);
      delete root.dataset.theme;
    };
  }, [theme]);
}
