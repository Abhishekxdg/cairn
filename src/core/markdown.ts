/**
 * Tiny, dependency-free Markdown helpers.
 *
 * Stated keeps human-facing files (project.md, goals.md) as the source of truth,
 * so it needs to read and edit them without mangling formatting a human added.
 * These helpers operate on simple `##` section headings and `-` bullet lists,
 * which is all the spec'd files use.
 */

/** Extract the bullet items (`- foo`) listed under a `## Heading`. */
export function bulletsUnderHeading(md: string, heading: string): string[] {
  const lines = md.split("\n");
  const target = heading.trim().toLowerCase();
  const out: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      inSection = (h[1] ?? "").trim().toLowerCase() === target;
      continue;
    }
    if (!inSection) continue;
    const bullet = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (bullet && bullet[1]) out.push(bullet[1].trim());
  }
  return out;
}

/** Read the free-text value following a `Label:` line, up to the next label. */
export function fieldValue(md: string, label: string): string {
  const lines = md.split("\n");
  const target = label.trim().toLowerCase();
  const collected: string[] = [];
  let capturing = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(/^([A-Za-z][A-Za-z ]*):\s*(.*)$/);
    if (m) {
      const key = (m[1] ?? "").trim().toLowerCase();
      if (key === target) {
        capturing = true;
        if ((m[2] ?? "").trim()) collected.push((m[2] ?? "").trim());
        continue;
      }
      if (capturing) break; // hit the next label
    }
    if (capturing) {
      if (line.startsWith("#")) break;
      if (line.trim()) collected.push(line.trim());
    }
  }
  return collected.join("\n").trim();
}

/**
 * Replace the bullet list under `## Heading` with `items`. If the heading does
 * not exist it is appended to the end of the document. Preserves everything
 * outside the targeted section.
 */
export function setBulletsUnderHeading(
  md: string,
  heading: string,
  items: string[],
): string {
  const lines = md.split("\n");
  const target = heading.trim().toLowerCase();
  const result: string[] = [];
  let i = 0;
  let replaced = false;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h && (h[2] ?? "").trim().toLowerCase() === target) {
      // Emit the heading, then the new bullets, then skip the old body.
      result.push(line);
      result.push("");
      for (const it of items) result.push(`- ${it}`);
      replaced = true;
      i++;
      // Skip lines until the next heading.
      while (i < lines.length && !/^#{1,6}\s+/.test(lines[i] ?? "")) i++;
      // Preserve a blank separator before the next heading.
      result.push("");
      continue;
    }
    result.push(line);
    i++;
  }

  if (!replaced) {
    if (result.length && (result[result.length - 1] ?? "").trim() !== "") {
      result.push("");
    }
    result.push(`## ${heading}`);
    result.push("");
    for (const it of items) result.push(`- ${it}`);
    result.push("");
  }

  return result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
