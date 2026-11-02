import { useEffect, useState } from "react";

const actions = ["pointerdown", "keydown"];

/** `request` until the user clicks or presses a key, so a request whose target
 * is still loading never takes focus from wherever they have moved it. */
export function usePendingRequest(request: number | undefined) {
  const [expired, setExpired] = useState<number>();
  useEffect(() => {
    if (!request) return;
    const expire = () => setExpired(request);
    for (const type of actions) document.addEventListener(type, expire, true);
    return () => {
      for (const type of actions)
        document.removeEventListener(type, expire, true);
    };
  }, [request]);
  return request === expired ? undefined : request;
}
