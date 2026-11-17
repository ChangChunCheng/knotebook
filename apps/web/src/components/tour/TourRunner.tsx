import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { NavigationType, useLocation, useNavigate, useNavigationType } from "react-router";
import { useRealNavigationType } from "@/lib/real-location";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalNotePath, type AiActionDto, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useDeleteNote } from "@/api/notes";
import { toast } from "@/components/ui/toast";
import { useSidebarQuery } from "@/lib/sidebar-query";
import type { SidebarTab } from "@/lib/sidebar-tab";
import { getShellControls, getTourNoteEditor } from "@/lib/tour-bridge";
import { tourLayout, useTourLayout } from "@/lib/tour-find";
import { showTrashedToast, type Translate } from "@/lib/trash-undo";
import {
  fetchTourAiActions,
  focusReturnTarget,
  fullTourStops,
  measureCardBands,
  measureTargets,
  planStops,
  RETURN_FOCUS_TIMEOUT_MS,
  samePath,
  SCREEN_TIMEOUT_MS,
  TourEngine,
  tourProgress,
  type CardBands,
  waitForDrawerClosed,
  waitForFrames,
  type EndReason,
  type EngineSnapshot,
  type TourStartOptions,
  type TourStopEntry,
} from "./engine";
import { NO_INSETS, sameInsets, type Rect } from "./geometry";
import { canRunLiveStop, installLiveStopInput } from "./live-stops";
import { stopTitle } from "./sequence";
import { stopBody, stopScreen, stopTarget, type StopContext, type TourScreen } from "./stops";
import { TourOverlay } from "./TourOverlay";

export interface TourRunnerProps extends TourStartOptions {
  /**
   * 建示範筆記、導過去、等它可編輯並寫入示範內容，回傳那篇筆記；回 null＝沒辦法開始（提示由它自己處理）。
   * 元件卸載時 `signal` 會中止。`aiActions` 是這一輪唯一一次向 server 讀 AI 動作的結果（不會 reject，失敗是空陣列）：
   * 寫入示範內容時用它決定放不放 AI 那句，站點也用同一份，兩邊看到的答案才一致。
   */
  prepareSample: (signal: AbortSignal, aiActions: Promise<AiActionDto[]>) => Promise<NoteDto | null>;
  /** 第一站出現時呼叫，整輪恰好一次（重繪、往回走、StrictMode 都不會重複）。開始前中止的不呼叫。 */
  onStarted?: () => void;
  /** 導覽結束、還原做完之後呼叫一次；沒辦法開始時也呼叫。卸載時不呼叫。 */
  onFinished: (result: TourResult) => void;
  /** 要走的站；預設是完整導覽。 */
  stops?: readonly TourStopEntry[];
}

/**
 * 導覽怎麼結束的：
 * - `completed`：最後一站〔保留示範筆記〕或〔刪除〕。
 * - `closed`：✕、Esc、第 1 站的「跳過」。
 * - `left`：進過站之後，位置離開了示範筆記。
 * - `aborted`：第一站出現之前就停了（沒辦法準備示範筆記、讀 AI 動作期間離開頁面）。
 */
export type TourFinishReason = "completed" | "closed" | "left" | "aborted";

export interface TourResult {
  /** 第一站有沒有出現過。 */
  started: boolean;
  reason: TourFinishReason;
}

function finishReason(reason: EndReason, started: boolean): TourFinishReason {
  if (!started) return "aborted";
  if (reason === "keep" || reason === "delete") return "completed";
  return reason === "left" ? "left" : "closed";
}

interface Run {
  engine: TourEngine;
  /** 這一輪的站（前置條件濾過），卡片上的「n / N」照目前的版面從這裡數。 */
  stops: readonly TourStopEntry[];
  note: NoteDto;
  path: string;
  /** 開始前的側欄 tab；沒有登記的側欄時是 null。 */
  tab: SidebarTab | null;
  ctx: StopContext;
}

/** 手機的清單畫面（首頁）。 */
const LIST_PATH = "/";

/** 畫面出來了沒：清單＝手機清單在畫面上；示範筆記＝它的編輯器登記了，或筆記頁的標題框已經掛上。 */
function screenReady(screen: TourScreen, noteId: string): boolean {
  if (screen === "list") return document.querySelector("[data-phone-list-shown]") !== null;
  return getTourNoteEditor(noteId) !== null || document.querySelector("input[data-note-title-input]") !== null;
}

