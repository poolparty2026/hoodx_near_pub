// Two independent RPC providers must agree (EC-W08, ARCHITECTURE section 8). Disagreement, or one
// provider failing, is "unverifiable", never "matching".
export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

export type Agreed<T> =
  | { readonly kind: "agreed"; readonly value: T }
  | { readonly kind: "failed" }
  | { readonly kind: "disagree" };

export function agree<T>(a: Read<T>, b: Read<T>, same: (x: T, y: T) => boolean): Agreed<T> {
  if (!a.ok || !b.ok) return { kind: "failed" };
  return same(a.value, b.value) ? { kind: "agreed", value: a.value } : { kind: "disagree" };
}
