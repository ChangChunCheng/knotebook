import { useCallback, useEffect, useState } from "react";

/**
 * 標題大綱的釘住偏好：全站一個設定（不分筆記），`"1"`＝釘住，取消時刪鍵。
 * 開到寬版、全寬筆記或空間不夠時只是暫時不釘，偏好照舊，回到能釘的筆記自動再釘住。
 * 儲存被封鎖時偏好只活在這次的 state。
 */
export const OUTLINE_PINNED_STORAGE_KEY = "outline.pinned";

export function readOutlinePinned(): boolean {
  try {
    return window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeOutlinePinned(pinned: boolean): void {
  try {
    if (pinned) window.localStorage.setItem(OUTLINE_PINNED_STORAGE_KEY, "1");
    else window.localStorage.removeItem(OUTLINE_PINNED_STORAGE_KEY);
  } catch {
    // 儲存被封鎖：畫面照樣切換，只是不記住。
  }
}

/**
 * 內文欄的釘住過場要不要開：大綱出現滿一個畫格之後才開，大綱一不在就關。
 * 開筆記、離開版本預覽、關掉浮動版本面板時，大綱一出現欄就直接是釘住的寬度，不從標準寬滑過去；
 * 之後按釘選、調整視窗或側欄、開關第三欄版本面板才有過場。
 */
export function usePinMotionReady(outlineShown: boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!outlineShown) {
      setReady(false);
      return;
    }
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, [outlineShown]);
  return ready && outlineShown;
}

/** 釘住偏好的 state；setter 先改畫面再盡力寫入儲存。 */
export function useOutlinePinned(): [boolean, (next: boolean) => void] {
  const [pinned, setPinned] = useState(readOutlinePinned);
  const update = useCallback((next: boolean) => {
    setPinned(next);
    writeOutlinePinned(next);
  }, []);
  return [pinned, update];
}
