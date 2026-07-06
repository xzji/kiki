"use client";

import { HOUR_HEIGHT, TIME_GUTTER_WIDTH } from "./colorTokens";
import { minutesSinceDayStart, minutesToPx } from "./timeGrid";

type Props = {
  now: Date;
  labelVariant?: "text" | "pill";
};

export function CurrentTimeLine({ now, labelVariant = "text" }: Props) {
  const minutes = minutesSinceDayStart(now);
  const top = minutesToPx(minutes, HOUR_HEIGHT);
  const h = now.getHours();
  const m = now.getMinutes().toString().padStart(2, "0");
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const label = labelVariant === "pill" ? `${hour12}:${m}${suffix}` : `${h.toString().padStart(2, "0")}:${m}`;

  return (
    <div className="pointer-events-none absolute left-0 right-0" style={{ top }}>
      <div className="absolute left-0 flex -translate-y-1/2 items-center" style={{ width: TIME_GUTTER_WIDTH }}>
        {labelVariant === "pill" ? (
          <span className="ml-1 rounded px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ backgroundColor: "#E5484D" }}>
            {label}
          </span>
        ) : (
          <span className="ml-2 text-[11px] font-medium text-badge">{label}</span>
        )}
      </div>
      <div className="relative h-px bg-badge" style={{ marginLeft: TIME_GUTTER_WIDTH }}>
        <span className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-badge" />
      </div>
    </div>
  );
}

