import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface PlaybackState {
  currentTime: number;
  duration: number;
  playing: boolean;
  seek: (t: number) => void;
  setDuration: (d: number) => void;
  registerVideo: (el: HTMLVideoElement | null) => void;
  togglePlay: () => void;
}

const Ctx = createContext<PlaybackState | null>(null);

/**
 * One clock for the video, the timeline, the risk curve and the event list.
 *
 * currentTime is driven by requestAnimationFrame rather than the `timeupdate`
 * event, which only fires ~4x/s and makes the playhead visibly lag the frame.
 */
export function PlaybackProvider({ children }: { children: ReactNode }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDurationState] = useState(0);
  const [playing, setPlaying] = useState(false);

  /**
   * Hand a held seek to `el`, immediately if it has a duration and on
   * loadedmetadata otherwise. Clicking an event before the video has its
   * metadata is normal on a cold load.
   */
  const applyPending = useCallback((el: HTMLVideoElement) => {
    const want = pendingSeek.current;
    if (want === null) return;
    if (Number.isFinite(el.duration)) {
      el.currentTime = Math.min(want, el.duration);
      pendingSeek.current = null;
      return;
    }
    el.addEventListener(
      "loadedmetadata",
      () => {
        const t = pendingSeek.current;
        if (t !== null && Number.isFinite(el.duration)) {
          el.currentTime = Math.min(t, el.duration);
          pendingSeek.current = null;
        }
      },
      { once: true },
    );
  }, []);

  const registerVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      videoRef.current = el;
      if (el === null) {
        pendingSeek.current = null;
        setCurrentTime(0);
        return;
      }
      // A ?t= deep link seeks from an effect that runs before the player's own
      // mount effect, so a request can already be waiting when the element
      // arrives. Discarding it here is what made those links land at 0.
      applyPending(el);
    },
    [applyPending],
  );

  const seek = useCallback(
    (t: number) => {
      const target = Math.max(0, t);
      setCurrentTime(target);
      // Recorded unconditionally: the element may not exist yet, and the rAF
      // loop treats a non-null pendingSeek as "do not overwrite the optimistic
      // time with the element's stale one".
      pendingSeek.current = target;
      const el = videoRef.current;
      if (el) applyPending(el);
    },
    [applyPending],
  );

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = -1;
    const tick = () => {
      const el = videoRef.current;
      // While a seek is queued the element still reports its old time; letting
      // that through would snap the playhead back from the clicked position.
      if (el && pendingSeek.current === null) {
        const t = el.currentTime;
        if (Math.abs(t - last) > 1 / 60) {
          last = t;
          setCurrentTime(t);
        }
        setPlaying(!el.paused && !el.ended);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const value = useMemo<PlaybackState>(
    () => ({
      currentTime,
      duration,
      playing,
      seek,
      setDuration: setDurationState,
      registerVideo,
      togglePlay,
    }),
    [currentTime, duration, playing, seek, registerVideo, togglePlay],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayback(): PlaybackState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePlayback must be used inside <PlaybackProvider>");
  return ctx;
}
