"use client";

import { useEffect } from "react";

/**
 * Report the iframe's content height to the host page.
 *
 * An iframe cannot size itself to its content, and a fixed height is wrong in both
 * directions: too short and the summary is cut off, too tall and the partner's page has a
 * block of dead space in the middle of their listing. The SDK listens for these messages
 * and resizes accordingly.
 *
 * Messages are namespaced so a page running several widgets — the Dream Neighborhood
 * Explorer and the schools widget both do this — cannot resize each other's frames.
 */
export function EmbedAutoHeight() {
  useEffect(() => {
    if (window.parent === window) return;

    let lastHeight = 0;

    const report = () => {
      const height = Math.ceil(document.documentElement.scrollHeight);
      // Ignore sub-pixel churn; resizing on every reflow makes the host page judder.
      if (Math.abs(height - lastHeight) < 8) return;
      lastHeight = height;
      window.parent.postMessage({ type: "dws:height", height }, "*");
    };

    report();

    const observer = new ResizeObserver(report);
    observer.observe(document.documentElement);

    // The scores arrive asynchronously and expanding the breakdown changes the height
    // again, so keep watching rather than measuring once.
    const interval = setInterval(report, 1000);

    return () => {
      observer.disconnect();
      clearInterval(interval);
    };
  }, []);

  return null;
}
