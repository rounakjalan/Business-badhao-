"use client";

import { useEffect, useState } from "react";

/**
 * Renders a horizontal bar that grows from 0 to its target width on mount.
 * Kept as a tiny client island so the rest of a page (e.g. the dashboard's
 * funnel) can stay a server component fetching real data.
 */
export function AnimatedBar({
  widthPercent,
  className = "",
  style,
  children,
}: {
  widthPercent: number;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const [grown, setGrown] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`transition-[width] duration-700 ease-out ${className}`}
      style={{ ...style, width: grown ? `${widthPercent}%` : "0%" }}
    >
      {children}
    </div>
  );
}
