import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_WIDTH = 320;
const MAX_WIDTH = 640;

function readWidth(key: string, fallback: number) {
  try {
    const w = Number(localStorage.getItem(key));
    return w >= MIN_WIDTH && w <= MAX_WIDTH ? w : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A right-hand dock's width: the page and the header give up exactly that much (--right-dock-width, see
 * .has-right-dock), it is dragged wider or narrower from the dock's left edge, and it is remembered per dock.
 * Returns what the resize handle needs.
 */
export function useDockWidth(storageKey: string, fallback = 380) {
  const [width, setWidth] = useState(() => readWidth(storageKey, fallback));
  const dragging = useRef(false);

  useEffect(() => {
    document.documentElement.style.setProperty('--right-dock-width', `${width}px`);
    return () => {
      document.documentElement.style.removeProperty('--right-dock-width');
    };
  }, [width]);

  const onDrag = useCallback((e: PointerEvent) => {
    if (!dragging.current) return;
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX)));
  }, []);
  const endDrag = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.classList.remove('is-resizing-dock');
    setWidth((w) => {
      try {
        localStorage.setItem(storageKey, String(w));
      } catch {
        /* storage unavailable — the width lasts for this page only */
      }
      return w;
    });
  }, [storageKey]);
  useEffect(() => {
    window.addEventListener('pointermove', onDrag);
    window.addEventListener('pointerup', endDrag);
    return () => {
      window.removeEventListener('pointermove', onDrag);
      window.removeEventListener('pointerup', endDrag);
    };
  }, [onDrag, endDrag]);

  const startDrag = useCallback(() => {
    dragging.current = true;
    document.body.classList.add('is-resizing-dock');
  }, []);
  return { width, startDrag };
}
