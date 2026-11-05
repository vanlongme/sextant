/** Up to 2 characters from word boundaries, uppercase. */
export function clusterInitials(name: string): string {
  const words = name.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [];
  const [first, second] = words;
  if (!first) return "?";
  const raw = second
    ? `${Array.from(first)[0]}${Array.from(second)[0]}`
    : Array.from(first).slice(0, 2).join("");
  return Array.from(raw.toUpperCase()).slice(0, 2).join("");
}

// Mid-tone hues that carry white initials in both the dark and light themes.
const PALETTE = [
  "#b5651d",
  "#2f7d6d",
  "#3d6fa8",
  "#8a5aa8",
  "#a84d6a",
  "#6d7f2a",
  "#a8562f",
  "#4f6d7a",
];

/** A stable pick from the palette (FNV-1a over the id). */
export function clusterColor(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  }
  return PALETTE[(hash >>> 0) % PALETTE.length] as string;
}