const IDLE: EngineSnapshot = { phase: "idle", index: -1, total: 0, entry: null, pending: false, preparing: null, endReason: null };
const subscribeNothing = () => () => {};
const idleSnapshot = () => IDLE;

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** ApiFail → errors.<code>；其餘 → errors.fallback（各檔各自一份，是既有慣例）。 */
function errorMessage(t: Translate, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * 跑一輪功能導覽：開始流程、換站、結束後的還原。整輪只畫一個 `TourOverlay`：換站時原地換掉內容，
 * 報讀器的換站通知（常駐的 live region）才讀得出來，重掛的話它會把每一站當成剛打開。
 *
 * - **開始**：先關側欄抽屜、等它從 DOM 消失（抽屜是 modal，開著時卡片按不到、目標全都查不到）→ 記下目前的側欄 tab →
 *   開始向 server 讀 AI 動作，同時 `prepareSample`（建示範筆記、導過去、寫入內容）→ 用同一次讀到的 AI 動作算前置條件、定站數 → 第一站。
 *   讀取和建筆記並行：等到編輯器可編輯時多半已經讀完，寫入示範內容不必再等一個來回（等的期間使用者在空筆記打的字會讓寫入作罷）。
 *   第一站出現之前不蓋遮罩。開始流程寫在掛載的 effect 裡、每一步之後看中止訊號：開發模式的 StrictMode
 *   掛載時會先卸載一次，第一輪在建示範筆記之前就會停下，不會建兩篇。這靠的是中止檢查之前有一個 `await`
 *   （等抽屜消失）：第一輪的 cleanup 在它回來之前就跑了；開頭改成不讓出執行權的話，第一輪會先把示範筆記建起來。
 * - **換畫面**（只有手機）：清單上的站在清單（`/`），其餘在示範筆記上。引擎進站前呼叫 `ctx.showScreen`：這裡用取代歷史的方式導過去
 *   （歷史不會越走越長）、等畫面出來，期間卡片藏起來（遮罩照樣擋著）。導覽中跨過 640 時，畫面上那一站也照新的版面換畫面。
 * - **導覽中離開**就結束，不續跑，示範筆記留著：位置不在該在的畫面上（被導到登入頁、筆記在別處被刪……），
 *   或瀏覽器的上一頁／下一頁（換畫面是取代歷史，上一頁可能回到同一個路徑的清單，所以看導覽型別，不只看路徑）。
 *   `prepareSample` 要等示範筆記的頁面掛上才回傳，所以第一次檢查時位置已經在示範筆記上。
 * - **結束**：手機上，完成或關掉時回清單（已經在清單上就不動），離開的話不導；其他版面還在示範筆記上就導回 `returnTo`。
 *   tab 與開始時不同就切回去：寬視窗在導走之前切；手機只換 tab、不帶畫面（`reveal: false`）；側欄浮動時不切（切 tab 會打開抽屜）。
 *   等新的位置生效後，每格畫面用 `returnFocus()` 重新找觸發鈕來聚焦。〔刪除〕在導走之後才移到垃圾桶：
 *   開著的筆記被刪掉，筆記頁會跳出「這篇已被刪除」的處理。
 */
export function TourRunner({ returnTo, returnFocus, prepareSample, onStarted, onFinished, stops }: TourRunnerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { query } = useSidebarQuery();
  const deleteNote = useDeleteNote();
  const layout = useTourLayout();
  const [run, setRun] = useState<Run | null>(null);
  /** 進行中的換畫面次數（手機的清單與示範筆記之間；跨過 640 與換站可能重疊）：大於 0 時卡片先藏起來。 */
  const [switchCount, setSwitchCount] = useState(0);
  const switching = switchCount > 0;
  const navigateRef = useRef(navigate);
  const locationRef = useRef(location);
  useEffect(() => {
    navigateRef.current = navigate;
    locationRef.current = location;
  });
  /** 這一刻導覽該在的路徑（示範筆記，或手機清單上的站的清單）；位置變到別處＝離開。 */
  const expectedPathRef = useRef<string | null>(null);

  const readQuery = useEffectEvent(() => query);

  const startFlow = useEffectEvent(async (signal: AbortSignal) => {
    getShellControls()?.closeDrawer();
    await waitForDrawerClosed(signal);
    if (signal.aborted) return;
    const tab = getShellControls()?.getTab() ?? null;
    // 在等抽屜那個 await 之後才發：StrictMode 的第一輪在那裡就停，不會多讀一次。
    const aiRead = fetchTourAiActions(queryClient);
    let note: NoteDto | null = null;
    try {
      note = await prepareSample(signal, aiRead);
    } catch (err) {
      console.error(err);
    }
    if (signal.aborted) return;
    if (note === null) {
      onFinished({ started: false, reason: "aborted" });
      return;
    }
    const aiActions = await aiRead;
    if (signal.aborted) return;
    const notePath = canonicalNotePath(note);
    const noteId = note.id;
    expectedPathRef.current = notePath;
    let engine: TourEngine | null = null;
    const showScreen = async (screen: TourScreen, screenSignal: AbortSignal): Promise<void> => {
      const path = screen === "list" ? LIST_PATH : notePath;
      expectedPathRef.current = path;
      const ready = () => samePath(locationRef.current.pathname, path) && screenReady(screen, noteId);
      if (ready()) return;
      setSwitchCount((n) => n + 1);
      try {
        if (!samePath(locationRef.current.pathname, path)) void navigateRef.current(path, { replace: true });
        const shown = await waitForFrames(() => (ready() ? true : null), screenSignal, SCREEN_TIMEOUT_MS);
        if (shown === null && !screenSignal.aborted && screen === "note") engine?.end("left");
        // 清單上的站從頂端開始（tab 列不釘在頂端，清單捲下去時看不到）。
        if (shown !== null && screen === "list" && window.scrollY > 0) window.scrollTo(0, 0);
      } finally {
        setSwitchCount((n) => n - 1);
      }
    };
    const ctx: StopContext = { searchQuery: readQuery(), aiActions, sampleNoteId: noteId, liveStops: canRunLiveStop(noteId), showScreen };
    const planned = planStops(stops ?? fullTourStops(), ctx);
    engine = new TourEngine(planned, ctx);
    setRun({ engine, stops: planned, note, path: notePath, tab, ctx });
  });

  useEffect(() => {
    const controller = new AbortController();
    void startFlow(controller.signal);
    return () => controller.abort();
  }, []);

  const snapshot = useSyncExternalStore(run?.engine.subscribe ?? subscribeNothing, run?.engine.getSnapshot ?? idleSnapshot);

  // 位置一變就看還在不在該在的畫面上（示範筆記，或手機清單上的站的清單）；只換 search／hash（例如簡報模式的 `?present`）不算離開。
  // 上一頁／下一頁（POP）一律算離開：導覽自己換畫面都是取代歷史，不會產生 POP。
  // 這支排在下面進第一站那支之前：開始時就已經不在示範筆記上的話，不進站。
  // 真實的導覽型別：導覽住在 App 層、在帶 `location` 的 `<Routes>` 外面，`useNavigationType()` 本來就是真的；
  // 萬一被搬進那種樹裡（那裡的型別恆為 POP），先讀 `RealLocationContext` 給的。
  const realNavigationType = useRealNavigationType();
  const routerNavigationType = useNavigationType();
  const navigationType = realNavigationType ?? routerNavigationType;
  const seenKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (run === null || run.engine.getSnapshot().phase === "ended") return;
    const seen = seenKeyRef.current;
    seenKeyRef.current = location.key;
    if (seen !== null && seen !== location.key && navigationType === NavigationType.Pop) {
      run.engine.end("left");
      return;
    }
    if (!samePath(location.pathname, expectedPathRef.current ?? run.path)) run.engine.end("left");
  }, [location.key, location.pathname, navigationType, run]);

  useEffect(() => {
    if (run === null) return;
    void run.engine.begin();
    return () => run.engine.end("unmount");
  }, [run]);

  // 第一站出現的訊號只發一次：ref 跟著元件實例，StrictMode 的模擬重掛、重繪、往回走都不會再發。
  const startedRef = useRef(false);
  const notifyStarted = useEffectEvent(() => onStarted?.());
  useEffect(() => {
    if (snapshot.index < 0 || startedRef.current) return;
    startedRef.current = true;
    notifyStarted();
  }, [snapshot.index]);

  // 導回原頁之後要等新的位置生效（新的側欄掛上）才找觸發鈕：太早找會找到正要卸載的舊側欄裡那顆。
  const locationKeyRef = useRef(location.key);
  useEffect(() => {
    locationKeyRef.current = location.key;
  }, [location.key]);

  const trashSample = useEffectEvent(async (note: NoteDto) => {
    try {
      await deleteNote.mutateAsync(note.id);
      showTrashedToast({ notes: [note], queryClient, navigate, t, reopen: false });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  });

  const finish = useEffectEvent(async (reason: EndReason, signal: AbortSignal) => {
    if (run === null) return;
    const restoreTab = (options?: { reveal?: boolean }) => {
      if (run.tab === null) return;
      const shell = getShellControls();
      if (shell !== null && shell.getTab() !== run.tab) shell.showTab(run.tab, options);
    };
    const phone = tourLayout() === "phone";
    if (tourLayout() === "wide") restoreTab();
    // 手機：完成或關掉時回清單（頭像在那裡）。看的是導覽該在的路徑，不是畫面上的位置：結束時可能正在從清單換到示範筆記，
    // 那次導頁還沒生效，畫面上仍是清單。已經在清單、也沒有在換畫面就不導。離開（`left`）時使用者自己去了別處，不導。
    // 其他版面：還在示範筆記上就導回 `returnTo`（建示範筆記之前記下的位置，不會就是示範筆記）。
    const leave = phone
      ? reason !== "left" && !(samePath(location.pathname, LIST_PATH) && expectedPathRef.current === LIST_PATH)
      : samePath(location.pathname, run.path);
    if (leave) {
      const from = locationKeyRef.current;
      // 取代掉示範筆記那一筆歷史：〔刪除〕之後按上一頁才不會回到垃圾桶裡的示範筆記。
      void navigate(phone ? LIST_PATH : returnTo, { replace: true });
      await waitForFrames(() => (locationKeyRef.current !== from ? true : null), signal, RETURN_FOCUS_TIMEOUT_MS);
      if (signal.aborted) return;
    }
    // 手機只換 tab、不帶畫面：離開到別篇筆記或登入頁時，不把人拉回清單。
    if (phone) restoreTab({ reveal: false });
    await Promise.all([focusReturnTarget(returnFocus, signal), reason === "delete" ? trashSample(run.note) : null]);
    if (signal.aborted) return;
    const started = run.engine.getSnapshot().index >= 0;
    onFinished({ started, reason: finishReason(reason, started) });
  });

  useEffect(() => {
    const reason = snapshot.endReason;
    if (snapshot.phase !== "ended" || reason === null || reason === "unmount") return;
    const controller = new AbortController();
    void finish(reason, controller.signal);
    return () => controller.abort();
  }, [snapshot.phase, snapshot.endReason]);

  // 挖洞每格畫面重新量：視窗縮放、捲動、DOM 變動、跨過版面判準（目標換成側欄鈕或「‹」）都跟著動；
  // 卡片要避開的邊帶（手機的頁首、圓形鈕）也一起量。進站當下在 layout effect 先量一次，畫面上不會先閃一格沒有挖洞的卡片。
  const entry = snapshot.phase === "running" ? snapshot.entry : null;

  // 導覽中跨過 640：畫面上那一站照新的版面換畫面（例如從側欄浮動轉成手機，清單上的站要回清單）。換站中不動，引擎自己會換。
  const pending = snapshot.pending;
  useEffect(() => {
    const show = run?.ctx.showScreen;
    if (entry === null || pending || show === undefined) return;
    const controller = new AbortController();
    void show(stopScreen(entry.stop, layout), controller.signal);
    return () => controller.abort();
  }, [run, entry, pending, layout]);

  const [target, setTarget] = useState<Rect | null>(null);
  const [bands, setBands] = useState<CardBands>({ keepOut: NO_INSETS, blocked: NO_INSETS });
  useLayoutEffect(() => {
    if (entry === null || run === null) return;
    let frame = 0;
    const measure = () => {
      const now = tourLayout();
      const next = measureTargets(stopTarget(entry.stop, run.ctx, now));
      setTarget((prev) => (sameRect(prev, next) ? prev : next));
      const nextBands = measureCardBands(now);
      setBands((prev) => (sameInsets(prev.keepOut, nextBands.keepOut) && sameInsets(prev.blocked, nextBands.blocked) ? prev : nextBands));
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [entry, run]);

  // 現場演示站：焦點留在編輯器，鍵盤與選單上的點擊由導覽接走（細節見 `installLiveStopInput`）。
  // 卡片上的樣子看畫面上那一站；攔截另外看「正在準備的那一站」：換進演示站時選單在目標出現之前就已經開了。
  const liveStop = entry !== null && run !== null && entry.stop.live?.(run.ctx) === true;
  const preparing = snapshot.phase === "running" ? snapshot.preparing : null;
  const liveInput = liveStop || (preparing !== null && run !== null && preparing.stop.live?.(run.ctx) === true);
  useEffect(() => {
    if (!liveInput || run === null) return;
    const { engine } = run;
    return installLiveStopInput({ next: () => engine.next(), back: () => engine.back() });
  }, [liveInput, run]);

  if (entry === null || run === null) return null;
  const { engine } = run;
  const { step, total } = tourProgress(run.stops, snapshot.index, layout);
  return (
    <TourOverlay
      target={switching ? null : target}
      hidden={switching}
      keepOut={bands.keepOut}
      blocked={bands.blocked}
      live={liveStop}
      stopKey={snapshot.index}
      step={step}
      total={total}
      title={stopTitle(t, entry.stop, layout)}
      body={stopBody(t, entry.stop, layout)}
      onNext={() => engine.next()}
      onBack={() => engine.back()}
      onSkip={() => engine.end("close")}
      onClose={() => engine.end("close")}
      onKeep={() => engine.end("keep")}
      onDelete={() => engine.end("delete")}
    />
  );
}
