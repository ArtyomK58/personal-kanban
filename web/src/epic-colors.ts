import type { EpicSummary } from "./api";

/** Muted tints from the blue, violet, teal, peach, rose, lime, cyan and sand families.
 * Assign against the full epic catalog, so filters and drag overlays never change a group's tint. */
const PALETTE = ["#f3f6fb", "#f6f3fa", "#f1f8f5", "#fcf5f0", "#fbf2f5", "#f6f8ef", "#f0f7f9", "#f9f6ef"] as const;

export function epicCardTints(epics: Pick<EpicSummary, "id">[]): Map<number, string> {
  const colors = new Map<number, string>();
  const used = new Set<string>();
  for (const { id } of [...epics].sort((a, b) => a.id - b.id)) {
    const preferred = id % PALETTE.length;
    let color: string | undefined;
    for (let offset = 0; offset < PALETTE.length; offset++) {
      const candidate = PALETTE[(preferred + offset) % PALETTE.length];
      if (!used.has(candidate)) { color = candidate; break; }
    }
    // Keep additional epics distinct after the curated palette is exhausted.
    // The golden-angle sequence spreads hues; saturation/lightness keep them near-white.
    let variant = 0;
    while (!color || used.has(color)) {
      const hue = Math.round((id * 137.508 + variant++ * 47.3) % 360 * 100) / 100;
      color = `hsl(${hue} 30% 97%)`;
    }
    colors.set(id, color);
    used.add(color);
  }
  return colors;
}
