import { useEffect } from "react";

/** Keyboard navigation never waits for authored motion. */
export function useInputModality() {
  useEffect(() => {
    const pointer = () => { document.documentElement.dataset.inputModality = "pointer"; };
    const keyboard = () => { document.documentElement.dataset.inputModality = "keyboard"; };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", keyboard, true);
      delete document.documentElement.dataset.inputModality;
    };
  }, []);
}
