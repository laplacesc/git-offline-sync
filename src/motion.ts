import { useEffect, useLayoutEffect, useRef, useState } from "react";

type DisclosureKind = "drawer" | "collapse";

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

/** Retain only the visual exit; callers hide closed content from focus immediately. */
export function useDisclosureMotion<T extends HTMLElement>(open: boolean, kind: DisclosureKind, enabled = true) {
  const ref = useRef<T>(null);
  const animation = useRef<Animation | null>(null);
  const previousOpen = useRef(open);
  const previousEnabled = useRef(enabled);
  const currentOpen = useRef(open);
  currentOpen.current = open;
  const [present, setPresent] = useState(open);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const wasOpen = previousOpen.current;
    const modeChanged = previousEnabled.current !== enabled;
    previousOpen.current = open;
    previousEnabled.current = enabled;
    const previous = animation.current;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
    if (!enabled || modeChanged || reduced || document.documentElement.dataset.inputModality === "keyboard" || !element.animate) {
      animation.current = null;
      previous?.cancel();
      setPresent(open);
      return;
    }
    if (open === wasOpen && !previous) return;

    const style = getComputedStyle(element);
    let opacity = wasOpen ? "1" : "0";
    let transform = wasOpen ? "translateX(0)" : "translateX(-100%)";
    if (previous) {
      opacity = style.opacity;
      transform = style.transform;
    }
    const height = previous || wasOpen ? element.getBoundingClientRect().height : 0;
    const start = kind === "drawer" ? { transform, opacity } : { height: `${height}px`, opacity };
    // Sample before cancellation so a rapid reversal starts at the visible position.
    previous?.cancel();
    const end = kind === "drawer"
      ? { transform: open ? "translateX(0)" : "translateX(-100%)", opacity: open ? "1" : "0" }
      : { height: `${open ? element.scrollHeight : 0}px`, opacity: open ? "1" : "0" };
    const duration = parseFloat(style.getPropertyValue(kind === "drawer" ? "--motion-drawer-duration" : "--motion-disclosure-duration"));
    const easing = style.getPropertyValue(kind === "drawer" ? "--ease-drawer" : "--spring").trim();
    if (!duration || !easing) {
      animation.current = null;
      setPresent(open);
      return;
    }
    setPresent(true);
    const next = element.animate([start, end], { duration, easing, fill: "both" });
    animation.current = next;
    next.finished.then(() => {
      if (animation.current !== next) return;
      animation.current = null;
      setPresent(open);
      next.cancel();
    }).catch(() => {});
  }, [open, kind, enabled]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const settle = () => {
      const previous = animation.current;
      animation.current = null;
      previous?.cancel();
      setPresent(currentOpen.current);
    };
    const onReduction = () => { if (media?.matches) settle(); };
    document.addEventListener("keydown", settle, true);
    media?.addEventListener("change", onReduction);
    return () => {
      document.removeEventListener("keydown", settle, true);
      media?.removeEventListener("change", onReduction);
      animation.current?.cancel();
      animation.current = null;
    };
  }, []);

  return { ref, visible: open || present };
}
