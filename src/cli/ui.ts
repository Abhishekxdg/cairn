/**
 * Tiny zero-dependency terminal UI: truecolor gradients, a logo banner, and
 * rounded, width-aware boxes. Degrades gracefully — no color when piped or when
 * NO_COLOR is set, and a compact banner on narrow terminals.
 */

const isTTY = !!process.stdout.isTTY;
const noColor = process.env["NO_COLOR"] !== undefined;
export const useColor = isTTY && !noColor;
const truecolor =
  useColor && /truecolor|24bit/i.test(process.env["COLORTERM"] ?? "");

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

/** Strip ANSI escapes so visible width can be measured. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
const width = (s: string) => stripAnsi(s).length;

/** Basic SGR wrappers. */
const sgr = (code: number) => (s: string) =>
  useColor ? `${ESC}${code}m${s}${RESET}` : s;
export const style = {
  bold: sgr(1),
  dim: sgr(2),
  italic: sgr(3),
  red: sgr(31),
  green: sgr(32),
  yellow: sgr(33),
  blue: sgr(34),
  magenta: sgr(35),
  cyan: sgr(36),
  gray: sgr(90),
};

/** Truecolor foreground; falls back to cyan when 24-bit isn't available. */
function rgb(r: number, g: number, b: number, s: string): string {
  if (!useColor) return s;
  if (!truecolor) return style.cyan(s);
  return `${ESC}38;2;${r};${g};${b}m${s}${RESET}`;
}

/** A cyan→violet brand gradient across a string, character by character. */
export function gradient(s: string): string {
  if (!useColor) return s;
  const from = [34, 211, 238]; // cyan
  const to = [139, 92, 246]; // violet
  const chars = [...s];
  const n = Math.max(1, chars.length - 1);
  return chars
    .map((ch, i) => {
      if (ch === " ") return ch;
      const t = i / n;
      const r = Math.round(from[0]! + (to[0]! - from[0]!) * t);
      const g = Math.round(from[1]! + (to[1]! - from[1]!) * t);
      const b = Math.round(from[2]! + (to[2]! - from[2]!) * t);
      return rgb(r, g, b, ch);
    })
    .join("");
}

const LOGO = [
  " ██████╗  █████╗  ██╗ ██████╗  ███╗   ██╗",
  "██╔════╝ ██╔══██╗ ██║ ██╔══██╗ ████╗  ██║",
  "██║      ███████║ ██║ ██████╔╝ ██╔██╗ ██║",
  "██║      ██╔══██║ ██║ ██╔══██╗ ██║╚██╗██║",
  "╚██████╗ ██║  ██║ ██║ ██║  ██║ ██║ ╚████║",
  " ╚═════╝ ╚═╝  ╚═╝ ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═══╝",
];

/** Render the Cairn banner with a vertical gradient + tagline. */
export function banner(): string {
  const cols = process.stdout.columns ?? 80;
  const out: string[] = [""];
  if (cols < 30) {
    out.push("  " + gradient("Cairn"));
  } else {
    const from = [34, 211, 238];
    const to = [139, 92, 246];
    LOGO.forEach((line, i) => {
      const t = i / (LOGO.length - 1);
      const r = Math.round(from[0]! + (to[0]! - from[0]!) * t);
      const g = Math.round(from[1]! + (to[1]! - from[1]!) * t);
      const b = Math.round(from[2]! + (to[2]! - from[2]!) * t);
      out.push(rgb(r, g, b, line));
    });
  }
  out.push("  " + style.bold("Cairn") + style.dim("  ·  the Git of AI memory"));
  out.push("");
  return out.join("\n");
}

/** A rounded box with a title and content lines (ANSI-aware width). */
export function box(
  title: string,
  lines: string[],
  opts: { pad?: number; color?: (s: string) => string } = {},
): string {
  const pad = opts.pad ?? 1;
  const color = opts.color ?? gradient;
  const inner = Math.max(
    width(title) + 2,
    ...lines.map((l) => width(l)),
    24,
  );
  const w = inner + pad * 2;
  const sp = " ".repeat(pad);

  const top = color(`╭─ ${title} ` + "─".repeat(Math.max(0, w - width(title) - 3)) + "╮");
  const bottom = color("╰" + "─".repeat(w) + "╯");
  const bar = color("│");

  const body = lines.map((l) => {
    const gap = " ".repeat(Math.max(0, inner - width(l)));
    return `${bar}${sp}${l}${gap}${sp}${bar}`;
  });
  return ["  " + top, ...body.map((b) => "  " + b), "  " + bottom].join("\n");
}

/** A checklist row: green ✓ + label, with an optional dim trailing note. */
export function step(label: string, note = ""): string {
  const tick = style.green("✓");
  const trail = note ? "  " + style.dim(note) : "";
  return `${tick} ${label}${trail}`;
}

