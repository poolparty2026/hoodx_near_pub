export type Mood = "happy" | "wow" | "shh" | "hype" | "sleepy" | "cute-rekt";

// Art: docs/brand/hoodx/hoody-*.svg, copied to public/hoody/. The file for "cute-rekt" is hoody-rekt.svg.
const FILE: Record<Mood, string> = { happy: "happy", wow: "wow", shh: "shh", hype: "hype", sleepy: "sleepy", "cute-rekt": "rekt" };
const LABEL: Record<Mood, string> = { happy: "Happy", wow: "Wow", shh: "Shh", hype: "Hype", sleepy: "Sleepy", "cute-rekt": "Cute-rekt" };

/** Hoody in one of the six moods. Decorative by default; pass `label` when it carries meaning. The cream halo on the dark UI is in CSS (.hoody). */
export function Hoody({ mood = "happy", size = 64, label }: { mood?: Mood; size?: number; label?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="hoody" src={`/hoody/hoody-${FILE[mood]}.svg`} width={size} height={Math.round((size * 280) / 240)}
      alt={label ? `${label} (Hoody, ${LABEL[mood]})` : ""} aria-hidden={label ? undefined : true}
    />
  );
}
