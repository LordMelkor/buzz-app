import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { avatarAnimation, type agentAvatars } from "./avatar-packs";

// The outgoing view stays mounted during a shared-layout transition. Read its
// current frame when the incoming video is ready instead of restarting at zero.
const playingAvatars = new Map<string, Set<HTMLVideoElement>>();

// Follow the system setting while mounted, not only at first render.
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(change: () => void) {
  const media = window.matchMedia?.(reducedMotionQuery);
  media?.addEventListener("change", change);
  return () => media?.removeEventListener("change", change);
}
const prefersReducedMotion = () =>
  !!window.matchMedia?.(reducedMotionQuery).matches;

// Covered panes stay laid out under `visibility: hidden`, which an
// IntersectionObserver still reports as intersecting. One observer rechecks
// mounted avatars whenever a pane is covered or revealed.
const coverChecks = new Set<() => void>();
let coverObserver: MutationObserver | undefined;
function watchCovering(check: () => void) {
  coverChecks.add(check);
  if (!coverObserver) {
    coverObserver = new MutationObserver(() => {
      for (const recheck of coverChecks) recheck();
    });
    coverObserver.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-covered"],
    });
  }
  return () => {
    coverChecks.delete(check);
    if (coverChecks.size) return;
    coverObserver?.disconnect();
    coverObserver = undefined;
  };
}

/** Animated avatar with a still fallback for reduced motion or playback failure. */
export function PackedAgentAvatar({
  avatar,
  fit = "contain",
}: {
  avatar: (typeof agentAvatars)[number];
  fit?: "contain" | "cover";
}) {
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const synchronizing = useRef(false);
  const visible = useRef(false);
  const [ready, setReady] = useState<string>();
  useLayoutEffect(() => {
    if (reducedMotion) return;
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
    const videos = playingAvatars.get(avatar.id) ?? new Set<HTMLVideoElement>();
    videos.add(video);
    playingAvatars.set(avatar.id, videos);
    return () => {
      videos.delete(video);
      if (!videos.size) playingAvatars.delete(avatar.id);
    };
  }, [avatar.id, reducedMotion]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Source and reduced-motion changes replace the observed video node.
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video || typeof IntersectionObserver === "undefined") return;
    let intersecting = false;
    const update = () => {
      visible.current = intersecting && !video.closest("[data-covered]");
      if (visible.current) void video.play()?.catch(() => {});
      else video.pause();
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = !!entry?.isIntersecting;
      update();
    });
    observer.observe(video);
    const unwatch = watchCovering(update);
    return () => {
      observer.disconnect();
      unwatch();
      visible.current = false;
      video.pause();
    };
  }, [avatar.id, reducedMotion]);
  const [failed, setFailed] = useState<string>();
  const media = avatarAnimation(avatar.id);
  if (reducedMotion || failed === avatar.id || (!media.webm && !media.hevc))
    return (
      <img
        data-loaded="true"
        src={avatar.preview}
        alt={avatar.label}
        style={{ width: "100%", height: "100%", objectFit: fit }}
      />
    );
  // Prefer Apple's alpha HEVC only on Apple WebKit. Linux WebKit can
  // advertise HEVC decoding without Apple's alpha-video support.
  const appleWebkit =
    /^(Mac|iPhone|iPad|iPod)/.test(navigator.platform) &&
    /AppleWebKit/.test(navigator.userAgent) &&
    !/Chrome|Chromium|Edg/.test(navigator.userAgent);
  const sources = appleWebkit
    ? [
        { src: media.hevc, type: 'video/mp4; codecs="hvc1"' },
        { src: media.webm, type: "video/webm" },
      ]
    : [
        { src: media.webm, type: "video/webm" },
        { src: media.hevc, type: 'video/mp4; codecs="hvc1"' },
      ];
  return (
    <div
      style={{ position: "relative", width: "100%", height: "100%" }}
      onPointerEnter={() => {
        const video = videoRef.current;
        if (visible.current && video?.paused)
          void video.play()?.catch(() => {});
      }}
    >
      {ready !== avatar.id && (
        <img
          data-loaded="true"
          src={avatar.preview}
          alt=""
          style={{
            position: "absolute",
            width: "100%",
            height: "100%",
            objectFit: fit,
          }}
        />
      )}
      <video
        ref={videoRef}
        key={avatar.id}
        className="agent-packed-video"
        controls={false}
        disablePictureInPicture
        muted
        loop
        playsInline
        preload="none"
        style={{
          width: "100%",
          height: "100%",
          objectFit: fit,
          opacity: ready === avatar.id ? 1 : 0,
          pointerEvents: "none",
        }}
        onLoadedData={(event) => {
          const video = event.currentTarget;
          const previous = [...(playingAvatars.get(avatar.id) ?? [])].find(
            (candidate) =>
              candidate !== video &&
              candidate.isConnected &&
              candidate.readyState >= 2 &&
              !candidate.paused,
          );
          synchronizing.current = false;
          if (
            previous &&
            Math.abs(previous.currentTime - video.currentTime) > 0.03
          ) {
            synchronizing.current = true;
            video.currentTime = previous.currentTime;
          } else setReady(avatar.id);
        }}
        onSeeked={() => {
          synchronizing.current = false;
          setReady(avatar.id);
        }}
        onCanPlay={(event) => {
          const video = event.currentTarget;
          video.muted = true;
          video.defaultMuted = true;
          // Autoplay can be temporarily blocked; keep the video for hover retry.
          if (visible.current) void video.play()?.catch(() => {});
          if (!synchronizing.current) setReady(avatar.id);
        }}
        poster={avatar.preview}
        aria-label={avatar.label}
        onError={() => setFailed(avatar.id)}
      >
        {sources
          .filter((source) => source.src)
          .map((source, index, available) => (
            <source
              key={source.type}
              {...source}
              onError={
                index === available.length - 1
                  ? () => setFailed(avatar.id)
                  : undefined
              }
            />
          ))}
      </video>
    </div>
  );
}
