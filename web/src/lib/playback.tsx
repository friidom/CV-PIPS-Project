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

/** A seek far enough to be worth animating; `index` is set when it came from picking an event. */
export interface Jump {
  id: number;
  t: number;
  index: number | null;
}

interface PlaybackState {
  currentTime: number;
  duration: number;
  playing: boolean;
  seek: (t: number) => void;
  setDuration: (d: number) => void;
  registerVideo: (el: HTMLVideoElement | null) => void;
  togglePlay: () => void;
  /** Event selected in any view — timeline, list, risk curve or player — shared by all of them. */
  selected: number | null;
  /** Select an event (null clears); with `t`, also jump the video to it. */
  select: (index: number | null, t?: number) => void;
  jump: Jump | null;
}

/** Seeks shorter than this are playback or frame steps, not jumps. */
const JUMP_SEC = 0.5;

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
  const timeRef = useRef(0);
  const jumps = useRef(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDurationState] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);

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
    (t: number, index: number | null = null) => {
      const target = Math.max(0, t);
      if (index !== null || Math.abs(target - timeRef.current) > JUMP_SEC) {
        jumps.current += 1;
        setJump({ id: jumps.current, t: target, index });
      }
      timeRef.current = target;
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

  const select = useCallback(
    (index: number | null, t?: number) => {
      setSelected(index);
      if (t !== undefined) seek(t, index);
    },
    [seek],
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
          timeRef.current = t;
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
      selected,
      select,
      jump,
    }),
    [currentTime, duration, playing, seek, registerVideo, togglePlay, selected, select, jump],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayback(): PlaybackState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePlayback must be used inside <PlaybackProvider>");
  return ctx;
}

/**
 * True for a moment after each jump. Playheads switch on a CSS transition while
 * it holds, so a jump glides and ordinary playback stays locked to the frame.
 */
export function useGliding(): boolean {
  const { jump } = usePlayback();
  const [gliding, setGliding] = useState(false);
  useEffect(() => {
    if (!jump) return;
    setGliding(true);
    const id = window.setTimeout(() => setGliding(false), 420);
    return () => window.clearTimeout(id);
  }, [jump]);
  return gliding;
}

/** The transition a playhead wears while gliding. */
export const GLIDE = "transform 380ms cubic-bezier(0.22, 0.8, 0.24, 1)";
